/*
 * CONSUMO DE IA: precos, custo e agregacao por usuario.
 *
 * REGRA DESTE ARQUIVO: o custo e calculado a partir dos tokens MEDIDOS no
 * retorno da API, nunca estimados a partir do tamanho do texto. Estimativa
 * serve para dimensionar um preco antes de existir produto; depois que
 * existe chamada real, estimar e trocar fato por palpite.
 *
 * Eu mesmo errei duas vezes a conta estimada nesta semana (o peso da imagem
 * e o ganho do cache), e nos dois casos so a medicao corrigiu.
 */

/* ========================================================================
   TABELA DE PRECOS

   USD por milhao de tokens, lida da documentacao oficial em 30/10/2026.

   `leituraCache` nao e uma fracao fixa da entrada: e 0,1x na maioria dos
   modelos, 0,05x no Opus 5.5 e no Sonnet 5.5, 0,025x no Fable e no Mythos.
   Por isso fica como numero absoluto, e nao como multiplicador.
   ======================================================================== */

export const MODELOS = {
  "claude-haiku-5-5":  { nome: "Haiku 5.5",  ent: 0.10, sai:  0.50, leituraCache: 0.01, escritaCache: 0.125 },
  "claude-sonnet-5-5": { nome: "Sonnet 5.5", ent: 2.00, sai: 10.00, leituraCache: 0.10, escritaCache: 2.50 },
  "claude-opus-5-5":   { nome: "Opus 5.5",   ent: 4.00, sai: 20.00, leituraCache: 0.20, escritaCache: 5.00 },
  "claude-opus-5":     { nome: "Opus 5",     ent: 5.00, sai: 25.00, leituraCache: 0.50, escritaCache: 6.25 },
};

/* Os tres tipos de chamada que o artefato faz, com o padrao decidido pelo
   Marcelo em 30/10/2026. Trocaveis pelo seletor do admin. */
export const TIPOS = {
  parecer:  { rotulo: "Pedir parecer",        padrao: "claude-sonnet-5-5" },
  pergunta: { rotulo: "Pergunte ao Gaia",     padrao: "claude-haiku-5-5"  },
  explicar: { rotulo: "Explicar com IA",      padrao: "claude-haiku-5-5"  },
};

/** Cotacao usada para mostrar o custo em reais. Vem do Dolar carregado na base. */
export const USD_BRL_PADRAO = 5.40;

/**
 * Custo de UMA chamada, em dolares, a partir dos tokens medidos.
 *
 * Tokens de imagem chegam separados so para a tela poder mostrar o peso
 * dela, mas sao cobrados como entrada normal. Somar aqui e cobrar uma vez.
 */
export function custoUSD(modelo, t) {
  const m = MODELOS[modelo];
  if (!m) return null;
  const M = 1e6;
  return (
    ((t.entrada || 0) + (t.imagem || 0)) * m.ent / M +
    (t.cacheLeitura || 0) * m.leituraCache / M +
    (t.cacheEscrita || 0) * m.escritaCache / M +
    (t.saida || 0) * m.sai / M
  );
}

/* ========================================================================
   ESCOLHA DE MODELO POR TIPO DE CHAMADA

   Guardada na tabela `config`, que ja existia para configuracao do motor.
   Nao criei tabela nova: tres linhas de chave e valor resolvem.
   ======================================================================== */

const chaveModelo = (tipo) => `modelo.${tipo}`;

export async function lerModelos(db) {
  const { results } = await db
    .prepare(`SELECT chave, valor FROM config WHERE chave LIKE 'modelo.%'`)
    .all();
  const salvos = Object.fromEntries((results || []).map((r) => [r.chave, r.valor]));
  const saida = {};
  for (const [tipo, t] of Object.entries(TIPOS)) {
    const escolhido = salvos[chaveModelo(tipo)];
    // Um modelo salvo que nao existe mais na tabela de precos cai no padrao,
    // em vez de quebrar a tela ou cobrar errado em silencio.
    saida[tipo] = {
      rotulo: t.rotulo,
      modelo: MODELOS[escolhido] ? escolhido : t.padrao,
      padrao: t.padrao,
      alterado: !!escolhido && escolhido !== t.padrao,
      invalido: !!escolhido && !MODELOS[escolhido] ? escolhido : null,
    };
  }
  return saida;
}

export async function gravarModelo(db, tipo, modelo) {
  if (!TIPOS[tipo]) throw new Error(`tipo de chamada desconhecido: ${tipo}`);
  if (!MODELOS[modelo]) throw new Error(`modelo desconhecido: ${modelo}`);
  await db
    .prepare(
      `INSERT INTO config (chave, valor, updated_at) VALUES (?, ?, datetime('now'))
         ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor, updated_at = datetime('now')`
    )
    .bind(chaveModelo(tipo), modelo)
    .run();
  return { tipo, modelo };
}

/* ========================================================================
   CONSUMO POR USUARIO
   ======================================================================== */

