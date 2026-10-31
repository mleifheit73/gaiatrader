/*
 * Testes da camada de consumo de IA.
 *
 * O que estes testes protegem: o custo que a tela do admin mostra. Se ele
 * sair errado, o Marcelo precifica o produto em cima de um numero falso, e
 * essa e a decisao mais cara que ele vai tomar neste projeto.
 */
import { bancoDeTeste, criarUsuario } from "./ajuda-d1.mjs";
import {
  MODELOS, TIPOS, custoUSD, lerModelos, gravarModelo,
  consumoPorUsuario, totaisConsumo, usuariosEmAlerta, ajustarCota,
  registrarChamada, USD_BRL_PADRAO,
} from "../src/consumo.js";

let falhas = 0;
const quase = (a, b, tol = 1e-9) => a !== null && Math.abs(a - b) <= tol;
function ok(nome, cond, extra = "") {
  console.log(`${cond ? "PASSOU" : "FALHOU"}  ${nome}${extra ? "  " + extra : ""}`);
  if (!cond) falhas++;
}

/* ---- Tabela de precos --------------------------------------------------- */

{
  ok("os quatro modelos estao na tabela", Object.keys(MODELOS).length === 4);
  ok("Haiku 5.5 custa 0,10 de entrada e 0,50 de saida",
     MODELOS["claude-haiku-5-5"].ent === 0.10 && MODELOS["claude-haiku-5-5"].sai === 0.50);
  ok("Sonnet 5.5 custa 2 de entrada e 10 de saida",
     MODELOS["claude-sonnet-5-5"].ent === 2 && MODELOS["claude-sonnet-5-5"].sai === 10);
  ok("a saida custa 5 vezes a entrada em todos os modelos",
     Object.values(MODELOS).every((m) => quase(m.sai, m.ent * 5)),
     "e por isso que max_tokens e o parametro que mais controla o gasto");
  ok("a leitura de cache do Sonnet 5.5 e 0,05x e nao 0,1x",
     MODELOS["claude-sonnet-5-5"].leituraCache === 0.10 * 1,
     "0,10 absoluto = 0,05x de 2,00");
}

/* ---- Custo por chamada -------------------------------------------------- */

{
  // Parecer tipico medido no artefato: 3.293 de texto novo, 993 cacheados,
  // 3.404 de imagem, 1.500 de saida.
  const c = custoUSD("claude-sonnet-5-5", {
    entrada: 3293, cacheLeitura: 993, imagem: 3404, saida: 1500,
  });
  const esperado = (3293 + 3404) * 2 / 1e6 + 993 * 0.10 / 1e6 + 1500 * 10 / 1e6;
  ok("custo do parecer bate com a conta feita a mao", quase(c, esperado),
     `R$ ${(c * USD_BRL_PADRAO).toFixed(4)}`);
  ok("o parecer tipico fica perto de R$ 0,15", c * USD_BRL_PADRAO > 0.13 && c * USD_BRL_PADRAO < 0.17,
     `veio R$ ${(c * USD_BRL_PADRAO).toFixed(4)}`);
}

{
  const comImagem = custoUSD("claude-sonnet-5-5", { entrada: 3293, cacheLeitura: 993, imagem: 3404, saida: 1500 });
  const semImagem = custoUSD("claude-sonnet-5-5", { entrada: 3293, cacheLeitura: 993, imagem: 0, saida: 1500 });
  ok("a imagem e cobrada como entrada", comImagem > semImagem);
  ok("a imagem pesa entre 20% e 35% do parecer",
     (1 - semImagem / comImagem) > 0.20 && (1 - semImagem / comImagem) < 0.35,
     `${((1 - semImagem / comImagem) * 100).toFixed(0)}%`);
}

{
  const h = custoUSD("claude-haiku-5-5",  { entrada: 1857, saida: 250 });
  const s = custoUSD("claude-sonnet-5-5", { entrada: 1857, saida: 250 });
  ok("a mesma pergunta no Haiku custa 20x menos que no Sonnet",
     quase(s / h, 20, 0.5), `veio ${(s / h).toFixed(1)}x`);
}

{
  ok("modelo desconhecido devolve null em vez de zero", custoUSD("inventado", { entrada: 1000 }) === null,
     "zero seria um custo plausivel e errado");
  ok("chamada sem tokens custa zero", custoUSD("claude-haiku-5-5", {}) === 0);
}

