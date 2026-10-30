/**
 * Apuracao e leitura das metricas de rastreamento.
 *
 * O DESENHO, E O MOTIVO DE CADA ESCOLHA
 *
 * 1. CALCULA UMA VEZ, LE MUITAS. A tela precisa dos indicadores dos 96 ativos
 *    de uma vez. Ao vivo seriam 235 mil linhas por carregamento, e o plano
 *    gratuito permitiria 21 acessos por dia. Guardado, a tela le 96 linhas.
 *
 * 2. EM LOTES, POR CAUSA DO TEMPO DE PROCESSADOR. Calcular 96 ativos em 3
 *    tempos graficos de uma vez significa varrer centenas de milhares de
 *    candles numa execucao so, e o plano gratuito limita o tempo de CPU por
 *    execucao. A apuracao entao processa um lote por vez e se completa ao longo
 *    das 12 execucoes da varredura noturna, exatamente como a carga ja faz.
 *
 * 3. SEMPRE NA SERIE AJUSTADA E NO TRECHO CONTINUO. Nao e opcional: media longa
 *    atravessando provento ou buraco de serie produz numero errado com cara de
 *    certo, que e a classe de defeito que mais custou tempo neste projeto.
 *
 * 4. FALHA DE UM ATIVO NAO DERRUBA OS OUTROS, e fica registrada na propria
 *    linha. Leitura que falha em silencio deixaria a tela mostrando numero
 *    velho como se fosse de hoje.
 */

import { ajustar, trechoContinuo, intervaloMaximo } from "./ajuste.js";
import { agregar } from "./agregacao.js";
import { leituraAtual } from "./indicadores.js";

const LOTE_PADRAO = 10;
const PERIODOS = ["dia", "semana", "mes"];

/**
 * Quantos candles diarios bastam para o tempo grafico pedido.
 *
 * Ler a serie inteira de todo ativo seria desperdicio: para o diario, 260
 * pregoes ja cobrem a media de 200 com folga. O semanal e o mensal precisam de
 * muito mais dias para formar o mesmo numero de barras, e ai o teto de 5.000
 * entra como limite de sanidade.
 */
const PREGOES_NECESSARIOS = { dia: 280, semana: 1100, mes: 5000 };

/**
 * Ativos que precisam ser apurados, os mais atrasados primeiro.
 *
 * A CONDICAO QUE IMPORTA: so entra ativo cujos CANDLES sao mais novos que a
 * ultima apuracao. Sem isso, a varredura noturna apuraria metricas de ativos
 * que ela ainda nao recarregou, e a leitura sairia com um dia de atraso sem
 * ninguem perceber, porque o numero existiria e teria cara de atual.
 *
 * A condicao tambem se auto-regula: apurado tudo, a consulta nao devolve nada e
 * as execucoes restantes da varredura nao fazem trabalho nenhum.
 */
export async function selecionarParaApurar(db, lote = LOTE_PADRAO) {
  const { results } = await db
    .prepare(
      `SELECT a.ticker, a.market, a.last_ok_at,
              (SELECT MIN(m.calculado_em) FROM asset_metrics m WHERE m.ticker = a.ticker) AS apurado_em
         FROM assets a
        WHERE a.active = 1
          AND a.last_ok_at IS NOT NULL
          AND (apurado_em IS NULL OR a.last_ok_at > apurado_em)
        ORDER BY (apurado_em IS NOT NULL), apurado_em ASC, a.ticker ASC
        LIMIT ?`
    )
    .bind(Math.max(1, Math.min(lote, 40)))
    .all();
  return results || [];
}

/** Le os candles de um ativo, ja ajustados e cortados no trecho continuo. */
async function serieDoAtivo(db, ticker, market, quantos) {
  const { results } = await db
    .prepare(
      `SELECT d, o, h, l, c, v, partial FROM daily_bars
        WHERE ticker = ? ORDER BY d DESC LIMIT ?`
    )
    .bind(ticker, quantos)
    .all();

  let bars = (results || []).reverse();
  if (!bars.length) return { bars: [], corte: null };

  const { results: eventos } = await db
    .prepare(`SELECT d, kind, valor FROM corporate_events WHERE ticker = ? ORDER BY d`)
    .bind(ticker)
    .all();

  bars = ajustar(bars, eventos || []).bars;

  const t = trechoContinuo(bars, intervaloMaximo(market));
  return { bars: t.bars, corte: t.cortado ? t.buraco : null };
}

const COLUNAS = 13;
const LINHAS_POR_COMANDO = 7;   // 7 x 13 = 91 parametros, sob o limite de 100 do D1

