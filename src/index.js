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
  atualizarContagem, lerContagem, ativosComCandles, atrasados,
} from "./ingest.js";
import { estado as estadoLimite, liberar, limparAntigos } from "./limites.js";
import { ajustar, trechoContinuo, intervaloMaximo } from "./ajuste.js";
import { costurar } from "./costura.js";
import { agregar } from "./agregacao.js";
import { leituraAtual } from "./indicadores.js";
import { apurarLote, rastrear, faltamApurar } from "./rastreamento.js";
import {
  MODELOS, TIPOS, lerModelos, gravarModelo,
  consumoPorUsuario, totaisConsumo, usuariosEmAlerta, ajustarCota,
} from "./consumo.js";
import {
  COOKIE_SESSAO, COOKIE_STATE, aleatorio, lerCookie, montarCookie,
  conferirConfig, urlAutorizacao, trocarCodigo, lerIdToken, validarPerfil,
  entrar, lerSessao, sair,
} from "./auth.js";
import { nivel, aviso, podeEscrever, podeGastarIA, podePedirParecer, ehAdmin } from "./acesso.js";

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

  /*
   * TEMPO GRAFICO.
   *
   * O limite pedido vale para as barras DEVOLVIDAS, nao para as lidas. Quem
   * pede 100 barras mensais quer 100 meses, nao 100 dias virando 5 meses.
   * Entao lemos pregoes suficientes para formar o que foi pedido: cerca de 5
   * por semana e 22 por mes, com folga.
   */
  const periodo = url.searchParams.get("periodo") || "dia";
  if (!["dia", "semana", "mes"].includes(periodo)) return erro("periodo invalido");

  const pregoesPorBarra = { dia: 1, semana: 5, mes: 22 }[periodo];
  const limiteDiario = Math.min(limite * pregoesPorBarra + pregoesPorBarra * 2, 5000);

  const { results } = await env.DB.prepare(
    `SELECT d, o, h, l, c, v, partial
       FROM daily_bars
      WHERE ticker = ?
      ORDER BY d DESC
      LIMIT ?`
  )
    .bind(ticker, limiteDiario)
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

  /*
   * A AGREGACAO VEM POR ULTIMO, E A ORDEM NAO E NEGOCIAVEL.
   *
   * O ajuste por proventos aplica um fator por DATA, entao precisa dos pregoes
   * individuais: agregar antes faria o fator de um dividendo cair sobre a
   * semana inteira em vez de sobre os dias certos.
   *
   * O corte de trecho continuo tambem vem antes, porque e ele quem garante que
   * a semana nao vai misturar pregoes dos dois lados de um buraco.
   */
  const pregoesLidos = bars.length;
  if (periodo !== "dia") bars = agregar(bars, periodo);
  // O corte vale para todos os tempos graficos: o limite pedido e de barras
  // DEVOLVIDAS. No diario lemos algumas a mais de proposito, para o ajuste e o
  // corte de trecho continuo terem com o que trabalhar.
  if (bars.length > limite) bars = bars.slice(-limite);

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
    periodo,
    pregoes_lidos: pregoesLidos,
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

      // Leitura de indicadores de um ativo, no tempo grafico pedido.
      //
      // Reaproveita a rota de candles de proposito: assim indicador e grafico
      // leem exatamente a mesma serie, com o mesmo ajuste e o mesmo corte de
      // trecho continuo. Duas leituras diferentes da mesma coisa seriam duas
      // fontes de verdade, e uma delas estaria errada em algum momento.
      // Tela de rastreamento: le a tabela apurada, uma linha por ativo.
      //
      // Nao calcula nada aqui de proposito. Calcular ao vivo custaria cerca de
      // 235 mil linhas por carregamento, e o plano gratuito permitiria 21
      // acessos por dia. Lendo a apuracao, custa 96 linhas.
      if (rota === "/api/rastreamento") {
        const linhas = await rastrear(env.DB, {
          periodo: url.searchParams.get("periodo") || "dia",
          market: url.searchParams.get("mercado") || undefined,
          liquidezMinima: url.searchParams.get("liquidez_minima") || undefined,
        });

        return json({
          periodo: url.searchParams.get("periodo") || "dia",
          total: linhas.length,
          // Apuracao incompleta precisa aparecer: a tela mostraria menos ativos
          // do que o catalogo e o usuario nao saberia por que.
          faltam_apurar: await faltamApurar(env.DB),
          ativos: linhas,
        });
      }

      if (rota === "/api/indicadores") {
        // Indicador calcula na serie AJUSTADA por proventos e no trecho
        // continuo, sempre. Nao e opcional: media longa atravessando provento
        // ou buraco de serie da numero errado com cara de certo.
        url.searchParams.set("ajustado", "1");
        url.searchParams.set("continuo", "1");

        const resposta = await rotaBarras(url, env, ctx);
        const dados = await resposta.json();
        if (dados.erro) return json(dados, resposta.status);

        return json({
          ticker: dados.ticker,
          ativo: dados.ativo,
          periodo: dados.periodo,
          serie: dados.serie,
          trecho_cortado_em: dados.trecho_cortado_em,
          leitura: leituraAtual(dados.bars),
        });
      }

      // Dispara uma carga manualmente, para nao depender do horario do agendamento
      // durante o desenvolvimento. Protegido por segredo.
      if (rota === "/api/admin/ingest" && request.method === "POST") {
        const check = conferirAdmin(request, env);
        if (check === "sem_segredo_no_servidor") {
          return erro(
            "O segredo ADMIN_TOKEN não está configurado neste Worker. " +
              "Defina-o em Settings, Variables and Secrets, e tente de novo.",
            503
          );
        }
        if (check === "sem_cabecalho") {
          return erro("Faltou o cabeçalho x-admin-token na requisição.", 401);
        }
        if (check !== "ok") {
          return erro("O valor de x-admin-token não confere com o segredo do servidor.", 401);
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
        if (check !== "ok") return erro("não autorizado", check === "sem_segredo_no_servidor" ? 503 : 401);

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
          // Ativos um ou mais pregoes atras do resto do mercado deles. A
          // varredura pode terminar sem falha nenhuma e ainda assim deixar
          // ativos para tras, quando o provedor nao publicou o dia a tempo.
          atrasados: await atrasados(env.DB),
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
        if (check !== "ok") return erro("não autorizado", 401);

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
        if (check !== "ok") return erro("não autorizado", 401);

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
      // Dispara a apuracao de um lote manualmente, para nao depender do
      // horario da varredura durante o desenvolvimento.
      if (rota === "/api/admin/apurar" && request.method === "POST") {
        const check = conferirAdmin(request, env);
        if (check !== "ok") return erro("não autorizado", check === "sem_segredo_no_servidor" ? 503 : 401);

        const n = parseInt(url.searchParams.get("lote") || "10", 10);
        try {
          const resumo = await apurarLote(env.DB, { lote: Number.isFinite(n) ? n : 10 });
          return json({ ...resumo, faltam_apurar: await faltamApurar(env.DB) });
        } catch (e) {
          // Rota de administracao ja exige segredo, entao mostrar o erro de
          // verdade nao vaza nada para estranho e poupa horas de diagnostico.
          // "Erro interno" aqui ja escondeu duas causas diferentes em dois dias.
          return erro(String(e?.message || e).slice(0, 400), 500);
        }
      }

      if (rota === "/api/admin/liberar" && request.method === "POST") {
        const check = conferirAdmin(request, env);
        if (check !== "ok") return erro("não autorizado", 401);
        await liberar(env.DB);
        return json({ ok: true, mensagem: "recuo liberado" });
      }


      /* ================================================================
         CONSUMO DE IA

         Todas protegidas por segredo: expoem e-mail de usuario, custo e
         limite, que nao sao coisas para ficarem abertas.
         ================================================================ */

      // Tabela da tela de consumo: uma linha por usuario.
      if (rota === "/api/admin/consumo") {
        const check = conferirAdmin(request, env);
        if (check !== "ok") return erro("não autorizado", check === "sem_segredo_no_servidor" ? 503 : 401);
        try {
          // A cotacao vem do Dolar que carregamos na base, nao de um numero
          // fixo no codigo. Se ele ainda nao carregou, cai no padrao e a tela
          // avisa de onde veio o numero.
          const dolar = await env.DB
            .prepare(`SELECT c, d FROM daily_bars WHERE ticker = 'USDBRL=X' ORDER BY d DESC LIMIT 1`)
            .first();
          const usdBrl = dolar && dolar.c > 0 ? dolar.c : undefined;

          const [linhas, totais, alertas, modelos] = await Promise.all([
            consumoPorUsuario(env.DB, { usdBrl, limite: url.searchParams.get("limite") }),
            totaisConsumo(env.DB, { usdBrl }),
            usuariosEmAlerta(env.DB),
            lerModelos(env.DB),
          ]);
          return json({
            usuarios: linhas,
            totais,
            alertas,
            modelos,
            catalogo: Object.entries(MODELOS).map(([id, m]) => ({
              id, nome: m.nome, entrada: m.ent, saida: m.sai, leitura_cache: m.leituraCache,
            })),
            cotacao: {
              usd_brl: totais.usd_brl,
              origem: usdBrl ? "Dolar carregado na base" : "padrao do codigo",
              data: dolar ? dolar.d : null,
            },
          });
        } catch (e) {
          return erro(String(e?.message || e).slice(0, 400), 500);
        }
      }

      // Escolha de modelo por tipo de chamada.
      if (rota === "/api/admin/modelos" && request.method === "POST") {
        const check = conferirAdmin(request, env);
        if (check !== "ok") return erro("não autorizado", check === "sem_segredo_no_servidor" ? 503 : 401);
        try {
          const corpo = await request.json();
          const feitos = [];
          for (const [tipo, modelo] of Object.entries(corpo || {})) {
            if (!TIPOS[tipo]) continue;          // ignora campo que nao e tipo de chamada
            feitos.push(await gravarModelo(env.DB, tipo, modelo));
          }
          if (!feitos.length) return erro("nenhum tipo de chamada válido no pedido", 400);
          return json({ ok: true, gravados: feitos, modelos: await lerModelos(env.DB) });
        } catch (e) {
          return erro(String(e?.message || e).slice(0, 400), 400);
        }
      }

      // Ajuste manual da cota de um usuario.
      if (rota === "/api/admin/cota" && request.method === "POST") {
        const check = conferirAdmin(request, env);
        if (check !== "ok") return erro("não autorizado", check === "sem_segredo_no_servidor" ? 503 : 401);
        try {
          const b = await request.json();
          const r = await ajustarCota(env.DB, b.user_id, {
            pareceresMes:  b.pareceres_mes  != null ? parseInt(b.pareceres_mes, 10)  : null,
            pareceresHora: b.pareceres_hora != null ? parseInt(b.pareceres_hora, 10) : null,
            alertaEm:      b.alerta_em      != null ? parseInt(b.alerta_em, 10)      : null,
            motivo: b.motivo,
            por: b.por || "admin",
          });
          return json({ ok: true, cota: r });
        } catch (e) {
          return erro(String(e?.message || e).slice(0, 400), 400);
        }
      }


      /* ================================================================
         ENTRAR COM GOOGLE

         Nenhuma destas rotas pede segredo de administracao: sao o caminho
         de entrada de qualquer pessoa. O que protege o retorno e o `state`.
         ================================================================ */

      // Passo 1: sorteia o state, guarda num cookie curto e manda para o Google.
      if (rota === "/auth/google") {
        const cfg = conferirConfig(env);
        if (!cfg.pronto) {
          return erro(
            "O login com Google ainda não está configurado neste Worker. " +
            "Faltam: " + cfg.faltando.join(" e ") + ". " +
            "Defina em Settings, Variables and Secrets.",
            503
          );
        }
        const state = aleatorio(16);
        return new Response(null, {
          status: 302,
          headers: {
            location: urlAutorizacao(env, request.url, state),
            // Dez minutos: tempo de escolher a conta, nao de deixar aberto.
            "set-cookie": montarCookie(COOKIE_STATE, state, { maxAge: 600 }),
            "cache-control": "no-store",
          },
        });
      }

      // Passo 3: o Google volta aqui.
      if (rota === "/auth/google/callback") {
        const paraEntrada = (motivo) =>
          new Response(null, {
            status: 302,
            headers: {
              location: "/entrar.html?erro=" + encodeURIComponent(motivo),
              "set-cookie": montarCookie(COOKIE_STATE, "", { apagar: true }),
              "cache-control": "no-store",
            },
          });

        // A pessoa pode ter clicado em cancelar na tela do Google.
        const recusa = url.searchParams.get("error");
        if (recusa) {
          return paraEntrada(recusa === "access_denied"
            ? "Você cancelou a entrada pelo Google."
            : "O Google recusou a entrada: " + recusa);
        }

        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state");
        const esperado = lerCookie(request.headers.get("cookie"), COOKIE_STATE);

        // Sem esta conferencia, um site qualquer poderia disparar este
        // retorno e amarrar a sessao da vitima a uma conta do atacante.
        if (!code || !state || !esperado || state !== esperado) {
          return paraEntrada("A entrada expirou ou veio de um caminho inesperado. Tente de novo.");
        }

        try {
          const tokens = await trocarCodigo(env, request.url, code);
          const perfil = validarPerfil(lerIdToken(tokens.id_token), env);
          const r = await entrar(env.DB, perfil, {
            ip: request.headers.get("cf-connecting-ip"),
            agente: request.headers.get("user-agent"),
          });
          const destino = r.usuario.papel === "admin" ? "/admin-consumo.html" : "/";
          return new Response(null, {
            status: 302,
            headers: new Headers([
              ["location", destino],
              ["set-cookie", montarCookie(COOKIE_SESSAO, r.sessao, { maxAge: r.maxAge })],
              ["set-cookie", montarCookie(COOKIE_STATE, "", { apagar: true })],
              ["cache-control", "no-store"],
            ]),
          });
        } catch (e) {
          return paraEntrada(String(e?.message || e).slice(0, 200));
        }
      }

      if (rota === "/auth/sair") {
        await sair(env.DB, lerCookie(request.headers.get("cookie"), COOKIE_SESSAO));
        return new Response(null, {
          status: 302,
          headers: {
            location: "/entrar.html",
            "set-cookie": montarCookie(COOKIE_SESSAO, "", { apagar: true }),
            "cache-control": "no-store",
          },
        });
      }

      // Quem esta nesta sessao, e o que esta pessoa pode fazer.
      if (rota === "/api/eu") {
        const u = await lerSessao(env.DB, lerCookie(request.headers.get("cookie"), COOKIE_SESSAO));
        if (!u) return json({ autenticado: false, login_configurado: conferirConfig(env).pronto });

        const [assinatura, cota, ciclo] = await Promise.all([
          env.DB.prepare(`SELECT * FROM subscriptions WHERE user_id = ?`).bind(u.id).first(),
          env.DB.prepare(`SELECT * FROM ai_quota WHERE user_id = ?`).bind(u.id).first(),
          env.DB.prepare(`SELECT * FROM ai_uso_ciclo WHERE user_id = ?`).bind(u.id).first(),
        ]);
        const n = nivel(u, assinatura);
        const parecer = podePedirParecer(n, cota, ciclo, null);

        return json({
          autenticado: true,
          usuario: { id: u.id, email: u.email, nome: u.nome, foto: u.foto_url, papel: u.papel },
          admin: ehAdmin(u),
          acesso: {
            nivel: n,
            pode_salvar: podeEscrever(n),
            pode_usar_ia: podeGastarIA(n),
            aviso: aviso(n, assinatura),
          },
          assinatura: assinatura
            ? { plano: assinatura.plano, status: assinatura.status, proxima_cobranca: assinatura.proxima_cobranca }
            : null,
          cota: {
            pareceres_usados: parecer.usados,
            pareceres_limite: parecer.limite,
            pareceres_restantes: parecer.restantes,
            ciclo_fim: ciclo ? ciclo.ciclo_fim : null,
          },
        });
      }

      if (rota.startsWith("/api/")) return erro("rota não encontrada", 404);

      // Tudo que nao e API vai para os arquivos estaticos.
      return env.ASSETS.fetch(request);
    } catch (e) {
      console.error("erro nao tratado:", e?.stack || e);

      /*
       * CONDICAO OPERACIONAL CONHECIDA MERECE MENSAGEM PROPRIA.
       *
       * "Erro interno" e a resposta certa para defeito nosso, porque detalhe de
       * implementacao nao deve vazar. Mas o limite diario do banco nao e
       * defeito nem segredo: e uma condicao prevista, com hora marcada para
       * passar, e esconde-la atras de "erro interno" custou tempo de
       * diagnostico duas vezes em dois dias.
       *
       * O plano gratuito do D1 permite 5 milhoes de linhas lidas por dia e
       * recusa consultas ao estourar, voltando a meia-noite UTC, que e 21h de
       * Brasilia.
       */
      const msg = String(e?.message || e);

      if (/row read limit/i.test(msg)) {
        return json(
          {
            erro: "O limite diario de leitura do banco foi atingido.",
            detalhe:
              "O plano gratuito permite 5 milhoes de linhas lidas por dia. " +
              "O limite volta a zerar a meia-noite UTC, que e 21h de Brasilia.",
            tipo: "limite_diario_leitura",
          },
          503,
          { "retry-after": "3600" }
        );
      }

      if (/row write limit/i.test(msg)) {
        return json(
          {
            erro: "O limite diario de gravacao do banco foi atingido.",
            detalhe: "O limite volta a zerar a meia-noite UTC, que e 21h de Brasilia.",
            tipo: "limite_diario_gravacao",
          },
          503,
          { "retry-after": "3600" }
        );
      }

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

          /*
           * APURACAO DAS METRICAS, DEPOIS DA CARGA E EM LOTE.
           *
           * Depois porque a metrica tem que sair dos candles de hoje, nao dos
           * de ontem. Em lote porque calcular 96 ativos em 3 tempos graficos
           * numa execucao so varre centenas de milhares de candles, e o plano
           * gratuito limita o tempo de processador por execucao.
           *
           * Com 10 ativos por execucao e 12 execucoes na janela, os 96 cabem
           * com folga. Quando acaba, a consulta de selecao nao devolve nada e
           * as execucoes restantes nao fazem trabalho nenhum.
           */
          const metricas = await apurarLote(env.DB, { lote: 10 });
          if (metricas.ok || metricas.falhas) {
            console.log("apuracao de metricas:", JSON.stringify(metricas));
          }
        } catch (e) {
          // Sem este try, uma excecao aqui some sem deixar rastro, e a carga
          // falha em silencio. Ja perdemos tempo com isso uma vez.
          console.error("carga agendada falhou:", e?.stack || e);
        }
      })()
    );
  },
};
