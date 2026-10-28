-- Gaia Trader, migracao 0003
-- Contabilidade de consultas ao provedor de dados e estado de protecao.
--
-- POR QUE ISTO EXISTE
-- O provedor atual (Yahoo) nao e contratado, nao documenta limites e nao nos
-- deve nada. Pior: rodamos em Cloudflare Workers, de onde o endereco de saida
-- e compartilhado com outros clientes, entao podemos ser bloqueados por excesso
-- de terceiros. Nao da para controlar o vizinho, mas da para controlar o que
-- gastamos, enxergar o consumo e recuar sozinho ao primeiro sinal de bloqueio.

-- Uma linha por requisicao feita ao provedor. E a fonte do medidor de consumo.
CREATE TABLE IF NOT EXISTS provider_calls (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  at        TEXT    NOT NULL,          -- ISO 8601
  provider  TEXT    NOT NULL,
  ticker    TEXT,
  kind      TEXT    NOT NULL,          -- cron | demanda | manual
  status    INTEGER,                   -- codigo HTTP, quando houver
  ok        INTEGER NOT NULL DEFAULT 0,
  ms        INTEGER                    -- duracao
);

CREATE INDEX IF NOT EXISTS idx_calls_at ON provider_calls(at DESC);

-- Configuracao e estado que precisam sobreviver entre execucoes.
-- Usada hoje para guardar ate quando a ingestao esta pausada e por que.
CREATE TABLE IF NOT EXISTS config (
  chave      TEXT PRIMARY KEY,
  valor      TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
