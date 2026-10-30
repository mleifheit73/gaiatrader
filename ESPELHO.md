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
| Ibovespa (`^BVSP`) | **a fazer** | o artefato carrega como contexto; a base tem zero índices |
| Dólar (`USDBRL=X`) | **a fazer** | ver ressalva abaixo |
| Histórico diário | feito | 235.128 candles |
| Semanal e mensal | feito | agregação local |
| Eventos corporativos | feito | ajuste retroativo |
| Códigos antigos | feito | costura verificada por sobreposição |

> **Ressalva do próprio artefato sobre o Dólar:** a série diária do Yahoo
> para câmbio **repete a abertura no fechamento em 54% dos candles**, o
> que invalida médias, IFR, pivôs e a leitura técnica. Por isso ele fica
> sem botão no artefato. Se entrar no SaaS, precisa de outra fonte.

### Indicadores

Especificação completa em `METODO.md`.

| Item | Status |
|---|---|
| MME 8, MME 9, MM 21, MM 80, MM 200 | **a fazer** (hoje: MMA 5 e MMA 200, conjunto errado) |
| IFR 2 e IFR 14 | feito |
| ATR 14 | **parcial** (hoje Wilder; o artefato usa média aritmética) |
| Bollinger, Estocástico, MACD, OBV, SAR | **a fazer** |
| Pivôs confirmados | **a fazer** |
| Candles sinal 9.1, 9.2, 9.3, PFR | **a fazer** |
| Plano de risco (entrada, stop, alvo) | **a fazer** |
| Força relativa 12m e 3m | **a fazer**, bloqueado pelo Ibovespa |
| Situação e Pontuação | **a fazer** |
| Barras Curto e Médio prazo | **a fazer** |
| Liquidez (financeiro 21 dias) | feito |

> **Resíduo encontrado:** existem **dois** conjuntos de checklist curto e
> médio prazo no código. Um dentro de `compute()` (RSI, Estocástico,
> MACD, SAR, Bollinger) e outro dentro de `classify()` (MME 9, MM 21,
> IFR 2). **A tabela usa o segundo.** O primeiro parece ser de uma versão
> anterior e não aparece em tela. Confirmar antes de portar os dois.

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
