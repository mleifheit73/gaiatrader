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

/*
 * ULTIMA LINHA DE DEFESA, NO PROPRIO BANCO.
 *
 * O WHERE no fim da clausula de conflito impede que um candle EM FORMACAO
 * substitua um candle JA FECHADO. Um candle fechado e fato consumado: nenhuma
 * leitura posterior sabe mais sobre aquele pregao do que ele.
 *
 * Sem esta linha, qualquer defeito no provedor que produza uma barra parcial
 * sobre uma data antiga apaga dado bom em silencio, que foi exatamente o que
 * aconteceu com o candle de 28/10/2026 do PETR4. As protecoes no provedor
 * resolvem a causa conhecida; esta resolve a classe inteira, inclusive as
 * causas que ainda nao conhecemos.
 *
 * Barra parcial continua podendo atualizar barra parcial, que e o caso normal
 * de varias leituras ao longo do mesmo pregao.
 */
const SUFIXO_CONFLITO = `ON CONFLICT(ticker, d) DO UPDATE SET
   o = excluded.o, h = excluded.h, l = excluded.l, c = excluded.c,
   v = excluded.v, partial = excluded.partial,
   src = excluded.src, updated_at = excluded.updated_at
 WHERE excluded.partial = 0 OR daily_bars.partial = 1`;

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

/*
 * PROFUNDIDADE DE HISTORICO
 *
 * Guardamos qual periodo ja foi pedido ao provedor para cada ativo, e nunca
 * deixamos esse registro regredir: a atualizacao diaria pede 3 meses, e se ela
 * sobrescrevesse o registro, um ativo com 10 anos carregados passaria a parecer
 * raso no dia seguinte.
 *
 * Isto existe porque o PETR4 ficou travado em 2 anos sem ninguem notar. A carga
 * escolhia o periodo pela pergunta errada ("tem algum candle?") em vez da certa
 * ("tem a profundidade que eu quero?").
 */
const DIAS_DO_RANGE = {
  "1d": 1, "5d": 5, "1mo": 30, "3mo": 92, "6mo": 183,
  "1y": 365, "2y": 730, "5y": 1826, "10y": 3653, "max": 36500,
};

export function profundidadeEmDias(range) {
  return DIAS_DO_RANGE[range] || 0;
}

/** Devolve o mais fundo entre dois periodos, para o registro nunca regredir. */
function rangeMaisFundo(atual, novo) {
  return profundidadeEmDias(novo) >= profundidadeEmDias(atual) ? novo : atual;
}

/*
 * GRAVACAO DE EVENTOS CORPORATIVOS
 *
 * Guardamos dividendos e desdobramentos em vez de guardar o preco ajustado.
 * O motivo esta escrito por extenso em migrations/0004_eventos.sql: o provedor
 * recalcula o ajustado de todo o historico a cada provento novo, e como a nossa
 * atualizacao diaria so reescreve os ultimos meses, um ajustado gravado
 * envelheceria em silencio e pioraria a cada dividendo.
 */
const COLUNAS_EVENTO = 6;
const EVENTOS_POR_COMANDO = 15;  // 15 x 6 = 90 parametros, sob o limite de 100 do D1

const SUFIXO_CONFLITO_EVENTO = `ON CONFLICT(ticker, d, kind) DO UPDATE SET
   valor = excluded.valor, src = excluded.src, updated_at = excluded.updated_at`;

