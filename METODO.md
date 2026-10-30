# Método do Gaia Trader

Extraído do código do artefato, não deduzido das telas. Este documento é
a especificação para reconstruir a camada de indicadores no SaaS.

> **Por que ele existe:** a primeira camada de apuração do SaaS foi
> escrita com MMA 5 e MMA 200, que não é o método. Coincidiam apenas
> MM 200, IFR 2, IFR 14 e ATR 14. Números certos para uma pergunta que
> o produto não faz.

## Indicadores calculados

| Indicador | Fórmula |
|---|---|
| `sma(a,n)` | Média aritmética das últimas n. Null antes de n-1. |
| `ema(a,n)` | k = 2/(n+1), semeada com o **primeiro valor**, não com SMA. |
| `rsi(c,n)` | Wilder. Primeira média aritmética de n, depois suavizada. 100 quando não há perdas. |
| `atr` | **Média aritmética** de 14 true ranges (i-13 até i), não Wilder. |

Conjunto do `compute`: `ema9`, `mme8`, `mm21`, `mm80`, `ifr2` (rsi n=2),
`ma9`, `ma90`, `ma200`, Bollinger(20, 2), `rsi`(14), Estocástico(14,1,3),
MACD(12,26,9), OBV, PSAR, `obvMa` = sma(obv,20), `vma` = sma(volume,20).

**Mínimo de 85 candles** para a leitura técnica existir.

## Filtro de tendência, `eden()`

Quatro condições, todas obrigatórias:

```
MME8[i] > MME8[i-1]        (MME 8 subindo)
MM80[i] > MM80[i-1]        (MM 80 subindo)
close    > MME8[i]
close    > MM80[i]
```

## Pivôs

`pivots(b, N)`: topo quando a máxima é maior que as N anteriores e maior
ou igual às N posteriores; fundo pelo espelho com as mínimas.
**Só confirmados**, porque exige N candles depois. Os sinais usam N = 2.

A tendência por pivôs (alta, baixa, lateral) compara os dois últimos
topos e os dois últimos fundos.

## Candle sinal, `signals()`

Sobre a **MME 9**, avaliando os candles i, i-1 e i-2:

| Sinal | Condição |
|---|---|
| **9.1** | MME 9 subindo agora **e** estava caindo no candle anterior |
| **9.2** | MME 9 subindo nos dois **e** fechamento abaixo da mínima do candle anterior |
| **9.3** | MME 9 subindo nos dois **e** fechamento abaixo do fechamento de i-2 **e** fechamento de i-1 abaixo do de i-2 **e** não é 9.2 |
| **PFR** | Mínima menor que as duas anteriores **e** fechamento acima do fechamento anterior |

Avaliados em cadeia: 9.1 tem precedência, depois 9.2, depois 9.3. O PFR
é testado à parte e pode acumular.

**Entrada** = máxima do candle sinal + R$ 0,01 (rompimento).

## Plano de risco, `riskPlan()`

```
ATR    = média de 14 true ranges
stop   = último fundo confirmado (pivô) ABAIXO da entrada, menos R$ 0,01
         sem fundo confirmado: entrada - 2 x ATR  (marcado refStop)
alvo   = entrada + 2 x (entrada - stop)
stopAtr = (entrada - stop) / ATR
riskOk  = stopAtr <= 3
```

O fundo só vale se `pivô.i + 2 <= i`, isto é, se já estiver confirmado.
Saída por tempo em até 40 pregões se o alvo não vier.

## Situação

```
favor = filtro de tendência a favor
Setup    = favor  e  candle sinal  e  riskOk
Observar = favor  e  (sem sinal  ou  stop a mais de 3 ATR)
Risco    = sem favor  e  com candle sinal
Evitar   = sem favor  e  sem candle sinal
```

## Pontuação (0 a 7)

```
(filtro a favor ?  2 : -2)
+ (pivôs em alta ? 1 : pivôs em baixa ? -1 : 0)
+ (força relativa desconhecida ? 0 : mais forte ? 1 : -1)
+ (tem MM 200 ? (preço acima ? 1 : -1) : 0)
+ (tem candle sinal ? 1 : 0)
+ (riskOk ? 1 : 0)
```

Máximo 7, mínimo -5. A tela mostra "0 de 7".

## Checklists exibidas

**Filtro de tendência:** MME 8 subindo · MM 80 subindo · preço acima das
duas · pivôs em alta · mais forte que o Ibovespa em 12 meses.

**Gatilho e risco:** candle sinal no último candle · stop no último fundo
abaixo da entrada · stop de até 3 ATR · volume acima da média de 20 ·
IFR 14 entre 40 e 70.

**Barra Curto prazo (0 a 5):** MME 9 subindo · preço acima da MME 9 ·
preço acima da MM 21 · IFR 2 saindo da sobrevenda (>=25 tendo estado <25
nos 3 anteriores) ou subindo sem passar de 75 · candle sinal nos últimos
3 pregões.

**Barra Médio prazo (0 a 5):** MME 8 subindo com preço acima · MM 80
subindo com preço acima · pivôs em alta · IFR 14 entre 40 e 70 · mais
forte que o Ibovespa em 12 meses (cripto e índice usam preço acima da
MM 200 no lugar).

## Força relativa

```
relRet(acao, indice, n) = ((acao[fim]/acao[fim-n]) - (indice[fim]/indice[fim-n])) * 100
```

Resultado em **pontos percentuais** de diferença. `fr12` usa n = 252
pregões, `fr3` usa n = 63. A série contínua `relStrength` normaliza a
razão ação/índice em base 100 e tem média de 21.

> ### Pendência de dados, bloqueante
>
> A força relativa exige a série do **Ibovespa** candle a candle. A base
> tem 96 ativos (76 da B3 e 20 criptos) e **nenhum índice**. Sem carregar
> o Ibovespa, três coisas não calculam: a quinta condição do filtro, o
> terceiro termo da Pontuação, e a coluna Força 12m do scanner.
>
> No artefato, cripto e índice já substituem essa condição por "preço
> acima da MM 200". Para as ações da B3 não há substituto: ou carrega o
> índice, ou a Pontuação passa a valer no máximo 6 e a checklist perde
> uma linha.

## Fora do escopo deste documento

A tela, que segue o padrão do artefato, e os textos da leitura técnica,
que estão no código do artefato e devem ser portados literalmente.
