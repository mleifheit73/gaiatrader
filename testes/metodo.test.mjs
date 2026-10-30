/*
 * Testes do metodo do artefato.
 *
 * O objetivo NAO e provar que a matematica e boa. E travar as peculiaridades,
 * para que ninguem (inclusive eu, numa sessao futura) "conserte" um indicador
 * e quebre a paridade com o artefato sem o teste gritar.
 */
import {
  sma, ema, smaN, rsi, stoch, macd, boll, obv, psar,
  pivots, eden, riskPlan, signals, relRet, compute,
  situacao, pontuacao, aFavor,
} from "../src/metodo.js";

let falhas = 0;
const quase = (a, b, tol = 1e-6) => a !== null && Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));
function ok(nome, cond, extra = "") {
  console.log(`${cond ? "PASSOU" : "FALHOU"}  ${nome}${extra ? "  " + extra : ""}`);
  if (!cond) falhas++;
}

/* ---- SMA ---------------------------------------------------------------- */

{
  const r = sma([1, 2, 3, 4, 5], 3);
  ok("sma devolve null antes da janela cheia", r[0] === null && r[1] === null);
  ok("sma calcula a media da janela", quase(r[2], 2) && quase(r[4], 4));
}

/* ---- EMA: a peculiaridade mais importante ------------------------------- */

{
  const r = ema([10, 11, 12], 3); // k = 0,5
  ok("ema tem valor na PRIMEIRA barra (semeada com o primeiro valor)", r[0] === 10,
     `esperado 10, veio ${r[0]}`);
  ok("ema segue a recorrencia padrao depois da semente",
     quase(r[1], 10.5) && quase(r[2], 11.25), `[${r.join(", ")}]`);
}

{
  const r = ema([10, null, 12], 3);
  ok("ema devolve null para entrada nula", r[1] === null);
  ok("ema NAO avanca o estado em entrada nula", quase(r[2], 11),
     `esperado 11 (0,5*12 + 0,5*10), veio ${r[2]}`);
}

{
  // Prova de que a semente NAO e uma SMA dos n primeiros. Se fosse, o indice
  // n-1 valeria a media simples. Aqui a serie sobe em degrau.
  const r = ema([0, 0, 0, 100], 4);
  ok("ema nao usa SMA como semente", !quase(r[3], 25), `veio ${r[3]}`);
}

/* ---- RSI ---------------------------------------------------------------- */

{
  const r = rsi([10, 11, 10, 11], 2);
  ok("rsi null antes do periodo", r[0] === null && r[1] === null);
  ok("rsi inicializa com media aritmetica no indice n", quase(r[2], 50), `veio ${r[2]}`);
  ok("rsi suaviza por Wilder depois", quase(r[3], 75), `esperado 75, veio ${r[3]}`);
}

{
  const parada = rsi([5, 5, 5, 5, 5], 2);
  ok("rsi de serie PARADA devolve 100, nao 50 (peculiaridade do artefato)",
     parada[4] === 100, `veio ${parada[4]}`);
}

{
  const soSobe = rsi(Array.from({ length: 20 }, (_, i) => 10 + i), 14);
  ok("rsi sem perdas devolve 100", soSobe[19] === 100, `veio ${soSobe[19]}`);
}

/* ---- Bollinger: desvio populacional ------------------------------------- */

{
  const c = [2, 4, 4, 4, 5, 5, 7, 9]; // media 5, desvio populacional 2
  const r = boll(c, 8, 1);
  ok("boll usa desvio POPULACIONAL (divide por n)",
     quase(r[7].up, 7) && quase(r[7].lo, 3), `up ${r[7].up} lo ${r[7].lo}`);
}

/* ---- Pivos: assimetria do desempate ------------------------------------- */

{
  const b = [
    { h: 10, l: 5 }, { h: 12, l: 5 }, { h: 12, l: 5 }, { h: 10, l: 5 },
  ];
  const p = pivots(b, 1).filter((x) => x.t === "top");
  ok("pivo de topo em empate fica com a barra MAIS ANTIGA",
     p.length === 1 && p[0].i === 1, JSON.stringify(p));
}

{
  const b = Array.from({ length: 9 }, (_, i) => ({ h: 10, l: 10 }));
  b[4] = { h: 20, l: 1 }; // topo e fundo no meio
  const p = pivots(b, 2);
  ok("pivo confirmado precisa de N barras depois", p.every((x) => x.i <= b.length - 1 - 2));
  ok("as ultimas N barras nunca tem pivo", !p.some((x) => x.i > b.length - 1 - 2));
  ok("topo e fundo sao detectados na mesma barra", p.filter((x) => x.i === 4).length === 2);
}

