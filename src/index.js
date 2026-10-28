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

import { ingerirLote, quantosFaltam, atualizarUm, inconsistentes } from "./ingest.js";
import { estado as estadoLimite, liberar, limparAntigos } from "./limites.js";

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

/**
 * Serve a serie do NOSSO banco e, se o dado estiver velho, dispara uma
 * atualizacao em segundo plano.
 *
 * A ordem importa: o usuario recebe o banco imediatamente e nunca espera o
 * provedor. A atualizacao acontece depois da resposta ter sido enviada, e
 * aparece para ele na proxima vez que abrir. Isso mantem a tela rapida e faz o
 * consumo de requisicoes acompanhar o uso real, em vez de varrer 96 ativos de
 * hora em hora para ninguem olhar.
 */
async function rotaBarras(url, env, ctx) {
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

  // Idade do dado: se o ultimo candle do banco e de antes de hoje, ou se o
  // ativo nao e atualizado ha mais de 20 minutos, vale buscar.
  const controle = await env.DB.prepare(
    `SELECT last_ok_at,
            (julianday('now') - julianday(COALESCE(last_ok_at,'1970-01-01'))) * 1440 AS min_desde
       FROM assets WHERE ticker = ?`
  )
    .bind(ticker)
    .first();

  const minutosDesde = Math.round(controle?.min_desde ?? 999999);
  const velho = minutosDesde > 20;

  if (velho && ativo && ctx) {
    // waitUntil: roda DEPOIS da resposta ir embora. O usuario nao espera.
    ctx.waitUntil(
      atualizarUm(env.DB, env, ticker, ativo.market, "demanda").catch((e) =>
        console.warn("atualizacao sob demanda falhou:", ticker, e?.message || e)
      )
    );
  }

  return json({
    ticker,
    ativo: ativo || null,
    total: results.length,
    bars: (results || []).reverse(),
    frescor: {
      minutos_desde_ultima_carga: controle?.last_ok_at ? minutosDesde : null,
      atualizando_em_segundo_plano: !!(velho && ativo && ctx),
    },
  });
}

async function rotaStatus(env) {
  const { results: runs } = await env.DB.prepare(
    `SELECT id, kind, provider, started_at, finished_at, ok_count, fail_count, bars_written, detail
       FROM ingest_runs ORDER BY id DESC LIMIT 10`
  ).all();

  const totais = await env.DB.prepare(
    `SELECT (SELECT COUNT(*) FROM assets WHERE active = 1)                      AS ativos,
            (SELECT COUNT(*) FROM assets WHERE active = 1 AND last_ok_at IS NOT NULL) AS ativos_carregados,
            (SELECT COUNT(*) FROM daily_bars)                                   AS barras,
            (SELECT COUNT(DISTINCT ticker) FROM daily_bars)                      AS ativos_com_candles`
  ).first();

  const { results: comErro } = await env.DB.prepare(
    `SELECT ticker, last_error, last_error_at FROM assets
      WHERE last_error IS NOT NULL ORDER BY last_error_at DESC LIMIT 20`
  ).all();

  return json({
    totais,
    faltam_carregar: await quantosFaltam(env.DB),
    ativos_com_erro: comErro || [],
    ultimas_cargas: runs || [],
  });
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

      if (rota === "/api/bars") return rotaBarras(url, env, ctx);

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
        // Parametros ajustaveis pela chamada, para eu conseguir medir o tamanho
        // de lote que cabe no limite do plano antes de fixar um valor.
        const n = (k, padrao) => {
          const v = parseInt(url.searchParams.get(k) || "", 10);
          return Number.isFinite(v) ? v : padrao;
        };
        const resumo = await ingerirLote(env.DB, env, {
          kind: "manual",
          lote: n("lote", 20),
          frescorHoras: n("frescor", 6),
          rangeInicial: url.searchParams.get("inicial") || undefined,
          rangeAtualizacao: url.searchParams.get("atualizacao") || undefined,
        });
        return json(resumo);
      }

      // Medidor de consumo do provedor. Protegido: expoe o estado do motor.
      if (rota === "/api/admin/metrics") {
        const check = conferirAdmin(request, env);
        if (check !== "ok") return erro("nao autorizado", check === "sem_segredo_no_servidor" ? 503 : 401);

        const [limite, totais] = await Promise.all([
          estadoLimite(env.DB, env),
          env.DB.prepare(
            `SELECT (SELECT COUNT(*) FROM assets WHERE active = 1)                               AS ativos,
                    (SELECT COUNT(*) FROM assets WHERE active = 1 AND last_ok_at IS NOT NULL)    AS carregados,
                    (SELECT COUNT(*) FROM daily_bars)                                            AS barras,
                    (SELECT COUNT(*) FROM assets WHERE last_error IS NOT NULL)                   AS com_erro`
          ).first(),
        ]);

        const { results: porHora } = await env.DB.prepare(
          `SELECT strftime('%Y-%m-%d %H:00', at) AS hora, COUNT(*) AS n,
                  SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END) AS falhas
             FROM provider_calls
            WHERE at >= datetime('now','-24 hours')
            GROUP BY hora ORDER BY hora DESC LIMIT 24`
        ).all();

        const { results: cargas } = await env.DB.prepare(
          `SELECT id, kind, provider, started_at, finished_at, ok_count, fail_count, bars_written
             FROM ingest_runs ORDER BY id DESC LIMIT 8`
        ).all();

        const { results: erros } = await env.DB.prepare(
          `SELECT ticker, last_error, last_error_at FROM assets
            WHERE last_error IS NOT NULL ORDER BY last_error_at DESC LIMIT 15`
        ).all();

        return json({
          agora: new Date().toISOString(),
          limite,
          totais,
          faltam_carregar: await quantosFaltam(env.DB),
          // Deve ser sempre uma lista vazia. Qualquer nome aqui indica defeito
          // gravando o marcador de sucesso antes dos dados.
          carregados_sem_candles: await inconsistentes(env.DB),
          consumo_por_hora: porHora || [],
          ultimas_cargas: cargas || [],
          ativos_com_erro: erros || [],
        });
      }

      // Tira o sistema do recuo automatico antes da hora, se eu decidir que ja da.
      if (rota === "/api/admin/liberar" && request.method === "POST") {
        const check = conferirAdmin(request, env);
        if (check !== "ok") return erro("nao autorizado", 401);
        await liberar(env.DB);
        return json({ ok: true, mensagem: "recuo liberado" });
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
        try {
          // Varredura unica do dia, apos o after-market fechar. Busca 3 meses
          // para pegar correcoes e tapar buracos se o sistema ficou fora do ar.
          const resumo = await ingerirLote(env.DB, env, {
            kind: "cron",
            rangeAtualizacao: "3mo",
            frescorHoras: 6,
          });
          console.log("carga agendada:", JSON.stringify(resumo));
          await limparAntigos(env.DB, 30);
        } catch (e) {
          // Sem este try, uma excecao aqui some sem deixar rastro, e a carga
          // falha em silencio. Ja perdemos tempo com isso uma vez.
          console.error("carga agendada falhou:", e?.stack || e);
        }
      })()
    );
  },
};
