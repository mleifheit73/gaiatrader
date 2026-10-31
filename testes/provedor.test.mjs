import { yahoo } from "../src/providers/yahoo.js";

let falhas = 0;
function ok(nome, cond, extra = "") {
  console.log(`${cond ? "PASSOU" : "FALHOU"}  ${nome}${extra ? "  " + extra : ""}`);
  if (!cond) falhas++;
}

const OFF = -10800;                       // Brasilia, UTC-3
const ep = (iso) => Math.floor(Date.parse(iso) / 1000);

// Dois registros que caem na MESMA data de pregao (2026-10-28):
//  t1 = abertura do pregao de 28/10
//  t2 = madrugada de 29/10 UTC, que ao descontar o fuso volta para 28/10.
//       E o registro do periodo seguinte que o Yahoo devolve com tudo vazio.
const t1 = ep("2026-10-28T13:00:00Z");
const t2 = ep("2026-10-29T02:00:00Z");

function respostaYahoo({ fimDaSessao, segundoRegistro }) {
  return {
    chart: { result: [{
      meta: {
        gmtoffset: OFF, currency: "BRL", shortName: "PETROBRAS PN",
        regularMarketPrice: 52.51,
        regularMarketDayHigh: 53.21, regularMarketDayLow: 52.22,
        currentTradingPeriod: { regular: { start: t1, end: fimDaSessao } },
      },
      timestamp: segundoRegistro ? [t1, t2] : [t1],
      indicators: {
        quote: [{
          open:   segundoRegistro ? [53.17, null] : [53.17],
          high:   segundoRegistro ? [53.21, null] : [53.21],
          low:    segundoRegistro ? [52.22, null] : [52.22],
          close:  segundoRegistro ? [52.51, null] : [52.51],
          volume: segundoRegistro ? [56654300, null] : [56654300],
        }],
        adjclose: [{ adjclose: segundoRegistro ? [52.51, null] : [52.51] }],
      },
      events: {},
    }] },
  };
}

function stubFetch(corpo) {
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => corpo });
}

// ---------------------------------------------------------------------------
// 1. O DEFEITO QUE DESTRUIU O CANDLE DO PETR4
// Mercado fechado, registro do periodo seguinte vazio caindo na mesma data.
// O candle real tem que sobreviver inteiro.
// ---------------------------------------------------------------------------
stubFetch(respostaYahoo({ fimDaSessao: ep("2026-10-28T20:00:00Z"), segundoRegistro: true }));
const r1 = await yahoo.daily("PETR4", "b3", { range: "10y" });
const b1 = r1.bars.find((b) => b.d === "2026-10-28");

ok("so existe UMA barra para 28/10", r1.bars.filter((b) => b.d === "2026-10-28").length === 1);
ok("abertura preservada", b1?.o === 53.17, `veio ${b1?.o}`);
ok("maxima preservada", b1?.h === 53.21, `veio ${b1?.h}`);
ok("minima preservada", b1?.l === 52.22, `veio ${b1?.l}`);
ok("fechamento preservado", b1?.c === 52.51, `veio ${b1?.c}`);
ok("VOLUME preservado (era o que mais se perdia)", b1?.v === 56654300, `veio ${b1?.v}`);
ok("pregao fechado marca a barra como definitiva", b1?.partial === 0, `partial=${b1?.partial}`);

// ---------------------------------------------------------------------------
// 2. PREGAO ABERTO: a barra do dia tem que ser marcada como em formacao
// ---------------------------------------------------------------------------
stubFetch(respostaYahoo({ fimDaSessao: ep("2099-01-01T00:00:00Z"), segundoRegistro: false }));
const r2 = await yahoo.daily("PETR4", "b3", { range: "10y" });
ok("pregao aberto marca a ultima barra como parcial", r2.bars.at(-1).partial === 1);
ok("pregao aberto nao inventa dado", r2.bars.at(-1).v === 56654300);