/* ---- Filtro de tendencia ------------------------------------------------ */

{
  // Serie que sobe de verdade: MME8 e MM80 ambas subindo, preco acima das duas.
  const barras = Array.from({ length: 120 }, (_, i) => ({ c: 100 + i, h: 100 + i, l: 100 + i, v: 1000 }));
  const I = compute(barras);
  ok("eden aceita tendencia de alta limpa", eden(barras, I, 119) === true);

  const paradas = Array.from({ length: 120 }, () => ({ c: 100, h: 100, l: 100, v: 1000 }));
  const J = compute(paradas);
  ok("eden recusa serie parada", eden(paradas, J, 119) === false);

  ok("eden recusa quando falta MM80", eden(barras, I, 50) === false,
     "indice 50 nao tem MM80");
}

/* ---- ATR: media aritmetica, nao Wilder ---------------------------------- */

{
  // 14 barras com TR 1 e a ultima com TR 15. Media aritmetica = 28/14 = 2.
  const b = Array.from({ length: 15 }, () => ({ h: 10.5, l: 9.5, c: 10 }));
  b[14] = { h: 17.5, l: 2.5, c: 10 };
  const rp = riskPlan(b, 14, 17.51, []);
  ok("atr e media ARITMETICA de 14 true ranges, nao Wilder",
     quase(rp.atr, 2), `esperado 2, veio ${rp.atr}`);
}

/* ---- Plano de risco ----------------------------------------------------- */

{
  const b = Array.from({ length: 15 }, () => ({ h: 10.5, l: 9.5, c: 10 }));
  const pv = [{ i: 3, t: "bot", p: 9.0 }];
  const rp = riskPlan(b, 14, 11.0, pv);
  ok("stop estrutural e o fundo confirmado MENOS um centavo", rp.stop === 8.99, `veio ${rp.stop}`);
  ok("stop estrutural e marcado como structural", rp.structural === true);
  ok("alvo e entrada mais 2x o risco", rp.target === 15.02,
     `11 + 2*(11-8,99) = 15,02, veio ${rp.target}`);
}

{
  const b = Array.from({ length: 15 }, () => ({ h: 10.5, l: 9.5, c: 10 }));
  const rp = riskPlan(b, 14, 11.0, []); // sem pivo
  ok("sem pivo abaixo da entrada, o stop vira entrada menos 2 ATR",
     rp.stop === 9.0 && rp.structural === false, `stop ${rp.stop} atr ${rp.atr}`);
}

{
  const b = Array.from({ length: 15 }, () => ({ h: 10.5, l: 9.5, c: 10 }));
  const pv = [{ i: 13, t: "bot", p: 9.0 }]; // i+2 = 15 > 14: ainda nao confirmado
  const rp = riskPlan(b, 14, 11.0, pv);
  ok("pivo ainda nao confirmado e ignorado", rp.structural === false);
}

{
  const b = Array.from({ length: 15 }, () => ({ h: 10.5, l: 9.5, c: 10 }));
  const pv = [{ i: 3, t: "bot", p: 12.0 }]; // acima da entrada
  const rp = riskPlan(b, 14, 11.0, pv);
  ok("pivo acima da entrada e ignorado", rp.structural === false);
}

/* ---- Precisao: o defeito do artefato em cripto de preco baixo ----------- */

{
  const b = Array.from({ length: 15 }, () => ({ h: 0.0000245, l: 0.0000240, c: 0.0000242 }));
  const comDuasCasas = riskPlan(b, 14, +(0.0000245 + 0.01).toFixed(2), [], 2);
  ok("DEFEITO CONHECIDO: duas casas destroem cripto de preco baixo",
     comDuasCasas.stop === 0.01 || comDuasCasas.stop === 0,
     `stop ${comDuasCasas.stop} para um ativo que vale 0,0000242`);

  const s = signals(b, { ema9: Array(15).fill(1) }, 8);
  ok("com casas=8 a entrada fica na escala do ativo",
     s.length === 0 || s[0].entry < 0.001, JSON.stringify(s[0] || {}));
}

/* ---- Candles sinal: precedencia da cadeia ------------------------------- */

