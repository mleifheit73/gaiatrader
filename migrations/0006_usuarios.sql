/*
 * USUARIOS, ASSINATURA E AMBIENTE PRIVADO DE ESTUDOS
 *
 * Ate aqui o banco era inteiramente compartilhado: seis tabelas, nenhuma com
 * coluna de usuario. Esta migracao cria a outra metade da arquitetura.
 *
 * A DIVISAO, que e uma decisao e nao um detalhe:
 *
 *   COMPARTILHADO  assets, daily_bars, corporate_events, asset_metrics e o
 *                  cache de eventos. Sao dados publicos e calculo sobre dado
 *                  publico. Uma apuracao serve todo mundo, e e isso que faz o
 *                  scanner custar 96 linhas lidas por acesso em vez de 235 mil.
 *
 *   PRIVADO        tudo que o usuario escreveu, desenhou, configurou ou
 *                  decidiu. Nunca sai do usuario dele.
 *
 * REGRA INEGOCIAVEL, declarada pelo Marcelo em 30/10/2026:
 *
 *   O PARECER NUNCA E COMPARTILHADO NEM REAPROVEITADO ENTRE USUARIOS.
 *
 *   Dentro dele vao a tese escrita pelo trader, o capital dele, o limite de
 *   perda dele e os desenhos dele. Se alguem um dia "otimizar" cacheando
 *   parecer por ticker, vaza patrimonio e posicao de um usuario no parecer de
 *   outro, sem erro nenhum. O cache compartilhado vale SO para o resultado
 *   bruto da busca de eventos (event_cache abaixo), que e sobre o ativo e nao
 *   sobre a pessoa.
 *
 * SEGUNDA REGRA: toda consulta a tabela deste arquivo filtra por user_id NO
 * SERVIDOR. Nunca no cliente, nunca por parametro vindo do navegador sem
 * conferencia contra a sessao.
 */

/* ========================================================================
   IDENTIDADE
   ======================================================================== */

/*
 * Login por Google. Nao guardamos senha: o `google_sub` e o identificador
 * estavel que o Google devolve, e e por ele que reconhecemos a pessoa.
 * O e-mail pode mudar; o sub nao.
 */
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  google_sub    TEXT NOT NULL UNIQUE,
  email         TEXT NOT NULL,
  nome          TEXT,
  foto_url      TEXT,
  papel         TEXT NOT NULL DEFAULT 'usuario',   -- usuario | admin
  ativo         INTEGER NOT NULL DEFAULT 1,        -- 0 = bloqueado pelo admin
  criado_em     TEXT NOT NULL DEFAULT (datetime('now')),
  ultimo_acesso TEXT
);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id),
  criado_em  TEXT NOT NULL DEFAULT (datetime('now')),
  expira_em  TEXT NOT NULL,
  ip         TEXT,
  agente     TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id, expira_em DESC);

/* ========================================================================
   ASSINATURA

   Autenticar e autorizar sao coisas diferentes e ficam separadas de
   proposito. O Google diz QUEM a pessoa e. Esta tabela diz SE ela tem
   acesso. Misturar os dois impediria um assinante atrasado de entrar para
   ver por que foi bloqueado e para pagar, que e exatamente a hora em que
   voce mais quer que ele consiga entrar.
   ======================================================================== */

