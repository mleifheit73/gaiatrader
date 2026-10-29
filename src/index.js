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

import {
  ingerirLote, quantosFaltam, atualizarUm, inconsistentes, recarregar, rasos,
  atualizarContagem, lerContagem, ativosComCandles,
} from "./ingest.js";
import { estado as estadoLimite, liberar, limparAntigos } from "./limites.js";
import { ajustar, trechoContinuo, intervaloMaximo } from "./ajuste.js";
import { costurar } from "./costura.js";

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

  // Ordem crescente a partir daqui: e a ordem que o calculo de ajuste espera.
  let bars = (results || []).reverse();
  const totalBruto = bars.length;

  // DUAS SERIES, UMA FONTE.
  //
  // O banco guarda sempre o preco bruto, igual ao da corretora. A serie
  // ajustada por proventos e calculada aqui, na leitura, e nunca gravada: o
  // provedor recalcula o ajuste de todo o historico a cada dividendo novo, e um
  // valor ajustado gravado envelheceria em silencio. O motivo completo esta em
  // migrations/0004_eventos.sql.
  //
  // Grafico pede o bruto (padrao). Indicador pede ajustado=1.
  const querAjustado = url.searchParams.get("ajustado") === "1";
  const querContinuo = url.searchParams.get("continuo") === "1";

  let ajuste = null;
  let corte = null;

  if (querAjustado) {
    const { results: eventos } = await env.DB.prepare(
      `SELECT d, kind, valor FROM corporate_events WHERE ticker = ? ORDER BY d`
    )
      .bind(ticker)
      .all();

    const r = ajustar(bars, eventos || []);
    bars = r.bars;
    // Evento recusado aparece na resposta de proposito. Ajuste que falha calado
    // e pior que ajuste nenhum, porque ninguem descobre.
    ajuste = { eventos_aplicados: r.aplicados, eventos_recusados: r.recusados };
  }

  // O ajuste vem antes do corte porque o ajuste de um dividendo precisa do
  // fechamento anterior a data ex, e cortar primeiro poderia jogar esse
  // fechamento fora da janela.
  if (querContinuo) {
    const t = trechoContinuo(bars, intervaloMaximo(ativo?.market));
    bars = t.bars;
    corte = t.cortado ? t.buraco : null;
  }

  // ORDEM DOS CAMPOS: TODO O DIAGNOSTICO ANTES DO VETOR DE CANDLES.
  //
  // Nao e capricho. Com 2.491 candles a resposta passa de 300 KB, e qualquer
  // leitor que corte o conteudo (um navegador, uma ferramenta, um log) perde o
  // que vem depois. Na primeira conferencia da serie ajustada o objeto "ajuste"
  // estava no fim e sumiu exatamente quando era necessario. Diagnostico que
  // desaparece quando a resposta cresce nao serve para nada, porque some
  // justamente nos casos grandes, que sao os que costumam dar problema.
  return json({
    ticker,
    ativo: ativo || null,
    total: bars.length,
    serie: querAjustado ? "ajustada" : "bruta",
    ajuste,
    // Quando preenchido, a serie tem um buraco e so o trecho posterior a ele foi
    // devolvido. Acontece em troca de codigo (NATU3) e em ativo com candle solto
    // antes do inicio de verdade (AVAX).
    trecho_cortado_em: corte,
    descartados_pelo_corte: querContinuo ? totalBruto - bars.length : 0,
    frescor: {
      minutos_desde_ultima_carga: controle?.last_ok_at ? minutosDesde : null,
      atualizando_em_segundo_plano: !!(velho && ativo && ctx),
    },
    bars,
  });
}

