/*
 * Testes do login com Google.
 *
 * Tres coisas aqui, se quebrarem, quebram em silencio e caro:
 *   1. casar a pessoa pelo e-mail em vez do `sub` do Google
 *   2. guardar o identificador de sessao em claro no banco
 *   3. aceitar um id_token emitido para outro aplicativo
 * As tres tem teste proprio.
 */
import { bancoDeTeste } from "./ajuda-d1.mjs";
import {
  hash, lerCookie, montarCookie, conferirConfig, urlAutorizacao, urlDeRetorno,
  trocarCodigo, lerIdToken, validarPerfil, entrar, lerSessao, sair, limparSessoes,
  fimDoCiclo,
  COOKIE_SESSAO, COOKIE_STATE,
} from "../src/auth.js";
import { gravarAdmins } from "../src/acesso.js";

let falhas = 0;
function ok(nome, cond, extra = "") {
  console.log(`${cond ? "PASSOU" : "FALHOU"}  ${nome}${extra ? "  " + extra : ""}`);
  if (!cond) falhas++;
}

const ENV = {
  GOOGLE_CLIENT_ID: "123.apps.googleusercontent.com",
  GOOGLE_CLIENT_SECRET: "segredo-de-teste",
};
const URL_BASE = "https://gaiatrader.com.br/auth/google";

const b64url = (o) => Buffer.from(JSON.stringify(o), "utf8").toString("base64")
  .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fazerToken = (p) => `cabecalho.${b64url(p)}.assinatura`;
const perfilGoogle = (extra = {}) => ({
  iss: "https://accounts.google.com",
  aud: ENV.GOOGLE_CLIENT_ID,
  sub: "11223344556677889900",
  email: "mleifheit@gmail.com",
  email_verified: true,
  name: "Marcelo Leifheit",
  picture: "https://exemplo/foto.jpg",
  exp: Math.floor(Date.now() / 1000) + 3600,
  ...extra,
});

/* ---- Configuracao ------------------------------------------------------- */

{
  ok("avisa o que falta quando nao ha credencial",
     conferirConfig({}).faltando.join(",") === "GOOGLE_CLIENT_ID,GOOGLE_CLIENT_SECRET");
  ok("fica pronto com as duas credenciais", conferirConfig(ENV).pronto === true);
  ok("a url de retorno sai da origem do pedido",
     urlDeRetorno(ENV, URL_BASE) === "https://gaiatrader.com.br/auth/google/callback");
  ok("uma url de retorno configurada tem preferencia",
     urlDeRetorno({ ...ENV, OAUTH_REDIRECT_URI: "https://outro/x" }, URL_BASE) === "https://outro/x");
}

/* ---- URL de consentimento ----------------------------------------------- */

{
  const u = new URL(urlAutorizacao(ENV, URL_BASE, "estado-123"));
  ok("vai para o Google", u.origin === "https://accounts.google.com");
  ok("leva o identificador do aplicativo", u.searchParams.get("client_id") === ENV.GOOGLE_CLIENT_ID);
  ok("pede codigo, nao token", u.searchParams.get("response_type") === "code");
  ok("pede so openid, email e profile", u.searchParams.get("scope") === "openid email profile",
     "pedir permissao que nao se usa e pedir risco de graca");
  ok("leva o state", u.searchParams.get("state") === "estado-123");
  ok("nao pede acesso permanente", u.searchParams.get("access_type") === "online",
     "nao precisamos agir pela pessoa depois que ela sai");
  ok("o segredo NAO vai na url", !urlAutorizacao(ENV, URL_BASE, "x").includes(ENV.GOOGLE_CLIENT_SECRET));
}

/* ---- Cookies ------------------------------------------------------------ */

