/**
 * Costura do historico de um codigo antigo da B3 no codigo atual.
 *
 * O PROBLEMA, MEDIDO
 *
 * A B3 trocou 126 codigos de negociacao desde 2016. Quando isso acontece, o
 * provedor as vezes emenda o historico no codigo novo e as vezes nao. Quando
 * nao emenda, o ativo aparece com historico curto e passa por IPO recente.
 *
 * Tres ativos do catalogo estavam assim, e a prova e a data:
 *
 *   AURE3   1o candle 2022-03-28   CESP6 -> AURE3 efetiva em 2022-03-28
 *   IGTI11  1o candle 2021-11-22   IGTA3 -> IGTI11 efetiva em 2021-11-22
 *   NATU3   buraco de 2.017 dias   NTCO3 -> NATU3 efetiva em 2025-07-02
 *
 * A data do primeiro candle e identica a data oficial da troca. Isso nao e
 * coincidencia de IPO, e historico que ficou no codigo antigo.
 *
 * DUAS REGRAS DE SEGURANCA, PORQUE EMENDAR SERIE E PERIGOSO
 *
 * 1. NUNCA SOBRESCREVE CANDLE QUE JA EXISTE. Só preenche buraco. Um candle
 *    nosso, ja conferido, vale mais que um candle vindo de um codigo que nem
 *    negocia mais.
 *
 * 2. CONFERE A FRONTEIRA ANTES DE EMENDAR. Se o ultimo preco do codigo antigo
 *    nao bate com o primeiro preco do codigo novo, houve conversao de
 *    quantidade (uma acao virou uma unidade, ou duas acoes viraram uma) e emendar
 *    sem corrigir a razao criaria um degrau falso no grafico, do tamanho da
 *    conversao. Nesse caso a funcao RECUSA e informa a razao implicita, em vez
 *    de aplicar um fator que ninguem conferiu.
 *
 * A segunda regra e a que importa mais. Emendar errado nao da erro, nao derruba
 * nada e nao aparece: so produz um salto de preco que todo indicador vai ler
 * como rompimento. E a classe de defeito mais caras de descobrir depois.
 */

import { getProvider } from "./providers/index.js";
import { consultar } from "./limites.js";

/** Faixa em que a fronteira e considerada continua, ou seja, conversao 1 para 1. */
const TOLERANCIA_FRONTEIRA = 0.20;

const COLUNAS = 10;
const LINHAS_POR_COMANDO = 9;     // 9 x 10 = 90 parametros, sob o limite de 100 do D1
const COMANDOS_POR_VIAGEM = 150;

/*
 * DO NOTHING, nao DO UPDATE. E a diferenca entre preencher buraco e
 * sobrescrever dado bom. Ver a regra 1 no cabecalho.
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
 * Emenda o historico de um codigo antigo no ativo atual.
 *
 * @param {D1Database} db
 * @param {object} env
 * @param {string} ticker       codigo atual, que recebe o historico (ex.: AURE3)
 * @param {object} opts
 * @param {string} opts.predecessor  codigo antigo a buscar no provedor (ex.: CESP6)
 * @param {string} opts.ate          emenda apenas candles ANTERIORES a esta data
 * @param {string} [opts.range]      periodo a pedir ao provedor, padrao 10y
 * @param {number} [opts.razao]      razao de conversao, quando conhecida
 * @param {boolean} [opts.simular]   true confere e relata sem gravar nada
 */
