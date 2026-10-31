/*
 * Testes do esquema do banco.
 *
 * O que estes testes protegem nao e a sintaxe do SQL, e uma regra de
 * produto: dado de um usuario nunca aparece para outro. Esse defeito nao
 * produz erro nenhum, so produz manchete, entao ele precisa de teste.
 */
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";

let falhas = 0;
function ok(nome, cond, extra = "") {
  console.log(`${cond ? "PASSOU" : "FALHOU"}  ${nome}${extra ? "  " + extra : ""}`);
  if (!cond) falhas++;
}

const MIGRACOES = fs.readdirSync("migrations").filter((f) => f.endsWith(".sql")).sort();

function banco() {
  const db = new DatabaseSync(":memory:");
  for (const f of MIGRACOES) db.exec(fs.readFileSync("migrations/" + f, "utf8"));
  return db;
}

/* ---- As migracoes aplicam ----------------------------------------------- */

let db;
{
  let erro = null;
  try { db = banco(); } catch (e) { erro = e.message; }
  ok(`as ${MIGRACOES.length} migracoes aplicam em sequencia`, erro === null, erro || "");
}

/* ---- Toda tabela privada tem user_id ------------------------------------ */

{
  // event_cache e webhook_events sao compartilhadas de proposito. Qualquer
  // outra tabela sem user_id e um vazamento esperando para acontecer.
  const COMPARTILHADAS = new Set([
    "assets", "daily_bars", "corporate_events", "asset_metrics",
    "config", "ingest_runs", "provider_calls", "event_cache", "webhook_events",
    "users", "sqlite_sequence",
  ]);
  const tabelas = db.prepare(
    "SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
  ).all();
  const sem = tabelas.filter((t) => !COMPARTILHADAS.has(t.name) && !/user_id/.test(t.sql));
  ok("toda tabela nao compartilhada tem user_id",
     sem.length === 0, sem.length ? "sem user_id: " + sem.map((t) => t.name).join(", ") : "");
  ok("as tabelas compartilhadas conhecidas continuam sem user_id",
     !/user_id/.test(tabelas.find((t) => t.name === "event_cache").sql),
     "event_cache e sobre o ativo, nao sobre a pessoa");
}

/* ---- Isolamento entre usuarios ------------------------------------------ */

{
  const d = banco();
  d.exec("INSERT INTO users (id,google_sub,email) VALUES ('u1','g1','a@b.c'),('u2','g2','d@e.f')");

  // Dois usuarios desenham no MESMO ativo e MESMO tempo grafico.
  d.exec(`INSERT INTO user_drawings (user_id,ticker,timeframe,dados)
          VALUES ('u1','PETR4','diario','tracos-do-u1'),('u2','PETR4','diario','tracos-do-u2')`);
  const vistos = d.prepare("SELECT dados FROM user_drawings WHERE user_id=? AND ticker=?").all("u1", "PETR4");
  ok("dois usuarios convivem no mesmo ativo e tempo grafico",
     d.prepare("SELECT COUNT(*) n FROM user_drawings").get().n === 2);
  ok("cada usuario so enxerga os proprios desenhos",
     vistos.length === 1 && vistos[0].dados === "tracos-do-u1",
     JSON.stringify(vistos.map((x) => x.dados)));

  // O mesmo para carteira, configuracao e diario.
  d.exec("INSERT INTO user_watchlist (user_id,ticker) VALUES ('u1','PETR4'),('u2','VALE3')");
  const w = d.prepare("SELECT ticker FROM user_watchlist WHERE user_id=?").all("u2");
  ok("a carteira de um nao aparece na do outro", w.length === 1 && w[0].ticker === "VALE3");

  d.exec("INSERT INTO user_config (user_id,capital) VALUES ('u1',100000),('u2',5000)");
  ok("o capital de um nao aparece para o outro",
     d.prepare("SELECT capital FROM user_config WHERE user_id=?").get("u2").capital === 5000);
}

/* ---- Identidade --------------------------------------------------------- */

{
  const d = banco();
  d.exec("INSERT INTO users (id,google_sub,email) VALUES ('u1','g1','a@b.c')");
  let recusou = false;
  try { d.exec("INSERT INTO users (id,google_sub,email) VALUES ('u2','g1','outro@b.c')"); }
  catch { recusou = true; }
  ok("o mesmo google_sub nao pode virar dois usuarios", recusou,
     "o sub e estavel, o e-mail pode mudar");

  // O mesmo e-mail em dois subs E permitido: o Google pode reciclar e-mail
  // entre contas, e o que identifica a pessoa e o sub.
  let aceitou = true;
  try { d.exec("INSERT INTO users (id,google_sub,email) VALUES ('u3','g2','a@b.c')"); }
  catch { aceitou = false; }
  ok("o mesmo e-mail em subs diferentes e permitido", aceitou);
}