{
  // EMA9 que vinha caindo e virou: 9.1. O candle tambem fecha abaixo da
  // minima anterior, o que serviria para 9.2. A cadeia deve dar SO 9.1.
  const b = [
    { h: 10, l: 9, c: 9.5, o: 9.5, v: 1 },
    { h: 11, l: 10, c: 10.5, o: 10.5, v: 1 },
    { h: 12, l: 9.8, c: 9.9, o: 11, v: 1 },
  ];
  const I = { ema9: [10, 9, 9.5] }; // caiu, depois subiu: upNow e wasDn
  const s = signals(b, I);
  const sinal = s.find((x) => x.i === 2);
  ok("9.1 tem precedencia sobre 9.2 na cadeia",
     sinal && sinal.L.includes("9.1") && !sinal.L.includes("9.2"),
     JSON.stringify(sinal));
}

{
  // PFR: minima menor que as duas anteriores e fechamento acima do anterior.
  const b = [
    { h: 10, l: 9, c: 9.5, v: 1 },
    { h: 10, l: 9, c: 9.5, v: 1 },
    { h: 10, l: 8, c: 9.6, v: 1 },
  ];
  const s = signals(b, { ema9: [5, 5, 5] }); // EMA plana: nenhum 9.x
  const sinal = s.find((x) => x.i === 2);
  ok("PFR e detectado independente da MME9", sinal && sinal.L.includes("PFR"),
     JSON.stringify(sinal));
}

{
  const b = [
    { h: 10, l: 9, c: 9.5, v: 1 },
    { h: 11, l: 10, c: 10.5, v: 1 },
    { h: 12, l: 8, c: 10.6, v: 1 },
  ];
  const s = signals(b, { ema9: [10, 9, 9.5] });
  const sinal = s.find((x) => x.i === 2);
  ok("9.1 e PFR podem acumular no mesmo candle",
     sinal && sinal.L.includes("9.1") && sinal.L.includes("PFR"), JSON.stringify(sinal));
}

{
  const b = [
    { h: 10, l: 9, c: 9.5, v: 1 },
    { h: 11, l: 10, c: 10.5, v: 1 },
    { h: 12.34, l: 10, c: 11, v: 1 },
  ];
  const s = signals(b, { ema9: [10, 9, 9.5] });
  ok("entrada e a maxima do candle mais um centavo", s[0] && s[0].entry === 12.35,
     `veio ${s[0] && s[0].entry}`);
}

/* ---- Forca relativa ----------------------------------------------------- */

{
  const acao = [{ d: "2026-01-01", c: 100 }, { d: "2026-01-02", c: 110 }];
  const idx = [{ d: "2026-01-01", c: 100 }, { d: "2026-01-02", c: 105 }];
  ok("forca relativa e a diferenca de retorno em pontos percentuais",
     quase(relRet(acao, idx, 1), 5), `veio ${relRet(acao, idx, 1)}`);
}

{
  const acao = [{ d: "2026-01-01", c: 100 }, { d: "2026-01-02", c: 110 }];
  const furado = [{ d: "2026-01-02", c: 105 }]; // falta a ponta inicial
  ok("forca relativa devolve null se o indice nao cobre as duas pontas",
     relRet(acao, furado, 1) === null);
  ok("forca relativa devolve null sem indice", relRet(acao, null, 1) === null);
  ok("forca relativa devolve null com historico curto", relRet(acao, acao, 300) === null);
}

/* ---- Conjunto completo -------------------------------------------------- */

{
  const b = Array.from({ length: 260 }, (_, i) => ({
    d: `d${i}`, o: 100 + i, h: 101 + i, l: 99 + i, c: 100 + i, v: 1000 + i,
  }));
  const I = compute(b);
  const esperados = ["ema9", "mme8", "mm21", "mm80", "ifr2", "ma9", "ma90", "ma200",
                     "bb", "rsi", "st", "mc", "obv", "sar", "obvMa", "vma"];
  const faltando = esperados.filter((k) => !(k in I));
  ok("compute devolve todos os indicadores do artefato", faltando.length === 0,
     faltando.length ? `faltam: ${faltando.join(", ")}` : "16 indicadores");
  ok("obvMa e a media de 20 do OBV", I.obvMa[259] !== null);
  ok("estocastico devolve k e d", I.st.k && I.st.d && I.st.k[259] !== null);
  ok("macd devolve linha, sinal e histograma",
     I.mc.m[259] !== null && I.mc.sig[259] !== null && I.mc.h[259] !== null);
  ok("psar devolve valor e direcao", I.sar.v[259] !== null && typeof I.sar.up[259] === "boolean");
  ok("psar marca alta numa serie que sobe", I.sar.up[259] === true);
}

