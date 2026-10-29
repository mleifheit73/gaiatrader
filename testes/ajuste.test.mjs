import { ajustar, trechoContinuo, intervaloMaximo, fatoresDosEventos } from "../src/ajuste.js";

let falhas = 0;
const quase = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));
function ok(nome, cond, extra = "") {
  console.log(`${cond ? "PASSOU" : "FALHOU"}  ${nome}${extra ? "  " + extra : ""}`);
  if (!cond) falhas++;
}

const barra = (d, c, v = 1000) => ({ d, o: c, h: c, l: c, c, v });

// ---------------------------------------------------------------------------
// 1. O CASO REAL DO PETR4
// Fechou 58,68 no dia 23 e abriu 51,20 no dia 26. Se a queda foi provento, o
// ajuste tem que FECHAR o buraco: o candle do dia 23, ajustado, precisa valer
// os mesmos 51,20 do dia 26.
// ---------------------------------------------------------------------------
const provento = 58.68 - 51.20;   // 7,48
const petr = [
  barra("2026-10-22", 57.83),
  barra("2026-10-23", 58.68),
  barra("2026-10-26", 51.20),
  barra("2026-10-27", 52.79),
];
const r1 = ajustar(petr, [{ d: "2026-10-26", kind: "div", valor: provento }]);

ok("PETR4: fator aplicado uma vez", r1.aplicados === 1);
ok("PETR4: nada recusado", r1.recusados.length === 0);
ok("PETR4: o ultimo candle NAO muda (ajuste retroativo)", quase(r1.bars[3].c, 52.79));
ok("PETR4: o candle da data ex NAO muda", quase(r1.bars[2].c, 51.20));
ok(
  "PETR4: o buraco fecha, 58,68 ajustado vira 51,20",
  quase(r1.bars[1].c, 51.20, 1e-9),
  `calculado ${r1.bars[1].c.toFixed(4)}`
);
const variacaoBruta = petr[2].c / petr[1].c - 1;
const variacaoAjustada = r1.bars[2].c / r1.bars[1].c - 1;
ok(
  "PETR4: variacao bruta era -12,7% e a ajustada vira 0%",
  quase(variacaoBruta, -0.127471, 1e-3) && quase(variacaoAjustada, 0, 1e-9),
  `bruta ${(variacaoBruta * 100).toFixed(2)}%, ajustada ${(variacaoAjustada * 100).toFixed(6)}%`
);

// ---------------------------------------------------------------------------
// 2. DESDOBRAMENTO 2 POR 1: preco anterior cai pela metade, volume dobra
// ---------------------------------------------------------------------------
const sp = [barra("2026-01-05", 100, 500), barra("2026-01-06", 50, 1000)];
const r2 = ajustar(sp, [{ d: "2026-01-06", kind: "split", valor: 2 }]);
ok("Split: preco anterior cai pela metade", quase(r2.bars[0].c, 50));
ok("Split: volume anterior dobra", quase(r2.bars[0].v, 1000));
ok("Split: candle da data em diante intocado", quase(r2.bars[1].c, 50) && quase(r2.bars[1].v, 1000));

// ---------------------------------------------------------------------------
// 3. EVENTOS COMPOSTOS: o fator tem que MULTIPLICAR, nao somar
// ---------------------------------------------------------------------------
const comp = [barra("2026-01-01", 100), barra("2026-02-01", 100), barra("2026-03-01", 100)];
const r3 = ajustar(comp, [
  { d: "2026-02-01", kind: "div", valor: 10 },   // fator 0,9 sobre o 1o candle
  { d: "2026-03-01", kind: "div", valor: 10 },   // fator 0,9 sobre o 1o e o 2o
]);
ok("Composto: candle mais antigo leva 0,9 x 0,9 = 0,81", quase(r3.bars[0].c, 81), `deu ${r3.bars[0].c}`);
ok("Composto: candle do meio leva so 0,9", quase(r3.bars[1].c, 90), `deu ${r3.bars[1].c}`);
ok("Composto: ultimo candle intocado", quase(r3.bars[2].c, 100));

// ---------------------------------------------------------------------------
// 4. DADO RUIM TEM QUE SER RECUSADO, NAO APLICADO
// Um provento maior que o proprio preco zeraria todo o passado em silencio.
// ---------------------------------------------------------------------------
const r4 = ajustar(comp, [{ d: "2026-03-01", kind: "div", valor: 500 }]);
ok("Dado ruim: provento maior que o preco e recusado", r4.recusados.length === 1 && r4.aplicados === 0);
ok("Dado ruim: a serie fica intacta em vez de zerada", quase(r4.bars[0].c, 100));

const r5 = fatoresDosEventos(comp, [{ d: "2026-02-01", kind: "split", valor: 0 }]);
ok("Dado ruim: razao zero e recusada", r5.recusados.length === 1 && r5.fatores.length === 0);

// Evento anterior ao inicio da serie nao tem o que ajustar.
const r6 = ajustar(comp, [{ d: "2025-01-01", kind: "div", valor: 1 }]);
ok("Evento fora da serie carregada e recusado sem quebrar nada", r6.recusados.length === 1 && quase(r6.bars[0].c, 100));

// Serie sem evento nenhum sai igual a entrada.
const r7 = ajustar(comp, []);
ok("Sem evento, a serie sai identica", r7.bars.every((b, i) => quase(b.c, comp[i].c)));

// ---------------------------------------------------------------------------
// 5. TRECHO CONTINUO: o caso NATU3 e o caso AVAX
// ---------------------------------------------------------------------------
const natu = [
  barra("2019-12-17", 30), barra("2019-12-18", 31),   // trecho antigo
  barra("2025-06-26", 12), barra("2025-06-27", 12.5), // trecho novo
];
const t1 = trechoContinuo(natu, intervaloMaximo("b3"));
ok("NATU3: corta no buraco e devolve so o trecho novo", t1.cortado && t1.bars.length === 2);
ok("NATU3: trecho novo comeca na data certa", t1.bars[0].d === "2025-06-26");
ok("NATU3: relata o buraco em vez de esconder", t1.buraco?.dias === 2017, `relatou ${t1.buraco?.dias} dias`);

// Fim de semana na B3 nao pode ser confundido com buraco.
const semana = [barra("2026-10-23", 10), barra("2026-10-26", 10)];  // sexta -> segunda
ok("B3: fim de semana nao e buraco", !trechoContinuo(semana, intervaloMaximo("b3")).cortado);

// Feriado emendado (4 dias) tambem nao.
const feriado = [barra("2026-04-02", 10), barra("2026-04-06", 10)];
ok("B3: feriado emendado nao e buraco", !trechoContinuo(feriado, intervaloMaximo("b3")).cortado);

// Em cripto, um dia faltando JA e buraco, porque negocia todo dia.
const cripto = [barra("2026-10-20", 1), barra("2026-10-25", 1)];
ok("Cripto: 5 dias sem candle e buraco", trechoContinuo(cripto, intervaloMaximo("cripto")).cortado);
const criptoOk = [barra("2026-10-24", 1), barra("2026-10-25", 1)];
ok("Cripto: dias consecutivos nao sao buraco", !trechoContinuo(criptoOk, intervaloMaximo("cripto")).cortado);

// Serie vazia nao pode estourar.
ok("Serie vazia nao quebra", trechoContinuo([], 6).bars.length === 0 && ajustar([], []).bars.length === 0);

console.log(falhas === 0 ? "\nTODOS OS TESTES PASSARAM" : `\n${falhas} TESTE(S) FALHARAM`);
process.exit(falhas === 0 ? 0 : 1);
