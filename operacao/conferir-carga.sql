-- Conferencia da carga do Ibovespa e do Dolar, para rodar DEPOIS da varredura.
--
-- Por que SQL e nao um script: este container nao alcanca gaiatrader.com.br
-- nem o dominio workers.dev (o proxy de saida recusa a conexao, os dois
-- hosts estao fora do allowlist da sessao). O conector do Cloudflare alcanca
-- o D1 direto, entao a conferencia vai por consulta.
--
-- Se o Marcelo liberar gaiatrader.com.br em claude.ai, Settings > Capabilities,
-- a conferencia passa a poder ser feita pelas rotas da API, que e melhor:
-- testaria o caminho inteiro (Worker, ajuste, agregacao) e nao so a tabela.

-- 1. Os dois ativos carregaram? Quantas barras, de quando a quando?
SELECT a.ticker, a.market, a.range_carregado, a.last_ok_at, a.last_error,
       COUNT(b.d)  AS barras,
       MIN(b.d)    AS primeira,
       MAX(b.d)    AS ultima
  FROM assets a LEFT JOIN daily_bars b ON b.ticker = a.ticker
 WHERE a.ticker IN ('^BVSP', 'USDBRL=X')
 GROUP BY a.ticker;

-- 2. PROVA DE FOGO DO DOLAR
--
-- O artefato afirma que a serie diaria de cambio do Yahoo repete a abertura
-- no fechamento em 54% dos candles, e e por isso que o Dolar nao recebe
-- leitura tecnica. Esta consulta mede a afirmacao NA NOSSA PROPRIA BASE, em
-- vez de confiar nela. Se vier perto de 54%, a trava do classify() esta
-- justificada por medicao. Se vier perto de zero, a afirmacao nao vale para
-- esta serie e a trava precisa ser revista.
SELECT COUNT(*)                                                        AS candles,
       SUM(CASE WHEN ABS(o - c) < 0.0000001 THEN 1 ELSE 0 END)         AS abertura_igual_fechamento,
       ROUND(100.0 * SUM(CASE WHEN ABS(o - c) < 0.0000001 THEN 1 ELSE 0 END) / COUNT(*), 1)
                                                                       AS pct
  FROM daily_bars WHERE ticker = 'USDBRL=X';

-- 3. PROVA DE FOGO DO IBOVESPA
--
-- O dia 26/10/2026 teve amplitude intradiaria acima de 18%. Candle achatado
-- ou sintetico nao reproduz isso. Se a amplitude vier pequena, a serie nao e
-- real, mesmo que os numeros parecam plausiveis.
SELECT d, o, h, l, c, v,
       ROUND(100.0 * (h - l) / l, 2) AS amplitude_pct
  FROM daily_bars
 WHERE ticker = '^BVSP' AND d BETWEEN '2026-10-23' AND '2026-10-29'
 ORDER BY d;

-- 4. A forca relativa precisa de 252 pregoes do indice casados por data com
-- a acao. Esta consulta diz se da para calcular fr12 hoje.
SELECT (SELECT COUNT(*) FROM daily_bars WHERE ticker = '^BVSP')              AS barras_indice,
       (SELECT COUNT(*) FROM daily_bars WHERE ticker = 'PETR4')              AS barras_petr4,
       (SELECT COUNT(*) FROM daily_bars b1
         WHERE b1.ticker = '^BVSP'
           AND EXISTS (SELECT 1 FROM daily_bars b2
                        WHERE b2.ticker = 'PETR4' AND b2.d = b1.d))          AS datas_casadas;

-- 5. Saude geral da varredura: quem ficou com erro.
SELECT ticker, last_error, last_error_at
  FROM assets WHERE last_error IS NOT NULL ORDER BY last_error_at DESC LIMIT 20;