CREATE TABLE IF NOT EXISTS subscriptions (
  user_id          TEXT PRIMARY KEY REFERENCES users(id),
  plano            TEXT NOT NULL,                  -- beta | mensal | anual
  status           TEXT NOT NULL,                  -- ativa | atrasada | cancelada | beta
  inicio           TEXT NOT NULL,
  dia_cobranca     INTEGER,                        -- dia do mes; a cota de IA renova nele
  proxima_cobranca TEXT,
  cancelada_em     TEXT,
  cakto_id         TEXT,                           -- id da assinatura na Cakto
  atualizado_em    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_subs_status ON subscriptions(status, proxima_cobranca);

/*
 * Webhooks de pagamento chegam repetidos quando a plataforma nao recebe o
 * 200 a tempo. Gravar o id do evento antes de processar e o que impede
 * contar a mesma renovacao duas vezes.
 */
CREATE TABLE IF NOT EXISTS webhook_events (
  id           TEXT PRIMARY KEY,                   -- id do evento na origem
  origem       TEXT NOT NULL,                      -- cakto
  tipo         TEXT NOT NULL,
  user_id      TEXT,
  recebido_em  TEXT NOT NULL DEFAULT (datetime('now')),
  processado   INTEGER NOT NULL DEFAULT 0,
  corpo        TEXT NOT NULL,
  erro         TEXT
);
CREATE INDEX IF NOT EXISTS idx_webhooks_recebido ON webhook_events(recebido_em DESC);

/* ========================================================================
   COTA E CONSUMO DE IA
   ======================================================================== */

/*
 * Limite por usuario. Os padroes sao os do Marcelo (30/10/2026): 200
 * pareceres por mes, alerta no painel em 150, teto de 30 por hora.
 *
 * O admin pode aumentar caso a caso, e o motivo fica gravado: um limite
 * mexido sem registro vira um numero que ninguem sabe explicar seis meses
 * depois.
 */
CREATE TABLE IF NOT EXISTS ai_quota (
  user_id         TEXT PRIMARY KEY REFERENCES users(id),
  pareceres_mes   INTEGER NOT NULL DEFAULT 200,
  pareceres_hora  INTEGER NOT NULL DEFAULT 30,
  alerta_em       INTEGER NOT NULL DEFAULT 150,
  motivo_ajuste   TEXT,
  ajustado_por    TEXT,
  ajustado_em     TEXT
);

/*
 * Uma linha por chamada, com o consumo MEDIDO no retorno da API, nunca
 * estimado. E daqui que sai a pagina de consumo do admin, e e isso que em
 * 30 dias de beta troca a aritmetica por fato.
 */
CREATE TABLE IF NOT EXISTS ai_calls (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id              TEXT NOT NULL REFERENCES users(id),
  at                   TEXT NOT NULL DEFAULT (datetime('now')),
  tipo                 TEXT NOT NULL,              -- parecer | pergunta | explicar
  modelo               TEXT NOT NULL,
  ticker               TEXT,
  tokens_entrada       INTEGER NOT NULL DEFAULT 0,
  tokens_cache_leitura INTEGER NOT NULL DEFAULT 0,
  tokens_cache_escrita INTEGER NOT NULL DEFAULT 0,
  tokens_imagem        INTEGER NOT NULL DEFAULT 0,
  tokens_saida         INTEGER NOT NULL DEFAULT 0,
  custo_usd            REAL,
  ok                   INTEGER NOT NULL DEFAULT 1,
  erro                 TEXT,
  ms                   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_aicalls_user_at ON ai_calls(user_id, at DESC);
CREATE INDEX IF NOT EXISTS idx_aicalls_tipo_at ON ai_calls(tipo, at DESC);

/*
 * Contador agregado do ciclo atual.
 *
 * POR QUE ELE EXISTE: conferir a cota contando linhas de ai_calls leria
 * centenas de linhas a cada chamada, e o D1 cobra por linha lida. Esta
 * tabela faz a conferencia custar UMA linha. O ciclo vai da data de
 * cobranca do usuario, nao do dia 1 do mes.
 */
CREATE TABLE IF NOT EXISTS ai_uso_ciclo (
  user_id         TEXT PRIMARY KEY REFERENCES users(id),
  ciclo_inicio    TEXT NOT NULL,
  ciclo_fim       TEXT NOT NULL,
  pareceres       INTEGER NOT NULL DEFAULT 0,
  perguntas       INTEGER NOT NULL DEFAULT 0,
  explicacoes     INTEGER NOT NULL DEFAULT 0,
  custo_usd       REAL NOT NULL DEFAULT 0,
  alerta_enviado  INTEGER NOT NULL DEFAULT 0,      -- ja avisou que passou de 150
  atualizado_em   TEXT NOT NULL DEFAULT (datetime('now'))
);

/* Janela de uma hora, para o teto de 30 por hora. */
CREATE TABLE IF NOT EXISTS ai_uso_hora (
  user_id    TEXT NOT NULL REFERENCES users(id),
  hora       TEXT NOT NULL,                        -- YYYY-MM-DDTHH, em UTC
  pareceres  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, hora)
) WITHOUT ROWID;

/* ========================================================================
   AMBIENTE PRIVADO DE ESTUDOS

   O artefato guarda tudo isto no localStorage do navegador. No SaaS vai
   para o servidor, porque o usuario nao pode perder o historico ao trocar
   de maquina ou limpar o navegador. Esse historico e o recurso: e o que
   deixa ele voltar no grafico semanas depois e conferir se o estudo dele
   estava certo.
   ======================================================================== */

/* Configuracao de risco (no artefato: radar_jcfg). */
CREATE TABLE IF NOT EXISTS user_config (
  user_id         TEXT PRIMARY KEY REFERENCES users(id),
  capital         REAL,
  perda_max_pct   REAL,
  heat_max_pct    REAL,
  posicao_max_pct REAL,
  rr_minimo       REAL,
  atualizado_em   TEXT NOT NULL DEFAULT (datetime('now'))
);

/* Preferencias de tela (no artefato: radar_vis, radar_tf, radar_mkt, etc). */
CREATE TABLE IF NOT EXISTS user_prefs (
  user_id       TEXT PRIMARY KEY REFERENCES users(id),
  dados         TEXT NOT NULL,                     -- JSON
  atualizado_em TEXT NOT NULL DEFAULT (datetime('now'))
);

/* Ativos que o usuario acompanha. */
CREATE TABLE IF NOT EXISTS user_watchlist (
  user_id       TEXT NOT NULL REFERENCES users(id),
  ticker        TEXT NOT NULL REFERENCES assets(ticker),
  adicionado_em TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, ticker)
) WITHOUT ROWID;

