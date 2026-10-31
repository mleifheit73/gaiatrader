/*
 * METODO DO GAIA TRADER
 *
 * Porte fiel do codigo do artefato. A especificacao esta em METODO.md.
 *
 * REGRA DESTE ARQUIVO: fidelidade acima de elegancia. Onde o artefato faz
 * algo incomum, nos fazemos igual e explicamos por que num comentario. Um
 * indicador "melhorado" aqui produziria numeros diferentes dos que o Marcelo
 * ve no artefato, e a primeira divergencia destruiria a confianca na base.
 *
 * As peculiaridades que um porte descuidado erraria estao marcadas com
 * PECULIARIDADE. Cada uma tem teste correspondente em testes/metodo.test.mjs.
 */

/* ========================================================================
   MEDIAS
   ======================================================================== */

/**
 * Media aritmetica simples das ultimas n. Null enquanto nao ha periodo cheio.
 */
export function sma(a, n) {
  return a.map((_, i) => {
    if (i < n - 1) return null;
    let s = 0;
    for (let j = i - n + 1; j <= i; j++) s += a[j];
    return s / n;
  });
}

/**
 * Media exponencial.
 *
 * PECULIARIDADE: a semente e o PRIMEIRO valor da serie, nao uma media simples
 * dos n primeiros. Por isso a EMA tem valor desde a primeira barra, sem
 * periodo de aquecimento, ao contrario da SMA. Isso faz as primeiras dezenas
 * de valores serem imprecisos, e e justamente por isso que a leitura tecnica
 * exige 85 candles antes de existir.
 *
 * PECULIARIDADE: entrada nula empurra null na saida e NAO atualiza o estado.
 */
export function ema(a, n) {
  const k = 2 / (n + 1);
  const o = [];
  let p = null;
  for (let i = 0; i < a.length; i++) {
    const v = a[i];
    if (v == null) { o.push(null); continue; }
    p = p == null ? v : v * k + p * (1 - k);
    o.push(p);
  }
  return o;
}

/** Media simples que exige a janela cheia E sem nulos. Usada sobre series derivadas. */
export function smaN(a, n) {
  return a.map((_, i) => {
    const w = a.slice(Math.max(0, i - n + 1), i + 1);
    if (w.length < n || w.some((x) => x == null)) return null;
    return w.reduce((s, x) => s + x, 0) / n;
  });
}

/* ========================================================================
   OSCILADORES
   ======================================================================== */

/**
 * Indice de forca relativa, suavizacao de Wilder.
 *
 * PECULIARIDADE: quando nao ha perdas na janela o resultado e 100, inclusive
 * numa serie totalmente parada, em que nao ha nem ganhos nem perdas. A
 * convencao mais comum devolveria 50 nesse caso. Seguimos o artefato.
 */