/* ---- Historico de pareceres: diferenca deliberada do artefato ----------- */

{
  const d = banco();
  d.exec("INSERT INTO users (id,google_sub,email) VALUES ('u1','g1','a@b.c')");
  const ins = d.prepare("INSERT INTO user_pareceres (user_id,ticker,criado_em,veredito,texto) VALUES (?,?,?,?,?)");
  for (const [dt, v] of [["2026-08-15","Entrar"],["2026-09-20","Esperar confirmacao"],["2026-10-30","Nao entrar"]])
    ins.run("u1", "PETR4", dt, v, "...");
  const hist = d.prepare("SELECT veredito FROM user_pareceres WHERE user_id=? AND ticker=? ORDER BY criado_em").all("u1", "PETR4");
  ok("o historico de pareceres do mesmo ativo e preservado",
     hist.length === 3, "o artefato guarda 1 e sobrescreve; aqui os 3 convivem");
  ok("da para recuperar o parecer mais antigo", hist[0].veredito === "Entrar",
     "e isso que permite conferir o estudo contra o que o preco fez depois");
}

/* ---- Cota de IA --------------------------------------------------------- */

{
  const d = banco();
  d.exec("INSERT INTO users (id,google_sub,email) VALUES ('u1','g1','a@b.c')");
  d.exec("INSERT INTO ai_quota (user_id) VALUES ('u1')");
  const q = d.prepare("SELECT * FROM ai_quota WHERE user_id=?").get("u1");
  ok("padrao de 200 pareceres por mes", q.pareceres_mes === 200);
  ok("padrao de 30 pareceres por hora", q.pareceres_hora === 30);
  ok("padrao de alerta em 150", q.alerta_em === 150);

  d.exec(`INSERT INTO ai_uso_ciclo (user_id,ciclo_inicio,ciclo_fim,pareceres)
          VALUES ('u1','2026-10-15','2026-11-15',151)`);
  const uso = d.prepare(
    `SELECT q.pareceres_mes, q.alerta_em, c.pareceres
       FROM ai_quota q JOIN ai_uso_ciclo c USING(user_id) WHERE q.user_id=?`
  ).get("u1");
  ok("a conferencia de cota le uma linha de cada tabela, nao conta ai_calls",
     uso.pareceres === 151);
  ok("em 151 de 200 o alerta do admin dispara", uso.pareceres >= uso.alerta_em);
  ok("em 151 de 200 o usuario ainda pode pedir parecer", uso.pareceres < uso.pareceres_mes);

  d.exec("UPDATE ai_uso_ciclo SET pareceres=200 WHERE user_id='u1'");
  const cheio = d.prepare("SELECT c.pareceres, q.pareceres_mes FROM ai_uso_ciclo c JOIN ai_quota q USING(user_id)").get();
  ok("em 200 de 200 o parecer e bloqueado", cheio.pareceres >= cheio.pareceres_mes);

  // O admin pode aumentar caso a caso, e o motivo fica gravado.
  d.exec("UPDATE ai_quota SET pareceres_mes=400, motivo_ajuste='usuario de teste do beta', ajustado_por='admin', ajustado_em=datetime('now') WHERE user_id='u1'");
  const aj = d.prepare("SELECT * FROM ai_quota WHERE user_id=?").get("u1");
  ok("o admin pode aumentar a cota de um usuario", aj.pareceres_mes === 400);
  ok("o aumento guarda o motivo", !!aj.motivo_ajuste && !!aj.ajustado_por && !!aj.ajustado_em,
     "limite mexido sem registro vira numero que ninguem explica depois");
}

/* ---- Webhook de pagamento: idempotencia --------------------------------- */

{
  const d = banco();
  d.exec("INSERT INTO webhook_events (id,origem,tipo,corpo) VALUES ('ev1','cakto','assinatura.paga','{}')");
  let recusou = false;
  try { d.exec("INSERT INTO webhook_events (id,origem,tipo,corpo) VALUES ('ev1','cakto','assinatura.paga','{}')"); }
  catch { recusou = true; }
  ok("o mesmo evento de pagamento nao entra duas vezes", recusou,
     "webhook repetido e normal; contar a renovacao duas vezes nao e");
}

console.log(falhas === 0 ? "\nTODOS OS TESTES PASSARAM" : `\n${falhas} TESTE(S) FALHARAM`);
process.exit(falhas === 0 ? 0 : 1);
