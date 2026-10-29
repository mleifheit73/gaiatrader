-- Gaia Trader, migracao 0005
-- Leitura de indicadores por ativo e tempo grafico, apurada uma vez por noite.
--
-- POR QUE GUARDAR EM VEZ DE CALCULAR NA HORA
--
-- A tela de rastreamento precisa dos indicadores dos 96 ativos de uma vez. Lendo
-- ao vivo, seriam cerca de 2.500 candles por ativo, ou 235 mil linhas por
-- carregamento de tela. Com o limite de 5 milhoes de linhas por dia do plano
-- gratuito, isso daria 21 acessos por dia: o rastreamento seria o gargalo do
-- produto inteiro.
--
-- Guardando a leitura, a tela le 96 linhas em vez de 235 mil. Reducao de 2.400
-- vezes, e o rastreamento passa de tela mais cara para tela mais barata.
--
-- Tem um ganho que nao e de custo: o indicador fica IGUAL para todo mundo que
-- olha no mesmo dia. Calculado na hora, dois usuarios veriam numeros diferentes
-- do mesmo ativo se abrissem a tela em momentos diferentes, e nenhum dos dois
-- saberia por que.
--
-- O QUE NAO ENTRA AQUI
--
-- Esta tabela e cache derivado, nunca fonte. Pode ser apagada inteira e
-- reconstruida a partir dos candles sem perda nenhuma. Nenhuma decisao do
-- sistema depende dela existir.

CREATE TABLE IF NOT EXISTS asset_metrics (
  ticker       TEXT NOT NULL,
  periodo      TEXT NOT NULL,              -- dia | semana | mes
  d            TEXT,                       -- data da ultima barra usada
  base         INTEGER NOT NULL DEFAULT 0, -- quantas barras formaram a leitura
  fechamento   REAL,
  mma_curta    REAL,
  mma_longa    REAL,
  ifr_curto    REAL,
  ifr_longo    REAL,
  atr          REAL,
  liquidez     REAL,
  -- 1 quando a ultima barra ainda esta em formacao. A tela precisa avisar, ou
  -- o usuario lera um numero que ainda vai mudar como se fosse definitivo.
  em_formacao  INTEGER NOT NULL DEFAULT 0,
  -- Data do buraco, quando a serie teve que ser cortada. Preenchido significa
  -- que a leitura usou apenas o trecho posterior ao buraco.
  cortado_em   TEXT,
  -- Erro da ultima tentativa, quando houve. Leitura que falha em silencio
  -- deixaria a tela mostrando numero velho como se fosse de hoje.
  erro         TEXT,
  calculado_em TEXT NOT NULL,
  PRIMARY KEY (ticker, periodo)
) WITHOUT ROWID;

-- A tela ordena por liquidez e filtra por tempo grafico.
CREATE INDEX IF NOT EXISTS idx_metricas_periodo ON asset_metrics(periodo, liquidez DESC);