export function rsi(c, n = 14) {
  const o = Array(c.length).fill(null);
  let g = 0, l = 0;
  for (let i = 1; i < c.length; i++) {
    const d = c[i] - c[i - 1];
    const G = Math.max(d, 0), L = Math.max(-d, 0);
    if (i <= n) {
      g += G; l += L;
      if (i === n) { g /= n; l /= n; o[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l); }
    } else {
      g = (g * (n - 1) + G) / n;
      l = (l * (n - 1) + L) / n;
      o[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
    }
  }
  return o;
}

/** Estocastico. O artefato usa 14, 1, 3 na tela. */
export function stoch(h, l, c, n = 14, sk = 3, sd = 3) {
  const raw = c.map((v, i) => {
    if (i < n - 1) return null;
    let hh = -Infinity, ll = Infinity;
    for (let j = i - n + 1; j <= i; j++) { hh = Math.max(hh, h[j]); ll = Math.min(ll, l[j]); }
    return hh === ll ? 50 : 100 * (v - ll) / (hh - ll);
  });
  const k = smaN(raw, sk);
  return { k, d: smaN(k, sd) };
}

/**
 * MACD 12, 26, close, 9.
 *
 * PECULIARIDADE: a linha de sinal e a EMA de 9 aplicada ao TRECHO da serie a
 * partir do indice 25, nao a serie inteira com nulos no comeco. Como a nossa
 * EMA semeia com o primeiro valor, mudar isso mudaria todos os valores.
 */
export function macd(c) {
  const e12 = ema(c, 12), e26 = ema(c, 26);
  const m = c.map((_, i) => (i < 25 ? null : e12[i] - e26[i]));
  const sigRaw = ema(m.slice(25), 9);
  const sig = Array(25).fill(null).concat(sigRaw);
  return { m, sig, h: m.map((v, i) => (v == null || sig[i] == null ? null : v - sig[i])) };
}

/** Bandas de Bollinger. Desvio populacional (divide por n), nao amostral. */
export function boll(c, n = 20, m = 2) {
  const mid = sma(c, n);
  return mid.map((md, i) => {
    if (md == null) return null;
    let s = 0;
    for (let j = i - n + 1; j <= i; j++) s += (c[j] - md) ** 2;
    const sd = Math.sqrt(s / n);
    return { mid: md, up: md + m * sd, lo: md - m * sd };
  });
}

/** On Balance Volume. Comeca em zero na primeira barra. */
export function obv(c, v) {
  const o = [0];
  for (let i = 1; i < c.length; i++) {
    o.push(o[i - 1] + (c[i] > c[i - 1] ? v[i] : c[i] < c[i - 1] ? -v[i] : 0));
  }
  return o;
}

/** SAR parabolico, passo 0,02 e teto 0,2. */
export function psar(h, l, step = 0.02, max = 0.2) {
  const n = h.length, o = Array(n).fill(null), up = Array(n).fill(true);
  if (n < 3) return { v: o, up };
  let bull = true, af = step, ep = h[0], sar = l[0];
  for (let i = 1; i < n; i++) {
    sar = sar + af * (ep - sar);
    if (bull) {
      sar = Math.min(sar, l[i - 1], i > 1 ? l[i - 2] : l[i - 1]);
      if (l[i] < sar) { bull = false; sar = ep; ep = l[i]; af = step; }
      else if (h[i] > ep) { ep = h[i]; af = Math.min(af + step, max); }
    } else {
      sar = Math.max(sar, h[i - 1], i > 1 ? h[i - 2] : h[i - 1]);
      if (h[i] > sar) { bull = true; sar = ep; ep = h[i]; af = step; }
      else if (l[i] < ep) { ep = l[i]; af = Math.min(af + step, max); }
    }
    o[i] = sar; up[i] = bull;
  }
  return { v: o, up };
}

/* ========================================================================
   PIVOS, FILTRO E SINAL
   ======================================================================== */

/**
 * Pivos confirmados.
 *
 * PECULIARIDADE: a comparacao e assimetrica. Para a esquerda exige MAIOR
 * (estrito); para a direita aceita MAIOR OU IGUAL. Num empate exato, o pivo
 * fica com a barra mais antiga. Trocar por simetria mudaria a contagem.
 *
 * So confirmados: precisa de N barras depois, entao as N ultimas nunca tem
 * pivo. E de proposito, um pivo nao confirmado pode desaparecer amanha.
 */
export function pivots(b, N) {
  const out = [];
  for (let i = N; i < b.length - N; i++) {
    let top = true, bot = true;
    for (let k = 1; k <= N; k++) {
      if (!(b[i].h > b[i - k].h && b[i].h >= b[i + k].h)) top = false;
      if (!(b[i].l < b[i - k].l && b[i].l <= b[i + k].l)) bot = false;
    }
    if (top) out.push({ i, t: "top", p: b[i].h });
    if (bot) out.push({ i, t: "bot", p: b[i].l });
  }
  return out;
}

/** Filtro de tendencia. As quatro condicoes sao obrigatorias juntas. */
export function eden(b, I, i) {
  const e8 = I.mme8, m80 = I.mm80;
  if (i < 1 || e8[i] == null || m80[i] == null || m80[i - 1] == null) return false;
  const c = b[i].c;
  return e8[i] > e8[i - 1] && m80[i] > m80[i - 1] && c > e8[i] && c > m80[i];
}

/**
 * Casas decimais do plano de risco, por mercado.
 *
 * O artefato fixa 2. Serve para a B3, onde 2 casas e o centavo, e destroi
 * cripto de preco baixo: uma entrada de R$ 0,0000245 arredondada para 2 casas
 * vira R$ 0,01, quatrocentas vezes o preco do ativo, com stop e alvo errados
 * na mesma proporcao. E nao daria erro nenhum: sairiam tres numeros plausiveis.
 */
export const casasDe = (market) => (market === "cripto" ? 8 : 2);

/**
 * Plano de risco de uma entrada.
 *
 * PECULIARIDADE: o ATR aqui e media ARITMETICA de 14 true ranges, nao a
 * suavizacao de Wilder que a maioria das plataformas usa. Valores diferem.
 *
 * PECULIARIDADE: o stop estrutural e o ultimo fundo confirmado MENOS um
 * centavo, nao o fundo exato. Um centavo abaixo evita ser estopado pelo toque.
 *
 * casas: quantas casas decimais arredondar. O artefato fixa 2, o que serve
 * para a B3 mas destroi cripto de preco baixo. Ver a nota em METODO.md.
 */
export function riskPlan(b, i, entry, pv, casas = 2) {
  let atrSoma = 0, k = 0;
  for (let j = Math.max(1, i - 13); j <= i; j++) {
    atrSoma += Math.max(
      b[j].h - b[j].l,
      Math.abs(b[j].h - b[j - 1].c),
      Math.abs(b[j].l - b[j - 1].c)
    );
    k++;
  }
  const atrValor = k ? atrSoma / k : 0;

  // Ultimo fundo confirmado abaixo da entrada. i+2 <= i atual garante
  // que o pivo ja estava confirmado naquele momento.
  let bot = null;
  for (let z = pv.length - 1; z >= 0; z--) {
    const q = pv[z];
    if (q.t === "bot" && q.i + 2 <= i && q.p < entry) { bot = q; break; }
  }

  const passo = 10 ** -casas;
  const arredonda = (x) => +x.toFixed(casas);
  const stop = bot ? arredonda(bot.p - passo) : arredonda(entry - 2 * atrValor);
  const target = arredonda(entry + 2 * (entry - stop));
  return { stop, target, atr: atrValor, structural: !!bot, bot };
}

/**
 * Candles sinal sobre a MME 9.
 *
 * PECULIARIDADE: 9.1, 9.2 e 9.3 sao avaliados em CADEIA com precedencia. Um
 * candle que serve para 9.1 nunca e marcado como 9.2, mesmo satisfazendo as
 * duas. O PFR e testado a parte e pode acumular com os outros.
 */
export function signals(b, I, casas = 2) {
  const out = [], e = I.ema9, pv = pivots(b, 2);
  for (let i = 2; i < b.length; i++) {
    const x = b[i], p = b[i - 1], q = b[i - 2], L = [];
    if (e[i] != null && e[i - 1] != null && e[i - 2] != null) {
      const subindoAgora = e[i] > e[i - 1], vinhaCaindo = e[i - 1] < e[i - 2];
      if (subindoAgora && vinhaCaindo) L.push("9.1");
      else if (subindoAgora && e[i - 1] > e[i - 2] && x.c < p.l) L.push("9.2");
      else if (subindoAgora && e[i - 1] > e[i - 2] && x.c < q.c && p.c < q.c && !(x.c < p.l)) L.push("9.3");
    }
    if (x.l < p.l && x.l < q.l && x.c > p.c) L.push("PFR");
    if (L.length) {
      const entry = +(x.h + 10 ** -casas).toFixed(casas);
      const rp = riskPlan(b, i, entry, pv, casas);
      out.push({ i, L, entry, stop: rp.stop, target: rp.target, structural: rp.structural });
    }
  }
  return out;
}

/* ========================================================================
   FORCA RELATIVA CONTRA O INDICE
   ======================================================================== */

/**
 * Diferenca de retorno contra o indice, em PONTOS PERCENTUAIS, nos ultimos n
 * pregoes. Positivo significa que a acao rendeu mais que o indice.
 *
 * Casa as series por data. Se qualquer das duas pontas faltar no indice,
 * devolve null em vez de inventar: serie incompleta produziria um numero
 * plausivel e errado, que e o defeito que mais nos custou ate aqui.
 */
export function relRet(bars, indice, n) {
  if (!bars || !indice || bars.length < n + 1) return null;
  const porData = new Map(indice.map((x) => [x.d, x.c]));
  const fim = bars[bars.length - 1];
  const ini = bars[bars.length - 1 - n];
  const iFim = porData.get(fim.d), iIni = porData.get(ini.d);
  if (!iFim || !iIni) return null;
  return ((fim.c / ini.c) - (iFim / iIni)) * 100;
}

/* ========================================================================
   CONJUNTO COMPLETO
   ======================================================================== */

/** Todos os indicadores que o artefato calcula, de uma vez. */
export function compute(b) {
  const c = b.map((x) => x.c), h = b.map((x) => x.h),
        l = b.map((x) => x.l), v = b.map((x) => x.v);
  const I = {
    ema9: ema(c, 9),
    mme8: ema(c, 8),
    mm21: sma(c, 21),
    mm80: sma(c, 80),
    ifr2: rsi(c, 2),
    ma9: sma(c, 9),
    ma90: sma(c, 90),
    ma200: sma(c, 200),
    bb: boll(c),
    rsi: rsi(c),
    st: stoch(h, l, c, 14, 1, 3),
    mc: macd(c),
    obv: obv(c, v),
    sar: psar(h, l),
  };
  I.obvMa = sma(I.obv, 20);
  I.vma = sma(v, 20);
  return I;
}

/** Minimo de candles para a leitura tecnica existir. */
export const MINIMO_CANDLES = 85;

/* ========================================================================
   VEREDITO

   As duas funcoes abaixo sao as regras de decisao, isoladas de proposito.
   Elas nao leem barras nem indicadores: recebem os sinalizadores ja
   apurados e devolvem a Situacao e a Pontuacao. Isoladas assim, dao para
   testar contra a especificacao do METODO.md sem montar uma serie inteira,
   e a tabela de verdade fica legivel.
   ======================================================================== */

/**
 * Situacao do ativo.
 *
 *   Setup     favor, com candle sinal e com risco aceitavel
 *   Observar  favor, mas sem sinal OU com stop a mais de 3 ATR
 *   Risco     sem favor, mas com candle sinal (o sinal existe, o contexto nao ajuda)
 *   Evitar    sem favor e sem sinal
 */
export function situacao(favor, temSinal, riskOk) {
  if (favor) return temSinal && riskOk ? "Setup" : "Observar";
  return temSinal ? "Risco" : "Evitar";
}

/**
 * Pontuacao de 0 a 7 na tela. O calculo vai de -5 a 7; a tela nao mostra
 * negativo porque Situacao "Evitar" ja comunica isso.
 *
 * PECULIARIDADE: forca relativa DESCONHECIDA (null) vale zero, nao -1. Nao
 * saber nao e o mesmo que estar mais fraco. E e por isso que, sem a serie do
 * Ibovespa, a pontuacao maxima real cai de 7 para 6.
 */
export function pontuacao({ ed, trend, frOk, acimaM200, temSinal, riskOk }) {
  let p = 0;
  p += ed ? 2 : -2;
  p += trend === "alta" ? 1 : trend === "baixa" ? -1 : 0;
  p += frOk == null ? 0 : frOk ? 1 : -1;
  p += acimaM200 == null ? 0 : acimaM200 ? 1 : -1;
  p += temSinal ? 1 : 0;
  p += riskOk ? 1 : 0;
  return p;
}

/**
 * Favor: o filtro de tendencia esta do nosso lado.
 *
 * PECULIARIDADE: forca relativa desconhecida NAO bloqueia. A condicao e
 * `frOk !== false`, nao `frOk === true`. Enquanto o Ibovespa nao estiver
 * carregado, frOk e null para as acoes da B3, e elas continuam podendo ser
 * Setup. Se isso fosse `=== true`, a tela ficaria sem nenhum Setup e
 * pareceria quebrada sem dar erro.
 */
export function aFavor(ed, trend, frOk) {
  return ed && trend !== "baixa" && frOk !== false;
}

/** Pontuacao maxima alcancavel, que cai para 6 sem a serie do indice. */
export const PONTUACAO_MAXIMA = 7;

/* ========================================================================
   ATIVOS DE CONTEXTO

   No artefato esta lista existe para que o indice e o cambio NAO virem
   linha do scanner. O comentario original e explicito sobre o cambio:

     "a serie diaria do Yahoo para cambio repete a abertura no fechamento
      (54% dos candles), o que invalida medias, IFR, pivos e a Leitura
      tecnica. Fica aqui so para nao virar linha do scanner."

   Por isso o Dolar tem `grafico: false`. Ele carrega, serve de contexto, e
   nao recebe parecer, leitura tecnica nem Situacao.
   ======================================================================== */

export const CONTEXTO = [
  { ticker: "^BVSP",     nome: "Ibovespa", grafico: true },
  { ticker: "USDBRL=X",  nome: "Dólar",    grafico: false },
];

const CONTEXTO_POR_TICKER = Object.fromEntries(CONTEXTO.map((x) => [x.ticker, x]));

/** O ativo e contexto (indice ou cambio), nao uma linha do scanner. */
export const ehContexto = (ticker) => !!CONTEXTO_POR_TICKER[ticker];

/* ========================================================================
   LEITURA TECNICA, classify()

   DIFERENCA DE ARQUITETURA, deliberada e necessaria:

   No artefato, `isCR()` le uma variavel global `MKT`, que e a aba de
   mercado que o usuario escolheu na tela. Funciona lá porque a tela mostra
   um mercado por vez. Aqui NAO funciona: a varredura noturna apura os 96
   ativos numa passada so. Se eu copiasse o global, as 20 criptos seriam
   avaliadas com a regra das acoes da B3 (forca relativa contra o Ibovespa
   em vez de preco acima da MM 200) e os numeros sairiam plausiveis e
   errados, sem erro nenhum na tela.

   Entao `isCR()` virou `alvo.market === "cripto"`, por ativo.
   ======================================================================== */

/**
 * Leitura tecnica de um ativo num candle.
 *
 * @param alvo   { ticker, market, bars, I } — barras e indicadores do compute()
 * @param nAt    indice do candle a avaliar; null usa o ultimo
 * @param opcoes { indice, casas }
 *               indice: barras do Ibovespa (com campo `d`), ou null
 *               casas:  casas decimais do plano de risco; 2 e o padrao do
 *                       artefato e so serve para a B3
 * @returns null quando nao ha base suficiente para uma leitura honesta
 */
export function classify(alvo, nAt = null, opcoes = {}) {
  const b = alvo.bars, I = alvo.I;
  const n = nAt == null ? (b ? b.length - 1 : -1) : nAt;

  // Sem base, devolve null em vez de uma leitura fraca. A tela mostra "–".
  if (!b || n < MINIMO_CANDLES || !I || I.mm80[n] == null || I.mm80[n - 1] == null) return null;

  // DIVERGENCIA DELIBERADA DO ARTEFATO.
  //
  // No artefato, a trava do Dolar fica na tela: classify() aceita ser chamado
  // nele, e e o botao do grafico que simplesmente nao existe. Aqui nao serve:
  // a varredura percorre os 96 ativos num laco, e um esquecimento produziria
  // leitura tecnica sobre dados que o proprio artefato declara invalidos para
  // medias, IFR e pivos. A trava desceu para ca, onde nao da para esquecer.
  const infoCtx = CONTEXTO_POR_TICKER[alvo.ticker];
  if (infoCtx && infoCtx.grafico === false) return null;

  const ehCripto = alvo.market === "cripto";
  const ctx = !!infoCtx;
  const casas = opcoes.casas != null ? opcoes.casas : casasDe(alvo.market);
  const indice = opcoes.indice || null;

  const x = b[n], c = x.c, bs = b.slice(0, n + 1);

  const e8 = I.mme8[n], e8p = I.mme8[n - 1];
  const m80 = I.mm80[n], m80p = I.mm80[n - 1];
  const e9 = I.ema9[n], e9p = I.ema9[n - 1];
  const m21 = I.mm21[n], m200 = I.ma200[n];

  // Filtro de tendencia, as quatro condicoes abertas porque a tela as mostra
  // uma por uma na checklist.
  const e8up = e8 > e8p, m80up = m80 > m80p;
  const above8 = c > e8, above80 = c > m80;
  const ed = e8up && m80up && above8 && above80;

  // Tendencia por pivos confirmados.
  //
  // PECULIARIDADE: sao QUATRO valores, nao tres. "indefinida" quando nao ha
  // dois topos ou dois fundos confirmados. Ela nao bloqueia o favor nem tira
  // ponto, igual a lateral, mas significa outra coisa: lateral e uma leitura,
  // indefinida e a ausencia de leitura.
  const pv = pivots(bs, 2);
  const T = pv.filter((z) => z.t === "top").slice(-2);
  const B = pv.filter((z) => z.t === "bot").slice(-2);
  const trend =
    T.length < 2 || B.length < 2 ? "indefinida"
    : T[1].p > T[0].p && B[1].p > B[0].p ? "alta"
    : T[1].p < T[0].p && B[1].p < B[0].p ? "baixa"
    : "lateral";
  const lastTop = T.length ? T[T.length - 1] : null;
  const lastBot = B.length ? B[B.length - 1] : null;

  // Forca relativa: so para acoes da B3. Cripto e contexto nao tem indice de
  // comparacao e usam preco acima da MM 200 no lugar, mais abaixo.
  let fr12 = null, fr3 = null;
  if (!ehCripto && !ctx && indice) {
    fr12 = relRet(bs, indice, 252);
    fr3 = relRet(bs, indice, 63);
  }
  const frOk = fr12 == null ? null : fr12 > 0;

  const favor = aFavor(ed, trend, frOk);

  // ATR da leitura: igual ao do artefato, media aritmetica de 14 true ranges
  // fixos de n-13 a n. Nao precisa de guarda porque n >= 85 aqui.
  let atr = 0;
  for (let i = n - 13; i <= n; i++) {
    atr += Math.max(b[i].h - b[i].l, Math.abs(b[i].h - b[i - 1].c), Math.abs(b[i].l - b[i - 1].c));
  }
  atr /= 14;

  const allSg = signals(bs, I, casas);
  const sg = allSg.filter((z) => z.i === n)[0] || null;

  let entry = null, stop = null, target = null, rr = null, stopAtr = null;
  let riskOk = false, refStop = false;
  if (sg) {
    entry = sg.entry; stop = sg.stop; target = sg.target;
    refStop = !sg.structural;
    const risco = entry - stop;
    stopAtr = atr ? risco / atr : null;
    rr = risco > 0 ? (target - entry) / risco : null;
    riskOk = stopAtr != null && stopAtr <= 3;
  }

  const ifr2 = I.ifr2[n], ifr14 = I.rsi[n];
  const volR = I.vma[n] ? x.v / I.vma[n] : null;

  const lab = situacao(favor, !!sg, riskOk);
  const sc = pontuacao({
    ed, trend, frOk,
    acimaM200: m200 != null ? c > m200 : null,
    temSinal: !!sg, riskOk,
  });

  /* ---- Checklist do filtro de tendencia ---------------------------------
     Quatro itens sempre, mais um quinto so para acoes da B3. O rotulo do
     quinto avisa "(carregando)" quando o Ibovespa ainda nao chegou, em vez
     de mostrar um X que pareceria uma reprovacao do ativo.               */
  const checksF = [
    ["MME 8 subindo", e8up],
    ["MM 80 subindo", m80up],
    ["Preço acima da MME 8 e da MM 80", above8 && above80],
    ["Pivôs em alta (topos e fundos mais altos)", trend === "alta"],
  ];
  if (!ehCripto && !ctx) {
    checksF.push([
      "Mais forte que o Ibovespa em 12 meses" + (fr12 == null ? " (carregando)" : ""),
      frOk === true,
    ]);
  }

  /* ---- Checklist de gatilho e risco -------------------------------------
     O volume entra na TERCEIRA posicao, antes do IFR 14, e so quando o ativo
     tem algum volume nos ultimos 20 candles. Ativo sem volume publicado nao
     ganha um item reprovado por falta de dado.                            */
  const checksG = [
    ["Candle sinal no último candle (9.1, 9.2, 9.3 ou PFR)", !!sg],
    ["Stop no último fundo (pivô) abaixo da entrada", !!sg && !refStop],
    ["Stop de até 3 ATR da entrada", !!sg && stopAtr != null && stopAtr <= 3],
    ["IFR 14 entre 40 e 70 (médio prazo saudável)", ifr14 != null && ifr14 >= 40 && ifr14 <= 70],
  ];
  if (b.slice(-20).some((z) => z.v > 0)) {
    checksG.splice(3, 0, ["Volume do último candle acima da média de 20", volR != null && volR > 1]);
  }

  /* ---- Barras de curto e medio prazo (0 a 5) ---------------------------- */
  const r2 = I.ifr2;
  const m200ok = m200 != null && c > m200;

  const cpL = [
    ["MME 9 subindo", e9 > e9p],
    ["Preço acima da MME 9", c > e9],
    ["Preço acima da MM 21", m21 != null && c > m21],
    ["IFR 2 saindo da sobrevenda ou subindo sem passar de 75",
      (r2[n] >= 25 && [n - 1, n - 2, n - 3].some((k) => r2[k] != null && r2[k] < 25))
      || (r2[n] > r2[n - 1] && r2[n] <= 75)],
    ["Candle sinal nos últimos 3 pregões", allSg.some((z) => z.i >= n - 2)],
  ];

  const mpL = [
    ["MME 8 subindo com o preço acima dela", e8up && above8],
    ["MM 80 subindo com o preço acima dela", m80up && above80],
    ["Pivôs em alta", trend === "alta"],
    ["IFR 14 entre 40 e 70", ifr14 != null && ifr14 >= 40 && ifr14 <= 70],
    (ehCripto || ctx)
      ? ["Preço acima da MM 200", m200ok]
      : ["Mais forte que o Ibovespa em 12 meses", frOk === true],
  ];

  const cpN = cpL.filter((z) => z[1]).length;
  const mpN = mpL.filter((z) => z[1]).length;

  return {
    cpL, mpL, cpN, mpN, n, x, c,
    e8, e8up, m80, m80up, above8, above80, ed,
    e9, e9up: e9 > e9p, m21, m200,
    trend, lastTop, lastBot, T, B,
    fr12, fr3, frOk, favor,
    atr, sg, entry, stop, refStop, target, rr, stopAtr, riskOk,
    ifr2, ifr14, volR,
    lab, sc, checksF, checksG,
  };
}