{
  const c = montarCookie(COOKIE_SESSAO, "abc", { maxAge: 100 });
  ok("o cookie de sessao e HttpOnly", /HttpOnly/.test(c), "script injetado nao le");
  ok("o cookie de sessao e Secure", /Secure/.test(c), "so viaja em HTTPS");
  ok("o cookie de sessao e SameSite=Lax", /SameSite=Lax/.test(c));
  ok("apagar manda Max-Age=0", /Max-Age=0/.test(montarCookie(COOKIE_SESSAO, "", { apagar: true })));

  ok("le o cookie certo entre varios",
     lerCookie("a=1; gt_sessao=xyz; b=2", COOKIE_SESSAO) === "xyz");
  ok("devolve nulo quando nao existe", lerCookie("a=1", COOKIE_SESSAO) === null);
  ok("aguenta cabecalho vazio", lerCookie("", COOKIE_SESSAO) === null && lerCookie(null, COOKIE_SESSAO) === null);
  ok("nao confunde nome parecido", lerCookie("gt_sessao_outro=nao; gt_sessao=sim", COOKIE_SESSAO) === "sim");
}

/* ---- ID token ----------------------------------------------------------- */

{
  const p = lerIdToken(fazerToken(perfilGoogle()));
  ok("decodifica o corpo do token", p.sub === "11223344556677889900");
  const comAcento = lerIdToken(fazerToken(perfilGoogle({ name: "João Conceição" })));
  ok("nome com acento chega inteiro", comAcento.name === "João Conceição",
     `veio ${comAcento.name}`);
  let e = null;
  try { lerIdToken("nao-e-um-token"); } catch (x) { e = x.message; }
  ok("token malformado e recusado", /malformado/.test(e || ""));
}

{
  const v = validarPerfil(perfilGoogle(), ENV);
  ok("perfil valido passa", v.sub === "11223344556677889900" && v.email === "mleifheit@gmail.com");
  ok("o e-mail vem normalizado em minusculas",
     validarPerfil(perfilGoogle({ email: "MLeifheit@Gmail.COM" }), ENV).email === "mleifheit@gmail.com");

  const recusa = (p) => { try { validarPerfil(p, ENV); return null; } catch (e) { return e.message; } };
  ok("token de OUTRO aplicativo e recusado",
     /não foi emitido para este aplicativo/.test(recusa(perfilGoogle({ aud: "999.apps.googleusercontent.com" })) || ""),
     "e o ataque que mais importa fechar aqui");
  ok("emissor diferente e recusado", /emissor/.test(recusa(perfilGoogle({ iss: "https://malvado.com" })) || ""));
  ok("token vencido e recusado",
     /vencido/.test(recusa(perfilGoogle({ exp: Math.floor(Date.now() / 1000) - 10 })) || ""));
  ok("token sem conta e recusado", /identificador de conta/.test(recusa(perfilGoogle({ sub: null })) || ""));
  ok("token sem e-mail e recusado", /e-mail/.test(recusa(perfilGoogle({ email: null })) || ""));
  ok("os dois emissores que o Google usa sao aceitos",
     !!validarPerfil(perfilGoogle({ iss: "accounts.google.com" }), ENV));
}

/* ---- Troca do codigo ---------------------------------------------------- */

{
  let visto = null;
  const buscar = async (u, opts) => {
    visto = { url: u, corpo: String(opts.body) };
    return { ok: true, json: async () => ({ id_token: fazerToken(perfilGoogle()), access_token: "a" }) };
  };
  const r = await trocarCodigo(ENV, URL_BASE, "codigo-abc", buscar);
  ok("troca o codigo e recebe o id_token", !!r.id_token);
  ok("manda o segredo no CORPO, nao na url",
     !visto.url.includes("segredo") && visto.corpo.includes("client_secret=segredo-de-teste"));
  ok("manda o codigo recebido", visto.corpo.includes("code=codigo-abc"));
  ok("declara o tipo de concessao", visto.corpo.includes("grant_type=authorization_code"));
}

{
  const recusou = async (resp) => {
    try { await trocarCodigo(ENV, URL_BASE, "x", async () => resp); return null; }
    catch (e) { return e.message; }
  };
  ok("erro do Google vira mensagem legivel",
     /recusou a troca/.test(await recusou({ ok: false, status: 400, json: async () => ({ error: "invalid_grant" }) }) || ""));
  ok("resposta sem id_token e recusada",
     /não devolveu id_token/.test(await recusou({ ok: true, json: async () => ({ access_token: "a" }) }) || ""));
}