/* ---- Guardas de robustez ------------------------------------------------ */

{
  ok("compute aguenta serie curta sem estourar", (() => {
    try { compute([{ o: 1, h: 1, l: 1, c: 1, v: 1 }]); return true; } catch { return false; }
  })());
  ok("pivots aguenta serie menor que a janela", pivots([{ h: 1, l: 1 }], 2).length === 0);
  ok("psar aguenta serie de duas barras", psar([1, 2], [1, 2]).v.length === 2);
}

/* ---- Situacao: tabela de verdade completa ------------------------------- */

{
  // Quatro situacoes, oito combinacoes. Escrito a partir do METODO.md, nao
  // do codigo, para que especificacao e porte se confiram um ao outro.
  const casos = [
    // favor  sinal  riskOk  esperado
    [true,    true,  true,   "Setup"],
    [true,    true,  false,  "Observar"], // sinal existe mas o stop e largo
    [true,    false, true,   "Observar"],
    [true,    false, false,  "Observar"],
    [false,   true,  true,   "Risco"],    // sem favor, o sinal nao promove
    [false,   true,  false,  "Risco"],
    [false,   false, true,   "Evitar"],
    [false,   false, false,  "Evitar"],
  ];
  let erros = 0;
  for (const [favor, sinal, risco, esperado] of casos) {
    const veio = situacao(favor, sinal, risco);
    if (veio !== esperado) {
      erros++;
      console.log(`   favor=${favor} sinal=${sinal} riskOk=${risco}: esperado ${esperado}, veio ${veio}`);
    }
  }
  ok("situacao cobre as 8 combinacoes da tabela de verdade", erros === 0);
  ok("riskOk nunca promove para Setup sem sinal", situacao(true, false, true) === "Observar");
  ok("sinal nunca promove para Setup sem favor", situacao(false, true, true) === "Risco");
}

/* ---- Pontuacao ---------------------------------------------------------- */

{
  const cheio = { ed: true, trend: "alta", frOk: true, acimaM200: true, temSinal: true, riskOk: true };
  ok("pontuacao maxima e 7", pontuacao(cheio) === 7, `veio ${pontuacao(cheio)}`);

  const vazio = { ed: false, trend: "baixa", frOk: false, acimaM200: false, temSinal: false, riskOk: false };
  ok("pontuacao minima e -5", pontuacao(vazio) === -5, `veio ${pontuacao(vazio)}`);

  ok("o filtro de tendencia pesa 2, nao 1",
     pontuacao({ ...cheio, ed: false }) === 3, `veio ${pontuacao({ ...cheio, ed: false })}`);
  ok("tendencia lateral vale zero",
     pontuacao({ ...cheio, trend: "lateral" }) === 6);
  ok("tendencia de baixa vale -1",
     pontuacao({ ...cheio, trend: "baixa" }) === 5);
}

{
  const base = { ed: true, trend: "alta", frOk: true, acimaM200: true, temSinal: true, riskOk: true };
  ok("forca relativa DESCONHECIDA vale zero, nao -1",
     pontuacao({ ...base, frOk: null }) === 6,
     `esperado 6, veio ${pontuacao({ ...base, frOk: null })}`);
  ok("forca relativa mais fraca vale -1",
     pontuacao({ ...base, frOk: false }) === 5);
  ok("sem a serie do indice, o maximo real cai para 6",
     pontuacao({ ...base, frOk: null }) === 6);
  ok("MM 200 ausente vale zero",
     pontuacao({ ...base, acimaM200: null }) === 6);
}

/* ---- Favor: o null que nao bloqueia ------------------------------------- */

{
  ok("favor exige o filtro de tendencia", aFavor(false, "alta", true) === false);
  ok("favor recusa tendencia de baixa por pivos", aFavor(true, "baixa", true) === false);
  ok("favor aceita tendencia lateral", aFavor(true, "lateral", true) === true);
  ok("forca relativa DESCONHECIDA nao bloqueia o favor",
     aFavor(true, "alta", null) === true,
     "senao a tela ficaria sem nenhum Setup enquanto o Ibovespa nao carregar");
  ok("forca relativa mais fraca bloqueia o favor", aFavor(true, "alta", false) === false);
}

console.log(falhas === 0 ? "\nTODOS OS TESTES PASSARAM" : `\n${falhas} TESTE(S) FALHARAM`);
process.exit(falhas === 0 ? 0 : 1);