// ---------------------------------------------------------------------------
// 3. INVARIANTE DA BARRA: fechamento abaixo da minima corrige a faixa
// Foi o sintoma que entregou os 7 candles de cripto.
// ---------------------------------------------------------------------------
const furada = respostaYahoo({ fimDaSessao: ep("2099-01-01T00:00:00Z"), segundoRegistro: false });
furada.chart.result[0].indicators.quote[0].low = [53.00];   // minima ACIMA do fechamento
stubFetch(furada);
const r3 = await yahoo.daily("PETR4", "b3", { range: "10y" });
const b3 = r3.bars.at(-1);
ok("minima corrigida para nao furar o fechamento", b3.l <= b3.c && b3.l === 52.51, `l=${b3.l} c=${b3.c}`);
ok("barra que furava a faixa fica marcada como em formacao", b3.partial === 1);

// ---------------------------------------------------------------------------
// 3b. SESSAO ABERTA DE OUTRO DIA NAO CONTAMINA O CANDLE DE ONTEM
//
// Com o mercado fechado de madrugada, o Yahoo ja aponta currentTradingPeriod
// para o pregao SEGUINTE. A versao anterior lia so "existe sessao aberta" e
// carimbava o candle de ontem, ja encerrado, como em formacao.
// ---------------------------------------------------------------------------
const ontem = respostaYahoo({ fimDaSessao: ep("2099-01-01T00:00:00Z"), segundoRegistro: false });
// A sessao corrente e a de 29/10; a unica barra da resposta e de 28/10.
ontem.chart.result[0].meta.currentTradingPeriod.regular.start = ep("2026-10-29T13:00:00Z");
stubFetch(ontem);
const rOntem = await yahoo.daily("PETR4", "b3", { range: "10y" });
ok("candle de ontem NAO vira parcial so porque ha sessao aberta hoje",
   rOntem.bars.at(-1).partial === 0, `d=${rOntem.bars.at(-1).d} partial=${rOntem.bars.at(-1).partial}`);

const hoje = respostaYahoo({ fimDaSessao: ep("2099-01-01T00:00:00Z"), segundoRegistro: false });
hoje.chart.result[0].meta.currentTradingPeriod.regular.start = t1;   // sessao do proprio dia da barra
stubFetch(hoje);
const rHoje = await yahoo.daily("PETR4", "b3", { range: "10y" });
ok("candle do pregao corrente continua sendo marcado como parcial",
   rHoje.bars.at(-1).partial === 1);

// ---------------------------------------------------------------------------
// 4. EVENTOS CORPORATIVOS continuam sendo lidos
// ---------------------------------------------------------------------------
const comEventos = respostaYahoo({ fimDaSessao: ep("2026-10-28T20:00:00Z"), segundoRegistro: false });
comEventos.chart.result[0].events = {
  dividends: { [t1]: { amount: 7.48, date: t1 } },
  splits: { [t1]: { numerator: 2, denominator: 1, date: t1 } },
};
stubFetch(comEventos);
const r4 = await yahoo.daily("PETR4", "b3", { range: "10y" });
ok("dividendo lido", r4.eventos.dividendos.length === 1 && r4.eventos.dividendos[0].valor === 7.48);
ok("desdobramento lido com a razao certa", r4.eventos.desdobramentos[0].razao === 2);

/* ========================================================================
   MOEDA DOS ATIVOS: CRIPTO EM DOLAR, NUNCA EM REAIS

   O Marcelo pediu confirmacao explicita disso, entao fica travado em teste
   em vez de so ficar certo por enquanto. Misturar as duas moedas na mesma
   coluna nao daria erro nenhum: BTC a 109 mil e plausivel em dolar e
   plausivel em reais, e a variacao percentual continuaria parecendo certa.
   So o valor absoluto estaria errado, em 5 vezes.
   ======================================================================== */

