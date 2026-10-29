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

    const q = new URLSearchParams({ symbols: ticker, interval: "1d", sortOrder: "asc" });

    // Intervalo de datas quando informado, que e o caso da costura. Senao, um
    // periodo relativo, como o Yahoo.
    if (opts.de && opts.ate) {
      q.set("startDate", opts.de);
      q.set("endDate", opts.ate);
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

    if (!res.ok) {
      // O codigo vai anexado porque a camada de protecao usa 429 para entrar em
      // recuo automatico, do mesmo jeito que faz com o Yahoo.
      const err = new Error(`brapi: HTTP ${res.status} em ${ticker}`);
      err.status = res.status;
      throw err;
    }

    const json = await res.json();
    const r = json?.results?.[0];

    if (!r) throw new Error(`brapi: ${ticker}: resposta sem resultado`);
    if (!Array.isArray(r.historicalDataPrice) || !r.historicalDataPrice.length) {
      throw new Error(`brapi: ${ticker}: resposta sem serie de precos`);
    }

    const bars = [];

    for (const p of r.historicalDataPrice) {
      const o = Number(p.open), h = Number(p.high), l = Number(p.low), c = Number(p.close);
      const v = Number(p.volume) || 0;

      if (![o, h, l, c].every((x) => Number.isFinite(x) && x > 0)) continue;
      if (!Number.isFinite(Number(p.date))) continue;

      // Mesma invariante do outro provedor: a maxima nunca e menor que abertura
      // ou fechamento, e a minima nunca e maior. Barra que fura a propria faixa
      // e impossivel no mundo real e faz qualquer calculo de amplitude sair
      // errado sem acusar erro.
      const hCerto = Math.max(h, o, c);
      const lCerto = Math.min(l, o, c);

      bars.push({
        d: dataDoPregao(Number(p.date)),
        o, h: hCerto, l: lCerto, c,
        v,
        // Esta rota serve historico fechado. O candle do dia corrente vem pela
        // atualizacao normal, do provedor padrao, que sabe decidir isso.
        partial: 0,
        acRef: Number(p.adjustedClose) > 0 ? Number(p.adjustedClose) : null,
      });
    }

    if (!bars.length) throw new Error(`brapi: ${ticker}: nenhuma barra aproveitavel`);

    // Data repetida nao deveria acontecer aqui, mas se acontecer fica a ultima,
    // que e a leitura mais recente do mesmo pregao fechado.
    const porData = new Map();
    for (const b of bars) porData.set(b.d, b);

    return {
      // A BRAPI devolve o codigo canonico quando o pedido foi um codigo antigo.
      // Guardamos isso para a costura poder relatar o que resolveu com o que.
      name: null,
      simboloCanonico: r.symbol || ticker,
      renomeado: !!r.changed,
      currency: "BRL",
      bars: [...porData.values()].sort((a, b) => (a.d < b.d ? -1 : 1)),
      // Proventos exigem plano pago. Ver o comentario no topo do arquivo.
      eventos: { dividendos: [], desdobramentos: [] },
    };
  },
};