/* ---- Seletor de modelo -------------------------------------------------- */

{
  const d1 = bancoDeTeste();
  const m = await lerModelos(d1);
  ok("sem nada salvo, os tres tipos caem no padrao",
     m.parecer.modelo === "claude-sonnet-5-5" &&
     m.pergunta.modelo === "claude-haiku-5-5" &&
     m.explicar.modelo === "claude-haiku-5-5");
  ok("o padrao do parecer e o Sonnet 5.5, como o Marcelo decidiu",
     TIPOS.parecer.padrao === "claude-sonnet-5-5");
  ok("nenhum aparece como alterado", Object.values(m).every((x) => !x.alterado));

  await gravarModelo(d1, "parecer", "claude-opus-5-5");
  const m2 = await lerModelos(d1);
  ok("o modelo gravado e lido de volta", m2.parecer.modelo === "claude-opus-5-5");
  ok("a tela sabe que foi alterado em relacao ao padrao", m2.parecer.alterado === true);
  ok("os outros tipos nao foram afetados", m2.pergunta.modelo === "claude-haiku-5-5");

  await gravarModelo(d1, "parecer", "claude-sonnet-5-5");
  ok("voltar ao padrao limpa a marca de alterado",
     (await lerModelos(d1)).parecer.alterado === false);
}

{
  const d1 = bancoDeTeste();
  let e1 = null, e2 = null;
  try { await gravarModelo(d1, "inventado", "claude-haiku-5-5"); } catch (e) { e1 = e.message; }
  try { await gravarModelo(d1, "parecer", "gpt-nao-existe"); } catch (e) { e2 = e.message; }
  ok("tipo de chamada desconhecido e recusado", /tipo de chamada/.test(e1 || ""));
  ok("modelo fora da tabela de precos e recusado", /modelo desconhecido/.test(e2 || ""),
     "aceitar cobraria o custo errado em silencio");
}

{
  // Um modelo salvo que saiu da tabela de precos nao pode quebrar a tela.
  const d1 = bancoDeTeste();
  d1.cru.exec(`INSERT INTO config (chave,valor) VALUES ('modelo.parecer','claude-aposentado')`);
  const m = await lerModelos(d1);
  ok("modelo aposentado cai no padrao em vez de quebrar", m.parecer.modelo === "claude-sonnet-5-5");
  ok("mas a tela e avisada de que havia um invalido", m.parecer.invalido === "claude-aposentado");
}

/* ---- Registro de chamada e contadores ----------------------------------- */

{
  const d1 = bancoDeTeste();
  criarUsuario(d1, "u1");

  await registrarChamada(d1, {
    userId: "u1", tipo: "parecer", modelo: "claude-sonnet-5-5", ticker: "PETR4",
    tokens: { entrada: 3293, cacheLeitura: 993, imagem: 3404, saida: 1500 }, ms: 4200,
  });

  const linha = d1.cru.prepare("SELECT * FROM ai_calls WHERE user_id='u1'").get();
  ok("a chamada foi gravada em ai_calls", !!linha);
  ok("o custo foi calculado e gravado", linha.custo_usd > 0, `${linha.custo_usd}`);
  ok("os tokens de imagem ficam em coluna propria",
     linha.tokens_imagem === 3404, "para a tela poder mostrar o peso da imagem");

  const ciclo = d1.cru.prepare("SELECT * FROM ai_uso_ciclo WHERE user_id='u1'").get();
  ok("o contador do ciclo subiu", ciclo.pareceres === 1);
  ok("o custo acumulado do ciclo subiu", ciclo.custo_usd > 0);

  const hora = d1.cru.prepare("SELECT * FROM ai_uso_hora WHERE user_id='u1'").get();
  ok("o contador da hora subiu", hora && hora.pareceres === 1);
}

