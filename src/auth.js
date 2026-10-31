/*
 * ENTRAR COM GOOGLE
 *
 * Fluxo de codigo de autorizacao (authorization code), que e o certo para
 * um servidor que guarda segredo. O navegador nunca ve o segredo nem o
 * token do Google: ele recebe so um cookie de sessao nosso.
 *
 * O caminho inteiro:
 *
 *   1. /auth/google          sorteamos um `state`, gravamos num cookie curto
 *                            e mandamos a pessoa para a tela do Google
 *   2. tela do Google        ela escolhe a conta e autoriza
 *   3. /auth/google/callback o Google volta com `code` e `state`
 *                            conferimos o state, trocamos o code por tokens
 *                            servidor-a-servidor, lemos o perfil, criamos ou
 *                            achamos o usuario, abrimos sessao e gravamos o
 *                            cookie
 *
 * DECISOES DE SEGURANCA, cada uma com o motivo:
 *
 *   O identificador da sessao e guardado no banco em HASH, nunca em claro.
 *   Se o banco vazar, os identificadores que estao la nao servem para
 *   entrar como ninguem, porque o cookie real nao pode ser reconstruido a
 *   partir do hash.
 *
 *   O `state` existe contra falsificacao de requisicao: sem ele, um site
 *   qualquer poderia disparar o retorno do login e amarrar a sessao da
 *   vitima a uma conta do atacante.
 *
 *   A pessoa e reconhecida pelo `sub` do Google, nunca pelo e-mail. O
 *   e-mail de uma conta Google pode mudar; o sub nao. Casar por e-mail
 *   criaria usuario duplicado no dia que alguem trocasse o endereco.
 *
 *   O papel de administrador e recalculado a CADA login, nao so no
 *   primeiro. Assim, por dos um e-mail na lista promove a pessoa no proximo
 *   login dela, e tirar da lista rebaixa. Sem isso, a lista viraria enfeite.
 */

import { papelDoLogin, lerAdmins } from "./acesso.js";

const GOOGLE_AUTH  = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";
const EMISSORES    = ["accounts.google.com", "https://accounts.google.com"];

export const COOKIE_SESSAO = "gt_sessao";
export const COOKIE_STATE  = "gt_state";
const DIAS_DE_SESSAO = 30;

/* ========================================================================
   FERRAMENTAS
   ======================================================================== */

const aleatorio = (bytes = 32) =>
  [...crypto.getRandomValues(new Uint8Array(bytes))]
    .map((b) => b.toString(16).padStart(2, "0")).join("");

/** SHA-256 em hexadecimal. O identificador de sessao entra aqui antes do banco. */
export async function hash(texto) {
  const dados = new TextEncoder().encode(texto);
  const d = await crypto.subtle.digest("SHA-256", dados);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Le um cookie do cabecalho. */
export function lerCookie(cabecalho, nome) {
  for (const parte of String(cabecalho || "").split(";")) {
    const i = parte.indexOf("=");
    if (i < 0) continue;
    if (parte.slice(0, i).trim() === nome) return decodeURIComponent(parte.slice(i + 1).trim());
  }
  return null;
}

/**
 * Monta um cookie.
 *
 * HttpOnly: o JavaScript da pagina nao le, entao um script injetado nao
 * rouba a sessao. Secure: so viaja em HTTPS. SameSite=Lax: nao e enviado
 * em requisicao de outro site, menos na navegacao de topo, que e o que o
 * retorno do Google precisa.
 */
export function montarCookie(nome, valor, { maxAge, apagar = false } = {}) {
  const p = [
    `${nome}=${apagar ? "" : encodeURIComponent(valor)}`,
    "Path=/", "HttpOnly", "Secure", "SameSite=Lax",
    apagar ? "Max-Age=0" : `Max-Age=${maxAge}`,
  ];
  return p.join("; ");
}

/* ========================================================================
   CONFIGURACAO
   ======================================================================== */

export function conferirConfig(env) {
  const faltando = [];
  if (!env.GOOGLE_CLIENT_ID) faltando.push("GOOGLE_CLIENT_ID");
  if (!env.GOOGLE_CLIENT_SECRET) faltando.push("GOOGLE_CLIENT_SECRET");
  return { pronto: faltando.length === 0, faltando };
}

export const urlDeRetorno = (env, url) =>
  env.OAUTH_REDIRECT_URI || `${new URL(url).origin}/auth/google/callback`;

/** URL da tela de consentimento do Google. */
export function urlAutorizacao(env, url, state) {
  const p = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: urlDeRetorno(env, url),
    response_type: "code",
    scope: "openid email profile",
    state,
    // Sem refresh token: nao precisamos agir pela pessoa depois que ela sai.
    // Pedir acesso que nao se usa e pedir risco de graca.
    access_type: "online",
    prompt: "select_account",
  });
  return `${GOOGLE_AUTH}?${p}`;
}

