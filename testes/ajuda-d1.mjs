/*
 * Adaptador que imita a interface do D1 sobre o SQLite do Node.
 *
 * POR QUE EXISTE: src/consumo.js fala a lingua do D1
 * (prepare().bind().all()/first()/run() e batch()). Sem este adaptador, a
 * unica forma de testar aquele codigo seria rodando contra o banco de
 * producao do Marcelo, que e exatamente o que nao se deve fazer.
 *
 * Ele nao imita o D1 inteiro: so a parte que o nosso codigo usa.
 */
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";

class Preparada {
  constructor(db, sql) { this.db = db; this.sql = sql; this.args = []; }
  bind(...args) { this.args = args; return this; }
  all()   { return { results: this.db.prepare(this.sql).all(...this.args), success: true }; }
  first() { return this.db.prepare(this.sql).get(...this.args) ?? null; }
  run()   { this.db.prepare(this.sql).run(...this.args); return { success: true }; }
}

export function bancoDeTeste() {
  const db = new DatabaseSync(":memory:");
  for (const f of fs.readdirSync("migrations").filter((x) => x.endsWith(".sql")).sort()) {
    db.exec(fs.readFileSync("migrations/" + f, "utf8"));
  }
  return {
    cru: db,
    prepare: (sql) => new Preparada(db, sql),
    batch: (stmts) => stmts.map((s) => s.run()),
  };
}

/** Cria um usuario pronto para os testes, com assinatura e ciclo abertos. */
export function criarUsuario(d1, id, { email, assinatura = "ativa", ciclo = true } = {}) {
  d1.cru.exec(
    `INSERT INTO users (id,google_sub,email) VALUES ('${id}','sub-${id}','${email || id + "@teste.com"}')`
  );
  if (assinatura) {
    d1.cru.exec(
      `INSERT INTO subscriptions (user_id,plano,status,inicio,dia_cobranca)
       VALUES ('${id}','mensal','${assinatura}','2026-10-15',15)`
    );
  }
  if (ciclo) {
    d1.cru.exec(
      `INSERT INTO ai_uso_ciclo (user_id,ciclo_inicio,ciclo_fim)
       VALUES ('${id}','2026-10-15','2026-11-15')`
    );
  }
  return id;
}