/*
 * Desenhos sobre o grafico (no artefato: radar_draw_<ticker>).
 *
 * Um conjunto por ativo e por tempo grafico, igual ao artefato. Cada traco
 * dentro do JSON carrega a propria data, que e o que permite abrir o
 * grafico meses depois e ver o estudo contra o que o preco fez desde entao.
 */
CREATE TABLE IF NOT EXISTS user_drawings (
  user_id       TEXT NOT NULL REFERENCES users(id),
  ticker        TEXT NOT NULL,
  timeframe     TEXT NOT NULL,                     -- diario | semanal | mensal
  dados         TEXT NOT NULL,                     -- JSON dos tracos
  criado_em     TEXT NOT NULL DEFAULT (datetime('now')),
  atualizado_em TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, ticker, timeframe)
) WITHOUT ROWID;

/*
 * Pareceres salvos.
 *
 * DIFERENCA DELIBERADA DO ARTEFATO: la e um parecer por ativo
 * (radar_par_<TK>), e pedir um novo apaga o anterior. Aqui guardamos
 * HISTORICO, porque o Marcelo pediu que nada se perca e porque comparar o
 * parecer de tres meses atras com o que aconteceu depois e exatamente o
 * estudo que o produto promete.
 *
 * `contexto` guarda o que foi enviado ao modelo. Serve para auditoria: sem
 * isso, um parecer estranho nao tem como ser investigado depois.
 */
CREATE TABLE IF NOT EXISTS user_pareceres (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    TEXT NOT NULL REFERENCES users(id),
  ticker     TEXT NOT NULL,
  criado_em  TEXT NOT NULL DEFAULT (datetime('now')),
  situacao   TEXT,                                 -- a Situacao das regras no momento
  veredito   TEXT,                                 -- o veredito que o modelo deu
  texto      TEXT NOT NULL,
  contexto   TEXT,
  modelo     TEXT,
  ai_call_id INTEGER REFERENCES ai_calls(id)
);
CREATE INDEX IF NOT EXISTS idx_pareceres_user ON user_pareceres(user_id, criado_em DESC);
CREATE INDEX IF NOT EXISTS idx_pareceres_user_tk ON user_pareceres(user_id, ticker, criado_em DESC);

/* Diario de trades (no artefato: radar_trades). */
CREATE TABLE IF NOT EXISTS user_trades (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       TEXT NOT NULL REFERENCES users(id),
  ticker        TEXT NOT NULL,
  lado          TEXT NOT NULL DEFAULT 'compra',
  entrada_d     TEXT,
  entrada_preco REAL,
  quantidade    REAL,
  stop          REAL,
  alvo          REAL,
  saida_d       TEXT,
  saida_preco   REAL,
  custos        REAL NOT NULL DEFAULT 0,
  motivo        TEXT,
  nota          TEXT,
  criado_em     TEXT NOT NULL DEFAULT (datetime('now')),
  atualizado_em TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_trades_user ON user_trades(user_id, entrada_d DESC);

/* ========================================================================
   CACHE DE EVENTOS, COMPARTILHADO

   Esta e a UNICA tabela deste arquivo sem user_id, e e de proposito. A
   busca e sobre o ativo (balanco, dividendo, assembleia, fato relevante),
   nao sobre a pessoa. Dois usuarios perguntando da PETR4 no mesmo dia tem
   que receber os mesmos eventos, porque o fato e o mesmo.

   Compartilhar isto e o que faz o plano Hobby do Firecrawl (R$ 103) bastar
   no lugar do Standard (R$ 538).

   O que NAO entra aqui, nunca: o parecer. Ver o aviso no topo do arquivo.
   ======================================================================== */

CREATE TABLE IF NOT EXISTS event_cache (
  ticker     TEXT PRIMARY KEY,
  buscado_em TEXT NOT NULL,
  provider   TEXT NOT NULL,
  resultado  TEXT NOT NULL,                        -- JSON dos resultados
  creditos   INTEGER
) WITHOUT ROWID;
