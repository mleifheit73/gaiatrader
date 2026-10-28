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
const COLUNAS = 10;
const LINHAS_POR_COMANDO = 90;   // 90 x 10 colunas = 900 parametros, sob o limite de 999
const COMANDOS_POR_VIAGEM = 10;  // 900 candles por ida ao banco

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
          AND (a.last_ok_at IS NULL OR a.last_ok_at < datetime('now', ?))
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
      `SELECT COUNT(*) AS n FROM assets
        WHERE active = 1 AND (last_ok_at IS NULL OR last_ok_at < datetime('now', ?))`
    )
    .bind(`-${horas} hours`)
    .first();
  return r?.n ?? 0;
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
  const alvos = await selecionarLote(db, opts);

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
      const info = await provider.daily(alvo.ticker, alvo.market, { range });
      if (!info.bars.length) throw new Error("serie vazia");

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

      const n = await gravarBarras(db, alvo.ticker, info.bars, provider.name);
      barras += n;
      ok++;
      carregados.push({ ticker: alvo.ticker, range, barras: n });
    } catch (e) {
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