{
  const d1 = bancoDeTeste();
  criarUsuario(d1, "u1");
  await registrarChamada(d1, { userId: "u1", tipo: "pergunta", modelo: "claude-haiku-5-5",
    tokens: { entrada: 1857, saida: 250 } });
  const ciclo = d1.cru.prepare("SELECT * FROM ai_uso_ciclo WHERE user_id='u1'").get();
  ok("pergunta conta no contador de perguntas", ciclo.perguntas === 1 && ciclo.pareceres === 0);
  const hora = d1.cru.prepare("SELECT * FROM ai_uso_hora WHERE user_id='u1'").get();
  ok("pergunta NAO entra no teto por hora", !hora,
     "o teto de 30/hora e so do parecer, que e a chamada cara");

  await registrarChamada(d1, { userId: "u1", tipo: "explicar", modelo: "claude-haiku-5-5",
    tokens: { entrada: 671, saida: 390 } });
  ok("explicacao conta no contador proprio",
     d1.cru.prepare("SELECT * FROM ai_uso_ciclo WHERE user_id='u1'").get().explicacoes === 1);
}

{
  const d1 = bancoDeTeste();
  criarUsuario(d1, "u1");
  await registrarChamada(d1, { userId: "u1", tipo: "parecer", modelo: "claude-sonnet-5-5",
    tokens: { entrada: 100, saida: 100 }, ok: false, erro: "rate_limited" });
  const l = d1.cru.prepare("SELECT * FROM ai_calls WHERE user_id='u1'").get();
  ok("chamada que falhou tambem e gravada", l.ok === 0 && l.erro === "rate_limited",
     "falha consome token e precisa aparecer no custo");
}

/* ---- Tabela de consumo por usuario -------------------------------------- */

{
  const d1 = bancoDeTeste();
  criarUsuario(d1, "leve");
  criarUsuario(d1, "pesado");
  criarUsuario(d1, "estourou");

  d1.cru.exec("UPDATE ai_uso_ciclo SET pareceres=10  WHERE user_id='leve'");
  d1.cru.exec("UPDATE ai_uso_ciclo SET pareceres=160 WHERE user_id='pesado'");
  d1.cru.exec("UPDATE ai_uso_ciclo SET pareceres=200 WHERE user_id='estourou'");

  const linhas = await consumoPorUsuario(d1);
  ok("devolve uma linha por usuario", linhas.length === 3);
  ok("ordena por consumo, do maior para o menor",
     linhas[0].id === "estourou" && linhas[2].id === "leve",
     linhas.map((l) => l.id).join(" > "));

  const porId = Object.fromEntries(linhas.map((l) => [l.id, l]));
  ok("10 de 200 e estado normal", porId.leve.estado === "normal");
  ok("160 de 200 dispara o alerta", porId.pesado.estado === "alerta",
     "o Marcelo pediu aviso em 150");
  ok("200 de 200 aparece como bloqueado", porId.estourou.estado === "bloqueado");
  ok("o percentual da cota e calculado", porId.pesado.pct_cota === 80, `${porId.pesado.pct_cota}%`);
  ok("quem nunca teve cota ajustada usa o padrao 200", porId.leve.cota_mes === 200);
}

{
  const d1 = bancoDeTeste();
  criarUsuario(d1, "u1");
  await registrarChamada(d1, { userId: "u1", tipo: "parecer", modelo: "claude-sonnet-5-5",
    tokens: { entrada: 3293, cacheLeitura: 993, imagem: 3404, saida: 1500 } });

  const [l] = await consumoPorUsuario(d1);
  ok("o custo aparece em reais na tela", l.custo_total_brl > 0,
     `R$ ${l.custo_total_brl.toFixed(4)}`);
  ok("os reais sao os dolares vezes a cotacao",
     quase(l.custo_total_brl, l.custo_total_usd * USD_BRL_PADRAO, 1e-9));
  ok("a tela recebe os tokens de imagem separados", l.tokens_imagem === 3404);

  const comOutraCotacao = await consumoPorUsuario(d1, { usdBrl: 6.00 });
  ok("a cotacao do dolar e um parametro, nao um numero fixo",
     quase(comOutraCotacao[0].custo_total_brl, l.custo_total_usd * 6.00, 1e-9));
}

/* ---- Alerta do admin ---------------------------------------------------- */