/* ========================================================================
   TROCA DO CODIGO E LEITURA DO PERFIL
   ======================================================================== */

/**
 * Troca o codigo pelo token, servidor a servidor.
 * `buscar` e injetavel para o teste nao precisar da internet.
 */
export async function trocarCodigo(env, url, code, buscar = fetch) {
  const r = await buscar(GOOGLE_TOKEN, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: urlDeRetorno(env, url),
      grant_type: "authorization_code",
    }),
  });
  const corpo = await r.json().catch(() => ({}));
  if (!r.ok) {
    throw new Error(`o Google recusou a troca do código: ${corpo.error || r.status}`);
  }
  if (!corpo.id_token) throw new Error("o Google não devolveu id_token");
  return corpo;
}

/** Decodifica o corpo do ID token. NAO confere assinatura: ver validarPerfil. */
export function lerIdToken(idToken) {
  const partes = String(idToken || "").split(".");
  if (partes.length !== 3) throw new Error("id_token malformado");
  const b64 = partes[1].replace(/-/g, "+").replace(/_/g, "/");
  const json = atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, "="));
  // atob devolve bytes como caracteres: isto remonta o UTF-8, senao nome
  // com acento chega corrompido.
  const bytes = Uint8Array.from(json, (c) => c.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}

/**
 * Confere as afirmacoes do ID token.
 *
 * POR QUE NAO CONFERIMOS A ASSINATURA: este token veio direto do endpoint
 * do Google, por HTTPS, numa chamada que nos fizemos usando o nosso
 * segredo. Nao passou pelo navegador, entao nao houve por onde ser
 * adulterado. A propria documentacao do Google dispensa a verificacao de
 * assinatura neste caso.
 *
 * Mesmo assim conferimos emissor, destinatario e validade. Custa nada e
 * pega configuracao errada, que e o defeito provavel aqui, nao ataque.
 */
export function validarPerfil(p, env, agora = Date.now()) {
  if (!p || !p.sub) throw new Error("id_token sem identificador de conta");
  if (!EMISSORES.includes(p.iss)) throw new Error(`emissor inesperado: ${p.iss}`);
  if (p.aud !== env.GOOGLE_CLIENT_ID) throw new Error("este token não foi emitido para este aplicativo");
  if (p.exp && p.exp * 1000 < agora) throw new Error("id_token vencido");
  if (!p.email) throw new Error("a conta do Google não devolveu e-mail");
  return {
    sub: p.sub,
    email: String(p.email).trim().toLowerCase(),
    email_verified: p.email_verified !== false,
    nome: p.name || null,
    foto: p.picture || null,
  };
}

/* ========================================================================
   ENTRAR
   ======================================================================== */

/** Primeiro dia do proximo ciclo, a partir de uma data. */
function fimDoCiclo(inicio) {
  const d = new Date(inicio + "T00:00:00Z");
  d.setUTCMonth(d.getUTCMonth() + 1);
  return d.toISOString().slice(0, 10);
}

