/*
 * NIVEIS DE ACESSO
 *
 * Regra definida pelo Marcelo em 30/10/2026:
 *
 *   Assinante atrasado NAO e bloqueado no login. Ele entra, enxerga tudo o
 *   que construiu, e perde duas coisas: nao gasta credito de IA e nao salva
 *   nada novo. Os dados dele continuam inteiros, com um convite a
 *   regularizar.
 *
 * POR QUE: bloquear o login do inadimplente o impede de entrar para ver por
 * que foi bloqueado e para pagar, que e exatamente a hora em que mais se
 * quer que ele entre. E apagar o que ele construiu transformaria uma fatura
 * atrasada numa perda permanente de estudo, o que nenhum trader perdoa.
 *
 * SEPARACAO QUE ESTE ARQUIVO MANTEM:
 *   autenticar  quem a pessoa e            -> Google
 *   autorizar   o que ela pode fazer aqui  -> este arquivo
 */

/** Niveis, do mais restrito ao mais amplo. */
export const SEM_ACESSO = "sem_acesso";   // bloqueado pelo admin, ou sessao invalida
export const SO_LEITURA = "so_leitura";   // atrasado ou cancelado: le tudo, nao escreve, nao gasta IA
export const COMPLETO   = "completo";     // beta ou assinatura ativa

/**
 * Nivel de acesso de um usuario.
 *
 * PADRAO SEGURO: qualquer estado que nao seja reconhecido cai em SO_LEITURA,
 * nunca em COMPLETO. Um defeito aqui que errasse para o lado permissivo
 * gastaria dinheiro silenciosamente; errando para o lado restritivo, o
 * usuario reclama e nos corrigimos.
 */
export function nivel(user, assinatura) {
  if (!user || user.ativo === 0) return SEM_ACESSO;
  // Administrador tem acesso completo sem assinatura. Ele e o dono do
  // sistema, nao um cliente dele. Mas repare que a COTA de IA continua
  // valendo para ele (ver podePedirParecer): e assim que o custo dele
  // aparece medido na tela de consumo junto com o de todo mundo, que e o
  // ponto inteiro do beta.
  if (user.papel === "admin") return COMPLETO;
  if (!assinatura) return SO_LEITURA;            // cadastrou e nunca assinou
  if (assinatura.status === "beta") return COMPLETO;
  if (assinatura.status === "ativa") return COMPLETO;
  return SO_LEITURA;                              // atrasada, cancelada, qualquer outro
}

export const ehAdmin = (user) => !!user && user.papel === "admin";

/* ========================================================================
   QUEM E ADMINISTRADOR

   O Google so devolve o identificador estavel da conta (o `sub`) no
   PRIMEIRO login. Por isso nao da para criar a linha do administrador
   antes dele entrar: o campo obrigatorio ainda nao existe.
   
   A solucao e pre-autorizar o e-mail. A lista fica na tabela `config`, que
   o administrador edita sem precisar de deploy, e o primeiro login com um
   e-mail da lista ja nasce com papel de admin.

   DUAS CONDICOES, as duas obrigatorias:

   1. o e-mail tem que estar na lista
   2. o Google tem que ter marcado o e-mail como VERIFICADO

   Sem a segunda, bastaria alguem conseguir uma conta que alegue aquele
   e-mail para virar administrador do sistema. O `email_verified` do Google
   e o que amarra o endereco a uma caixa que a pessoa controla de verdade.
   ======================================================================== */

export const CHAVE_ADMINS = "admin.emails";

/** Normaliza para comparar: minusculas e sem espaco em volta. */
const normaliza = (e) => String(e || "").trim().toLowerCase();

/**
 * Qual papel este login do Google deve receber.
 *
 * @param perfil  { email, email_verified } como o Google devolve
 * @param lista   e-mails pre-autorizados
 */
export function papelDoLogin(perfil, lista) {
  const email = normaliza(perfil && perfil.email);
  if (!email) return "usuario";
  if (perfil.email_verified === false) return "usuario";
  const autorizados = (lista || []).map(normaliza).filter(Boolean);
  return autorizados.includes(email) ? "admin" : "usuario";
}

/** Le a lista de e-mails pre-autorizados da tabela config. */
export async function lerAdmins(db) {
  const r = await db.prepare(`SELECT valor FROM config WHERE chave = ?`).bind(CHAVE_ADMINS).first();
  if (!r || !r.valor) return [];
  return String(r.valor).split(",").map(normaliza).filter(Boolean);
}

