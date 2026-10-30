import { mediaMovel, mma, ifr, atr, liquidezMedia, leituraAtual } from "../src/indicadores.js";

let falhas = 0;
const quase = (a, b, tol = 1e-6) => a !== null && Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));
function ok(nome, cond, extra = "") {
  console.log(`${cond ? "PASSOU" : "FALHOU"}  ${nome}${extra ? "  " + extra : ""}`);
  if (!cond) falhas++;
}

const barra = (c, h, l, v = 1000, partial = 0) => ({ d: "2026-01-01", o: c, h, l, c, v, partial });
const serie = (fechamentos) => fechamentos.map((c) => barra(c, c + 1, c - 1));

// ---------------------------------------------------------------------------
// 1. SEM BASE, SEM NUMERO. A regra que vale para tudo.
// ---------------------------------------------------------------------------
const curta = serie([10, 11, 12]);
ok("MMA de 200 sobre 3 pregoes devolve so nulos", mma(curta, 200).every((x) => x === null));
ok("IFR de 14 sobre 3 pregoes devolve so nulos", ifr(curta, 14).every((x) => x === null));
ok("ATR de 14 sobre 3 pregoes devolve so nulos", atr(curta, 14).every((x) => x === null));
ok("o vetor devolvido tem o mesmo tamanho da entrada", mma(curta, 200).length === 3);

const m3 = mma(serie([10, 20, 30, 40]), 3);
ok("MMA so comeca quando ha periodo completo", m3[0] === null && m3[1] === null);
ok("MMA no primeiro ponto valido", quase(m3[2], 20), `deu ${m3[2]}`);
ok("MMA desliza corretamente", quase(m3[3], 30), `deu ${m3[3]}`);

