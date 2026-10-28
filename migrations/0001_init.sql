-- Gaia Trader, esquema inicial
-- Fase 0: apenas o necessario para provar o caminho de dados ponta a ponta.
--
-- Decisao de projeto que vale registrar: a data do pregao e guardada como TEXTO
-- no formato YYYY-MM-DD, e nao como carimbo de tempo. O pregao de um dia e uma
-- DATA, nao um instante. Guardar como instante foi a origem dos defeitos de fuso
-- que custaram caro na versao anterior do sistema (candle de cambio caindo no dia
-- anterior, barra mensal duplicada). Data como data elimina a classe inteira de erro.

CREATE TABLE IF NOT EXISTS assets (
  ticker      TEXT PRIMARY KEY,              -- PETR4, BTC
  market      TEXT NOT NULL,                 -- b3 | cripto
  name        TEXT,                          -- nome longo, vindo do provedor
  currency    TEXT NOT NULL DEFAULT 'BRL',   -- BRL | USD
  active      INTEGER NOT NULL DEFAULT 1,    -- 0 desativa sem apagar historico
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_assets_market ON assets(market, active);

-- Uma linha por ativo por dia de pregao.
-- A chave primaria composta torna a ingestao idempotente: rodar a mesma carga
-- duas vezes atualiza em vez de duplicar.
CREATE TABLE IF NOT EXISTS daily_bars (
  ticker      TEXT NOT NULL,
  d           TEXT NOT NULL,                 -- YYYY-MM-DD
  o           REAL NOT NULL,
  h           REAL NOT NULL,
  l           REAL NOT NULL,
  c           REAL NOT NULL,
  v           REAL NOT NULL DEFAULT 0,
  partial     INTEGER NOT NULL DEFAULT 0,    -- 1 = pregao ainda aberto quando foi lido
  src         TEXT NOT NULL,                 -- provedor que forneceu (yahoo, b3, ...)
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (ticker, d)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_bars_ticker_date ON daily_bars(ticker, d DESC);

-- Registro de cada execucao da rotina de ingestao.
-- Existe para que uma carga que falha em silencio nao passe despercebida:
-- sem isto, a rotina pode quebrar numa terca e so ser notada um mes depois.
CREATE TABLE IF NOT EXISTS ingest_runs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  kind         TEXT NOT NULL,                -- cron | manual
  provider     TEXT NOT NULL,
  started_at   TEXT NOT NULL,
  finished_at  TEXT,
  ok_count     INTEGER NOT NULL DEFAULT 0,
  fail_count   INTEGER NOT NULL DEFAULT 0,
  bars_written INTEGER NOT NULL DEFAULT 0,
  detail       TEXT                          -- JSON com o que falhou e por que
);

CREATE INDEX IF NOT EXISTS idx_runs_started ON ingest_runs(started_at DESC);