/** Grava a lista. Recusa lista vazia, que trancaria todo mundo para fora. */
export async function gravarAdmins(db, emails) {
  const limpos = [...new Set((emails || []).map(normaliza).filter(Boolean))];
  if (!limpos.length) throw new Error("a lista de administradores nao pode ficar vazia");
  for (const e of limpos) {
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) throw new Error(`e-mail invalido: ${e}`);
  }
  await db
    .prepare(
      `INSERT INTO config (chave, valor, updated_at) VALUES (?, ?, datetime('now'))
         ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor, updated_at = datetime('now')`
    )
    .bind(CHAVE_ADMINS, limpos.join(","))
    .run();
  return limpos;
}

export const podeEntrar   = (n) => n !== SEM_ACESSO;
export const podeLer      = (n) => n !== SEM_ACESSO;
export const podeEscrever = (n) => n === COMPLETO;
export const podeGastarIA = (n) => n === COMPLETO;

/**
 * Mensagem para a tela, quando o acesso e limitado.
 * Devolve null quando esta tudo certo, para a tela nao mostrar nada.
 */
export function aviso(n, assinatura) {
  if (n === COMPLETO) return null;
  if (n === SEM_ACESSO) return {
    titulo: "Conta bloqueada",
    texto: "Esta conta foi bloqueada. Entre em contato pelo contato@gaiatrader.com.br.",
    acao: null,
  };
  const cancelada = assinatura && assinatura.status === "cancelada";
  return {
    titulo: cancelada ? "Assinatura cancelada" : "Assinatura em atraso",
    texto: "Seus estudos, desenhos, pareceres e o diario continuam aqui, " +
           "inteiros. Enquanto a assinatura nao for regularizada, voce pode " +
           "consultar tudo, mas nao salvar alteracoes nem pedir analises de IA.",
    acao: "Regularizar assinatura",
  };
}

/* ========================================================================
   COTA DE IA

   A conferencia le UMA linha de ai_quota e UMA de ai_uso_ciclo, nunca conta
   ai_calls. Contar custaria centenas de linhas lidas por chamada, e o D1
   cobra por linha lida.
   ======================================================================== */

/**
 * Pode pedir um parecer agora?
 *
 * @param n      nivel de acesso
 * @param cota   linha de ai_quota
 * @param ciclo  linha de ai_uso_ciclo (uso no ciclo de cobranca atual)
 * @param hora   linha de ai_uso_hora da hora corrente, ou null
 * @returns { permitido, motivo, usados, limite, restantes }
 */
export function podePedirParecer(n, cota, ciclo, hora) {
  const limiteMes  = cota ? cota.pareceres_mes  : 200;
  const limiteHora = cota ? cota.pareceres_hora : 30;
  const usadosMes  = ciclo ? ciclo.pareceres : 0;
  const usadosHora = hora  ? hora.pareceres  : 0;
  const base = { usados: usadosMes, limite: limiteMes, restantes: Math.max(0, limiteMes - usadosMes) };

  if (!podeGastarIA(n)) {
    return { ...base, permitido: false, motivo: "assinatura" };
  }
  if (usadosHora >= limiteHora) {
    return { ...base, permitido: false, motivo: "limite_hora",
             usadosHora, limiteHora };
  }
  if (usadosMes >= limiteMes) {
    return { ...base, permitido: false, motivo: "limite_mes" };
  }
  return { ...base, permitido: true, motivo: null };
}

/** Texto para o usuario quando o parecer e recusado. */
export function motivoEmTexto(r) {
  switch (r.motivo) {
    case "assinatura":
      return "As analises de IA ficam suspensas enquanto a assinatura nao for regularizada.";
    case "limite_hora":
      return `Voce pediu ${r.usadosHora} pareceres nesta hora, que e o limite. ` +
             "Tente de novo na proxima hora.";
    case "limite_mes":
      return `Voce usou os ${r.limite} pareceres do seu ciclo. ` +
             "A cota renova na data da sua proxima cobranca.";
    default:
      return null;
  }
}

/**
 * O usuario merece alerta no painel do admin?
 * Dispara uma vez por ciclo, para nao virar ruido.
 */
export function precisaAlertarAdmin(cota, ciclo) {
  if (!cota || !ciclo) return false;
  if (ciclo.alerta_enviado) return false;
  return ciclo.pareceres >= cota.alerta_em;
}

/**
 * Escrita de CONTEUDO do usuario (desenho, trade, configuracao, carteira).
 *
 * Nao confundir com escrita de sistema: sessao, ultimo_acesso e os
 * contadores continuam gravando em qualquer nivel, senao o proprio login
 * do inadimplente pararia de funcionar.
 */
export function podeSalvarConteudo(n) {
  return podeEscrever(n);
}
