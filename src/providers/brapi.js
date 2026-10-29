/**
 * Provedor de cotacoes: BRAPI.
 *
 * POR QUE ELE EXISTE, ALEM DO YAHOO
 *
 * 1. CODIGO APOSENTADO. A B3 trocou 126 codigos desde 2016, e o Yahoo indexa
 *    pelo codigo de negociacao, nao pela empresa: quando o codigo e aposentado,
 *    o historico dele some. CESP6, IGTA3 e NTCO3 devolvem HTTP 404 la. A BRAPI
 *    resolve o codigo antigo para o atual e serve a serie inteira.
 *
 * 2. USO COMERCIAL. O Yahoo nao autoriza uso comercial dos dados, entao trocar
 *    de provedor e obrigatorio antes da primeira cobranca. A BRAPI e provedor
 *    brasileiro comercial. Este arquivo e o comeco dessa migracao, nao um
 *    desvio: no dia da troca, basta mudar o PADRAO em providers/index.js.
 *
 * 3. INTERVALO DE DATAS. O Yahoo so aceita periodos relativos (10y, 3mo). A
 *    BRAPI aceita data inicial e final, que e o que a costura precisa para
 *    buscar exatamente o trecho que falta, sem trazer o que ja temos.
 *
 * LIMITE CONHECIDO: proventos exigem plano pago na BRAPI, entao este provedor
 * devolve a lista de eventos vazia. Nao e descuido: preencher com estimativa
 * derivada do fechamento ajustado seria inventar evento que ninguem conferiu.
 */

const BASE = "https://brapi.dev/api/v2/stocks/historical";

/*
 * LIMITE DO PLANO GRATUITO, MEDIDO E NAO SUPOSTO.
 *
 * A mensagem da propria BRAPI ao estourar:
 *   "Seu plano permite no maximo 90 dias de dados historicos.
 *    O periodo solicitado e de 120 dias."
 *
 * O limite e sobre a LARGURA da janela pedida, nao sobre a profundidade. Dados
 * de 2016 vem normalmente, desde que o pedido nao passe de 90 dias por vez.
 * Isso importa porque a documentacao resumida diz "historico maximo de 3 meses",
 * o que se le como "so os ultimos 3 meses" e esta errado.
 *
 * Entao o provedor fatia sozinho: quem chama pede o periodo que quiser e nao
 * precisa saber desse limite. No dia do plano pago, basta aumentar a constante.
 */
const DIAS_POR_JANELA = 90;

/*
 * TETO DE JANELAS POR CHAMADA.
 *
 * O plano gratuito da Cloudflare limita as chamadas externas por execucao do
 * Worker a 50. Com 40 janelas cobrimos quase 10 anos e ainda sobra folga para
 * o resto da execucao. Os tres casos que motivaram isto cabem: AURE3 precisa de
 * 22 janelas, IGTI11 de 21 e NATU3 de 23.
 */
const MAXIMO_DE_JANELAS = 40;

/**
 * A BRAPI carimba cada pregao com a meia-noite de Brasilia, em UTC-3 fixo.
 * Conferido em duas pontas da serie: 2016-10-28 e 2026-10-28, ambos as 03:00
 * UTC. O Brasil teve horario de verao ate 2019, e mesmo nas datas afetadas o
 * carimbo continua em UTC-3, entao o deslocamento fixo e o certo aqui.
 *
 * Ainda assim a costura confere as datas contra os candles que ja temos antes
 * de gravar, porque errar um dia inteiro de serie e o tipo de defeito que nao
 * acusa erro e estraga todo indicador.
 */
const FUSO_B3 = -10800;

function dataDoPregao(epochSegundos) {
  return new Date((epochSegundos + FUSO_B3) * 1000).toISOString().slice(0, 10);
}

function somarDias(data, dias) {
  const t = new Date(data + "T00:00:00Z");
  t.setUTCDate(t.getUTCDate() + dias);
  return t.toISOString().slice(0, 10);
}