/**
 * Acha ou cria o usuario e abre a sessao.
 *
 * Devolve { usuario, sessao, novo }. `sessao` e o valor CRU, que vai para o
 * cookie; o banco guarda so o hash dele.
 */
export async function entrar(db, perfil, { ip = null, agente = null, agora = new Date() } = {}) {
  const admins = await lerAdmins(db);
  const papel = papelDoLogin(perfil, admins);

  // A pessoa e reconhecida pelo sub, nunca pelo e-mail.
  let u = await db.prepare(`SELECT * FROM users WHERE google_sub = ?`).bind(perfil.sub).first();
  const novo = !u;

  if (novo) {
    const id = crypto.randomUUID();
    const hoje = agora.toISOString().slice(0, 10);
    await db.batch([
      db.prepare(
        `INSERT INTO users (id, google_sub, email, nome, foto_url, papel, ultimo_acesso)
         VALUES (?,?,?,?,?,?, datetime('now'))`
      ).bind(id, perfil.sub, perfil.email, perfil.nome, perfil.foto, papel),
      // Beta fechado: quem entra tem acesso completo ate a cobranca comecar.
      db.prepare(
        `INSERT INTO subscriptions (user_id, plano, status, inicio, dia_cobranca, proxima_cobranca)
         VALUES (?, 'beta', 'beta', ?, ?, ?)`
      ).bind(id, hoje, Number(hoje.slice(8, 10)), fimDoCiclo(hoje)),
      db.prepare(`INSERT INTO ai_quota (user_id) VALUES (?)`).bind(id),
      // Sem esta linha a conferencia de cota nao teria o que ler.
      db.prepare(
        `INSERT INTO ai_uso_ciclo (user_id, ciclo_inicio, ciclo_fim) VALUES (?,?,?)`
      ).bind(id, hoje, fimDoCiclo(hoje)),
    ]);
    u = await db.prepare(`SELECT * FROM users WHERE id = ?`).bind(id).first();
  } else {
    // O e-mail, o nome e a foto podem ter mudado no Google. O papel e
    // recalculado todo login, para a lista de admins valer de verdade.
    await db
      .prepare(
        `UPDATE users SET email = ?, nome = ?, foto_url = ?, papel = ?, ultimo_acesso = datetime('now')
          WHERE id = ?`
      )
      .bind(perfil.email, perfil.nome, perfil.foto, papel, u.id)
      .run();
    u = { ...u, email: perfil.email, nome: perfil.nome, foto_url: perfil.foto, papel };
  }

  const cru = aleatorio(32);
  const expira = new Date(agora.getTime() + DIAS_DE_SESSAO * 86400000);
  await db
    .prepare(`INSERT INTO sessions (id, user_id, expira_em, ip, agente) VALUES (?,?,?,?,?)`)
    .bind(await hash(cru), u.id, expira.toISOString(), ip, agente ? String(agente).slice(0, 300) : null)
    .run();

  return { usuario: u, sessao: cru, novo, maxAge: DIAS_DE_SESSAO * 86400 };
}

/** Quem esta nesta sessao. Devolve null quando nao ha, venceu ou sumiu. */
export async function lerSessao(db, cru) {
  if (!cru) return null;
  const r = await db
    .prepare(
      `SELECT u.*, s.id AS sessao_id, s.expira_em
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.id = ? AND s.expira_em > ?`
    )
    .bind(await hash(cru), new Date().toISOString())
    .first();
  return r || null;
}

export async function sair(db, cru) {
  if (!cru) return false;
  await db.prepare(`DELETE FROM sessions WHERE id = ?`).bind(await hash(cru)).run();
  return true;
}

/** Faxina das sessoes vencidas. Chamada pela varredura, nao a cada acesso. */
export async function limparSessoes(db) {
  await db.prepare(`DELETE FROM sessions WHERE expira_em <= ?`).bind(new Date().toISOString()).run();
}

export { aleatorio };