export async function costurar(db, env, ticker, opts = {}) {
  const { predecessor, ate } = opts;
  const range = opts.range || "10y";
  const simular = opts.simular !== false;   // seguro por padrao: so simula

  if (!predecessor) throw new Error("falta o codigo antigo (predecessor)");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ate || "")) throw new Error("falta a data da troca (ate)");

  const ativo = await db
    .prepare(`SELECT ticker, market FROM assets WHERE ticker = ?`)
    .bind(ticker)
    .first();
  if (!ativo) throw new Error(`ativo desconhecido no catalogo: ${ticker}`);

  // O que ja temos do lado novo, para conferir a fronteira.
  const novo = await db
    .prepare(
      `SELECT d, o, c FROM daily_bars WHERE ticker = ? AND d >= ? ORDER BY d ASC LIMIT 1`
    )
    .bind(ticker, ate)
    .first();

  if (!novo) throw new Error(`${ticker} nao tem candle em ${ate} ou depois: nada para emendar`);

  const provider = getProvider(null, env);
  const info = await consultar(db, env, provider, predecessor, ativo.market, { range }, "costura");

  const antigos = (info.bars || []).filter((b) => b.d < ate && !b.partial);
  if (!antigos.length) {
    throw new Error(`o provedor nao devolveu historico de ${predecessor} antes de ${ate}`);
  }

  const ultimoAntigo = antigos[antigos.length - 1];

  // CONFERENCIA DA FRONTEIRA.
  // Comparamos o ultimo fechamento do codigo antigo com a abertura do primeiro
  // candle do codigo novo. Numa troca de nome sem conversao, os dois precos sao
  // praticamente o mesmo numero.
  const precoNovo = novo.o > 0 ? novo.o : novo.c;
  const razaoImplicita = precoNovo / ultimoAntigo.c;
  const continua = Math.abs(razaoImplicita - 1) <= TOLERANCIA_FRONTEIRA;

  const fronteira = {
    codigo_antigo: predecessor,
    ultimo_candle_antigo: ultimoAntigo.d,
    fechamento_antigo: +ultimoAntigo.c.toFixed(4),
    primeiro_candle_novo: novo.d,
    preco_novo: +precoNovo.toFixed(4),
    razao_implicita: +razaoImplicita.toFixed(4),
    continua,
  };

  const razao = Number(opts.razao) > 0 ? Number(opts.razao) : null;

  if (!continua && !razao) {
    // RECUSA DELIBERADA. Ver a regra 2 no cabecalho: emendar com degrau de preco
    // nao da erro nenhum e estraga todo indicador em silencio.
    return {
      ticker,
      emendado: false,
      motivo:
        `a fronteira nao e continua (razao implicita ${fronteira.razao_implicita}). ` +
        `Houve conversao de quantidade. Confira a razao oficial e repita passando razao=<valor>.`,
      fronteira,
      candidatos: antigos.length,
    };
  }

  // Aplica a razao de conversao quando informada: o preco antigo passa a estar
  // na mesma escala do novo, e a quantidade anda no sentido inverso.
  const fator = razao || 1;
  const paraGravar = antigos.map((b) => ({
    d: b.d,
    o: b.o * fator,
    h: b.h * fator,
    l: b.l * fator,
    c: b.c * fator,
    v: fator !== 1 ? b.v / fator : b.v,
  }));

  if (simular) {
    return {
      ticker,
      emendado: false,
      modo: "simulacao",
      fronteira,
      razao_aplicada: fator,
      candidatos: paraGravar.length,
      periodo: { de: paraGravar[0].d, ate: paraGravar[paraGravar.length - 1].d },
      aviso: "nada foi gravado. Repita com aplicar=1 para gravar.",
    };
  }

  const gravadas = await gravarSemSobrescrever(
    db,
    ticker,
    paraGravar,
    `${provider.name}:${predecessor}`
  );

  await db
    .prepare(
      `UPDATE assets SET predecessor = ?, predecessor_ate = ?, updated_at = datetime('now')
        WHERE ticker = ?`
    )
    .bind(predecessor, ate, ticker)
    .run();

  return {
    ticker,
    emendado: true,
    fronteira,
    razao_aplicada: fator,
    candidatos: paraGravar.length,
    // Menor que candidatos e o esperado: as datas que ja tinhamos foram
    // preservadas, nao sobrescritas.
    gravadas,
    preservadas: paraGravar.length - gravadas,
    periodo: { de: paraGravar[0].d, ate: paraGravar[paraGravar.length - 1].d },
  };
}