async function rotaStatus(env) {
  const { results: runs } = await env.DB.prepare(
    `SELECT id, kind, provider, started_at, finished_at, ok_count, fail_count, bars_written, detail
       FROM ingest_runs ORDER BY id DESC LIMIT 10`
  ).all();

  // CUSTO DE LEITURA DESTA ROTA, QUE A PAGINA PUBLICA CHAMA A CADA VISITA.
  //
  // A versao anterior tinha COUNT(*) FROM daily_bars e COUNT(DISTINCT ticker)
  // FROM daily_bars aqui. Cada uma varre as 231 mil linhas da tabela, entao
  // cada visita a pagina custava cerca de 460 mil linhas lidas, e onze visitas
  // por dia estouravam o limite de 5 milhoes do plano gratuito. Um site que cai
  // com onze visitantes nao e um site.
  //
  // Agora: os totais de assets leem 96 linhas, a contagem de candles vem do
  // cache calculado uma vez por noite, e ativosComCandles usa EXISTS, que para
  // no primeiro registro de cada ativo.
  const totais = await env.DB.prepare(
    `SELECT (SELECT COUNT(*) FROM assets WHERE active = 1)                                AS ativos,
            (SELECT COUNT(*) FROM assets WHERE active = 1 AND last_ok_at IS NOT NULL)     AS ativos_carregados`
  ).first();

  const contagem = await lerContagem(env.DB);

  const { results: comErro } = await env.DB.prepare(
    `SELECT ticker, last_error, last_error_at FROM assets
      WHERE last_error IS NOT NULL ORDER BY last_error_at DESC LIMIT 20`
  ).all();

  return json({
    totais: {
      ...totais,
      ativos_com_candles: await ativosComCandles(env.DB),
      // Numero calculado uma vez por noite, nao em tempo real. A data vai junto
      // de proposito: snapshot apresentado como tempo real engana.
      barras: contagem?.barras ?? null,
      barras_apuradas_em: contagem?.em ?? null,
    },
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
            brapi_token_configurado: !!env.BRAPI_TOKEN,
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
          // Mesma correcao da rota /api/status, e aqui era mais grave: o painel
          // se recarrega a cada 60 segundos, entao o COUNT(*) FROM daily_bars
          // consumia 231 mil linhas por minuto. Painel aberto por 22 minutos
          // gastava o orcamento diario inteiro. Alarme que custa varredura e
          // passivo, nao protecao.
          env.DB.prepare(
            `SELECT (SELECT COUNT(*) FROM assets WHERE active = 1)                               AS ativos,
                    (SELECT COUNT(*) FROM assets WHERE active = 1 AND last_ok_at IS NOT NULL)    AS carregados,
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

        const contagem = await lerContagem(env.DB);

        return json({
          agora: new Date().toISOString(),
          limite,
          totais: {
            ...totais,
            barras: contagem?.barras ?? null,
            barras_apuradas_em: contagem?.em ?? null,
          },
          faltam_carregar: await quantosFaltam(env.DB),
          // Deve ser sempre uma lista vazia. Qualquer nome aqui indica defeito
          // gravando o marcador de sucesso antes dos dados.
          carregados_sem_candles: await inconsistentes(env.DB),
          // Ativos carregados com menos historico do que o desejado. Foi o
          // defeito que manteve o PETR4 em 2 anos sem ninguem notar.
          historico_raso: await rasos(env.DB),
          consumo_por_hora: porHora || [],
          ultimas_cargas: cargas || [],
          ativos_com_erro: erros || [],
        });
      }

      // RECARGA FORCADA DE UM ATIVO, COM PERIODO EXPLICITO.
      //
      // A carga em lote nao tem como aprofundar o historico de um ativo que ja
      // foi carregado: a regra automatica da 10 anos para ativo vazio e 3 meses
      // para ativo com qualquer candle. O PETR4 ficou preso em 2 anos por isso.
      //
      // Serve tambem para emendar o historico de um codigo antigo da B3 e para
      // reparar um ativo sem esperar o ciclo diario.
      if (rota === "/api/admin/recarregar" && request.method === "POST") {
        const check = conferirAdmin(request, env);
        if (check === "sem_segredo_no_servidor") {
          return erro("O segredo ADMIN_TOKEN nao esta configurado neste Worker.", 503);
        }
        if (check !== "ok") return erro("nao autorizado", 401);

        const ticker = (url.searchParams.get("ticker") || "").toUpperCase().trim();
        const range = url.searchParams.get("range") || "10y";
        if (!/^[A-Z0-9^=.-]{1,20}$/.test(ticker)) return erro("ticker invalido");

        try {
          return json(await recarregar(env.DB, env, ticker, range, "recarga"));
        } catch (e) {
          // Devolve o motivo: esta rota e de administracao e quem a chama
          // precisa saber se o problema foi o periodo, o ativo ou o orcamento.
          return erro(String(e?.message || e).slice(0, 300), 400);
        }
      }

      // EMENDA O HISTORICO DE UM CODIGO ANTIGO DA B3 NO ATIVO ATUAL.
      //
      // Simula por padrao. Grava so com aplicar=1. A simulacao existe porque
      // emendar serie errado nao da erro nenhum: so cria um degrau de preco que
      // todo indicador le como rompimento, e ninguem descobre por meses.
      if (rota === "/api/admin/costurar" && request.method === "POST") {
        const check = conferirAdmin(request, env);
        if (check === "sem_segredo_no_servidor") {
          return erro("O segredo ADMIN_TOKEN nao esta configurado neste Worker.", 503);
        }
        if (check !== "ok") return erro("nao autorizado", 401);

        const ticker = (url.searchParams.get("ticker") || "").toUpperCase().trim();
        const predecessor = (url.searchParams.get("predecessor") || "").toUpperCase().trim() || null;
        if (!/^[A-Z0-9^=.-]{1,20}$/.test(ticker)) return erro("ticker invalido");
        if (predecessor && !/^[A-Z0-9^=.-]{1,20}$/.test(predecessor)) return erro("predecessor invalido");

        try {
          return json(
            await costurar(env.DB, env, ticker, {
              // O codigo antigo vai junto so para o relatorio: a BRAPI resolve
              // o codigo sozinha e serve a serie inteira sob o codigo atual,
              // entao nao precisamos pedir o simbolo aposentado.
              predecessor,
              ate: url.searchParams.get("ate") || "",
              de: url.searchParams.get("de") || undefined,
              simular: url.searchParams.get("aplicar") !== "1",
            })
          );
        } catch (e) {
          return erro(String(e?.message || e).slice(0, 300), 400);
        }
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

          // UMA varredura completa por noite, aqui e so aqui. Custa 231 mil
          // linhas (4,6% do orcamento diario) e alimenta o numero que as telas
          // passam a ler por 1 linha. E o unico lugar do sistema onde uma
          // varredura completa e aceitavel, porque roda uma vez e nao esta no
          // caminho de nenhuma tela.
          if (resumo?.no_lote > 0) await atualizarContagem(env.DB);
        } catch (e) {
          // Sem este try, uma excecao aqui some sem deixar rastro, e a carga
          // falha em silencio. Ja perdemos tempo com isso uma vez.
          console.error("carga agendada falhou:", e?.stack || e);
        }
      })()
    );
  },
};
