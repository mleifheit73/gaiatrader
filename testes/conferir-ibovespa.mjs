/*
 * Confere a serie do Ibovespa carregada pelo Yahoo contra valores obtidos
 * de forma independente na BRAPI.
 *
 * POR QUE ISTO EXISTE
 * As 929 barras sinteticas que o Yahoo nos entregou em 64 ativos passaram por
 * toda verificacao interna que tinhamos, porque elas eram internamente
 * coerentes. So um SEGUNDO provedor desmente o primeiro. Este arquivo guarda
 * um controle externo para a serie que mais importa: o indice, que divide
 * todas as outras no calculo de forca relativa.
 *
 * Uso:  node testes/conferir-ibovespa.mjs [url-base]
 */

// Colhidos em 30/10/2026 via conector BRAPI, endpoint /api/v2/stocks/historical,
// simbolo ^BVSP, intervalo 1d. Fonte independente do Yahoo.
const CONTROLE = [
  { d: "2026-10-23", o: 204120, h: 205757, l: 203428, c: 205083, v: 11863800 },
  { d: "2026-10-26", o: 205070, h: 205089, l: 169516, c: 176608, v: 41232400 },
  { d: "2026-10-27", o: 176609, h: 178526, l: 175130, c: 175710, v: 25136900 },
  { d: "2026-10-28", o: 175711, h: 175711, l: 170163, c: 171006, v: 21515700 },
  { d: "2026-10-29", o: 171006, h: 171403, l: 168765, c: 169186, v: 16212200 },
];

// O indice tem casas decimais no Yahoo e inteiros na BRAPI, entao comparamos
// com tolerancia relativa em vez de igualdade.
const TOLERANCIA = 0.001;   // 0,1%
const TOL_VOLUME = 0.05;    // 5%, volume de indice diverge mais entre fontes

const base = process.argv[2] || "https://gaiatrader.gaiatrader.workers.dev";

const perto = (a, b, tol) => {
  if (a == null || b == null) return false;
  if (b === 0) return a === 0;
  return Math.abs(a / b - 1) <= tol;
};
const pct = (a, b) => (b === 0 ? "–" : ((a / b - 1) * 100).toFixed(3).replace(".", ",") + "%");

let r;
try {
  r = await fetch(base + "/api/bars?ticker=%5EBVSP&periodo=dia&limite=400");
} catch (e) {
  // O conteiner de desenvolvimento do Claude nao alcanca o workers.dev: a
  // saida passa por um proxy com lista de permissao. Rode isto da sua maquina.
  console.error("Nao consegui alcancar " + base);
  console.error("  motivo: " + (e?.cause?.code || e?.message || e));
  console.error("\n  Se voce esta num ambiente com a saida restrita, rode da sua");
  console.error("  propria maquina:  node testes/conferir-ibovespa.mjs");
  process.exit(2);
}
if (!r.ok) {
  console.error("A API respondeu HTTP " + r.status);
  console.error((await r.text().catch(() => "")).slice(0, 400));
  process.exit(1);
}
const corpo = await r.json();
const barras = corpo.bars || [];
if (!barras.length) {
  console.error("Nenhum candle do Ibovespa na base ainda. A varredura das 21h30 carrega.");
  process.exit(1);
}

const porData = new Map(barras.map((b) => [b.d, b]));
console.log("Candles do ^BVSP na base: " + barras.length +
            " (de " + barras[0].d + " a " + barras[barras.length - 1].d + ")\n");

let falhas = 0, ausentes = 0;
for (const k of CONTROLE) {
  const b = porData.get(k.d);
  if (!b) { console.log("  AUSENTE  " + k.d); ausentes++; continue; }
  const campos = [["o", TOLERANCIA], ["h", TOLERANCIA], ["l", TOLERANCIA],
                  ["c", TOLERANCIA], ["v", TOL_VOLUME]];
  const ruins = campos.filter(([f, tol]) => !perto(b[f], k[f], tol));
  if (ruins.length) {
    falhas++;
    console.log("  DIVERGE  " + k.d + "  " +
      ruins.map(([f]) => f + ": base " + b[f] + " vs controle " + k[f] + " (" + pct(b[f], k[f]) + ")").join("  |  "));
  } else {
    console.log("  ok       " + k.d + "  fechamento " + b.c.toLocaleString("pt-BR"));
  }
}

// A barra do dia 26/10 e a prova de fogo: 21% de amplitude. Se o provedor
// tivesse achatado ou sintetizado o candle, e aqui que apareceria.
const crash = porData.get("2026-10-26");
if (crash) {
  const amp = (crash.h / crash.l - 1) * 100;
  const ok = amp > 18;
  console.log("\n  " + (ok ? "ok      " : "DIVERGE ") +
    " amplitude de 26/10: " + amp.toFixed(1).replace(".", ",") + "% (esperado perto de 21%)");
  if (!ok) falhas++;
}

console.log("\n" + (falhas || ausentes
  ? "REPROVADO: " + falhas + " divergencia(s), " + ausentes + " ausente(s)"
  : "APROVADO: a serie do Yahoo bate com a da BRAPI"));
process.exit(falhas || ausentes ? 1 : 0);
