import { agregar, segundaDaSemana, primeiroDoMes } from "../src/agregacao.js";

let falhas = 0;
function ok(nome, cond, extra = "") {
  console.log(`${cond ? "PASSOU" : "FALHOU"}  ${nome}${extra ? "  " + extra : ""}`);
  if (!cond) falhas++;
}

const barra = (d, o, h, l, c, v = 1000, partial = 0) => ({ d, o, h, l, c, v, partial });

// ---------------------------------------------------------------------------
// 1. ROTULO DA SEMANA: tem que vir do CALENDARIO, nao do primeiro pregao
// ---------------------------------------------------------------------------
ok("segunda vira ela mesma", segundaDaSemana("2026-10-26") === "2026-10-26");
ok("terca recua para a segunda", segundaDaSemana("2026-10-27") === "2026-10-26");
ok("sexta recua para a segunda", segundaDaSemana("2026-10-30") === "2026-10-26");
ok("sabado recua para a segunda", segundaDaSemana("2026-10-31") === "2026-10-26");
ok("DOMINGO pertence a semana que comecou na segunda anterior",
   segundaDaSemana("2026-11-01") === "2026-10-26", `deu ${segundaDaSemana("2026-11-01")}`);
ok("semana que atravessa a virada do mes", segundaDaSemana("2026-11-02") === "2026-11-02");
ok("semana que atravessa a virada do ano", segundaDaSemana("2027-01-01") === "2026-12-28");

ok("primeiro do mes", primeiroDoMes("2026-10-28") === "2026-10-01");
ok("primeiro do mes no dia 1", primeiroDoMes("2026-10-01") === "2026-10-01");

// ---------------------------------------------------------------------------
// 2. ALINHAMENTO ENTRE ATIVOS: o motivo de o rotulo vir do calendario
// Ativo A negocia a semana toda. Ativo B so negocia a partir de terca, porque
// a segunda foi feriado para ele. As duas barras precisam ter a MESMA data.
// ---------------------------------------------------------------------------
const ativoA = [
  barra("2026-10-26", 10, 11, 9, 10.5),
  barra("2026-10-27", 10.5, 12, 10, 11),
  barra("2026-10-28", 11, 11.5, 10.8, 11.2),
];
const ativoB = [
  barra("2026-10-27", 20, 21, 19, 20.5),
  barra("2026-10-28", 20.5, 22, 20, 21),
];
const sA = agregar(ativoA, "semana", "2026-11-10");
const sB = agregar(ativoB, "semana", "2026-11-10");
ok("ativos com pregoes diferentes alinham na mesma semana",
   sA[0].d === sB[0].d && sA[0].d === "2026-10-26", `${sA[0].d} vs ${sB[0].d}`);
ok("a barra registra quantos pregoes a formaram", sA[0].pregoes === 3 && sB[0].pregoes === 2);

// ---------------------------------------------------------------------------
// 3. OHLC AGREGADO
// ---------------------------------------------------------------------------
ok("abertura e a do PRIMEIRO pregao", sA[0].o === 10);
ok("fechamento e o do ULTIMO pregao", sA[0].c === 11.2);
ok("maxima e a maior do periodo", sA[0].h === 12);
ok("minima e a menor do periodo", sA[0].l === 9);
ok("volume e a soma", sA[0].v === 3000);
ok("invariante preservada na barra agregada",
   sA[0].h >= sA[0].o && sA[0].h >= sA[0].c && sA[0].l <= sA[0].o && sA[0].l <= sA[0].c);

// ---------------------------------------------------------------------------
// 4. BARRA EM FORMACAO
// ---------------------------------------------------------------------------
const semanaFechada = agregar(ativoA, "semana", "2026-11-10");
ok("semana ja encerrada nao e parcial", semanaFechada[0].partial === 0);

const semanaCorrente = agregar(ativoA, "semana", "2026-10-28");
ok("semana corrente e parcial", semanaCorrente[0].partial === 1);

const semanaNoDomingo = agregar(ativoA, "semana", "2026-11-01");
ok("domingo ainda e a semana corrente", semanaNoDomingo[0].partial === 1);

