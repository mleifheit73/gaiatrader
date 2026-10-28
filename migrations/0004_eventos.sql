-- Gaia Trader, migracao 0004
-- Eventos corporativos, costura de codigo antigo e profundidade de historico.
--
-- POR QUE ISTO EXISTE
--
-- 1) SERIE AJUSTADA SEM ENVELHECER
--
-- A auditoria mostrou que o PETR4 fechou 58,68 num dia e abriu 51,20 no
-- seguinte, queda de 12,7%. Tres fontes independentes mostram o mesmo numero,
-- entao nao e defeito de carga: e provento. O efeito pratico e que toda media
-- movel longa e atravessada por um buraco artificial, e todo sinal de
-- rompimento perto da data do provento e falso.
--
-- A solucao obvia seria gravar o fechamento ajustado numa coluna. NAO FUNCIONA.
-- O provedor recalcula o ajustado de TODO o historico a cada novo provento, e a
-- nossa atualizacao diaria so reescreve os ultimos 3 meses. Candles mais antigos
-- ficariam com o fator velho para sempre, e a serie ajustada ficaria
-- internamente inconsistente, piorando a cada dividendo, sem acusar erro.
--
-- Entao guardamos o preco BRUTO nos candles e os EVENTOS aqui, e derivamos o
-- ajuste na leitura. Sao poucas dezenas de eventos por ativo em 10 anos, o
-- calculo e barato e o resultado nunca envelhece.
--
-- Grafico mostra o bruto, igual a corretora. Indicadores calculam no ajustado.
--
-- 2) CODIGO ANTIGO
--
-- A B3 trocou 126 codigos desde 2016. Tres ativos do nosso catalogo perderam
-- historico exatamente na data da troca: AURE3 (era CESP6), IGTI11 (era IGTA3)
-- e NATU3 (era NTCO3). O primeiro candle de cada um coincide com a data oficial
-- da troca, o que prova que nao e IPO. As outras plataformas mostram a serie
-- inteira porque emendam o codigo anterior, e e isso que passamos a fazer.
--
-- 3) PROFUNDIDADE DE HISTORICO
--
-- O PETR4 ficou travado em 2 anos para sempre. A carga decidia o periodo assim:
-- ativo sem candle nenhum recebe 10 anos, ativo com qualquer candle recebe
-- 3 meses. Como ele foi o ativo de teste da Fase 0, carregado com 2 anos, nunca
-- mais teve como aprofundar. Nao existia caminho, e ninguem seria avisado.
-- Agora o banco registra o periodo pedido, entao um ativo raso fica visivel.

-- Dividendos e desdobramentos, por data ex.
--   kind = 'div'   -> valor e o provento por acao, na moeda do ativo
--   kind = 'split' -> valor e a razao (2 significa 2 novas por 1 antiga;
--                     0,5 significa grupamento de 2 para 1)
CREATE TABLE IF NOT EXISTS corporate_events (
  ticker     TEXT NOT NULL,
  d          TEXT NOT NULL,                 -- YYYY-MM-DD
  kind       TEXT NOT NULL,                 -- div | split
  valor      REAL NOT NULL,
  src        TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (ticker, d, kind)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_eventos_ticker_data ON corporate_events(ticker, d DESC);

-- Colunas novas em assets. Rodar uma vez; o SQLite nao aceita IF NOT EXISTS em
-- ALTER TABLE, entao reexecutar da erro de coluna duplicada, que e inofensivo.
ALTER TABLE assets ADD COLUMN predecessor      TEXT;  -- codigo antigo a emendar
ALTER TABLE assets ADD COLUMN predecessor_ate  TEXT;  -- emendar candles ANTES desta data
ALTER TABLE assets ADD COLUMN range_carregado  TEXT;  -- maior periodo ja pedido