/** Grava dividendos e desdobramentos. Devolve quantos foram escritos. */
async function gravarEventos(db, ticker, eventos, src) {
  const linhas = [
    ...(eventos?.dividendos || []).map((e) => ({ d: e.d, kind: "div", valor: e.valor })),
    ...(eventos?.desdobramentos || []).map((e) => ({ d: e.d, kind: "split", valor: e.razao })),
  ].filter((e) => e.d && Number(e.valor) > 0);

  if (!linhas.length) return 0;

  const agora = new Date().toISOString().replace("T", " ").slice(0, 19);
  const tupla = "(" + new Array(COLUNAS_EVENTO).fill("?").join(",") + ")";
  const comandos = [];

  for (let i = 0; i < linhas.length; i += EVENTOS_POR_COMANDO) {
    const fatia = linhas.slice(i, i + EVENTOS_POR_COMANDO);
    const params = [];
    for (const e of fatia) params.push(ticker, e.d, e.kind, Number(e.valor), src, agora);
    comandos.push(
      db
        .prepare(
          `INSERT INTO corporate_events (ticker, d, kind, valor, src, updated_at) VALUES ` +
            new Array(fatia.length).fill(tupla).join(",") +
            " " +
            SUFIXO_CONFLITO_EVENTO
        )
        .bind(...params)
    );
  }

  await db.batch(comandos);
  return linhas.length;
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
      /*
       * EXISTS, NAO COUNT(*). A diferenca aqui vale mais de 2 milhoes de
       * linhas lidas por noite.
       *
       * Esta consulta e o PRIMEIRO passo de toda varredura, e o unico uso do
       * resultado e um teste de sim ou nao (ver primeiraVez, mais abaixo).
       * A versao anterior pedia COUNT(*), que obriga o banco a percorrer TODOS
       * os candles de cada ativo: cerca de 231 mil linhas para os 96 ativos, a
       * cada execucao. Como a varredura dispara 12 vezes por noite, isso dava
       * perto de 2,8 milhoes de linhas lidas por noite so para decidir o que
       * carregar, contra um limite diario de 5 milhoes no plano gratuito, e sem
       * nenhum usuario no sistema.
       *
       * EXISTS para no primeiro registro encontrado: 1 linha por ativo, 96 no
       * total. Mesma resposta, 2.400 vezes mais barato.
       *
       * Foi assim que descobrimos: a varredura das 18h30 de 28/10/2026 nao
       * rodou, e nao deixou nem registro de tentativa, porque esta consulta
       * bateu no limite diario antes de conseguir ler o que precisava.
       */
      `SELECT a.ticker, a.market, a.range_carregado,
              EXISTS (SELECT 1 FROM daily_bars b WHERE b.ticker = a.ticker) AS tem_candle
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
    const primeiraVez = !alvo.tem_candle;
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
      const nEventos = await gravarEventos(db, alvo.ticker, info.eventos, provider.name);

      await db
        .prepare(
          `UPDATE assets
              SET name = COALESCE(?, name), currency = ?,
                  range_carregado = ?,
                  last_ok_at = datetime('now'),
                  last_error = NULL, last_error_at = NULL,
                  updated_at = datetime('now')
            WHERE ticker = ?`
        )
        .bind(
          info.name,
          info.currency,
          rangeMaisFundo(alvo.range_carregado, range),
          alvo.ticker
        )
        .run();

      barras += n;
      ok++;
      carregados.push({ ticker: alvo.ticker, range, barras: n, eventos: nEventos });
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

  /*
   * O range_carregado precisa vir desta consulta, e nao e detalhe.
   *
   * A versao anterior lia so o COUNT e depois passava r.range_carregado para a
   * funcao que impede a profundidade de regredir. O campo nao existia no
   * resultado, entao chegava undefined, e "5d" sempre ganhava de nada: cada
   * atualizacao sob demanda rebaixava o ativo de 10 anos para 5 dias.
   *
   * O efeito seria o alarme de historico raso acusando o catalogo inteiro, um
   * ativo de cada vez, conforme as pessoas fossem abrindo os graficos. E o
   * alarme estaria tecnicamente certo sobre um dado que nos mesmos
   * corrompemos.
   */
  const r = await db
    .prepare(
      // EXISTS, nao COUNT: a pergunta e "tem algum candle?", e COUNT obrigaria
      // a percorrer os milhares de candles do ativo para responder sim ou nao.
      // Mesmo erro que custou 46.920 linhas por execucao na selecao do lote.
      `SELECT EXISTS (SELECT 1 FROM daily_bars b WHERE b.ticker = a.ticker) AS n,
              a.range_carregado
         FROM assets a WHERE a.ticker = ?`
    )
    .bind(ticker)
    .first();

  const range = r?.n ? "5d" : RANGE_INICIAL;

  const info = await consultar(db, env, provider, ticker, market, { range }, kind);
  if (!info.bars.length) throw new Error("serie vazia");

  // Mesma regra da carga em lote: candles primeiro, marcador de sucesso por
  // ultimo. Ver o comentario longo em ingerirLote sobre por que a ordem importa.
  const n = await gravarBarras(db, ticker, info.bars, provider.name);
  const nEventos = await gravarEventos(db, ticker, info.eventos, provider.name);

  await db
    .prepare(
      `UPDATE assets
          SET name = COALESCE(?, name), currency = ?,
              range_carregado = ?,
              last_ok_at = datetime('now'),
              last_error = NULL, last_error_at = NULL,
              updated_at = datetime('now')
        WHERE ticker = ?`
    )
    .bind(info.name, info.currency, rangeMaisFundo(r?.range_carregado, range), ticker)
    .run();

  return { ticker, range, barras: n, eventos: nEventos };
}

/**
 * RECARGA FORCADA DE UM ATIVO, COM PERIODO EXPLICITO.
 *
 * POR QUE PRECISA EXISTIR
 *
 * A carga em lote escolhe o periodo por uma regra automatica: ativo sem candle
 * recebe 10 anos, ativo com candle recebe 3 meses. Essa regra nao tem como
 * aprofundar o historico de um ativo que ja foi carregado raso.
 *
 * O PETR4 provou o problema: carregado com 2 anos na Fase 0, ficou com 498
 * candles em vez de 2.491 e nunca mais voltaria a fila, porque pela regra ele
 * "ja estava carregado". Nenhum alarme dispararia, porque nenhum alarme olhava
 * para a profundidade.
 *
 * Esta rota tambem e o caminho para emendar o historico de um codigo antigo e
 * para reparar um ativo qualquer sem esperar o ciclo diario.
 */
export async function recarregar(db, env, ticker, range, kind = "recarga") {
  const provider = getProvider(null, env);

  const ativo = await db
    .prepare(`SELECT ticker, market, range_carregado FROM assets WHERE ticker = ?`)
    .bind(ticker)
    .first();

  if (!ativo) throw new Error(`ativo desconhecido no catalogo: ${ticker}`);
  if (!profundidadeEmDias(range)) throw new Error(`periodo invalido: ${range}`);

  // Toda carga e registrada, inclusive a manual. Carga que acontece sem deixar
  // rastro e carga que ninguem consegue auditar depois.
  const run = await db
    .prepare(`INSERT INTO ingest_runs (kind, provider, started_at) VALUES (?, ?, ?) RETURNING id`)
    .bind(kind, provider.name, new Date().toISOString())
    .first();

  try {
    const info = await consultar(db, env, provider, ticker, ativo.market, { range }, kind);
    if (!info.bars.length) throw new Error("serie vazia");

    // Candles primeiro, marcador por ultimo. Mesma regra da carga em lote.
    const n = await gravarBarras(db, ticker, info.bars, provider.name);
    const nEventos = await gravarEventos(db, ticker, info.eventos, provider.name);

    await db
      .prepare(
        `UPDATE assets
            SET name = COALESCE(?, name), currency = ?,
                range_carregado = ?,
                last_ok_at = datetime('now'),
                last_error = NULL, last_error_at = NULL,
                updated_at = datetime('now')
          WHERE ticker = ?`
      )
      .bind(info.name, info.currency, rangeMaisFundo(ativo.range_carregado, range), ticker)
      .run();

    const resumo = {
      ticker,
      range,
      barras: n,
      eventos: nEventos,
      primeiro: info.bars[0]?.d || null,
      ultimo: info.bars[info.bars.length - 1]?.d || null,
    };

    await db
      .prepare(
        `UPDATE ingest_runs SET finished_at = ?, ok_count = 1, bars_written = ?, detail = ?
          WHERE id = ?`
      )
      .bind(new Date().toISOString(), n, JSON.stringify(resumo), run?.id)
      .run();

    return resumo;
  } catch (e) {
    const msg = String(e?.message || e).slice(0, 300);
    await db
      .prepare(
        `UPDATE ingest_runs SET finished_at = ?, fail_count = 1, detail = ? WHERE id = ?`
      )
      .bind(new Date().toISOString(), JSON.stringify({ ticker, range, erro: msg }), run?.id)
      .run();
    throw e;
  }
}

/*
 * CONTAGEM TOTAL DE CANDLES, EM CACHE.
 *
 * POR QUE NAO CONTAR NA HORA
 *
 * COUNT(*) sobre a tabela de candles le as 231 mil linhas. Nao existe atalho no
 * SQLite: contar tudo exige percorrer tudo. Enquanto essa contagem ficou dentro
 * da rota /api/status, cada visita a pagina publica custava uma varredura
 * completa, e onze visitas por dia estouravam o limite de 5 milhoes de linhas
 * lidas do plano gratuito. O painel de administracao era pior: recarregando a
 * cada 60 segundos, consumia o orcamento do dia inteiro em 22 minutos.
 *
 * A contagem total e um numero informativo, nao uma decisao do sistema. Nada
 * depende dele estar atualizado ao segundo. Entao ele e calculado UMA vez por
 * noite, junto da varredura agendada, e guardado. Quem le paga 1 linha em vez
 * de 231 mil, e a data do calculo vai junto para ninguem confundir snapshot
 * com tempo real.
 */
export async function atualizarContagem(db) {
  const r = await db
    .prepare(
      `SELECT COUNT(*) AS barras,
              (SELECT COUNT(*) FROM assets a
                WHERE EXISTS (SELECT 1 FROM daily_bars b WHERE b.ticker = a.ticker)) AS com_candles
         FROM daily_bars`
    )
    .first();

  const valor = JSON.stringify({
    barras: r?.barras ?? 0,
    ativos_com_candles: r?.com_candles ?? 0,
    em: new Date().toISOString(),
  });

  await db
    .prepare(
      `INSERT INTO config (chave, valor, updated_at) VALUES ('contagem_candles', ?, datetime('now'))
         ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor, updated_at = excluded.updated_at`
    )
    .bind(valor)
    .run();

  return JSON.parse(valor);
}

/** Le a contagem guardada. Custa 1 linha. Devolve null se nunca foi calculada. */
export async function lerContagem(db) {
  const r = await db
    .prepare(`SELECT valor FROM config WHERE chave = 'contagem_candles'`)
    .first();
  if (!r?.valor) return null;
  try {
    return JSON.parse(r.valor);
  } catch {
    return null;
  }
}

/**
 * Quantos ativos tem pelo menos um candle. Exato e barato: 1 linha por ativo,
 * 96 no total, contra 231 mil de um COUNT(DISTINCT ticker) na tabela de candles.
 */
export async function ativosComCandles(db) {
  const r = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM assets a
        WHERE a.active = 1
          AND EXISTS (SELECT 1 FROM daily_bars b WHERE b.ticker = a.ticker)`
    )
    .first();
  return r?.n ?? 0;
}