/**
 * Tabela da tela de consumo: uma linha por usuario, com o uso do ciclo
 * atual e o custo acumulado.
 *
 * CUSTO EM LINHAS LIDAS: esta consulta agrega ai_calls, que cresce. Por
 * isso a tela e do admin e nao do usuario, e por isso o limite de linhas
 * existe. A conferencia de cota que roda a CADA chamada nao passa por aqui:
 * ela le uma linha de ai_uso_ciclo (ver src/acesso.js).
 */
export async function consumoPorUsuario(db, opts = {}) {
  const limite = Math.min(Math.max(parseInt(opts.limite, 10) || 100, 1), 500);
  const { results } = await db
    .prepare(
      `SELECT
         u.id, u.email, u.nome, u.criado_em, u.ultimo_acesso, u.ativo,
         s.plano, s.status AS assinatura, s.proxima_cobranca,
         COALESCE(q.pareceres_mes, 200)  AS cota_mes,
         COALESCE(q.pareceres_hora, 30)  AS cota_hora,
         COALESCE(q.alerta_em, 150)      AS alerta_em,
         q.motivo_ajuste, q.ajustado_por, q.ajustado_em,
         c.ciclo_inicio, c.ciclo_fim,
         COALESCE(c.pareceres, 0)        AS pareceres,
         COALESCE(c.perguntas, 0)        AS perguntas,
         COALESCE(c.explicacoes, 0)      AS explicacoes,
         COALESCE(c.custo_usd, 0)        AS custo_ciclo_usd,
         (SELECT COUNT(*) FROM ai_calls a WHERE a.user_id = u.id)              AS chamadas_total,
         (SELECT COALESCE(SUM(a.tokens_entrada + a.tokens_imagem), 0)
            FROM ai_calls a WHERE a.user_id = u.id)                           AS tokens_entrada,
         (SELECT COALESCE(SUM(a.tokens_cache_leitura), 0)
            FROM ai_calls a WHERE a.user_id = u.id)                           AS tokens_cache,
         (SELECT COALESCE(SUM(a.tokens_imagem), 0)
            FROM ai_calls a WHERE a.user_id = u.id)                           AS tokens_imagem,
         (SELECT COALESCE(SUM(a.tokens_saida), 0)
            FROM ai_calls a WHERE a.user_id = u.id)                           AS tokens_saida,
         (SELECT COALESCE(SUM(a.custo_usd), 0)
            FROM ai_calls a WHERE a.user_id = u.id)                           AS custo_total_usd,
         (SELECT COUNT(*) FROM ai_calls a WHERE a.user_id = u.id AND a.ok = 0) AS falhas
       FROM users u
       LEFT JOIN subscriptions s ON s.user_id = u.id
       LEFT JOIN ai_quota       q ON q.user_id = u.id
       LEFT JOIN ai_uso_ciclo   c ON c.user_id = u.id
       ORDER BY COALESCE(c.pareceres, 0) DESC, u.criado_em DESC
       LIMIT ?`
    )
    .bind(limite)
    .all();

  const cotacao = opts.usdBrl || USD_BRL_PADRAO;
  return (results || []).map((r) => {
    const usado = r.pareceres;
    const pct = r.cota_mes ? (usado / r.cota_mes) * 100 : 0;
    return {
      ...r,
      pct_cota: Math.round(pct * 10) / 10,
      // Tres estados, porque "perto do limite" e "no limite" pedem acoes
      // diferentes do admin: um avisa, o outro ja bloqueou o usuario.
      estado: usado >= r.cota_mes ? "bloqueado"
            : usado >= r.alerta_em ? "alerta"
            : "normal",
      custo_ciclo_brl: r.custo_ciclo_usd * cotacao,
      custo_total_brl: r.custo_total_usd * cotacao,
    };
  });
}