/* ---- Entrar: primeiro login --------------------------------------------- */

{
  const d1 = bancoDeTeste();
  await gravarAdmins(d1, ["mleifheit@gmail.com", "laghettogolden@gmail.com"]);
  const perfil = validarPerfil(perfilGoogle(), ENV);

  const r = await entrar(d1, perfil, { ip: "1.2.3.4", agente: "Chrome" });
  ok("o primeiro login cria o usuario", r.novo === true);
  ok("o e-mail da lista nasce admin", r.usuario.papel === "admin");

  const assin = d1.cru.prepare("SELECT * FROM subscriptions WHERE user_id=?").get(r.usuario.id);
  ok("nasce com assinatura de beta", assin && assin.status === "beta",
     "beta fechado: acesso completo ate a cobranca comecar");
  ok("o dia de cobranca vem do dia do cadastro", assin.dia_cobranca > 0);

  const cota = d1.cru.prepare("SELECT * FROM ai_quota WHERE user_id=?").get(r.usuario.id);
  ok("nasce com a cota padrao", cota && cota.pareceres_mes === 200);

  const ciclo = d1.cru.prepare("SELECT * FROM ai_uso_ciclo WHERE user_id=?").get(r.usuario.id);
  ok("nasce com o ciclo aberto", !!ciclo,
     "sem esta linha a conferencia de cota nao teria o que ler");
  ok("o ciclo termina um mes depois", ciclo.ciclo_fim > ciclo.ciclo_inicio);
}

{
  const d1 = bancoDeTeste();
  await gravarAdmins(d1, ["mleifheit@gmail.com"]);
  const r = await entrar(d1, validarPerfil(perfilGoogle({ email: "outra@pessoa.com" }), ENV));
  ok("e-mail fora da lista nasce usuario comum", r.usuario.papel === "usuario");
}

/* ---- A sessao nao fica em claro no banco -------------------------------- */

{
  const d1 = bancoDeTeste();
  await gravarAdmins(d1, ["mleifheit@gmail.com"]);
  const r = await entrar(d1, validarPerfil(perfilGoogle(), ENV));

  const linha = d1.cru.prepare("SELECT id FROM sessions").get();
  ok("o identificador da sessao NAO fica em claro no banco", linha.id !== r.sessao,
     "se o banco vazar, o que esta la nao serve para entrar como ninguem");
  ok("o que esta no banco e o hash do cookie", linha.id === await hash(r.sessao));
  ok("o hash tem 64 caracteres (SHA-256)", linha.id.length === 64);
  ok("o cookie cru tem 64 caracteres (32 bytes)", r.sessao.length === 64);

  const u = await lerSessao(d1, r.sessao);
  ok("a sessao crua abre o usuario certo", u && u.id === r.usuario.id);
  ok("o hash NAO serve como cookie", (await lerSessao(d1, linha.id)) === null,
     "senao guardar o hash nao protegeria nada");
  ok("cookie inventado nao abre nada", (await lerSessao(d1, "a".repeat(64))) === null);
  ok("sem cookie nao abre nada", (await lerSessao(d1, null)) === null);
}

/* ---- Reconhecimento pelo sub, nunca pelo e-mail ------------------------- */

{
  const d1 = bancoDeTeste();
  await gravarAdmins(d1, ["mleifheit@gmail.com"]);

  const um = await entrar(d1, validarPerfil(perfilGoogle(), ENV));
  // A MESMA conta do Google, com e-mail trocado pela pessoa.
  const dois = await entrar(d1, validarPerfil(perfilGoogle({ email: "novo@endereco.com" }), ENV));

  ok("a mesma conta nao vira dois usuarios", dois.novo === false && dois.usuario.id === um.usuario.id,
     "casar por e-mail criaria duplicado no dia que alguem trocasse o endereco");
  ok("o e-mail novo e gravado", dois.usuario.email === "novo@endereco.com");
  ok("so existe um usuario no banco",
     d1.cru.prepare("SELECT COUNT(*) n FROM users").get().n === 1);
  ok("sair da lista de admins rebaixa no proximo login", dois.usuario.papel === "usuario",
     "o papel e recalculado todo login, senao a lista vira enfeite");
}

