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
 *   daily(ticker, market, opts) -> {
 *     name, currency,
 *     bars: [{ d, o, h, l, c, v, partial, acRef }],
 *     eventos: { dividendos: [{ d, valor }], desdobramentos: [{ d, razao }] }
 *   }
 *   onde d e uma data YYYY-MM-DD e os precos sao numeros positivos.
 *
 * acRef e o fechamento ajustado que o PROVEDOR calculou. Nao e gravado no banco,
 * de proposito: serve apenas para conferir o nosso proprio calculo de ajuste.
 * Ver o comentario sobre ajuste em migrations/0004_eventos.sql.
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

/**
 * Le o mapa de eventos do Yahoo, que vem indexado por carimbo de tempo.
 * Formato na origem:
 *   events.dividends = { "1600000000": { amount: 1.23, date: 1600000000 }, ... }
 *   events.splits    = { "1600000000": { numerator: 2, denominator: 1, ... }, ... }
 */
function lerEventos(events, off) {
  const dividendos = [];
  const desdobramentos = [];

  for (const e of Object.values(events?.dividends || {})) {
    const valor = Number(e?.amount);
    if (e?.date && valor > 0) dividendos.push({ d: tradingDate(e.date, off), valor });
  }

  for (const e of Object.values(events?.splits || {})) {
    const num = Number(e?.numerator);
    const den = Number(e?.denominator);
    // razao > 1 e desdobramento (mais acoes, preco menor). razao < 1 e grupamento.
    if (e?.date && num > 0 && den > 0) {
      desdobramentos.push({ d: tradingDate(e.date, off), razao: num / den });
    }
  }

  const porData = (a, b) => (a.d < b.d ? -1 : 1);
  return { dividendos: dividendos.sort(porData), desdobramentos: desdobramentos.sort(porData) };
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
    const url =
      `${BASE}${toYahooSymbol(ticker, market)}` +
      `?range=${range}&interval=1d&events=div%2Csplit&includeAdjustedClose=true`;

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
    const aj = result.indicators?.adjclose?.[0]?.adjclose || [];
    const off = meta.gmtoffset || 0;
    const last = result.timestamp.length - 1;
    const marketPrice = meta.regularMarketPrice;

    // O PREGAO AINDA ESTA ABERTO?
    //
    // A versao anterior decidia isso olhando se o vetor de precos veio
    // incompleto, e errava sempre que ele vinha completo. Em cripto vinha
    // completo TODO dia, porque o mercado nao fecha, e o candle do dia era
    // gravado como definitivo. O sintoma que entregou o defeito: fechamento
    // 0,2% abaixo da minima, porque o fechamento vem do ultimo negocio e os
    // extremos vem de uma janela mais antiga.
    //
    // A pergunta certa nao e sobre o formato da resposta, e sobre o relogio do
    // mercado, que o proprio Yahoo informa. Usamos o fim do after-market quando
    // existe, porque entre o fim do pregao regular e o fim do after-market o
    // fechamento do dia ainda pode mudar.
    const periodo = meta.currentTradingPeriod || {};
    const fimDaSessao = periodo.post?.end || periodo.regular?.end || null;
    const agora = Math.floor(Date.now() / 1000);
    const sessaoAberta = fimDaSessao ? agora < fimDaSessao : null;

    const bars = [];

    result.timestamp.forEach((t, i) => {
      let o = q.open?.[i], h = q.high?.[i], l = q.low?.[i], c = q.close?.[i];
      const v = q.volume?.[i] || 0;
      const d = tradingDate(t, off);
      let partial = 0;

      if (i === last) {
        // O pregao em andamento as vezes vem so com o fechamento. Reconstruimos
        // o que der com os extremos do dia que o proprio Yahoo informa no
        // cabecalho.
        if (!(c > 0) && marketPrice > 0) c = marketPrice;
        if (c > 0 && [o, h, l].some((x) => x == null || !(x > 0))) {
          const dh = meta.regularMarketDayHigh, dl = meta.regularMarketDayLow;
          o = c;
          h = Math.max(c, dh > 0 ? dh : c);
          l = Math.min(c, dl > 0 ? dl : c);
          partial = 1;
        }

        // Regra principal: o relogio do mercado manda, mesmo que a barra venha
        // completa.
        if (sessaoAberta === true) partial = 1;

        // Rede de seguranca para provedor que nao informa o periodo: se a barra
        // e do dia de hoje no fuso do mercado, trate como em andamento. Errar
        // marcando parcial uma barra fechada custa um rotulo na tela. Errar
        // marcando definitiva uma barra aberta contamina todo indicador.
        if (sessaoAberta === null && d === tradingDate(agora, off)) partial = 1;
      }

      if ([o, h, l, c].some((x) => x == null || !(x > 0))) return;

      // INVARIANTE DA BARRA: a maxima nunca e menor que a abertura ou o
      // fechamento, e a minima nunca e maior. Se negociou naquele preco, o
      // extremo do dia e no minimo aquele preco, entao corrigimos a faixa em vez
      // de descartar a barra. Uma barra que fura a propria faixa e impossivel no
      // mundo real e faz qualquer calculo de amplitude (ATR, por exemplo) sair
      // errado sem acusar erro.
      const hCerto = Math.max(h, o, c);
      const lCerto = Math.min(l, o, c);
      if (hCerto !== h || lCerto !== l) {
        h = hCerto;
        l = lCerto;
        // Furar a faixa so acontece quando o fechamento e mais recente que os
        // extremos, o que por si so prova que a barra esta em formacao.
        if (i === last) partial = 1;
      }

      const acRef = Number(aj[i]);

      bars.push({
        d,
        o, h, l, c,
        v: v || 0,
        partial,
        acRef: acRef > 0 ? acRef : null,
      });
    });

    // O Yahoo as vezes repete a data do periodo corrente. A ultima leitura vence.
    const porData = new Map();
    for (const b of bars) porData.set(b.d, b);

    return {
      name: meta.shortName || meta.longName || null,
      currency: meta.currency || (market === "cripto" ? "USD" : "BRL"),
      bars: [...porData.values()].sort((a, b) => (a.d < b.d ? -1 : 1)),
      eventos: lerEventos(result.events, off),
    };
  },
};
