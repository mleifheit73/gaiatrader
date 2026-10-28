/**
 * Provedor de cotacoes: Yahoo Finance.
 *
 * ATENCAO COMERCIAL: o Yahoo nao autoriza uso comercial dos dados. Este provedor
 * serve para desenvolvimento e validacao. No dia em que o sistema cobrar de um
 * assinante, troque o provedor por um licenciado. Essa troca deve custar UMA linha
 * no arquivo src/providers/index.js, e nada mais no sistema inteiro. Se algum dia
 * precisar mudar mais que isso, a camada vazou e precisa ser consertada.
 *
 * Contrato que todo provedor precisa cumprir:
 *   daily(ticker, market, opts) -> { name, currency, bars: [{ d, o, h, l, c, v, partial }] }
 *   onde d e uma data YYYY-MM-DD e os precos sao numeros positivos.
 */

const BASE = "https://query1.finance.yahoo.com/v8/finance/chart/";

/** Converte o nosso codigo interno para o codigo do Yahoo. */
function toYahooSymbol(ticker, market) {
  if (ticker.startsWith("^") || ticker.includes("=")) return encodeURIComponent(ticker);
  if (market === "cripto") return encodeURIComponent(ticker) + "-USD";
  return encodeURIComponent(ticker) + ".SA";
}

/**
 * Converte carimbo de tempo do pregao para a DATA do pregao, no fuso do mercado.
 * O Yahoo devolve o instante de abertura em UTC mais um deslocamento de fuso.
 * Somamos o deslocamento e ficamos so com a parte da data.
 */
function tradingDate(epochSeconds, gmtOffsetSeconds) {
  const ms = (epochSeconds + (gmtOffsetSeconds || 0)) * 1000;
  return new Date(ms).toISOString().slice(0, 10);
}

export const yahoo = {
  name: "yahoo",

  /**
   * @param {string} ticker  codigo interno (PETR4, BTC, ^BVSP)
   * @param {string} market  b3 | cripto
   * @param {{range?: string}} opts
   */
  async daily(ticker, market, opts = {}) {
    const range = opts.range || "2y";
    const url = `${BASE}${toYahooSymbol(ticker, market)}?range=${range}&interval=1d`;

    const res = await fetch(url, {
      headers: {
        // Sem um agente de usuario reconhecivel o Yahoo as vezes devolve 429.
        "User-Agent": "Mozilla/5.0 (compatible; GaiaTrader/1.0)",
        Accept: "application/json",
      },
      cf: { cacheTtl: 0, cacheEverything: false },
    });

    if (!res.ok) {
      // O codigo vai anexado ao erro porque a camada de protecao usa o 429 para
      // decidir entrar em recuo automatico. Sem isso, um bloqueio vira apenas
      // mais uma falha generica e o sistema continua batendo na porta fechada.
      const err = new Error(`yahoo: HTTP ${res.status} em ${ticker}`);
      err.status = res.status;
      throw err;
    }

    const json = await res.json();
    const result = json?.chart?.result?.[0];

    if (!result?.timestamp) {
      const msg = json?.chart?.error?.description || "resposta sem serie de precos";
      throw new Error(`yahoo: ${ticker}: ${msg}`);
    }

    const meta = result.meta || {};
    const q = result.indicators?.quote?.[0] || {};
    const off = meta.gmtoffset || 0;
    const last = result.timestamp.length - 1;
    const marketPrice = meta.regularMarketPrice;

    const bars = [];

    result.timestamp.forEach((t, i) => {
      let o = q.open?.[i], h = q.high?.[i], l = q.low?.[i], c = q.close?.[i];
      const v = q.volume?.[i] || 0;
      let partial = 0;

      // O pregao em andamento costuma vir so com o fechamento. Reconstruimos o
      // que der com os extremos do dia que o proprio Yahoo informa no cabecalho,
      // e marcamos a barra como parcial para que ninguem a trate como fechada.
      if (i === last) {
        if (!(c > 0) && marketPrice > 0) c = marketPrice;
        if (c > 0 && [o, h, l].some((x) => x == null || !(x > 0))) {
          const dh = meta.regularMarketDayHigh, dl = meta.regularMarketDayLow;
          o = c;
          h = Math.max(c, dh > 0 ? dh : c);
          l = Math.min(c, dl > 0 ? dl : c);
          partial = 1;
        }
      }

      if ([o, h, l, c].some((x) => x == null || !(x > 0))) return;

      bars.push({
        d: tradingDate(t, off),
        o, h, l, c,
        v: v || 0,
        partial,
      });
    });

    // O Yahoo as vezes repete a data do periodo corrente. A ultima leitura vence.
    const porData = new Map();
    for (const b of bars) porData.set(b.d, b);

    return {
      name: meta.shortName || meta.longName || null,
      currency: meta.currency || (market === "cripto" ? "USD" : "BRL"),
      bars: [...porData.values()].sort((a, b) => (a.d < b.d ? -1 : 1)),
    };
  },
};