{
  // E o contrario: entrar na lista promove no proximo login.
  const d1 = bancoDeTeste();
  await gravarAdmins(d1, ["ninguem@exemplo.com"]);
  const um = await entrar(d1, validarPerfil(perfilGoogle(), ENV));
  ok("comeca como usuario comum", um.usuario.papel === "usuario");

  await gravarAdmins(d1, ["ninguem@exemplo.com", "mleifheit@gmail.com"]);
  const dois = await entrar(d1, validarPerfil(perfilGoogle(), ENV));
  ok("entrar na lista promove no proximo login", dois.usuario.papel === "admin");
  ok("continua sendo o mesmo usuario", dois.usuario.id === um.usuario.id);
}

{
  // Duas contas do Google diferentes sao duas pessoas, mesmo com nome igual.
  const d1 = bancoDeTeste();
  await gravarAdmins(d1, ["mleifheit@gmail.com"]);
  await entrar(d1, validarPerfil(perfilGoogle(), ENV));
  await entrar(d1, validarPerfil(perfilGoogle({ sub: "999", email: "laghettogolden@gmail.com" }), ENV));
  ok("duas contas do Google viram dois usuarios",
     d1.cru.prepare("SELECT COUNT(*) n FROM users").get().n === 2);
}

/* ---- Sair e faxina ------------------------------------------------------ */

{
  const d1 = bancoDeTeste();
  await gravarAdmins(d1, ["mleifheit@gmail.com"]);
  const r = await entrar(d1, validarPerfil(perfilGoogle(), ENV));
  ok("a sessao esta aberta", !!(await lerSessao(d1, r.sessao)));
  await sair(d1, r.sessao);
  ok("depois de sair a sessao nao abre mais", (await lerSessao(d1, r.sessao)) === null);
  ok("sair nao apaga o usuario", d1.cru.prepare("SELECT COUNT(*) n FROM users").get().n === 1,
     "sair e diferente de perder os estudos");
}

{
  const d1 = bancoDeTeste();
  await gravarAdmins(d1, ["mleifheit@gmail.com"]);
  const r = await entrar(d1, validarPerfil(perfilGoogle(), ENV));
  d1.cru.exec(`UPDATE sessions SET expira_em = '2020-01-01T00:00:00.000Z'`);
  ok("sessao vencida nao abre", (await lerSessao(d1, r.sessao)) === null);
  await limparSessoes(d1);
  ok("a faxina remove a sessao vencida",
     d1.cru.prepare("SELECT COUNT(*) n FROM sessions").get().n === 0);
}

/* ---- Hash --------------------------------------------------------------- */

{
  ok("o hash e estavel", (await hash("abc")) === (await hash("abc")));
  ok("entradas diferentes dao hashes diferentes", (await hash("abc")) !== (await hash("abd")));
  ok("o hash nao contem a entrada", !(await hash("segredo")).includes("segredo"));
}

/* ---- Ciclo de cobranca: as bordas do calendario ------------------------- */