/** Totais do rodape da tela. Uma consulta, nao a soma das linhas na tela. */
export async function totaisConsumo(db, opts = {}) {
  const cotacao = opts.usdBrl || USD_BRL_PADRAO;
  const r = await db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM users)                                  AS usuarios,
         (SELECT COUNT(*) FROM users WHERE ativo = 1)                  AS usuarios_ativos,
         (SELECT COUNT(*) FROM ai_calls)                               AS chamadas,
         (SELECT COUNT(*) FROM ai_calls WHERE tipo = 'parecer')        AS pareceres,
         (SELECT COUNT(*) FROM ai_calls WHERE tipo = 'pergunta')       AS perguntas,
         (SELECT COUNT(*) FROM ai_calls WHERE tipo = 'explicar')       AS explicacoes,
         (SELECT COALESCE(SUM(custo_usd), 0) FROM ai_calls)            AS custo_usd,
         (SELECT COALESCE(SUM(tokens_entrada + tokens_imagem), 0) FROM ai_calls) AS tokens_entrada,
         (SELECT COALESCE(SUM(tokens_saida), 0) FROM ai_calls)         AS tokens_saida,
         (SELECT COALESCE(SUM(tokens_cache_leitura), 0) FROM ai_calls) AS tokens_cache,
         (SELECT COUNT(*) FROM ai_calls WHERE ok = 0)                  AS falhas`
    )
    .first();
  return { ...r, custo_brl: (r.custo_usd || 0) * cotacao, usd_brl: cotacao };
}

/** Quem precisa de atencao do admin agora. */
export async function usuariosEmAlerta(db) {
  const { results } = await db
    .prepare(
      `SELECT u.id, u.email, u.nome,
              COALESCE(q.pareceres_mes, 200) AS cota_mes,
              COALESCE(q.alerta_em, 150)     AS alerta_em,
              c.pareceres, c.ciclo_fim
         FROM users u
         JOIN ai_uso_ciclo c ON c.user_id = u.id
         LEFT JOIN ai_quota q ON q.user_id = u.id
        WHERE c.pareceres >= COALESCE(q.alerta_em, 150)
        ORDER BY c.pareceres DESC`
    )
    .all();
  return (results || []).map((r) => ({
    ...r,
    estado: r.pareceres >= r.cota_mes ? "bloqueado" : "alerta",
  }));
}

/**
 * Ajusta a cota de um usuario.
 *
 * O motivo e obrigatorio de proposito: um limite mexido sem registro vira
 * um numero que ninguem sabe explicar seis meses depois.
 */
export async function ajustarCota(db, userId, { pareceresMes, pareceresHora, alertaEm, motivo, por }) {
  if (!userId) throw new Error("falta o usuario");
  if (!motivo || !motivo.trim()) throw new Error("o motivo do ajuste e obrigatorio");

  const atual = await db.prepare(`SELECT * FROM ai_quota WHERE user_id = ?`).bind(userId).first();
  const mes   = pareceresMes  != null ? pareceresMes  : (atual ? atual.pareceres_mes  : 200);
  const hora  = pareceresHora != null ? pareceresHora : (atual ? atual.pareceres_hora : 30);
  const aviso = alertaEm      != null ? alertaEm      : (atual ? atual.alerta_em      : 150);

  if (!(mes > 0) || !(hora > 0)) throw new Error("os limites precisam ser maiores que zero");
  if (aviso > mes) throw new Error("o alerta nao pode ser maior que a cota do mes");

  await db
    .prepare(
      `INSERT INTO ai_quota (user_id, pareceres_mes, pareceres_hora, alerta_em, motivo_ajuste, ajustado_por, ajustado_em)
            VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(user_id) DO UPDATE SET
            pareceres_mes  = excluded.pareceres_mes,
            pareceres_hora = excluded.pareceres_hora,
            alerta_em      = excluded.alerta_em,
            motivo_ajuste  = excluded.motivo_ajuste,
            ajustado_por   = excluded.ajustado_por,
            ajustado_em    = excluded.ajustado_em`
    )
    .bind(userId, mes, hora, aviso, motivo.trim(), por || "admin")
    .run();

  return { user_id: userId, pareceres_mes: mes, pareceres_hora: hora, alerta_em: aviso };
}

/**
 * Grava uma chamada e atualiza os contadores, numa transacao logica.
 *
 * Os contadores existem para a conferencia de cota custar uma linha lida em
 * vez de uma contagem. Mantar os dois em dia e o preco disso.
 */
export async function registrarChamada(db, { userId, tipo, modelo, ticker, tokens, ok = true, erro = null, ms = null }) {
  const custo = custoUSD(modelo, tokens || {});
  const t = tokens || {};
  const hora = new Date().toISOString().slice(0, 13);

  const campo = tipo === "parecer" ? "pareceres" : tipo === "pergunta" ? "perguntas" : "explicacoes";

  await db.batch([
    db.prepare(
      `INSERT INTO ai_calls
         (user_id, tipo, modelo, ticker, tokens_entrada, tokens_cache_leitura,
          tokens_cache_escrita, tokens_imagem, tokens_saida, custo_usd, ok, erro, ms)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(userId, tipo, modelo, ticker || null,
           t.entrada || 0, t.cacheLeitura || 0, t.cacheEscrita || 0,
           t.imagem || 0, t.saida || 0, custo, ok ? 1 : 0, erro, ms),
    db.prepare(
      `UPDATE ai_uso_ciclo
          SET ${campo} = ${campo} + 1,
              custo_usd = custo_usd + ?,
              atualizado_em = datetime('now')
        WHERE user_id = ?`
    ).bind(custo || 0, userId),
    // So o parecer entra no teto por hora: e a chamada cara e a que o
    // Marcelo limitou. Pergunta e explicacao nao tem teto horario.
    ...(tipo === "parecer" ? [
      db.prepare(
        `INSERT INTO ai_uso_hora (user_id, hora, pareceres) VALUES (?, ?, 1)
           ON CONFLICT(user_id, hora) DO UPDATE SET pareceres = pareceres + 1`
      ).bind(userId, hora),
    ] : []),
  ]);

  return { custo_usd: custo };
}
