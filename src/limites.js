/**
 * Orcamento de consultas ao provedor, medicao e recuo automatico.
 *
 * O PROBLEMA
 * O Yahoo nao e provedor contratado. Nao documenta limites, nao garante nada e
 * pode bloquear sem aviso. O numero mais citado por quem usa e 360 requisicoes
 * por hora, mas e informacao de terceiros, nao oficial.
 *
 * Agrava: rodamos em Cloudflare Workers, cujo endereco de saida e compartilhado
 * com outros clientes. Podemos levar bloqueio por excesso de gente que nao tem
 * nada a ver conosco.
 *
 * A POSTURA
 * Nao da para controlar o vizinho. Da para controlar tres coisas:
 *  1. Gastar pouco, com teto proprio bem abaixo do rumorado
 *  2. Enxergar o consumo, para a decisao ser sobre numero e nao sobre palpite
 *  3. Recuar sozinho ao primeiro 429, em vez de insistir numa porta fechada
 *
 * O item 3 e o mais importante. Uma rotina que continua batendo de 5 em 5
 * minutos numa porta fechada e a melhor forma de transformar um bloqueio
 * temporario em permanente.
 */

/** Teto que impomos a nos mesmos: um terco do limite rumorado de 360/h. */
export const LIMITE_HORA_PADRAO = 120;

/** Quanto tempo ficamos parados depois de levar um 429. */
const PAUSA_HORAS = 3;

/** Faixas do medidor, em porcentagem do nosso teto. */
const FAIXA_ATENCAO = 50;
const FAIXA_PERIGO = 80;

const limiteHora = (env) => {
  const v = parseInt(env?.LIMITE_HORA || "", 10);
  return Number.isFinite(v) && v > 0 ? v : LIMITE_HORA_PADRAO;
};

async function lerConfig(db, chave) {
  const r = await db.prepare(`SELECT valor FROM config WHERE chave = ?`).bind(chave).first();
  return r?.valor ?? null;
}

async function gravarConfig(db, chave, valor) {
  await db
    .prepare(
      `INSERT INTO config (chave, valor, updated_at) VALUES (?, ?, datetime('now'))
       ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor, updated_at = excluded.updated_at`
    )
    .bind(chave, valor)
    .run();
}

