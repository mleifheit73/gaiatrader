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
  if (!assinatura) return SO_LEITURA;            // cadastrou e nunca assinou
  if (assinatura.status === "beta") return COMPLETO;
  if (assinatura.status === "ativa") return COMPLETO;
  return SO_LEITURA;                              // atrasada, cancelada, qualquer outro
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
