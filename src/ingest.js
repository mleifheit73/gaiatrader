/**
 * Ingestao de cotacoes para o nosso banco, em lotes.
 *
 * POR QUE EM LOTES
 * O plano gratuito da Cloudflare limita as chamadas externas por execucao.
 * Buscar os 96 ativos de uma vez estoura o limite. Em vez de pagar para
 * levantar o teto, cada execucao processa um lote e o sistema se completa em
 * varias execucoes.
 *
 * COMO A RETOMADA FUNCIONA, SEM GUARDAR ESTADO
 * Cada ativo registra quando foi carregado com sucesso pela ultima vez. O lote
 * e sempre formado pelos mais desatualizados. Um ativo que falha nao tem esse
 * campo atualizado, entao aparece de novo no lote seguinte, naturalmente.
 * Nao existe cursor, nao existe fila, nao existe logica de retentativa: a
 * propria ordenacao resolve. Menos codigo, menos defeito possivel.
 *
 * CUSTO DE BANDA
 * A primeira carga de um ativo traz 10 anos. As seguintes trazem poucos meses,
 * porque so interessa o que mudou. Isso faz a carga diaria ser muito mais leve
 * que a inicial, sem nenhuma logica especial.
 */

import { getProvider } from "./providers/index.js";
import { consultar, podeConsultar } from "./limites.js";

const LOTE_PADRAO = 20;
const FRESCOR_HORAS = 6;
const RANGE_INICIAL = "10y";
const RANGE_ATUALIZACAO = "3mo";

/*
 * GRAVACAO EM BLOCO
 *
 * A primeira versao gravava um comando por candle, agrupados de 50 em 50. Para
 * 10 anos de historico isso dava 166 idas e voltas ao banco por ativo, e medimos
 * cerca de 1 minuto para 3 ativos. O gargalo nao era buscar no Yahoo, era a
 * conversa com o banco.
 *
 * Agora cada comando insere varias linhas de uma vez, e varios comandos viajam
 * juntos. O limite real e a quantidade de parametros por comando no SQLite, que
 * e 999; com 10 colunas por linha, cabem 90 linhas com folga. Dez comandos por
 * viagem dao 900 candles por ida ao banco, contra 50 antes.
 */
/*
 * NUMEROS VINDOS DA DOCUMENTACAO DO D1, NAO DO SQLITE.
 *
 * Esta distincao custou uma carga falha. O SQLite permite 999 parametros por
 * comando, e eu dimensionei por esse numero. O D1 permite 100, e so 100. O
 * resultado foi "too many SQL variables" em todos os ativos do lote.
 *
 * Em compensacao, a documentacao esclarece algo melhor do que eu supunha: um
 * lote inteiro conta como UMA operacao, e o exemplo oficial usa 2.000 comandos
 * num lote so. Entao o caminho e o inverso do que eu tinha feito: poucas linhas
 * por comando, muitos comandos por viagem.
 */
const COLUNAS = 10;
const LINHAS_POR_COMANDO = 9;     // 9 x 10 colunas = 90 parametros, sob o limite de 100
const COMANDOS_POR_VIAGEM = 150;  // 1.350 candles por ida ao banco

const SUFIXO_CONFLITO = `ON CONFLICT(ticker, d) DO UPDATE SET
   o = excluded.o, h = excluded.h, l = excluded.l, c = excluded.c,
   v = excluded.v, partial = excluded.partial,
   src = excluded.src, updated_at = excluded.updated_at`;

function montarInsert(n) {
  const tupla = "(" + new Array(COLUNAS).fill("?").join(",") + ")";
  return (
    `INSERT INTO daily_bars (ticker, d, o, h, l, c, v, partial, src, updated_at) VALUES ` +
    new Array(n).fill(tupla).join(",") +
    " " +
    SUFIXO_CONFLITO
  );
}

/** Grava as barras de um ativo. Devolve quantas linhas foram escritas. */
async function gravarBarras(db, ticker, bars, src) {
  if (!bars.length) return 0;

  const agora = new Date().toISOString().replace("T", " ").slice(0, 19);
  const comandos = [];

  for (let i = 0; i < bars.length; i += LINHAS_POR_COMANDO) {
    const fatia = bars.slice(i, i + LINHAS_POR_COMANDO);
    const params = [];
    for (const b of fatia) {
      params.push(ticker, b.d, b.o, b.h, b.l, b.c, b.v, b.partial, src, agora);
    }
    comandos.push(db.prepare(montarInsert(fatia.length)).bind(...params));
  }

  for (let i = 0; i < comandos.length; i += COMANDOS_POR_VIAGEM) {
    await db.batch(comandos.slice(i, i + COMANDOS_POR_VIAGEM));
  }

  return bars.length;
}

