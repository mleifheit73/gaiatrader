/**
 * Preenchimento de historico faltante a partir de um segundo provedor.
 *
 * O PROBLEMA, MEDIDO
 *
 * A B3 trocou 126 codigos de negociacao desde 2016. O Yahoo indexa pelo codigo,
 * nao pela empresa, e descarta o codigo aposentado: CESP6, IGTA3 e NTCO3
 * devolvem HTTP 404 la. Resultado, tres ativos do catalogo perderam historico
 * exatamente na data da troca, e a data e a prova:
 *
 *   AURE3   1o candle 2022-03-28   CESP6 -> AURE3 efetiva em 2022-03-28
 *   IGTI11  1o candle 2021-11-22   IGTA3 -> IGTI11 efetiva em 2021-11-22
 *   NATU3   buraco de 2.017 dias   NTCO3 -> NATU3 efetiva em 2025-07-02
 *
 * A BRAPI resolve o codigo antigo para o atual e serve a serie inteira. Entao
 * nao buscamos o codigo antigo: pedimos o codigo ATUAL com data inicial antiga,
 * e o proprio provedor devolve o periodo em que o papel negociava com outro
 * nome.
 *
 * COMO A CONFERENCIA FUNCIONA, E POR QUE ELA E ASSIM
 *
 * Emendar serie errado e o pior defeito possivel aqui, porque nao da erro
 * nenhum: so cria um degrau de preco que todo indicador le como rompimento, e
 * ninguem descobre por meses. Duas coisas podem dar errado em silencio:
 *
 *   data deslocada  um dia inteiro fora de lugar, por fuso ou horario de verao
 *   escala diferente  conversao de quantidade na troca (acao virando unit)
 *
 * A conferencia pega as duas de uma vez. Buscamos um periodo que SE SOBREPOE ao
 * que ja temos e comparamos preco a preco nas datas em comum. Se as datas
 * baterem e os precos baterem, as duas fontes concordam e o resto da serie pode
 * ser emendado com seguranca. Se nao baterem, a funcao RECUSA e relata, em vez
 * de aplicar um fator que ninguem conferiu.
 *
 * Isso e muito mais forte que comparar so o preco da fronteira, que era a
 * versao anterior: um unico par de numeros pode coincidir por acaso, dezenas de
 * pregoes em sequencia nao.
 *
 * E NUNCA SOBRESCREVE CANDLE QUE JA EXISTE. So preenche buraco. Um candle
 * nosso, ja conferido, vale mais que um candle vindo de uma segunda fonte.
 */

import { getProvider } from "./providers/index.js";
import { consultar } from "./limites.js";

/** Dias de sobreposicao pedidos alem da data da troca, para a conferencia. */
const DIAS_DE_SOBREPOSICAO = 60;

/** Minimo de pregoes em comum para a conferencia valer alguma coisa. */
const MINIMO_EM_COMUM = 5;

/** Diferenca relativa maxima aceita entre as duas fontes, no mesmo pregao. */
const TOLERANCIA_PRECO = 0.005;   // 0,5%

const COLUNAS = 10;
const LINHAS_POR_COMANDO = 9;     // 9 x 10 = 90 parametros, sob o limite de 100 do D1
const COMANDOS_POR_VIAGEM = 150;

function somarDias(data, dias) {
  const t = new Date(data + "T00:00:00Z");
  t.setUTCDate(t.getUTCDate() + dias);
  return t.toISOString().slice(0, 10);
}

/*
 * DO NOTHING, nao DO UPDATE. E a diferenca entre preencher buraco e sobrescrever
 * dado bom.
 */
function montarInsertSemSobrescrever(n) {
  const tupla = "(" + new Array(COLUNAS).fill("?").join(",") + ")";
  return (
    `INSERT INTO daily_bars (ticker, d, o, h, l, c, v, partial, src, updated_at) VALUES ` +
    new Array(n).fill(tupla).join(",") +
    ` ON CONFLICT(ticker, d) DO NOTHING`
  );
}

async function gravarSemSobrescrever(db, ticker, bars, src) {
  if (!bars.length) return 0;

  const agora = new Date().toISOString().replace("T", " ").slice(0, 19);
  const comandos = [];

  for (let i = 0; i < bars.length; i += LINHAS_POR_COMANDO) {
    const fatia = bars.slice(i, i + LINHAS_POR_COMANDO);
    const params = [];
    for (const b of fatia) {
      params.push(ticker, b.d, b.o, b.h, b.l, b.c, b.v, 0, src, agora);
    }
    comandos.push(db.prepare(montarInsertSemSobrescrever(fatia.length)).bind(...params));
  }

  let gravadas = 0;
  for (let i = 0; i < comandos.length; i += COMANDOS_POR_VIAGEM) {
    const res = await db.batch(comandos.slice(i, i + COMANDOS_POR_VIAGEM));
    for (const r of res) gravadas += r?.meta?.changes ?? 0;
  }

  return gravadas;
}

/**
 * @param {D1Database} db
 * @param {object} env
 * @param {string} ticker        codigo atual (ex.: AURE3)
 * @param {object} opts
 * @param {string} opts.ate      data da troca de codigo; preenche o que vem antes
 * @param {string} [opts.de]     data inicial da busca, padrao 2016-10-01
 * @param {string} [opts.predecessor] codigo antigo, so para o relatorio
 * @param {boolean} [opts.simular] true confere e relata sem gravar, que e o padrao
 */
