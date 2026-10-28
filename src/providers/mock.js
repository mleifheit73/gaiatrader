/**
 * Provedor falso, deterministico, para teste.
 *
 * Existe por dois motivos:
 *  1. Permitir testar ingestao, banco e API sem depender de rede nem do Yahoo.
 *  2. Servir de referencia do contrato que todo provedor precisa cumprir.
 *
 * Nunca deve ser o provedor padrao. A escolha vive em src/providers/index.js.
 */

/** Gerador pseudoaleatorio com semente, para a serie ser sempre a mesma. */
function semente(texto) {
  let s = 0;
  for (const ch of texto) s = (s * 31 + ch.charCodeAt(0)) % 2147483647;
  return () => ((s = (s * 16807) % 2147483647) / 2147483647);
}

/** Lista de dias uteis terminando hoje. */
function diasUteis(quantidade) {
  const dias = [];
  const d = new Date();
  d.setUTCHours(12, 0, 0, 0);
  while (dias.length < quantidade) {
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) dias.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() - 1);
  }
  return dias.reverse();
}

export const mock = {
  name: "mock",

  async daily(ticker, market, opts = {}) {
    const n = opts.barras || 300;
    const rnd = semente(ticker);
    const dias = diasUteis(n);

    let preco = market === "cripto" ? 60000 : 30;
    let tendencia = 0;
    const bars = [];

    dias.forEach((d, i) => {
      if (i % 40 === 0) tendencia = (rnd() - 0.45) * 0.004;
      const abertura = preco * (1 + (rnd() - 0.5) * 0.01);
      preco = abertura * (1 + tendencia + (rnd() - 0.5) * 0.03);
      bars.push({
        d,
        o: +abertura.toFixed(2),
        h: +(Math.max(abertura, preco) * (1 + rnd() * 0.012)).toFixed(2),
        l: +(Math.min(abertura, preco) * (1 - rnd() * 0.012)).toFixed(2),
        c: +preco.toFixed(2),
        v: Math.round(1e6 * (0.5 + rnd())),
        partial: i === dias.length - 1 ? 1 : 0,
        acRef: null,
      });
    });

    // Um dividendo e um desdobramento plantados em datas fixas, para que o
    // calculo de ajuste tenha o que exercitar sem depender de rede. Sem isso o
    // teste offline passaria por um caminho que a producao nunca usa.
    const eventos = { dividendos: [], desdobramentos: [] };
    if (dias.length > 120) {
      eventos.dividendos.push({ d: dias[dias.length - 60], valor: +(preco * 0.02).toFixed(2) });
      eventos.desdobramentos.push({ d: dias[dias.length - 120], razao: 2 });
    }

    return {
      name: `${ticker} (serie simulada)`,
      currency: market === "cripto" ? "USD" : "BRL",
      bars,
      eventos,
    };
  },
};