function respostaSimples({ currency, closes }) {
  const base = Math.floor(Date.parse("2026-10-20T13:00:00Z") / 1000);
  return {
    chart: {
      result: [{
        meta: { symbol: "X", currency, gmtoffset: -10800, regularMarketTime: base + 86400 * 10 },
        timestamp: closes.map((_, i) => base + 86400 * i),
        indicators: {
          quote: [{
            open:  closes.map((c) => c),
            high:  closes.map((c) => c),
            low:   closes.map((c) => c),
            close: closes.map((c) => c),
            volume: closes.map(() => 1000),
          }],
        },
      }],
      error: null,
    },
  };
}

{
  // Captura a URL que o provedor monta, para provar o sufixo do simbolo.
  let urlVista = null;
  globalThis.fetch = async (u) => {
    urlVista = String(u);
    return { ok: true, status: 200, json: async () => respostaSimples({ currency: "USD", closes: [100, 101, 102] }) };
  };

  const r = await yahoo.daily("BTC", "cripto", { range: "5d" });
  ok("cripto vira BTC-USD no simbolo do Yahoo",
     /BTC-USD/.test(urlVista), `url: ${urlVista}`);
  ok("cripto NAO leva o sufixo .SA das acoes da B3", !/\.SA/.test(urlVista));
  ok("cripto volta em USD", r.currency === "USD", `veio ${r.currency}`);
}

{
  // Acao da B3 segue em reais e com o sufixo .SA.
  let urlVista = null;
  globalThis.fetch = async (u) => {
    urlVista = String(u);
    return { ok: true, status: 200, json: async () => respostaSimples({ currency: "BRL", closes: [30, 31, 32] }) };
  };
  const r = await yahoo.daily("PETR4", "b3", { range: "5d" });
  ok("acao da B3 leva sufixo .SA", /PETR4\.SA/.test(urlVista), `url: ${urlVista}`);
  ok("acao da B3 volta em BRL", r.currency === "BRL", `veio ${r.currency}`);
}

{
  // Cambio e indice nao levam sufixo nenhum: o ticker ja e o simbolo.
  let urlVista = null;
  globalThis.fetch = async (u) => {
    urlVista = String(u);
    return { ok: true, status: 200, json: async () => respostaSimples({ currency: "BRL", closes: [5.4, 5.41, 5.42] }) };
  };
  await yahoo.daily("USDBRL=X", "cambio", { range: "5d" });
  ok("cambio vai sem sufixo, so codificado na URL",
     /USDBRL(%3D|=)X/.test(urlVista) && !/-USD/.test(urlVista) && !/\.SA/.test(urlVista),
     `url: ${urlVista}`);

  await yahoo.daily("^BVSP", "indice", { range: "5d" });
  ok("indice vai sem sufixo", /(%5E|\^)BVSP/.test(urlVista) && !/\.SA/.test(urlVista),
     `url: ${urlVista}`);
}

{
  // FURO CONHECIDO, documentado de proposito.
  //
  // O codigo e `meta.currency || (cripto ? "USD" : "BRL")`. O fallback esta
  // certo, mas o meta GANHA dele. Como pedimos BTC-USD, o Yahoo responde USD
  // e na pratica nunca da problema. Mas se um dia ele responder outra moeda,
  // nos gravamos essa moeda numa linha de cripto sem reclamar.
  //
  // Este teste afirma o comportamento ATUAL, nao o desejado. Se o Marcelo
  // mandar forcar USD para cripto, este teste muda junto.
  globalThis.fetch = async () => ({
    ok: true, status: 200,
    json: async () => respostaSimples({ currency: "BRL", closes: [100, 101, 102] }),
  });
  const r = await yahoo.daily("BTC", "cripto", { range: "5d" });
  ok("FURO: se o Yahoo disser BRL numa cripto, o codigo hoje aceita",
     r.currency === "BRL",
     "comportamento atual; forcar USD e decisao do Marcelo");
}

console.log(falhas === 0 ? "\nTODOS OS TESTES PASSARAM" : `\n${falhas} TESTE(S) FALHARAM`);
process.exit(falhas === 0 ? 0 : 1);