/**
 * Escolhe o proximo lote: os ativos ativos mais desatualizados primeiro,
 * ignorando os que ja foram carregados ha pouco tempo.
 */
export async function selecionarLote(db, opts = {}) {
  const lote = Math.max(1, Math.min(opts.lote || LOTE_PADRAO, 60));
  const horas = opts.frescorHoras ?? FRESCOR_HORAS;

  const { results } = await db
    .prepare(
      `SELECT a.ticker, a.market,
              (SELECT COUNT(*) FROM daily_bars b WHERE b.ticker = a.ticker) AS n_barras
         FROM assets a
        WHERE a.active = 1
          AND (
                a.last_ok_at IS NULL
             OR a.last_ok_at < datetime('now', ?)
             -- Rede de seguranca: ativo marcado como carregado mas SEM candle
             -- nenhum e um estado impossivel de ser correto. Entra na fila de
             -- qualquer jeito, ignorando o marcador. Sem esta linha, um defeito
             -- que marque sucesso cedo demais deixa o ativo vazio para sempre,
             -- e foi exatamente o que aconteceu uma vez.
             OR NOT EXISTS (SELECT 1 FROM daily_bars b2 WHERE b2.ticker = a.ticker)
          )
        ORDER BY (a.last_ok_at IS NOT NULL), a.last_ok_at ASC, a.ticker ASC
        LIMIT ?`
    )
    .bind(`-${horas} hours`, lote)
    .all();

  return results || [];
}

