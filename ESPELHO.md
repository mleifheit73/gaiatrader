# Espelho: artefato → SaaS

O artefato é a especificação. O SaaS implementa. Toda alteração feita lá
é portada para cá.

## Como o espelhamento funciona de verdade

**Não existe sincronia automática.** O artefato é uma página publicada no
claude.ai, sem webhook, sem API de saída, sem canal para este
repositório. Nada do que for alterado lá chega aqui sozinho.

O processo que funciona, e que vale a partir de agora:

1. Você altera o artefato.
2. Me avisa o que mudou.
3. Eu leio o código novo do artefato e porto.
4. Marco o item nesta tabela.

## O que eu li, e o que não li

**Lido linha a linha:** todo o CSS, todo o HTML, e os blocos com lógica
própria (indicadores, `compute`, leitura e correção dos dados do Yahoo,
varredura, montagem da tabela, pivôs, candles sinal, plano de risco,
`classify` com Situação e Pontuação, calculadora de posição, checklist de
risco, e as contas do Diário incluindo imposto de renda).

**Mapeado, não lido linha a linha:** desenho do gráfico, ferramentas de
desenho, régua, conteúdo da Ajuda (três fases), tour de primeiro acesso,
interface do parecer e aba Mercados. São interface e conteúdo: portam por
cópia do código, não por reconstrução a partir de entendimento.

## A diferença de arquitetura que mais afeta o porte

| | Artefato | SaaS |
|---|---|---|
| Origem dos dados | Yahoo ao vivo, via Firecrawl do usuário | Banco próprio, carga noturna |
| Quem paga a consulta | o usuário, em créditos | nós, uma vez para todos |
| Limite de taxa | 3 rodadas, 2 trabalhadores, espera de 12 a 28s | não existe |
| Cache | `quotes/`, `qcr/` no banco do artefato | desnecessário |
| "Varredura completa" | botão do usuário | cron das 21h30 |
| Ranking Top 20 | salvo em `prefs/top10` | consulta por liquidez |
| Frescor | até 15 min de atraso | fechamento do dia anterior |

Boa parte do código do artefato existe para contornar limite de taxa e
cache. Isso **não** deve ser portado: some com o banco próprio.

## Inventário

Status: **feito**, **parcial**, **a fazer**.

### Dados e base

| Item | Status | Nota |
|---|---|---|
| 76 ações do Ibovespa | feito | lista `IBOV` confere com a base |
| 20 criptomoedas | feito | lista `CRYPTO` confere |
| Ibovespa (`^BVSP`) | **em carga** | cadastrado como `market='indice'`; a varredura das 21h30 faz a carga de 10 anos. Conferência cruzada em `testes/conferir-ibovespa.mjs` |
| Dólar (`USDBRL=X`) | **a fazer** | entra como LINHA de fechamento diário, nunca como candle |
| Histórico diário | feito | 235.128 candles |
| Semanal e mensal | feito | agregação local |
| Eventos corporativos | feito | ajuste retroativo |
| Códigos antigos | feito | costura verificada por sobreposição |

> **O Dólar é linha, não candle.** A série diária do Yahoo para câmbio
> traz o fechamento do dia, não um candle de verdade: a abertura repete o
> fechamento em 54% dos registros. Isso não é defeito a contornar, é a
> natureza do dado. Portanto o Dólar entra desenhado como linha, sem
> parecer, sem registro no Diário e sem ferramentas de desenho, como o
> artefato já faz. Médias, IFR, pivôs e leitura técnica não se aplicam.

### Indicadores

Especificação completa em `METODO.md`.

| Item | Status |
|---|---|
| MME 8, MME 9, MM 21, MM 80, MM 200 | **portado** (`src/metodo.js`, não ligado) |
| IFR 2 e IFR 14 | feito |
| ATR 14 | **portado** (`src/metodo.js`, não ligado), média aritmética |
| Bollinger, Estocástico, MACD, OBV, SAR | **portado** (`src/metodo.js`, não ligado) |
| Pivôs confirmados | **portado** (`src/metodo.js`, não ligado) |
| Candles sinal 9.1, 9.2, 9.3, PFR | **portado** (`src/metodo.js`, não ligado) |
| Plano de risco (entrada, stop, alvo) | **portado** (`src/metodo.js`, não ligado) |
| Força relativa 12m e 3m | **portado** (`src/metodo.js`, não ligado); falta a série do Ibovespa |
| Situação e Pontuação | **portado** (`src/metodo.js`, não ligado) |
| Barras Curto e Médio prazo | **portado** (`src/metodo.js`, não ligado) |
| Liquidez (financeiro 21 dias) | feito |