/**
 * Ativos carregados com menos profundidade do que a desejada.
 *
 * Serve de alarme no painel, do mesmo jeito que inconsistentes(). Deve ficar
 * vazio depois que todo ativo tiver sido carregado com o periodo cheio.
 *
 * CUSTO DE LEITURA, DE PROPOSITO MAGRO
 *
 * Nao conta candles por ativo. Um COUNT(*) por ticker sobre 96 ativos le a
 * tabela inteira de candles, e no plano gratuito do D1 (5 milhoes de linhas
 * lidas por dia) um alarme assim no painel custaria uma varredura completa a
 * cada abertura de tela. MIN(d) e barato porque o indice resolve com uma busca.
 */
export async function rasos(db, alvoRange = RANGE_INICIAL) {
  const { results } = await db
    .prepare(
      `SELECT a.ticker, a.range_carregado,
              (SELECT MIN(b.d) FROM daily_bars b WHERE b.ticker = a.ticker) AS primeiro
         FROM assets a
        WHERE a.active = 1
        ORDER BY a.ticker`
    )
    .all();

  const minimo = profundidadeEmDias(alvoRange);

  return (results || [])
    .filter((r) => profundidadeEmDias(r.range_carregado) < minimo)
    .map((r) => ({
      ticker: r.ticker,
      range_carregado: r.range_carregado || null,
      primeiro_candle: r.primeiro || null,
    }));
}