export async function costurar(db, env, ticker, opts = {}) {
  const ate = opts.ate;
  const de = opts.de || "2016-10-01";
  const simular = opts.simular !== false;

  if (!/^\d{4}-\d{2}-\d{2}$/.test(ate || "")) throw new Error("falta a data da troca (ate)");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(de)) throw new Error("data inicial invalida (de)");

  const ativo = await db
    .prepare(`SELECT ticker, market FROM assets WHERE ticker = ?`)
    .bind(ticker)
    .first();
  if (!ativo) throw new Error(`ativo desconhecido no catalogo: ${ticker}`);

  const token = env.BRAPI_TOKEN;
  if (!token) {
    throw new Error(
      "BRAPI_TOKEN nao esta configurado neste Worker. " +
        "Defina-o em Settings, Variables and Secrets, na mesma lista de DATA_PROVIDER."
    );
  }

  // Pedimos ALEM da data da troca de proposito: o excedente e o que permite
  // conferir as duas fontes nos mesmos pregoes.
  const ateComFolga = somarDias(ate, DIAS_DE_SOBREPOSICAO);

  const provider = getProvider("brapi", env);
  const info = await consultar(
    db, env, provider, ticker, ativo.market,
    { de, ate: ateComFolga, token },
    "costura"
  );

  const vindas = info.bars || [];
  if (!vindas.length) throw new Error(`a BRAPI nao devolveu serie de ${ticker} em ${de}..${ateComFolga}`);

  // ------------------------------------------------------------------
  // CONFERENCIA: as duas fontes concordam nos pregoes em comum?
  // ------------------------------------------------------------------
  const { results: nossas } = await db
    .prepare(`SELECT d, c FROM daily_bars WHERE ticker = ? AND d >= ? AND d <= ? ORDER BY d`)
    .bind(ticker, ate, ateComFolga)
    .all();

  const nossoPorData = new Map((nossas || []).map((r) => [r.d, r.c]));
  const comparacoes = [];

  for (const b of vindas) {
    const nosso = nossoPorData.get(b.d);
    if (nosso > 0) comparacoes.push({ d: b.d, nosso, deles: b.c, dif: Math.abs(b.c / nosso - 1) });
  }

  const piorDif = comparacoes.length ? Math.max(...comparacoes.map((x) => x.dif)) : null;

  const conferencia = {
    pregoes_em_comum: comparacoes.length,
    pior_diferenca_pct: piorDif === null ? null : +(piorDif * 100).toFixed(4),
    tolerancia_pct: TOLERANCIA_PRECO * 100,
    amostra: comparacoes.slice(0, 3).map((x) => ({
      d: x.d, nosso: +x.nosso.toFixed(2), brapi: +x.deles.toFixed(2),
    })),
  };

  if (comparacoes.length < MINIMO_EM_COMUM) {
    return {
      ticker, emendado: false, conferencia,
      motivo:
        `so ${comparacoes.length} pregao(s) em comum, e o minimo para conferir e ${MINIMO_EM_COMUM}. ` +
        `Sem sobreposicao nao da para provar que as datas e a escala das duas fontes batem.`,
    };
  }

  if (piorDif > TOLERANCIA_PRECO) {
    // RECUSA DELIBERADA. Ou a data esta deslocada, ou houve conversao de
    // quantidade. Nos dois casos, emendar criaria um degrau que nenhum erro
    // acusaria.
    const razao = comparacoes[0].nosso / comparacoes[0].deles;
    return {
      ticker, emendado: false, conferencia,
      razao_implicita: +razao.toFixed(4),
      motivo:
        `as duas fontes divergem ate ${conferencia.pior_diferenca_pct}% nos mesmos pregoes, ` +
        `acima da tolerancia de ${conferencia.tolerancia_pct}%. ` +
        `Ou a data esta deslocada, ou houve conversao de quantidade na troca de codigo.`,
    };
  }

  // ------------------------------------------------------------------
  // Fontes concordam. Emenda so o que vem ANTES da troca.
  // ------------------------------------------------------------------
  const paraGravar = vindas.filter((b) => b.d < ate);

  if (!paraGravar.length) {
    return { ticker, emendado: false, conferencia, motivo: `nada anterior a ${ate} foi devolvido` };
  }

  const resumo = {
    ticker,
    codigo_antigo: opts.predecessor || null,
    simbolo_resolvido: info.simboloCanonico || ticker,
    conferencia,
    candidatos: paraGravar.length,
    periodo: { de: paraGravar[0].d, ate: paraGravar[paraGravar.length - 1].d },
  };

  if (simular) {
    return { ...resumo, emendado: false, modo: "simulacao",
      aviso: "nada foi gravado. Repita com aplicar=1 para gravar." };
  }

  const gravadas = await gravarSemSobrescrever(db, ticker, paraGravar, `brapi:${ate}`);

  await db
    .prepare(
      `UPDATE assets SET predecessor = COALESCE(?, predecessor), predecessor_ate = ?,
              updated_at = datetime('now')
        WHERE ticker = ?`
    )
    .bind(opts.predecessor || null, ate, ticker)
    .run();

  return {
    ...resumo,
    emendado: true,
    gravadas,
    // Menor que candidatos e esperado: datas que ja tinhamos foram preservadas.
    preservadas: paraGravar.length - gravadas,
  };
}