function montarInsert(n) {
  /*
   * calculado_em entra como expressao, nao como parametro.
   *
   * A coluna e NOT NULL e a primeira versao simplesmente nao a preenchia: toda
   * gravacao falhava na restricao do banco. O teste nao pegou porque o banco
   * falso dos testes exercita a logica, nao o esquema.
   *
   * Pondo datetime('now') direto no comando, a coluna fica garantida sem gastar
   * nenhum dos 100 parametros que o D1 permite.
   */
  const tupla = "(" + new Array(COLUNAS).fill("?").join(",") + ",datetime('now'))";
  return (
    `INSERT INTO asset_metrics
       (ticker, periodo, d, base, fechamento, mma_curta, mma_longa,
        ifr_curto, ifr_longo, atr, liquidez, em_formacao, cortado_em,
        calculado_em) VALUES ` +
    new Array(n).fill(tupla).join(",") +
    ` ON CONFLICT(ticker, periodo) DO UPDATE SET
        d = excluded.d, base = excluded.base, fechamento = excluded.fechamento,
        mma_curta = excluded.mma_curta, mma_longa = excluded.mma_longa,
        ifr_curto = excluded.ifr_curto, ifr_longo = excluded.ifr_longo,
        atr = excluded.atr, liquidez = excluded.liquidez,
        em_formacao = excluded.em_formacao, cortado_em = excluded.cortado_em,
        erro = NULL, calculado_em = datetime('now')`
  );
}

/**
 * Apura as metricas de um lote de ativos.
 * @returns {{ok: number, falhas: number, linhas: number, problemas: Array, candles_lidos: number}}
 */
export async function apurarLote(db, opts = {}) {
  const alvos = await selecionarParaApurar(db, opts.lote ?? LOTE_PADRAO);
  const periodos = opts.periodos || PERIODOS;

  let ok = 0, falhas = 0, candlesLidos = 0;
  const problemas = [];
  const linhas = [];

  for (const alvo of alvos) {
    try {
      // Uma leitura por ativo cobre o maior periodo pedido; os menores saem da
      // mesma serie. Ler tres vezes o mesmo ativo seria pagar tres vezes pelo
      // mesmo dado.
      const quantos = Math.max(...periodos.map((p) => PREGOES_NECESSARIOS[p] || 280));
      const { bars, corte } = await serieDoAtivo(db, alvo.ticker, alvo.market, quantos);

      if (!bars.length) throw new Error("sem candles");
      candlesLidos += bars.length;

      for (const periodo of periodos) {
        const serie = periodo === "dia" ? bars : agregar(bars, periodo);
        const L = leituraAtual(serie);

        linhas.push([
          alvo.ticker, periodo, L.data, L.base, L.fechamento,
          L.mma_curta, L.mma_longa, L.ifr_curto, L.ifr_longo,
          L.atr, L.liquidez_media, L.em_formacao ? 1 : 0, corte?.retomou_em || null,
        ]);
      }
      ok++;
    } catch (e) {
      falhas++;
      const msg = String(e?.message || e).slice(0, 200);
      problemas.push({ ticker: alvo.ticker, erro: msg });

      // Marca o erro na propria linha, para a tela poder avisar em vez de
      // mostrar numero velho como se fosse de hoje.
      await db
        .prepare(
          `INSERT INTO asset_metrics (ticker, periodo, base, erro, calculado_em)
                VALUES (?, 'dia', 0, ?, datetime('now'))
           ON CONFLICT(ticker, periodo) DO UPDATE SET
                erro = excluded.erro, calculado_em = excluded.calculado_em`
        )
        .bind(alvo.ticker, msg)
        .run();
    }
  }

  for (let i = 0; i < linhas.length; i += LINHAS_POR_COMANDO) {
    const fatia = linhas.slice(i, i + LINHAS_POR_COMANDO);
    await db
      .prepare(montarInsert(fatia.length))
      .bind(...fatia.flat())
      .run();
  }

  return { ok, falhas, linhas: linhas.length, candles_lidos: candlesLidos, problemas };
}

/**
 * Le a tabela de rastreamento. Custa uma linha por ativo.
 *
 * @param {object} opts
 * @param {string} [opts.periodo]        dia | semana | mes
 * @param {string} [opts.market]         b3 | cripto
 * @param {number} [opts.liquidezMinima] filtro em dinheiro por dia
 */
export async function rastrear(db, opts = {}) {
  const periodo = PERIODOS.includes(opts.periodo) ? opts.periodo : "dia";

  const condicoes = ["m.periodo = ?", "a.active = 1"];
  const params = [periodo];

  if (opts.market) { condicoes.push("a.market = ?"); params.push(opts.market); }
  if (Number(opts.liquidezMinima) > 0) {
    condicoes.push("m.liquidez >= ?");
    params.push(Number(opts.liquidezMinima));
  }

  const { results } = await db
    .prepare(
      `SELECT m.ticker, a.market, a.name, a.currency,
              m.d, m.base, m.fechamento, m.mma_curta, m.mma_longa,
              m.ifr_curto, m.ifr_longo, m.atr, m.liquidez,
              m.em_formacao, m.cortado_em, m.erro, m.calculado_em
         FROM asset_metrics m
         JOIN assets a ON a.ticker = m.ticker
        WHERE ${condicoes.join(" AND ")}
        ORDER BY m.liquidez DESC NULLS LAST, m.ticker ASC`
    )
    .bind(...params)
    .all();

  return results || [];
}

/** Quantos ativos ainda nao foram apurados hoje. */
export async function faltamApurar(db) {
  const r = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM assets a
        WHERE a.active = 1
          AND NOT EXISTS (
                SELECT 1 FROM asset_metrics m
                 WHERE m.ticker = a.ticker
                   AND m.calculado_em >= datetime('now', '-20 hours'))`
    )
    .first();
  return r?.n ?? 0;
}
