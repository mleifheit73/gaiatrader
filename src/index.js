/**
 * Gaia Trader, API e rotina de ingestao.
 *
 * Fase 0: provar o caminho completo, do provedor ate o grafico, passando pelo
 * nosso banco. Sem login, sem IA, sem cobranca.
 *
 * O que ja esta desenhado pensando no que vem depois:
 *  - provedor de dados trocavel em um unico arquivo
 *  - toda carga registrada, para que falha silenciosa nao exista
 *  - respostas de erro sem vazar detalhe interno
 */

import { ingerir, alvosDaCarga } from "./ingest.js";

const json = (data, status = 200, extra = {}) =>
  new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...extra,
    },
  });

const erro = (msg, status = 400) => json({ erro: msg }, status);

/**
 * Confere o cabecalho de administracao em tempo constante.
 *
 * Devolve um motivo em vez de um booleano porque "o segredo nao esta configurado
 * no servidor" e "o segredo enviado esta errado" sao problemas completamente
 * diferentes, e responder 401 para os dois torna o defeito impossivel de
 * diagnosticar de fora. Distinguir os dois nao vaza nada util para um atacante:
 * ele descobre apenas que o servidor esta mal configurado, nunca o valor.
 */
function conferirAdmin(request, env) {
  const esperado = env.ADMIN_TOKEN;
  if (!esperado) return "sem_segredo_no_servidor";

  const recebido = request.headers.get("x-admin-token") || "";
  if (!recebido) return "sem_cabecalho";

  if (recebido.length !== esperado.length) return "nao_confere";
  let diff = 0;
  for (let i = 0; i < esperado.length; i++) {
    diff |= esperado.charCodeAt(i) ^ recebido.charCodeAt(i);
  }
  return diff === 0 ? "ok" : "nao_confere";
}

async function rotaBarras(url, env) {
  const ticker = (url.searchParams.get("ticker") || "").toUpperCase().trim();
  if (!/^[A-Z0-9^=.-]{1,20}$/.test(ticker)) return erro("ticker invalido");

  const limite = Math.min(parseInt(url.searchParams.get("limite") || "500", 10) || 500, 5000);

  const { results } = await env.DB.prepare(
    `SELECT d, o, h, l, c, v, partial
       FROM daily_bars
      WHERE ticker = ?
      ORDER BY d DESC
      LIMIT ?`
  )
    .bind(ticker, limite)
    .all();

  const ativo = await env.DB.prepare(
    `SELECT ticker, market, name, currency FROM assets WHERE ticker = ?`
  )
    .bind(ticker)
    .first();

  return json({
    ticker,
    ativo: ativo || null,
    total: results.length,
    bars: (results || []).reverse(),
  });
}

async function rotaStatus(env) {
  const { results: runs } = await env.DB.prepare(
    `SELECT id, kind, provider, started_at, finished_at, ok_count, fail_count, bars_written, detail
       FROM ingest_runs ORDER BY id DESC LIMIT 10`
  ).all();

  const totais = await env.DB.prepare(
    `SELECT (SELECT COUNT(*) FROM assets)     AS ativos,
            (SELECT COUNT(*) FROM daily_bars) AS barras`
  ).first();

  return json({ totais, ultimas_cargas: runs || [] });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const rota = url.pathname;

    try {
      if (rota === "/api/health") {
        // Reporta apenas SE os bindings existem, nunca o conteudo deles.
        // Serve para diagnosticar configuracao sem precisar de acesso ao painel.
        return json({
          ok: true,
          fase: 0,
          agora: new Date().toISOString(),
          config: {
            banco_conectado: !!env.DB,
            arquivos_conectados: !!env.ASSETS,
            admin_token_configurado: !!env.ADMIN_TOKEN,
            provedor: env.DATA_PROVIDER || "(padrao)",
          },
        });
      }

      if (rota === "/api/bars") return rotaBarras(url, env);

      if (rota === "/api/status") return rotaStatus(env);

      // Dispara uma carga manualmente, para nao depender do horario do agendamento
      // durante o desenvolvimento. Protegido por segredo.
      if (rota === "/api/admin/ingest" && request.method === "POST") {
        const check = conferirAdmin(request, env);
        if (check === "sem_segredo_no_servidor") {
          return erro(
            "O segredo ADMIN_TOKEN nao esta configurado neste Worker. " +
              "Defina-o em Settings, Variables and Secrets, e tente de novo.",
            503
          );
        }
        if (check === "sem_cabecalho") {
          return erro("Faltou o cabecalho x-admin-token na requisicao.", 401);
        }
        if (check !== "ok") {
          return erro("O valor de x-admin-token nao confere com o segredo do servidor.", 401);
        }
        const alvos = await alvosDaCarga(env.DB);
        const resumo = await ingerir(env.DB, env, alvos, { kind: "manual", range: "2y" });
        return json(resumo);
      }

      if (rota.startsWith("/api/")) return erro("rota nao encontrada", 404);

      // Tudo que nao e API vai para os arquivos estaticos.
      return env.ASSETS.fetch(request);
    } catch (e) {
      // Nunca devolver detalhe interno ao cliente. O detalhe vai para o log.
      console.error("erro nao tratado:", e?.stack || e);
      return erro("erro interno", 500);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      (async () => {
        const alvos = await alvosDaCarga(env.DB);
        const resumo = await ingerir(env.DB, env, alvos, { kind: "cron", range: "2y" });
        console.log("carga agendada:", JSON.stringify(resumo));
      })()
    );
  },
};
