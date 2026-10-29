# Gaia Trader

Plataforma de análise técnica para ações da B3 e criptomoedas. Ferramenta de
estudo e planejamento para swing trade e position trade, voltada a quem tem outra
profissão e pouco tempo para analisar.

**Não é sistema de recomendação de investimentos.** Não indica ativo, não diz
quando comprar e não promete rentabilidade.

---

## Situação atual: Fase 0 (esqueleto)

O objetivo da Fase 0 é provar o caminho completo de dados antes de portar
qualquer funcionalidade: provedor, ingestão, banco, API e gráfico.

Sem login, sem IA, sem cobrança, sem cadastro. Um único ativo (PETR4).

## Arquitetura

```
Navegador
    │
    ▼
Cloudflare Worker  (gaiatrader)
    ├── /api/health            estado do serviço
    ├── /api/bars              série de candles, lida do NOSSO banco
    │                          ?ajustado=1  série corrigida por proventos
    │                          ?continuo=1  só o último trecho sem buraco
    ├── /api/status            últimas cargas e totais
    ├── /api/admin/ingest      dispara carga manual (protegido por segredo)
    ├── /api/admin/recarregar  força um ativo com período explícito
    ├── /api/admin/costurar    emenda o histórico de um código antigo da B3
    ├── /api/admin/metrics     medidor de consumo e alarmes
    └── /                      arquivos estáticos
    │
    ├──► D1 (gaiatrader-db)      cotações, ativos, histórico de cargas
    └──► Cron diário 21h30 UTC   = 18h30 de Brasília, seg a sex
             │
             ▼
         Provedor de cotações (trocável)
```

### O provedor de dados é trocável de propósito

O Yahoo Finance **não autoriza uso comercial**. Ele está aqui para
desenvolvimento e validação.

Todo o sistema fala com `getProvider()` e nunca com um provedor concreto. Trocar
para um provedor licenciado deve custar **uma linha** em `src/providers/index.js`,
mais o arquivo do provedor novo cumprindo o mesmo contrato. Se algum dia for
preciso mudar mais que isso, a camada vazou e precisa ser consertada.

Contrato de um provedor:

```js
daily(ticker, market, opts) -> {
  name, currency,
  bars: [{ d: "YYYY-MM-DD", o, h, l, c, v, partial }]
}
```

### Decisões de projeto que valem registro

**A data do pregão é guardada como texto `YYYY-MM-DD`, não como carimbo de tempo.**
O pregão de um dia é uma data, não um instante. Guardar como instante foi a origem
dos defeitos de fuso horário que custaram caro na versão anterior do sistema
(candle de câmbio caindo no dia anterior, barra mensal duplicada). Data como data
elimina a classe inteira de erro.

**A ingestão é idempotente.** A chave primária `(ticker, d)` com `ON CONFLICT DO
UPDATE` faz com que rodar a mesma carga duas vezes atualize, nunca duplique.

**Toda carga é registrada** na tabela `ingest_runs`, com início, fim, quantos
ativos deram certo, quantos falharam e por quê. Carga que falha em silêncio é o
pior defeito possível num sistema de dados: pode quebrar numa terça e só ser
notada um mês depois.

**A falha de um ativo não derruba a carga dos outros.**

## Estrutura

```
migrations/0001_init.sql    esquema do banco
src/index.js                Worker: rotas da API e rotina agendada
src/ingest.js               ingestão, idempotente e observável
src/providers/index.js      escolha do provedor (ponto único de troca)
src/providers/yahoo.js      provedor Yahoo Finance
public/index.html           página do gráfico, lê do nosso banco
wrangler.toml               configuração do Worker, banco e agendamento
```

## Publicação

O repositório é a fonte da verdade. A publicação acontece pelo Workers Builds da
Cloudflare: todo envio para a ramificação principal publica automaticamente.

Para rodar localmente:

```bash
npm install
cp .dev.vars.example .dev.vars    # e troque o ADMIN_TOKEN
npm run dev
```

Segredos nunca ficam no repositório. São definidos com:

```bash
npx wrangler secret put ADMIN_TOKEN
```

## Disparar uma carga manualmente

```bash
curl -X POST https://<endereco>/api/admin/ingest -H "x-admin-token: <segredo>"
```

## Próximas fases

| Fase | Escopo |
|---|---|
| 0 | Esqueleto: um ativo, do provedor ao gráfico (atual) |
| 1 | Mercado completo, histórico de 10 anos, indicadores |
| 2 | Cadastro, login e separação de dados por usuário |
| 3 | Funções de inteligência artificial, com cota por usuário |
| 4 | Diário de trades, pareceres e estudos salvos |
| 5 | Cobrança e controle de assinatura |

## Limites da plataforma que o projeto respeita

Números da documentação da Cloudflare, não do SQLite. A diferença entre os dois
já custou uma carga falha: o SQLite permite 999 parâmetros por comando, o D1
permite 100.

