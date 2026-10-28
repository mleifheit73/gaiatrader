/**
 * Ingestao de cotacoes para o nosso banco.
 *
 * Regras de projeto:
 *  - Idempotente: rodar duas vezes a mesma carga atualiza, nunca duplica.
 *    Garantido pela chave primaria (ticker, d) e pelo ON CONFLICT.
 *  - Observavel: toda execucao registra inicio, fim, quantos ativos deram certo,
 *    quantos falharam e o motivo. Carga que falha em silencio e o pior defeito
 *    possivel num sistema de dados.
 *  - Tolerante: a falha de um ativo nao derruba a carga dos outros.
 */

import { getProvider } from "./providers/index.js";

/** Grava as barras de um ativo. Devolve quantas linhas foram escritas. */
async function gravarBarras(db, ticker, bars, src) {
  if (!bars.length) return 0;

  const agora = new Date().toISOString().replace("T", " ").slice(0, 19);
  const LOTE = 50; // D1 limita o tamanho do lote; 50 e folgado e rapido
  let escritas = 0;

  for (let i = 0; i < bars.length; i += LOTE) {
    const fatia = bars.slice(i, i + LOTE);
    const stmts = fatia.map((b) =>
      db
        .prepare(
          `INSERT INTO daily_bars (ticker, d, o, h, l, c, v, partial, src, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(ticker, d) DO UPDATE SET
             o = excluded.o, h = excluded.h, l = excluded.l, c = excluded.c,
             v = excluded.v, partial = excluded.partial,
             src = excluded.src, updated_at = excluded.updated_at`
        )
        .bind(ticker, b.d, b.o, b.h, b.l, b.c, b.v, b.partial, src, agora)
    );
    await db.batch(stmts);
    escritas += fatia.length;
  }

  return escritas;
}

/** Atualiza o cadastro do ativo com o que o provedor informou. */
async function atualizarAtivo(db, ticker, market, info) {
  await db
    .prepare(
      `INSERT INTO assets (ticker, market, name, currency, updated_at)
       VALUES (?, ?, ?, ?, datetime('now'))
       ON CONFLICT(ticker) DO UPDATE SET
         name = COALESCE(excluded.name, assets.name),
         currency = excluded.currency,
         updated_at = excluded.updated_at`
    )
    .bind(ticker, market, info.name, info.currency)
    .run();
}

/**
 * Executa uma carga.
 * @param {D1Database} db
 * @param {Array<{ticker: string, market: string}>} alvos
 * @param {{kind?: string, range?: string}} opts
 */
export async function ingerir(db, env, alvos, opts = {}) {
  const provider = getProvider(opts.provider, env);
  const kind = opts.kind || "manual";
  const inicio = new Date().toISOString();

  const run = await db
    .prepare(
      `INSERT INTO ingest_runs (kind, provider, started_at) VALUES (?, ?, ?) RETURNING id`
    )
    .bind(kind, provider.name, inicio)
    .first();

  const runId = run?.id;
  let ok = 0, falhas = 0, barras = 0;
  const problemas = [];

  for (const alvo of alvos) {
    try {
      const info = await provider.daily(alvo.ticker, alvo.market, { range: opts.range });
      if (!info.bars.length) throw new Error("serie vazia");

      await atualizarAtivo(db, alvo.ticker, alvo.market, info);
      barras += await gravarBarras(db, alvo.ticker, info.bars, provider.name);
      ok++;
    } catch (e) {
      falhas++;
      problemas.push({ ticker: alvo.ticker, erro: String(e?.message || e) });
    }
  }

  const resumo = {
    runId,
    provider: provider.name,
    ok,
    falhas,
    barras,
    problemas,
  };

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

  return resumo;
}

/** Os ativos que a carga agendada deve buscar. Na Fase 0, apenas um. */
export async function alvosDaCarga(db) {
  const { results } = await db
    .prepare(`SELECT ticker, market FROM assets WHERE active = 1 ORDER BY ticker`)
    .all();

  // Semente: enquanto a tabela estiver vazia, a Fase 0 trabalha com um unico ativo.
  if (!results || !results.length) {
    return [{ ticker: "PETR4", market: "b3" }];
  }
  return results;
}
