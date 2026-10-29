import { brapi } from "../src/providers/brapi.js";

let falhas = 0;
function ok(nome, cond, extra = "") {
  console.log(`${cond ? "PASSOU" : "FALHOU"}  ${nome}${extra ? "  " + extra : ""}`);
  if (!cond) falhas++;
}

// A BRAPI carimba o pregao a meia-noite de Brasilia, em UTC-3 fixo.
const epochDe = (dia) => Math.floor(Date.parse(dia + "T03:00:00Z") / 1000);

function resposta(dias, symbol = "AURE3", changed = false) {
  return {
    ok: true, status: 200,
    json: async () => ({ results: [{
      symbol, changed,
      historicalDataPrice: dias.map((d, i) => ({
        date: epochDe(d),
        open: 10 + i, high: 11 + i, low: 9 + i, close: 10.5 + i,
        volume: 1000 + i, adjustedClose: 8 + i,
      })),
    }] }),
  };
}

// ---------------------------------------------------------------------------
// 1. FATIAMENTO: periodo longo vira varias janelas de 90 dias
// O plano gratuito recusa pedido acima de 90 dias, entao o provedor precisa
// fatiar sozinho, sem que quem chama precise saber disso.
// ---------------------------------------------------------------------------
let chamadas = [];
globalThis.fetch = async (url) => {
  const u = new URL(url);
  chamadas.push({ de: u.searchParams.get("startDate"), ate: u.searchParams.get("endDate") });
  return resposta([u.searchParams.get("startDate")]);
};

const r1 = await brapi.daily("AURE3", "b3", { de: "2021-01-01", ate: "2021-12-31", token: "x" });

ok("periodo de 1 ano vira varias janelas", chamadas.length > 1, `${chamadas.length} janelas`);
ok("nenhuma janela passa de 90 dias", chamadas.every((c) => {
  const dias = (Date.parse(c.ate) - Date.parse(c.de)) / 86400000 + 1;
  return dias <= 90;
}));
ok("a primeira janela comeca na data pedida", chamadas[0].de === "2021-01-01");
ok("a ultima janela termina na data pedida", chamadas.at(-1).ate === "2021-12-31");
ok("nao ha buraco entre janelas vizinhas", chamadas.every((c, i) => {
  if (i === 0) return true;
  const seguinte = new Date(chamadas[i - 1].ate + "T00:00:00Z");
  seguinte.setUTCDate(seguinte.getUTCDate() + 1);
  return c.de === seguinte.toISOString().slice(0, 10);
}));
ok("relata quantas requisicoes gastou", r1.requisicoes === chamadas.length, `${r1.requisicoes}`);

// ---------------------------------------------------------------------------
// 2. DATA: o carimbo da BRAPI tem que virar a data certa do pregao
// Errar um dia inteiro de serie nao acusa erro e estraga todo indicador.
// ---------------------------------------------------------------------------
globalThis.fetch = async () => resposta(["2016-10-28", "2016-10-31"]);
const r2 = await brapi.daily("AURE3", "b3", { de: "2016-10-28", ate: "2016-11-01", token: "x" });
ok("carimbo de 2016 vira a data certa", r2.bars[0].d === "2016-10-28", `veio ${r2.bars[0].d}`);
ok("series em ordem crescente", r2.bars[0].d < r2.bars[1].d);

// ---------------------------------------------------------------------------
// 3. JANELA VAZIA nao derruba a busca
// Periodo anterior a existencia do papel devolve 404, e isso e normal.
// ---------------------------------------------------------------------------
let n = 0;
globalThis.fetch = async (url) => {
  n++;
  if (n <= 2) return { ok: false, status: 404 };
  return resposta([new URL(url).searchParams.get("startDate")]);
};
const r3 = await brapi.daily("AURE3", "b3", { de: "2021-01-01", ate: "2021-12-31", token: "x" });
ok("janela 404 e pulada, nao fatal", r3.bars.length > 0, `${r3.bars.length} barras`);

// ---------------------------------------------------------------------------
// 4. BLOQUEIO DE VERDADE interrompe, com o status anexado para o recuo automatico
// ---------------------------------------------------------------------------
globalThis.fetch = async () => ({ ok: false, status: 429 });
let erro = null;
try {
  await brapi.daily("AURE3", "b3", { de: "2021-01-01", ate: "2021-03-01", token: "x" });
} catch (e) { erro = e; }
ok("429 interrompe a busca", erro !== null);
ok("429 leva o status anexado", erro?.status === 429);

// ---------------------------------------------------------------------------
// 5. REGRAS DE CONTRATO
// ---------------------------------------------------------------------------
globalThis.fetch = async () => resposta(["2021-01-04"], "AURE3", true);
const r5 = await brapi.daily("CESP6", "b3", { de: "2021-01-01", ate: "2021-02-01", token: "x" });
ok("relata o simbolo canonico que a BRAPI resolveu", r5.simboloCanonico === "AURE3");
ok("relata que houve renomeacao", r5.renomeado === true);
ok("invariante da barra respeitada", r5.bars.every((b) => b.h >= b.o && b.h >= b.c && b.l <= b.o && b.l <= b.c));
ok("historico vem sempre como definitivo", r5.bars.every((b) => b.partial === 0));
ok("eventos vem vazios (plano gratuito nao serve proventos)",
   r5.eventos.dividendos.length === 0 && r5.eventos.desdobramentos.length === 0);

let semToken = null;
try { await brapi.daily("AURE3", "b3", { range: "1y" }); } catch (e) { semToken = e; }
ok("sem token, falha com mensagem clara", /BRAPI_TOKEN/.test(semToken?.message || ""));

let cripto = null;
try { await brapi.daily("BTC", "cripto", { token: "x" }); } catch (e) { cripto = e; }
ok("recusa cripto, que a BRAPI nao atende", /cripto/.test(cripto?.message || ""));

console.log(falhas === 0 ? "\nTODOS OS TESTES PASSARAM" : `\n${falhas} TESTE(S) FALHARAM`);
process.exit(falhas === 0 ? 0 : 1);