/** Quebra um periodo em janelas que cabem no limite do plano. */
function janelas(de, ate) {
  const saida = [];
  let inicio = de;
  while (inicio <= ate && saida.length < MAXIMO_DE_JANELAS) {
    const fim = somarDias(inicio, DIAS_POR_JANELA - 1);
    saida.push({ de: inicio, ate: fim < ate ? fim : ate });
    inicio = somarDias(inicio, DIAS_POR_JANELA);
  }
  return saida;
}

/*
 * ONDE A SERIE DE PRECOS MORA NA RESPOSTA.
 *
 * A API crua aninha a serie dentro de um objeto "data":
 *   results[0].data.historicalDataPrice
 *
 * O conector MCP da BRAPI achata isso e entrega no primeiro nivel:
 *   results[0].historicalDataPrice
 *
 * Eu escrevi este provedor olhando a resposta do conector e tratei os dois
 * contratos como se fossem um so. As 23 janelas voltaram com HTTP 200 e com
 * dados, e o provedor devolveu zero barras, porque procurava no lugar errado.
 *
 * Licao que fica: formato visto atraves de uma ferramenta nao e o formato da
 * API. A ferramenta pode reorganizar, e quase sempre reorganiza.
 *
 * Aceitamos os dois lugares de proposito, para que uma mudanca de qualquer lado
 * nao derrube a leitura.
 */
function serieDaResposta(r) {
  return r?.data?.historicalDataPrice || r?.historicalDataPrice || [];
}

/** Converte a resposta de uma janela em barras do nosso formato. */
function lerBarras(r) {
  const bars = [];
  for (const p of serieDaResposta(r)) {
    const o = Number(p.open), h = Number(p.high), l = Number(p.low), c = Number(p.close);
    const v = Number(p.volume) || 0;

    if (![o, h, l, c].every((x) => Number.isFinite(x) && x > 0)) continue;
    if (!Number.isFinite(Number(p.date))) continue;

    // Mesma invariante do outro provedor: a maxima nunca e menor que abertura
    // ou fechamento, e a minima nunca e maior. Barra que fura a propria faixa e
    // impossivel no mundo real e faz qualquer calculo de amplitude sair errado
    // sem acusar erro.
    bars.push({
      d: dataDoPregao(Number(p.date)),
      o,
      h: Math.max(h, o, c),
      l: Math.min(l, o, c),
      c,
      v,
      // Esta rota serve historico fechado. O candle do dia corrente vem pela
      // atualizacao normal, do provedor padrao, que sabe decidir isso.
      partial: 0,
      acRef: Number(p.adjustedClose) > 0 ? Number(p.adjustedClose) : null,
    });
  }
  return bars;
}