{
  /*
   * A versao ingenua disto (setUTCMonth(mes + 1)) parece certa e esta errada
   * nas bordas, porque o JavaScript transborda em silencio quando o dia nao
   * existe no mes de destino. O Marcelo se cadastrou num dia 31 e o defeito
   * apareceu na primeira linha gravada no banco de producao.
   */
  const casos = [
    ["2026-01-15", "2026-02-15", "mes comum, dia que existe nos dois"],
    ["2026-01-29", "2026-02-28", "29/01 em ano comum: fevereiro nao tem 29"],
    ["2026-01-30", "2026-02-28", "30/01: prende no ultimo de fevereiro"],
    ["2026-01-31", "2026-02-28", "31/01: prende no ultimo de fevereiro"],
    ["2024-01-31", "2024-02-29", "31/01 em ano BISSEXTO: fevereiro tem 29"],
    ["2026-03-31", "2026-04-30", "31/03: abril tem 30"],
    ["2026-05-31", "2026-06-30", "31/05: junho tem 30"],
    ["2026-08-31", "2026-09-30", "31/08: setembro tem 30"],
    ["2026-10-31", "2026-11-30", "31/10: novembro tem 30, o caso do Marcelo"],
    ["2026-12-15", "2027-01-15", "virada de ano"],
    ["2026-12-31", "2027-01-31", "31/12: janeiro tem 31, nao prende"],
  ];
  let erros = 0;
  for (const [de, esperado, porque] of casos) {
    const veio = fimDoCiclo(de);
    if (veio !== esperado) {
      erros++;
      console.log(`   ${de} -> ${veio}, esperado ${esperado}  (${porque})`);
    }
  }
  ok("o ciclo prende o dia ao ultimo do mes alvo, nas 11 bordas", erros === 0);

  // A prova que mais importa: nenhum ciclo pode pular um mes inteiro.
  let pulou = null;
  for (let m = 1; m <= 12; m++) {
    for (const dia of [28, 29, 30, 31]) {
      const ini = `2026-${String(m).padStart(2, "0")}-${dia}`;
      // O JavaScript aceita "2026-02-29" e rola para marco em silencio, entao
      // conferir por NaN nao basta: a data precisa sobreviver a ida e volta.
      const t = new Date(ini + "T00:00:00Z");
      if (Number.isNaN(t.getTime()) || t.toISOString().slice(0, 10) !== ini) continue;
      const fim = fimDoCiclo(ini);
      const mesIni = Number(ini.slice(5, 7)), mesFim = Number(fim.slice(5, 7));
      const avanco = (mesFim - mesIni + 12) % 12;
      if (avanco !== 1) { pulou = `${ini} -> ${fim}`; break; }
    }
    if (pulou) break;
  }
  ok("nenhum ciclo avanca mais de um mes", pulou === null,
     pulou ? `pulou em ${pulou}` : "testado dia 28 a 31 de todos os meses de 2026");

  let curto = null;
  for (let m = 1; m <= 12; m++) {
    const ini = `2026-${String(m).padStart(2, "0")}-15`;
    const dias = (Date.parse(fimDoCiclo(ini)) - Date.parse(ini)) / 86400000;
    if (dias < 28 || dias > 31) { curto = `${ini}: ${dias} dias`; break; }
  }
  ok("todo ciclo tem entre 28 e 31 dias", curto === null, curto || "");
}

{
  // E o que o usuario novo recebe de verdade.
  const d1 = bancoDeTeste();
  await gravarAdmins(d1, ["mleifheit@gmail.com"]);
  const agora = new Date("2026-10-31T04:25:00Z");
  const r = await entrar(d1, validarPerfil(perfilGoogle(), ENV), { agora });
  const s = d1.cru.prepare("SELECT * FROM subscriptions WHERE user_id=?").get(r.usuario.id);
  ok("quem assina dia 31 de outubro tem o ciclo ate 30 de novembro",
     s.proxima_cobranca === "2026-11-30", `veio ${s.proxima_cobranca}`);
  const c = d1.cru.prepare("SELECT * FROM ai_uso_ciclo WHERE user_id=?").get(r.usuario.id);
  ok("o ciclo de uso termina na mesma data da cobranca",
     c.ciclo_fim === s.proxima_cobranca);
}

{
  const recusa = (d) => { try { fimDoCiclo(d); return null; } catch (e) { return e.message; } };
  ok("data que nao existe no calendario e recusada",
     /invalida/.test(recusa("2026-02-29") || ""),
     "o JavaScript aceitaria e rolaria para marco em silencio");
  ok("29 de fevereiro em ano bissexto e aceito", fimDoCiclo("2024-02-29") === "2024-03-29");
  ok("texto que nao e data e recusado", /invalida/.test(recusa("qualquer coisa") || ""));
  ok("mes 13 e recusado", /invalida/.test(recusa("2026-13-01") || ""));
}

console.log(falhas === 0 ? "\nTODOS OS TESTES PASSARAM" : `\n${falhas} TESTE(S) FALHARAM`);
process.exit(falhas === 0 ? 0 : 1);