// ---------------------------------------------------------------------------
// 2. MEDIA MOVEL: precisao, inclusive com numeros que nao fecham redondo
// ---------------------------------------------------------------------------
const mm = mediaMovel([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 4);
ok("media de 1,2,3,4", quase(mm[3], 2.5));
ok("media de 7,8,9,10", quase(mm[9], 8.5));
ok("MMA de periodo 1 e o proprio valor", mediaMovel([5, 7, 9], 1).every((x, i) => quase(x, [5, 7, 9][i])));

// Soma deslizante nao pode acumular erro ao longo de uma serie longa.
const longa = Array.from({ length: 3000 }, (_, i) => 100 + Math.sin(i) * 10);
const mmLonga = mediaMovel(longa, 200);
const conferencia = longa.slice(2800, 3000).reduce((a, b) => a + b, 0) / 200;
ok("sem acumulo de erro em 3.000 pontos", quase(mmLonga[2999], conferencia, 1e-9),
   `deu ${mmLonga[2999]?.toFixed(10)}, esperado ${conferencia.toFixed(10)}`);

// ---------------------------------------------------------------------------
// 3. IFR: os extremos conhecidos
// ---------------------------------------------------------------------------
const soSobe = serie([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
ok("serie so de alta: IFR = 100", quase(ifr(soSobe, 14).at(-1), 100));

const soCai = serie([16, 15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
ok("serie so de baixa: IFR = 0", quase(ifr(soCai, 14).at(-1), 0));

const parada = serie(new Array(20).fill(10));
ok("serie parada: IFR = 50, nao 100", quase(ifr(parada, 14).at(-1), 50), `deu ${ifr(parada, 14).at(-1)}`);

// IFR de 2, que o setup usa, precisa reagir rapido.
const quedaForte = serie([10, 10, 10, 10, 10, 9, 8]);
const i2 = ifr(quedaForte, 2);
ok("IFR de 2 so comeca no 3o pregao", i2[0] === null && i2[1] === null && i2[2] !== null);
ok("IFR de 2 afunda em duas quedas seguidas", i2.at(-1) < 5, `deu ${i2.at(-1)?.toFixed(2)}`);

// IFR fica sempre dentro da faixa.
const vaiEVem = serie([10, 12, 9, 14, 8, 15, 11, 13, 10, 16, 9, 12, 14, 10, 13, 11, 15, 9]);
ok("IFR nunca sai da faixa de 0 a 100",
   ifr(vaiEVem, 14).filter((x) => x !== null).every((x) => x >= 0 && x <= 100));

// ---------------------------------------------------------------------------
// 4. ATR: o gap de abertura PRECISA contar
// Um papel que abre muito abaixo e fica parado tem amplitude quase zero no dia,
// mas o risco aumentou. Sem contar o gap, o stop sairia absurdamente apertado
// justo no dia mais perigoso.
// ---------------------------------------------------------------------------
const semGap = [];
for (let i = 0; i < 20; i++) semGap.push(barra(10, 11, 9));
ok("amplitude constante: ATR = a amplitude", quase(atr(semGap, 14).at(-1), 2), `deu ${atr(semGap, 14).at(-1)}`);

const comGap = [];
for (let i = 0; i < 20; i++) comGap.push(barra(10, 10.05, 9.95));
comGap.push({ d: "2026-01-21", o: 5, h: 5.05, l: 4.95, c: 5, v: 1000, partial: 0 });
const atrComGap = atr(comGap, 14).at(-1);
const atrSemGap = atr(comGap.slice(0, 20), 14).at(-1);
ok("gap de abertura aumenta o ATR", atrComGap > atrSemGap * 2,
   `antes ${atrSemGap.toFixed(3)}, depois ${atrComGap.toFixed(3)}`);
ok("ATR nunca e negativo", atr(vaiEVem, 14).filter((x) => x !== null).every((x) => x >= 0));

// ---------------------------------------------------------------------------
// 5. LIQUIDEZ EM DINHEIRO, nao em quantidade
// Um milhao de acoes de R$ 2 e um milhao de acoes de R$ 200 sao negocios de
// tamanhos completamente diferentes.
// ---------------------------------------------------------------------------
const barato = Array.from({ length: 25 }, () => barra(2, 2.1, 1.9, 1_000_000));
const caro = Array.from({ length: 25 }, () => barra(200, 201, 199, 1_000_000));
// barra(c, h, l, v): preco tipico = (h + l + c) / 3
ok("liquidez usa o preco tipico, nao o fechamento",
   quase(liquidezMedia(barato, 21).at(-1), ((2.1 + 1.9 + 2) / 3) * 1_000_000));
ok("liquidez do papel caro e cerca de 100x maior",
   quase(liquidezMedia(caro, 21).at(-1), ((201 + 199 + 200) / 3) * 1_000_000));

// Num dia de amplitude grande, fechamento e preco tipico divergem de verdade.
const diaVolatil = Array.from({ length: 25 }, () => barra(53.88, 54.23, 51.17, 141_338_400));
const porTipico = liquidezMedia(diaVolatil, 21).at(-1);
const porFechamento = 53.88 * 141_338_400;
ok("em dia de 6% de amplitude os dois metodos divergem acima de 1%",
   Math.abs(porTipico / porFechamento - 1) > 0.01,
   `${((porTipico / porFechamento - 1) * 100).toFixed(2)}%`);
// Em cripto o provedor ja entrega o volume EM DINHEIRO. Multiplicar pelo preco
// conta o preco duas vezes: foi assim que o BTC saiu com 2 quatrilhoes por dia
// e o SHIB, cujo preco e 0,00001, saiu com R$ 277.
const cripto = Array.from({ length: 25 }, () => barra(76000, 77000, 75000, 44_000_000_000));
ok("cripto: volume ja financeiro nao e multiplicado pelo preco",
   quase(liquidezMedia(cripto, 21, true).at(-1), 44_000_000_000));
ok("cripto: sem a correcao o numero fica absurdo",
   liquidezMedia(cripto, 21, false).at(-1) > 1e14);

const shib = Array.from({ length: 25 }, () => barra(0.00001, 0.000011, 0.000009, 500_000_000));
ok("moeda de preco minusculo nao vira liquidez ridicula",
   quase(liquidezMedia(shib, 21, true).at(-1), 500_000_000));

ok("filtro de R$ 5 milhoes separa os dois",
   liquidezMedia(barato, 21).at(-1) < 5e6 && liquidezMedia(caro, 21).at(-1) > 5e6);

// ---------------------------------------------------------------------------
// 6. LEITURA DO RASTREAMENTO
// ---------------------------------------------------------------------------
const base250 = Array.from({ length: 250 }, (_, i) => barra(100 + i * 0.1, 101 + i * 0.1, 99 + i * 0.1, 500_000));
const leitura = base250.length ? leituraAtual(base250) : null;
ok("com 250 pregoes a MMA de 200 existe", leitura.mma_longa !== null);
ok("com 250 pregoes o IFR, o ATR e a liquidez existem",
   leitura.ifr_curto !== null && leitura.ifr_longo !== null &&
   leitura.atr !== null && leitura.liquidez_media !== null);
ok("a leitura informa quantos pregoes serviram de base", leitura.base === 250);

const leituraCurta = leituraAtual(Array.from({ length: 150 }, () => barra(10, 11, 9)));
ok("com 150 pregoes a MMA de 200 vem NULA, nao aproximada", leituraCurta.mma_longa === null);
ok("mas os indicadores que cabem continuam valendo",
   leituraCurta.mma_curta !== null && leituraCurta.atr !== null);
ok("a base informada permite a tela escrever 'sem base'", leituraCurta.base === 150);

const leituraVazia = leituraAtual([]);
ok("serie vazia nao quebra a leitura", leituraVazia.base === 0 && leituraVazia.mma_longa === null);

const comParcial = [...base250];
comParcial[comParcial.length - 1] = barra(125, 126, 124, 500_000, 1);
ok("a leitura avisa quando o ultimo pregao esta em formacao", leituraAtual(comParcial).em_formacao === true);
ok("e avisa quando esta fechado", leituraAtual(base250).em_formacao === false);

console.log(falhas === 0 ? "\nTODOS OS TESTES PASSARAM" : `\n${falhas} TESTE(S) FALHARAM`);
process.exit(falhas === 0 ? 0 : 1);