> **Resolvido.** Eu havia tratado como resíduo os **dois** conjuntos de
> checklist curto e médio prazo do código: um dentro de `compute()` (RSI,
> Estocástico, MACD, SAR, Bollinger) e outro dentro de `classify()`
> (MME 9, MM 21, IFR 2). Estava errado. A tela do seletor de indicadores
> mostra que o primeiro conjunto são camadas que o usuário liga e desliga
> no gráfico. **Os dois ficam.** A tabela do scanner usa o segundo.

> **Estado do porte:** `src/metodo.js` existe, tem 46 testes e passa, mas
> **nada o importa ainda**. A apuração noturna continua rodando sobre
> `src/indicadores.js`. A troca é uma etapa própria, depois que o
> `classify()` estiver portado e o Ibovespa carregado.

### Telas

| Item | Status |
|---|---|
| Aba Análise: scanner com 12 colunas | **a fazer** |
| Aba Análise: gráfico com 6 painéis | **a fazer** |
| Ferramentas de desenho e régua | **a fazer** |
| Leitura técnica em texto | **a fazer** |
| Filtro de tendência e Gatilho e risco | **a fazer** |
| Estudos salvos | **a fazer** |
| Aba Diário de trades | **a fazer** |
| Aba Mercados | **a fazer** |
| Aba Ajuda (3 fases, busca, trilha) | **a fazer** |
| Tour de primeiro acesso | **a fazer** |
| Pergunte ao Gaia | **a fazer** |
| Tema claro e escuro | feito (tokens) |

### Diário de trades

| Item | Status |
|---|---|
| Plano: ativo, lado, setup, tempo gráfico, entrada, stop gatilho e limite, quantidade, parcial, alvos, reposicionamento, tese | **a fazer** |
| Gestão: mover stop, registrar saída, histórico | **a fazer** |
| Revisão pós-trade: seguiu o plano, disciplina, erros, lições | **a fazer** |
| 10 indicadores do período | **a fazer** |
| Curva acumulada, resultado por mês, distribuição em R | **a fazer** |
| Desempenho por setup | **a fazer** |
| Imposto de renda com isenção de R$ 20 mil, 15% swing, 20% day trade e compensação de prejuízo | **a fazer** |

### Risco

| Item | Status |
|---|---|
| Capital e risco: 10 parâmetros | **a fazer** |
| Calculadora de posição: 3 tetos simultâneos (risco, teto por posição, caixa livre), com emolumentos e corretagem | **a fazer** |
| Lote padrão e fracionário | **a fazer** |
| Checklist de risco: 10 verificações, 3 status | **a fazer** |
| Risco de gap (percentil 5 das aberturas) | **a fazer** |

### Parecer e IA

| Item | Status |
|---|---|
| Formulário de intenção | **a fazer** |
| Envio de imagem do gráfico | **a fazer** |
| Calendário da empresa (balanço, dividendos, notícias) | **a fazer** |
| Números determinísticos no contexto | **a fazer** |
| Lista de pareceres com acompanhamento | **a fazer** |
| Cota por usuário | **a fazer**, não existe no artefato |

## O que o SaaS tem e o artefato não

Vale registrar, porque não deve ser perdido no porte:

- Banco próprio com 10 anos de histórico, contra 2 anos do artefato
- Carga noturna automática, sem consumir crédito do usuário
- Correção das 929 barras sintéticas que o Yahoo emitia
- Provedor BRAPI, que resolve códigos antigos
- Detecção de ativo atrasado e de histórico raso
- 163 testes automatizados
- Disciplina de leitura do D1, com o custo medido

## Limitação de rede deste ambiente

Este container **não alcança** `gaiatrader.com.br` nem `gaiatrader.workers.dev`:
o proxy de saída recusa a conexão, porque os dois hosts estão fora do
allowlist da sessão. Também não alcança o Yahoo. Consequências práticas:

- Não dá para conferir a carga pelas rotas da API daqui. A conferência vai
  por SQL no D1, via conector do Cloudflare, que funciona. As consultas estão
  em `operacao/conferir-carga.sql`.
- `testes/conferir-ibovespa.mjs` nunca vai conseguir buscar os dados por conta
  própria neste ambiente. Ele já trata a falha, mas o `fetch` dele só serve
  rodando de fora.
- Não dá para testar se o Yahoo aceita o símbolo do câmbio (`USDBRL=X` vira
  `USDBRL%3DX` na URL). A codificação é padrão e deve funcionar, mas isso é
  dedução, não medição. Só a varredura prova.

Se o Marcelo liberar `gaiatrader.com.br` em claude.ai, Settings > Capabilities,
a conferência passa a testar o caminho inteiro (Worker, ajuste, agregação) e
não só a tabela.