const comDiarioParcial = agregar(
  [barra("2026-10-26", 10, 11, 9, 10.5), barra("2026-10-27", 10.5, 12, 10, 11, 1000, 1)],
  "semana", "2026-11-10");
ok("pregao parcial contamina a semana inteira", comDiarioParcial[0].partial === 1);

// ---------------------------------------------------------------------------
// 5. MENSAL, E O DEFEITO DE BARRA DUPLICADA QUE JA ACONTECEU
// ---------------------------------------------------------------------------
const doisMeses = [
  barra("2026-09-29", 10, 10, 10, 10),
  barra("2026-09-30", 10, 13, 9, 12),
  barra("2026-10-01", 12, 12, 12, 12),
  barra("2026-10-30", 12, 14, 11, 13),
];
const m = agregar(doisMeses, "mes", "2026-12-01");
ok("dois meses viram DUAS barras, nao tres", m.length === 2, `deu ${m.length}`);
ok("setembro rotulado no dia 1", m[0].d === "2026-09-01");
ok("outubro rotulado no dia 1", m[1].d === "2026-10-01");
ok("nenhuma data de barra mensal se repete", new Set(m.map((x) => x.d)).size === m.length);
ok("setembro: abertura do 1o pregao e fechamento do ultimo", m[0].o === 10 && m[0].c === 12);
ok("setembro: maxima e minima do mes", m[0].h === 13 && m[0].l === 9);

// Ultimo dia do mes nao pode vazar para o mes seguinte.
const viradaMes = agregar([barra("2026-02-28", 1, 1, 1, 1)], "mes", "2026-12-01");
ok("29/02 nao existe em 2026 e 28/02 fica em fevereiro", viradaMes[0].d === "2026-02-01");

const fevBissexto = agregar([barra("2024-02-29", 1, 1, 1, 1)], "mes", "2024-12-01");
ok("29/02 de ano bissexto fica em fevereiro", fevBissexto[0].d === "2024-02-01");

const dezembro = agregar([barra("2026-12-31", 1, 1, 1, 1)], "mes", "2027-06-01");
ok("31/12 fica em dezembro e nao vaza para janeiro", dezembro[0].d === "2026-12-01");
ok("dezembro encerrado nao e parcial", dezembro[0].partial === 0);

// ---------------------------------------------------------------------------
// 6. CRIPTO: negocia sabado e domingo, e os dois entram na mesma semana
// ---------------------------------------------------------------------------
const cripto = [
  barra("2026-10-26", 100, 100, 100, 100),
  barra("2026-10-31", 100, 120, 90, 110),   // sabado
  barra("2026-11-01", 110, 115, 105, 112),  // domingo
  barra("2026-11-02", 112, 112, 112, 112),  // segunda seguinte
];
const sc = agregar(cripto, "semana", "2026-12-01");
ok("7 dias de cripto cabem em UMA semana", sc.length === 2, `deu ${sc.length}`);
ok("sabado e domingo ficam na semana da segunda anterior", sc[0].d === "2026-10-26" && sc[0].pregoes === 3);
ok("a segunda seguinte abre semana nova", sc[1].d === "2026-11-02");
ok("maxima atravessa o fim de semana", sc[0].h === 120 && sc[0].l === 90);

// ---------------------------------------------------------------------------
// 7. CASOS DE BORDA
// ---------------------------------------------------------------------------
ok("serie vazia nao quebra", agregar([], "semana", "2026-01-01").length === 0);
ok("um unico pregao vira uma barra", agregar([barra("2026-10-28", 1, 2, 0.5, 1.5)], "semana", "2026-12-01").length === 1);

let invalido = null;
try { agregar(ativoA, "trimestre", "2026-12-01"); } catch (e) { invalido = e; }
ok("periodo desconhecido e recusado", /periodo invalido/.test(invalido?.message || ""));

ok("saida sempre em ordem crescente de data",
   m.every((b, i) => i === 0 || m[i - 1].d < b.d));

console.log(falhas === 0 ? "\nTODOS OS TESTES PASSARAM" : `\n${falhas} TESTE(S) FALHARAM`);
process.exit(falhas === 0 ? 0 : 1);