export const brapi = {
  name: "brapi",

  /**
   * @param {string} ticker  codigo atual ou antigo (a BRAPI resolve sozinha)
   * @param {string} market  b3 (cripto nao passa por aqui)
   * @param {{range?: string, de?: string, ate?: string}} opts
   */
  async daily(ticker, market, opts = {}) {
    if (market === "cripto") {
      throw new Error("brapi: provedor de acoes da B3, nao atende cripto");
    }

    const token = opts.token;
    if (!token) throw new Error("brapi: BRAPI_TOKEN nao configurado no servidor");

    const de0 = opts.de || "(relativo)";
    const ate0 = opts.ate || opts.range || "1y";

    const pedidos = opts.de && opts.ate
      ? janelas(opts.de, opts.ate)
      : [null];                     // periodo relativo: uma chamada so

    const bars = [];
    let canonico = ticker;
    let renomeado = false;
    let requisicoes = 0;

    /*
     * DIAGNOSTICO POR JANELA.
     *
     * A primeira versao pulava a janela que devolvia 404 em silencio, com a
     * justificativa de que periodo anterior a existencia do papel e situacao
     * normal. A justificativa esta certa e a consequencia estava errada: quando
     * TODAS as janelas falhavam, o que sobrava era "nenhuma barra aproveitavel",
     * uma mensagem que nao diz absolutamente nada sobre a causa.
     *
     * Tolerancia a erro sem contabilidade de erro nao e robustez, e cegueira.
     * Agora cada janela deixa rastro, e o relatorio sai junto da falha.
     */
    const diag = { ok: 0, vazias: 0, por_status: {}, primeira_resposta: null };

    for (const janela of pedidos) {
      const q = new URLSearchParams({ symbols: ticker, interval: "1d", sortOrder: "asc" });
      if (janela) {
        q.set("startDate", janela.de);
        q.set("endDate", janela.ate);
      } else {
        q.set("range", opts.range || "1y");
      }

      const res = await fetch(`${BASE}?${q.toString()}`, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          "User-Agent": "GaiaTrader/1.0",
        },
        cf: { cacheTtl: 0, cacheEverything: false },
      });

      requisicoes++;

      diag.por_status[res.status] = (diag.por_status[res.status] || 0) + 1;

      if (!res.ok) {
        // Janela sem dado nenhum (antes do papel existir, por exemplo) nao e
        // motivo para derrubar a busca inteira: pulamos e seguimos. Qualquer
        // outro codigo e problema de verdade e precisa interromper, com o
        // status anexado para a camada de protecao poder entrar em recuo.
        if (res.status === 404) {
          // Guarda o corpo da PRIMEIRA falha para o relatorio. O segredo vai no
          // cabecalho, nunca no corpo, entao isto nao vaza token.
          if (!diag.primeira_resposta) {
            diag.primeira_resposta = (await res.text().catch(() => "")).slice(0, 400);
          }
          continue;
        }
        const corpo = (await res.text().catch(() => "")).slice(0, 300);
        const err = new Error(`brapi: HTTP ${res.status} em ${ticker}: ${corpo}`);
        err.status = res.status;
        throw err;
      }

      const bruto = await res.text();
      if (!diag.primeira_resposta) diag.primeira_resposta = bruto.slice(0, 400);

      let json;
      try {
        json = JSON.parse(bruto);
      } catch {
        throw new Error(`brapi: ${ticker}: resposta nao e JSON: ${bruto.slice(0, 200)}`);
      }

      const r = json?.results?.[0];
      if (!r) {
        diag.vazias++;
        continue;
      }
      diag.ok++;

      if (r.symbol) canonico = r.symbol;
      if (r.changed) renomeado = true;

      bars.push(...lerBarras(r));
    }

    if (!bars.length) {
      // Mensagem que diz O QUE aconteceu, nao apenas que nada veio.
      const statuses = Object.entries(diag.por_status)
        .map(([s, n]) => `${n}x HTTP ${s}`)
        .join(", ") || "nenhuma resposta";
      throw new Error(
        `brapi: ${ticker}: nenhuma barra em ${requisicoes} janela(s) ` +
          `(${de0}..${ate0}). Respostas: ${statuses}. ` +
          `Janelas com resultado: ${diag.ok}, sem resultado: ${diag.vazias}. ` +
          `Primeira resposta: ${diag.primeira_resposta || "(vazia)"}`
      );
    }

    // Data repetida entre janelas vizinhas fica com a ultima leitura, que e do
    // mesmo pregao fechado de qualquer forma.
    const porData = new Map();
    for (const b of bars) porData.set(b.d, b);

    return {
      // A BRAPI devolve o codigo canonico quando o pedido foi um codigo antigo.
      // Guardamos isso para a costura poder relatar o que resolveu com o que.
      name: null,
      simboloCanonico: canonico,
      renomeado,
      // Quantas requisicoes foram gastas de verdade, porque o fatiamento torna
      // isso invisivel para quem chama e consumo invisivel nao se controla.
      requisicoes,
      janelas: diag,
      currency: "BRL",
      bars: [...porData.values()].sort((a, b) => (a.d < b.d ? -1 : 1)),
      // Proventos exigem plano pago. Ver o comentario no topo do arquivo.
      eventos: { dividendos: [], desdobramentos: [] },
    };
  },
};