| Limite | Valor | Onde nos afeta |
|---|---|---|
| Parâmetros por comando (D1) | 100 | Gravação de candles: 9 linhas por comando |
| Comandos por lote (D1) | sem limite documentado | Um lote conta como uma operação só |
| **Linhas lidas por dia (plano gratuito)** | **5 milhões** | **Consulta falha ao estourar, desde 01/09/2026** |
| Linhas gravadas por dia (plano gratuito) | 100.000 | A carga histórica dos 96 ativos gravou 232.698 |
| Chamadas externas por execução (plano gratuito) | 50 | Ingestão em lotes de até 20 ativos |
| Consultas ao provedor (teto nosso) | 120 por hora | Um terço do limite rumorado do Yahoo |

Tamanho medido da base com 96 ativos e 231.205 candles: 31,8 MB.

### O limite de leitura é o que aperta primeiro, e aperta de um jeito traiçoeiro

O limite que importa no dia a dia não é o tamanho da base, é a quantidade de
linhas lidas por dia. A auditoria da base provou isso na prática: quatro
varreduras completas da tabela de candles consumiram 4,57 milhões de linhas, ou
seja, 91% da cota diária, em poucos minutos.

A mesma auditoria feita como uma passada única, com somas condicionais em vez de
subconsultas independentes, custaria perto de 500 mil linhas. A diferença foi de
nove vezes, e veio só do jeito de escrever a consulta.

A regra que fica: **nenhuma consulta que varra a tabela inteira pode ficar no
caminho de uma tela.** Com 231 mil candles, uma varredura por carregamento de
tela permitiria 21 acessos por dia. O rastreamento de ativos precisa ler apenas
o trecho recente de cada papel, pelo índice. Alarme de painel que custa
varredura é um passivo, não uma proteção.

## O que a auditoria da base ensinou (28/10/2026)

A base passou em tudo que é integridade: 96 de 96 ativos carregados, 231.205
candles, zero preço inválido, zero data inválida, zero ativo marcado como
carregado sem candle. Os preços foram conferidos contra duas fontes
independentes (o Gaia Trader anterior e a BRAPI) sem uma única divergência.

Os quatro defeitos que ela encontrou são todos da mesma família: **erro que não
dá erro.**

**1) Candle em formação gravado como definitivo.** O marcador `partial` nunca
disparava, porque era decidido pelo formato da resposta (vetor de preços
incompleto) em vez de pelo relógio do mercado. Em cripto o vetor vem completo
todo dia e o mercado nunca fecha, então o candle do dia entrava como fechado. O
sintoma que entregou o defeito foi sutil: sete candles com fechamento abaixo da
própria mínima, porque o fechamento vem do último negócio e os extremos vêm de
uma janela mais antiga. Consequência: um indicador calculado sobre o candle de
hoje muda de valor ao longo do dia e gera sinal diferente às 11h e às 15h.

**2) Histórico raso sem alarme.** O PETR4 ficou preso em 2 anos (498 candles em
vez de 2.491) porque a carga decidia o período pela pergunta errada: "o ativo
tem algum candle?" em vez de "o ativo tem a profundidade que eu quero?". Como
ele tinha candles, recebia sempre 3 meses e nunca aprofundava. Nenhum alarme
olhava para profundidade. Corrigido com a coluna `range_carregado`, a rota de
recarga forçada e o alarme `historico_raso` no painel.

**3) Histórico perdido na troca de código.** A B3 trocou 126 códigos desde 2016.
Três ativos do catálogo perderam histórico exatamente na data da troca, e a data
é a prova: AURE3 começa em 2022-03-28 (CESP6 → AURE3 efetiva em 2022-03-28),
IGTI11 começa em 2021-11-22 (IGTA3 → IGTI11 na mesma data) e NATU3 tem um buraco
de 2.017 dias (NTCO3 → NATU3 em 2025-07-02). Passavam por IPO recente.

O conserto foi tentado e **não é possível com o provedor atual**: CESP6, IGTA3 e
NTCO3 devolvem HTTP 404. O padrão dos dados explica por quê. O NATU3 tem
histórico de 2016 a 2019 e de 2025 em diante, com o buraco no meio, enquanto
AURE3 e IGTI11 não têm absolutamente nada antes da troca. Ou seja, o Yahoo indexa
pelo código de negociação, não pela empresa, e descarta o código aposentado.

Os três ficam registrados com `predecessor` e `predecessor_ate` preenchidos, para
que o sistema saiba da troca mesmo sem conseguir preencher o buraco, e para que a
emenda seja feita de uma vez no dia em que trocarmos por um provedor licenciado,
o que é obrigatório antes da primeira cobrança de qualquer forma.

O impacto prático é pequeno: AURE3 fica com 4,5 anos e IGTI11 com 5, que
sustentam média de 200, IFR e ATR sem problema. Só o NATU3 fica de fato limitado,
com 16 meses de trecho contínuo. E nada disso produz número errado, porque
`trechoContinuo` usa apenas o pedaço sem buraco e devolve "sem base" quando o
indicador pedido não cabe.

**4) Série não ajustada por proventos.** O PETR4 fechou 58,68 num dia e abriu
51,20 no seguinte, queda de 12,7% confirmada em três fontes. Não é defeito de
carga, é provento, e abre um buraco artificial que atravessa qualquer média
longa.