/** Registra uma requisicao feita ao provedor. Nunca derruba a operacao. */
export async function registrarChamada(db, dados) {
  try {
    await db
      .prepare(
        `INSERT INTO provider_calls (at, provider, ticker, kind, status, ok, ms)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        new Date().toISOString(),
        dados.provider,
        dados.ticker || null,
        dados.kind || "manual",
        dados.status ?? null,
        dados.ok ? 1 : 0,
        dados.ms ?? null
      )
      .run();
  } catch (e) {
    // Contabilidade nunca pode quebrar a ingestao.
    console.error("falha ao registrar chamada:", e?.message || e);
  }
}

/** Entra em recuo: para de consultar o provedor por algumas horas. */
export async function recuar(db, motivo, horas = PAUSA_HORAS) {
  const ate = new Date(Date.now() + horas * 3600e3).toISOString();
  await gravarConfig(db, "pausa_ate", ate);
  await gravarConfig(db, "pausa_motivo", String(motivo).slice(0, 300));
  console.warn(`recuo automatico ate ${ate}: ${motivo}`);
  return ate;
}

/** Libera o recuo manualmente. */
export async function liberar(db) {
  await gravarConfig(db, "pausa_ate", "");
  await gravarConfig(db, "pausa_motivo", "");
}

/**
 * Fotografia do consumo. Alimenta o medidor do painel e as decisoes de gasto.
 */
export async function estado(db, env) {
  const teto = limiteHora(env);

  const c = await db
    .prepare(
      `SELECT
         SUM(CASE WHEN at >= datetime('now','-1 hour')  THEN 1 ELSE 0 END) AS h1,
         SUM(CASE WHEN at >= datetime('now','-24 hours') THEN 1 ELSE 0 END) AS h24,
         SUM(CASE WHEN at >= datetime('now','-24 hours') AND status = 429 THEN 1 ELSE 0 END) AS bloqueios24,
         SUM(CASE WHEN at >= datetime('now','-24 hours') AND ok = 0 THEN 1 ELSE 0 END) AS falhas24
       FROM provider_calls`
    )
    .first();

  const usadas1h = c?.h1 || 0;
  const pct = Math.min(100, Math.round((usadas1h / teto) * 100));

  const pausaAte = await lerConfig(db, "pausa_ate");
  const pausado = !!pausaAte && new Date(pausaAte) > new Date();

  let nivel = "ok";
  if (pausado) nivel = "pausado";
  else if (pct >= FAIXA_PERIGO) nivel = "perigo";
  else if (pct >= FAIXA_ATENCAO) nivel = "atencao";

  return {
    teto_hora: teto,
    usadas_1h: usadas1h,
    usadas_24h: c?.h24 || 0,
    percentual: pct,
    nivel,
    restantes_na_hora: Math.max(0, teto - usadas1h),
    bloqueios_24h: c?.bloqueios24 || 0,
    falhas_24h: c?.falhas24 || 0,
    pausado,
    pausa_ate: pausado ? pausaAte : null,
    pausa_motivo: pausado ? await lerConfig(db, "pausa_motivo") : null,
    faixas: { atencao: FAIXA_ATENCAO, perigo: FAIXA_PERIGO },
  };
}

/**
 * Pode gastar mais uma requisicao agora?
 * @returns {Promise<{pode: boolean, motivo?: string, estado: object}>}
 */
export async function podeConsultar(db, env, quantas = 1) {
  const e = await estado(db, env);
  if (e.pausado) {
    return { pode: false, motivo: `em recuo automatico ate ${e.pausa_ate}`, estado: e };
  }
  if (e.usadas_1h + quantas > e.teto_hora) {
    return {
      pode: false,
      motivo: `teto da hora atingido (${e.usadas_1h} de ${e.teto_hora})`,
      estado: e,
    };
  }
  return { pode: true, estado: e };
}

/**
 * Chama o provedor com toda a protecao em volta: confere orcamento, mede,
 * registra, e recua sozinho se levar 429.
 *
 * E o unico caminho pelo qual o sistema deve falar com o provedor. Qualquer
 * chamada direta escapa da contabilidade e do recuo, e e defeito.
 */
export async function consultar(db, env, provider, ticker, market, opts, kind) {
  const permissao = await podeConsultar(db, env);
  if (!permissao.pode) {
    const err = new Error(permissao.motivo);
    err.orcamento = true;
    throw err;
  }

  const t0 = Date.now();
  try {
    const info = await provider.daily(ticker, market, opts);
    await registrarChamada(db, {
      provider: provider.name,
      ticker,
      kind,
      status: 200,
      ok: 1,
      ms: Date.now() - t0,
    });
    return info;
  } catch (e) {
    const status = e?.status ?? null;
    await registrarChamada(db, {
      provider: provider.name,
      ticker,
      kind,
      status,
      ok: 0,
      ms: Date.now() - t0,
    });

    // 429 e o sinal explicito de excesso. 403 as vezes tambem e bloqueio.
    if (status === 429 || status === 403) {
      await recuar(db, `provedor respondeu ${status} em ${ticker}`);
    }
    throw e;
  }
}

/** Remove registros antigos, para a tabela nao crescer para sempre. */
export async function limparAntigos(db, dias = 30) {
  try {
    await db
      .prepare(`DELETE FROM provider_calls WHERE at < datetime('now', ?)`)
      .bind(`-${dias} days`)
      .run();
  } catch (e) {
    console.error("falha ao limpar registros antigos:", e?.message || e);
  }
}
