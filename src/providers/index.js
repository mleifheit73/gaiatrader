/**
 * Selecao do provedor de cotacoes.
 *
 * Este arquivo e o unico ponto do sistema que sabe qual provedor esta em uso.
 * Trocar de provedor e trocar a linha do PADRAO abaixo, depois de escrever o
 * novo provedor cumprindo o mesmo contrato de yahoo.js.
 *
 * O resto do sistema fala com `getProvider()` e nunca com um provedor concreto.
 */

import { yahoo } from "./yahoo.js";
import { mock } from "./mock.js";

const PROVEDORES = {
  yahoo,
  mock, // deterministico, so para teste; nunca como padrao
};

const PADRAO = "yahoo";

/**
 * @param {string} [nome] force um provedor especifico; por padrao usa a
 *   variavel de ambiente DATA_PROVIDER, e se ela nao existir, o PADRAO.
 */
export function getProvider(nome, env) {
  const escolhido = nome || env?.DATA_PROVIDER || PADRAO;
  const p = PROVEDORES[escolhido];
  if (!p) throw new Error(`provedor desconhecido: ${escolhido}`);
  return p;
}

export function listProviders() {
  return Object.keys(PROVEDORES);
}