{
  const d1 = bancoDeTeste();
  criarUsuario(d1, "ok1");
  criarUsuario(d1, "quase");
  criarUsuario(d1, "cheio");
  d1.cru.exec("UPDATE ai_uso_ciclo SET pareceres=100 WHERE user_id='ok1'");
  d1.cru.exec("UPDATE ai_uso_ciclo SET pareceres=150 WHERE user_id='quase'");
  d1.cru.exec("UPDATE ai_uso_ciclo SET pareceres=210 WHERE user_id='cheio'");

  const alertas = await usuariosEmAlerta(d1);
  ok("so quem passou do limite de alerta aparece", alertas.length === 2);
  ok("quem esta em 100 nao aparece", !alertas.some((a) => a.id === "ok1"));
  ok("quem esta exatamente em 150 aparece", alertas.some((a) => a.id === "quase"),
     "o limite e maior ou igual");
  ok("quem passou da cota aparece como bloqueado",
     alertas.find((a) => a.id === "cheio").estado === "bloqueado");
}

/* ---- Ajuste manual de cota ---------------------------------------------- */

{
  const d1 = bancoDeTeste();
  criarUsuario(d1, "u1");

  const r = await ajustarCota(d1, "u1", { pareceresMes: 400, motivo: "testador do beta fechado", por: "marcelo" });
  ok("o admin consegue aumentar a cota do usuario", r.pareceres_mes === 400);

  const q = d1.cru.prepare("SELECT * FROM ai_quota WHERE user_id='u1'").get();
  ok("o motivo fica gravado", q.motivo_ajuste === "testador do beta fechado");
  ok("quem ajustou fica gravado", q.ajustado_por === "marcelo");
  ok("a data do ajuste fica gravada", !!q.ajustado_em);
  ok("o que nao foi informado mantem o padrao", q.pareceres_hora === 30 && q.alerta_em === 150);

  const [l] = await consumoPorUsuario(d1);
  ok("a tela mostra a cota aumentada", l.cota_mes === 400);
  ok("a tela mostra o motivo do ajuste", l.motivo_ajuste === "testador do beta fechado");
}

{
  const d1 = bancoDeTeste();
  criarUsuario(d1, "u1");
  const tenta = async (args) => { try { await ajustarCota(d1, "u1", args); return null; } catch (e) { return e.message; } };

  ok("ajuste sem motivo e recusado",
     /motivo/.test(await tenta({ pareceresMes: 400 }) || ""),
     "limite mexido sem registro vira numero que ninguem explica depois");
  ok("motivo so com espacos e recusado", /motivo/.test(await tenta({ pareceresMes: 400, motivo: "   " }) || ""));
  ok("cota zero e recusada", /maiores que zero/.test(await tenta({ pareceresMes: 0, motivo: "x" }) || ""));
  ok("alerta maior que a cota e recusado",
     /alerta/.test(await tenta({ pareceresMes: 100, alertaEm: 150, motivo: "x" }) || ""),
     "senao o alerta nunca dispararia");
}

/* ---- Totais ------------------------------------------------------------- */

{
  const d1 = bancoDeTeste();
  criarUsuario(d1, "u1");
  criarUsuario(d1, "u2");
  await registrarChamada(d1, { userId: "u1", tipo: "parecer",  modelo: "claude-sonnet-5-5", tokens: { entrada: 3293, imagem: 3404, saida: 1500 } });
  await registrarChamada(d1, { userId: "u1", tipo: "pergunta", modelo: "claude-haiku-5-5",  tokens: { entrada: 1857, saida: 250 } });
  await registrarChamada(d1, { userId: "u2", tipo: "explicar", modelo: "claude-haiku-5-5",  tokens: { entrada: 671, saida: 390 } });

  const t = await totaisConsumo(d1);
  ok("conta os usuarios", t.usuarios === 2);
  ok("conta as chamadas por tipo", t.pareceres === 1 && t.perguntas === 1 && t.explicacoes === 1);
  ok("soma o custo em dolares", t.custo_usd > 0);
  ok("mostra o custo em reais", quase(t.custo_brl, t.custo_usd * USD_BRL_PADRAO, 1e-9));
  ok("informa a cotacao usada", t.usd_brl === USD_BRL_PADRAO,
     "senao o numero em reais nao tem como ser conferido");
}

console.log(falhas === 0 ? "\nTODOS OS TESTES PASSARAM" : `\n${falhas} TESTE(S) FALHARAM`);
process.exit(falhas === 0 ? 0 : 1);