A lição comum: nenhum dos quatro produzia mensagem de erro, log de falha ou tela
quebrada. Todos produziriam números errados com aparência perfeita. Em sistema de
dados, a verificação tem que procurar o que está plausível e errado, não o que
está quebrado.

## 929 barras inventadas, em 64 dos 76 ativos da B3

O achado mais sério da auditoria, e ele estava escondido desde a carga inicial.

O provedor devolve, em alguns dias, uma barra com **volume zero e amplitude
zero**: abertura igual à máxima, igual à mínima, igual ao fechamento. Não é
candle, é o eco do último preço conhecido, repetido para preencher o calendário.

A varredura da base encontrou 929 delas. Dois padrões distintos:

**Dias sem pregão.** Em 25/01/2018, aniversário de São Paulo, 60 ativos tinham
candle e **nenhum** tinha um único negócio. O dia inteiro era inventado. O mesmo
em 29/05/2017, com 59 de 62. Para efeito de comparação, num dia normal a conta é
62 candles e 61 com negócio, e no crash de 26/10/2026 são 76 e 76.

Isso significa que a base continha **dias de pregão que não existiram**, e cada
um deles entrava na janela de toda média de N períodos, deslocando o cálculo.

**Preenchimento prolongado.** O NATU3 tinha quatro dessas barras seguidas, todas
a R$ 36,86, entre 26/06 e 01/07/2025, enquanto o papel negociava perto de R$ 10.
Sozinhas, criavam um salto de +253% seguido de uma queda de -72% que nunca
aconteceram. Conferido contra o Investing.com: nos dias em questão o preço real
era 11,05 e 10,80.

### Por que isso passou despercebido

Nenhuma dessas barras viola qualquer invariante. O preço é positivo, a máxima não
é menor que a mínima, a data é válida, o volume não é negativo. **Passa em todas
as verificações de integridade e está completamente errada.** É o mesmo padrão
dos outros defeitos desta auditoria: o erro não se anuncia, só produz número
plausível e falso.

A correção no provedor (não emitir barra reconstruída sem negócio) impede que
novas entrem. A limpeza removeu as 929 que já estavam. Depois dela, restaram
apenas 4 buracos em toda a base, três deles pequenos e preenchidos a partir do
segundo provedor, e um conhecido (AVAX, anterior ao lançamento da rede).

## As duas fontes não concordam sobre units

Descoberto ao emendar o histórico perdido na troca de código. Comparando o
mesmo pregão nas duas fontes:

| Ativo | Tipo | Pior diferença medida |
|---|---|---|
| AURE3 | ação | **0%**, bate ao centavo em 43 pregões |
| NATU3 | ação | **0%**, bate ao centavo em 43 pregões |
| TAEE11 | unit | 0,31% |
| IGTI11 | unit | 1,02% em 2023, e **2,80%** no período da troca |

Em ação, as duas fontes dão exatamente o mesmo número. Em unit, que é
instrumento composto, elas divergem em pequenas quantidades e **nos dois
sentidos**, o que descarta conversão de quantidade (conversão é fator fixo, numa
direção só) e aponta para formas diferentes de precificar o papel composto.

Consequências práticas:

1. **O IGTI11 não foi emendado de propósito.** Emendar criaria uma série com
   uma costura onde o preço muda de fonte, e 1.233 candles (5 anos) já bastam
   para média de 200, IFR e ATR. O conserto certo é a migração completa de
   provedor, quando a série inteira vier de uma fonte só.

2. **Na migração de provedor, o preço das units vai mudar um pouco.** São 6 no
   catálogo: BPAC11, ENGI11, IGTI11, KLBN11, SANB11 e TAEE11. Não é defeito, é
   a fonte nova medindo diferente, mas precisa ser esperado em vez de descoberto
   como susto.

3. **A tolerância de 0,5% da conferência está bem calibrada.** Passou nas ações
   com folga total, passaria no TAEE11, e pegou o IGTI11. Não foi escolhida com
   esse conhecimento, mas o teste a validou.

## Pendências conhecidas

- Emendar o histórico de AURE3, IGTI11 e NATU3 no dia da troca por provedor
  licenciado. O `predecessor` de cada um já está registrado no banco, e a rota
  `/api/admin/costurar` já existe e já simula antes de gravar
- Verificar BPAC11 (1º candle 2017-02-24) e VBBR3 (2018-03-14): podem ser troca
  de código não coberta pela tabela de renomeações, ou início real de negociação
- Conferir a série ajustada que calculamos contra a do provedor, usando o campo
  `acRef` que o provedor devolve e que de propósito não é gravado
- Restrição CHECK na tabela de candles para o banco recusar barra impossível
  (máxima menor que mínima). Exige reconstruir a tabela, o que gasta 231 mil
  gravações: fazer junto com a próxima mudança de esquema
- Licença de dados para uso comercial: obrigatória antes da primeira cobrança
- Base legal de LGPD e política de privacidade: antes da Fase 2
- Registro de consumo de tokens por usuário: precisa existir desde a Fase 3
- Registro de eventos de uso: precisa existir desde a Fase 2