/** Quantos ativos ainda estao desatualizados, para saber se falta rodar mais. */
export async function quantosFaltam(db, opts = {}) {
  const horas = opts.frescorHoras ?? FRESCOR_HORAS;
  const r = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM assets a
        WHERE a.active = 1
          AND (a.last_ok_at IS NULL
            OR a.last_ok_at < datetime('now', ?)
            OR NOT EXISTS (SELECT 1 FROM daily_bars b WHERE b.ticker = a.ticker))`
    )
    .bind(`-${horas} hours`)
    .first();
  return r?.n ?? 0;
}

/**
 * Ativos marcados como carregados que nao tem candle nenhum.
 * Estado impossivel de ser correto: serve de alarme no painel. Deve ser sempre
 * zero. Se nao for, ha defeito gravando o marcador de sucesso cedo demais.
 */
export async function inconsistentes(db) {
  const { results } = await db
    .prepare(
      `SELECT a.ticker FROM assets a
        WHERE a.last_ok_at IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM daily_bars b WHERE b.ticker = a.ticker)
        ORDER BY a.ticker`
    )
    .all();
  return (results || []).map((r) => r.ticker);
}

/**
 * Executa uma carga de um lote.
 * @param {D1Database} db
 * @param {object} env
 * @param {{lote?: number, kind?: string, frescorHoras?: number,
 *          rangeInicial?: string, rangeAtualizacao?: string, provider?: string}} opts
 */
export async function ingerirLote(db, env, opts = {}) {
  const provider = getProvider(opts.provider, env);
  const kind = opts.kind || "manual";

  // Confere o orcamento ANTES de escolher o lote. Se estamos em recuo ou no
  // teto da hora, a carga nem comeca, e isso fica registrado como tal.
  const permissao = await podeConsultar(db, env);
  if (!permissao.pode) {
    return {
      runId: null,
      provider: provider.name,
      no_lote: 0,
      ok: 0,
      falhas: 0,
      barras: 0,
      faltam: await quantosFaltam(db, opts),
      carregados: [],
      problemas: [],
      bloqueado: permissao.motivo,
      orcamento: permissao.estado,
    };
  }

  // Nunca pedir mais ativos do que cabe no que resta do orcamento da hora.
  const teto = Math.min(opts.lote || LOTE_PADRAO, permissao.estado.restantes_na_hora);
  const alvos = await selecionarLote(db, { ...opts, lote: Math.max(0, teto) });

  const run = await db
    .prepare(
      `INSERT INTO ingest_runs (kind, provider, started_at) VALUES (?, ?, ?) RETURNING id`
    )
    .bind(kind, provider.name, new Date().toISOString())
    .first();

  const runId = run?.id;
  let ok = 0, falhas = 0, barras = 0;
  const problemas = [];
  const carregados = [];

  for (const alvo of alvos) {
    const primeiraVez = !alvo.n_barras;
    const range = primeiraVez
      ? opts.rangeInicial || RANGE_INICIAL
      : opts.rangeAtualizacao || RANGE_ATUALIZACAO;

    try {
      const info = await consultar(db, env, provider, alvo.ticker, alvo.market, { range }, kind);
      if (!info.bars.length) throw new Error("serie vazia");

      // A ORDEM AQUI E CRITICA, e errar custou dados.
      //
      // Gravar os candles PRIMEIRO, e so depois marcar o ativo como carregado.
      // Na primeira versao era o contrario, e quando a gravacao dos candles
      // falhou o ativo ficou marcado como carregado com sucesso sem ter um
      // unico candle no banco. Pior: por estar marcado, nunca mais voltaria a
      // fila, e ficaria vazio para sempre, em silencio.
      //
      // A regra geral: o marcador de sucesso e a ULTIMA coisa a ser escrita.
      // Enquanto ele nao existe, o ativo continua na fila e a proxima tentativa
      // conserta sozinha, porque a gravacao e idempotente.
      const n = await gravarBarras(db, alvo.ticker, info.bars, provider.name);

      await db
        .prepare(
          `UPDATE assets
              SET name = COALESCE(?, name), currency = ?,
                  last_ok_at = datetime('now'),
                  last_error = NULL, last_error_at = NULL,
                  updated_at = datetime('now')
            WHERE ticker = ?`
        )
        .bind(info.name, info.currency, alvo.ticker)
        .run();

      barras += n;
      ok++;
      carregados.push({ ticker: alvo.ticker, range, barras: n });
    } catch (e) {
      // Estouro de orcamento ou recuo nao e falha do ativo: e decisao nossa de
      // nao gastar. Interrompe a carga sem marcar o ativo como problematico.
      if (e?.orcamento) {
        problemas.push({ ticker: alvo.ticker, erro: "interrompido: " + e.message });
        break;
      }
      falhas++;
      const msg = String(e?.message || e).slice(0, 300);
      problemas.push({ ticker: alvo.ticker, erro: msg });
      // Nao atualiza last_ok_at de proposito: o ativo volta ao proximo lote.
      await db
        .prepare(
          `UPDATE assets SET last_error = ?, last_error_at = datetime('now') WHERE ticker = ?`
        )
        .bind(msg, alvo.ticker)
        .run()
        .catch(() => {});
    }
  }

  const faltam = await quantosFaltam(db, opts);

  if (runId) {
    await db
      .prepare(
        `UPDATE ingest_runs
            SET finished_at = ?, ok_count = ?, fail_count = ?, bars_written = ?, detail = ?
          WHERE id = ?`
      )
      .bind(
        new Date().toISOString(),
        ok,
        falhas,
        barras,
        problemas.length ? JSON.stringify(problemas) : null,
        runId
      )
      .run();
  }

  return {
    runId,
    provider: provider.name,
    no_lote: alvos.length,
    ok,
    falhas,
    barras,
    faltam,
    carregados,
    problemas,
  };
}

/**
 * Atualiza UM ativo, para a atualizacao sob demanda.
 *
 * Chamada quando alguem abre um ativo cujo dado esta velho. Roda depois que a
 * resposta ja foi enviada, entao nunca atrasa a tela. Passa pela mesma protecao
 * de orcamento e recuo que a carga agendada: se estamos no teto ou em recuo,
 * simplesmente nao acontece, e o usuario continua vendo o que havia no banco.
 */
export async function atualizarUm(db, env, ticker, market, kind = "demanda") {
  const provider = getProvider(null, env);

  const r = await db
    .prepare(`SELECT COUNT(*) AS n FROM daily_bars WHERE ticker = ?`)
    .bind(ticker)
    .first();

  const range = r?.n ? "5d" : RANGE_INICIAL;

  const info = await consultar(db, env, provider, ticker, market, { range }, kind);
  if (!info.bars.length) throw new Error("serie vazia");

  // Mesma regra da carga em lote: candles primeiro, marcador de sucesso por
  // ultimo. Ver o comentario longo em ingerirLote sobre por que a ordem importa.
  const n = await gravarBarras(db, ticker, info.bars, provider.name);

  await db
    .prepare(
      `UPDATE assets
          SET name = COALESCE(?, name), currency = ?,
              last_ok_at = datetime('now'),
              last_error = NULL, last_error_at = NULL,
              updated_at = datetime('now')
        WHERE ticker = ?`
    )
    .bind(info.name, info.currency, ticker)
    .run();

  return { ticker, range, barras: n };
}
