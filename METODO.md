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

A tendência por pivôs compara os dois últimos topos e os dois últimos
fundos, e tem **quatro** valores, não três:

| Valor | Quando |
|---|---|
| `alta` | último topo acima do anterior **e** último fundo acima do anterior |
| `baixa` | último topo abaixo do anterior **e** último fundo abaixo do anterior |
| `lateral` | qualquer outra combinação com dois topos e dois fundos |
| `indefinida` | menos de dois topos **ou** menos de dois fundos confirmados |

`indefinida` e `lateral` pesam igual na Pontuação (zero) e nenhuma das duas
bloqueia o favor, mas significam coisas diferentes: lateral é uma leitura,
indefinida é a ausência de leitura. Uma série que só sobe, sem recuo, não
tem pivô nenhum e cai em `indefinida`.

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

Máximo 7, mínimo -5. A tela mostra "de 7" e posiciona o medidor em
`(sc + 5) / 12 * 100`, para que o negativo tenha onde aparecer sem virar
número negativo em tela.

Sem a série do Ibovespa, o terceiro termo é sempre zero para as ações da
B3, então o **máximo real cai para 6**.

## Checklists exibidas

**Filtro de tendência (4 ou 5 itens):** MME 8 subindo · MM 80 subindo ·
preço acima das duas · pivôs em alta · *(só ações da B3)* mais forte que o
Ibovespa em 12 meses.

O quinto item só existe para ações da B3. Cripto e ativos de contexto não
têm índice de comparação e ficam com quatro. Quando o Ibovespa ainda não
carregou, o rótulo do quinto vira **"Mais forte que o Ibovespa em 12 meses
(carregando)"**, em vez de mostrar um X que pareceria reprovação do ativo.

**Gatilho e risco (4 ou 5 itens):** candle sinal no último candle · stop no
último fundo abaixo da entrada · stop de até 3 ATR · *(condicional)* volume
acima da média de 20 · IFR 14 entre 40 e 70.

O item de volume entra na **quarta** posição, antes do IFR 14, e só quando o
ativo teve algum volume nos últimos 20 candles. Ativo sem volume publicado
não ganha um item reprovado por falta de dado.

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

## Correções após ler o código literal

Este documento foi escrito primeiro a partir das telas e de uma leitura
parcial. Depois eu extraí o `classify()` literal do artefato (linhas 1295 a
1327) e ele contradisse o que eu tinha anotado em quatro pontos, todos já
corrigidos acima: a tendência tem quatro valores e não três, as duas
checklists têm tamanho variável, o rótulo do quinto item do filtro avisa
quando o índice não carregou, e a Pontuação tem um medidor próprio.

Fica o registro porque o padrão se repete neste projeto: **resumo não serve
para portar.** Cada vez que eu deduzi em vez de ler o código, produzi
números plausíveis para a pergunta errada.

### Diferença de arquitetura, deliberada

No artefato, `isCR()` lê a variável global `MKT`, que é a aba de mercado que
o usuário escolheu na tela. Funciona lá porque a tela mostra um mercado por
vez. **Aqui não funciona:** a varredura noturna apura os 96 ativos numa
passada só. Copiar o global faria as 20 criptos serem avaliadas com a regra
das ações (força relativa contra o Ibovespa em vez de preço acima da MM 200),
e os números sairiam plausíveis e errados, sem erro nenhum em tela.

No porte, `isCR()` virou `alvo.market === "cripto"`, por ativo. Há teste
afirmando que as mesmas barras produzem checklists diferentes conforme o
mercado do ativo.

### Ativos de contexto

O artefato mantém uma lista de dois ativos que existem para **não** virar
linha do scanner:

| Ticker | Nome | Gráfico |
|---|---|---|
| `^BVSP` | Ibovespa | sim |
| `USDBRL=X` | Dólar | **não** |

O comentário original do artefato explica o Dólar: a série diária do Yahoo
para câmbio repete a abertura no fechamento em 54% dos candles, o que
invalida médias, IFR, pivôs e a leitura técnica. Ele carrega, serve de
contexto, e não recebe parecer nem Situação.

### Textos da conclusão, para portar literalmente

São o que o painel de leitura técnica imprime. Nenhum deles promete
desempenho, e os quatro mencionam explicitamente que não são recomendação
ou dizem o que fazer se o usuário operar contra:

**Setup:** "filtro a favor, gatilho presente e risco adequado. Não é
recomendação de compra: significa que o plano está completo, com entrada,
stop e alvo definidos. A entrada só vale se o preço romper `<entrada>`; sem
rompimento, não há operação."

**Observar, com gatilho:** "a tendência está a favor e há gatilho, mas o
stop no último fundo fica longe demais (mais de 3 ATR da entrada)."

**Observar, sem gatilho:** "a tendência está a favor, mas não há gatilho no
último candle. Aguarde um candle sinal (9.1, 9.2, 9.3 ou PFR)."

**Risco:** "há candle sinal, mas o filtro de tendência está contra. Comprar
aqui é operar contra a tendência; se operar, use posição menor e respeite o
stop."

**Evitar:** "filtro de tendência contra e sem gatilho. Não é momento de
compra."

### Ainda não portado

`relStrength(bars, indice)`, que normaliza a razão ação sobre índice em base
100 com média de 21. Ela alimenta só o painel de gráfico "Força contra o
Ibovespa", não o `classify()`, então fica para quando o gráfico for
construído.
