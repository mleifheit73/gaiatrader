# Gaia Trader, design system

> Origem: o artefato Gaia Trader, que já tinha a direção visual
> resolvida. Este documento **codifica** essa direção, não escolhe
> outra. Valores em `public/tokens.css`.
>
> Sem referências externas: o UXKIN não estava conectado quando este
> documento foi escrito, então nada aqui vem de comparação com sites
> reais. A seção *Marketing* é a única que ficou pendente por isso.

## Para quem

O trader não profissional, com emprego, que não pode ficar na frente da
tela. A dor não é saber menos ou mais que os outros: é **não ter tempo
de montar a análise**. Ferramenta de estudo de gráficos para swing e
position trade. Não atende day trade, porque os gráficos não são em
tempo real.

## Princípios

**1. Número é conteúdo, não enfeite.** Todo valor numérico usa mono com
`tabular-nums`. Sem isso a coluna de preços dança a cada atualização e o
olho não consegue comparar duas linhas. Números alinham à direita, texto
à esquerda.

**2. Dizer "sem base" em vez de mostrar zero.** Indicador que não cabe
no histórico aparece escrito, nunca como 0 ou célula vazia. Uma MMA 200
no mensal é nula para todo ativo, e um zero ali teria cara de número
verdadeiro. Vale para toda tela: dado ausente se declara.

**3. Densidade no app, respiro no site.** A mesa de operação precisa de
muita informação por tela e usa base 14px. A página de vendas é lida de
longe e no celular, e usa base 16px com display grande. São duas escalas
de propósito, não inconsistência.

**4. O sistema não decide pelo usuário.** Nenhum componente emite
veredito de compra ou venda. Ver *O que não existe*.

## Cor

Dois temas, escuro como padrão (`localStorage.gt_theme`, cai em `dark`).
Cada cor tem um papel; nenhuma é decorativa.

| Token | Papel |
|---|---|
| `--bg` | Fundo da página |
| `--panel` | Painel, cartão, cabeçalho de tabela fixo |
| `--line` | Divisória decorativa |
| `--linha-forte` | Borda de campo de formulário (3:1, WCAG 1.4.11) |
| `--fg` | Texto principal |
| `--muted` | Texto secundário, rótulo, legenda |
| `--brand` | Marca e logotipo |
| `--accent` | Botão primário, link, anel de foco |
| `--accent-soft` | Linha realçada, fundo de aviso neutro |
| `--alta` / `--baixa` | **Direção de preço** |
| `--ok` / `--atencao` / `--perigo` | **Estado de interface** |
| `--c1`…`--c4` | Séries de gráfico |
| `--bb` | Banda, envelope, área de fundo |

### Mercado e interface são semânticas separadas

O artefato usava `--up` tanto para candle de alta quanto para etiqueta de
sucesso. São coisas diferentes: **papel caindo não é erro, é
informação.** Um dia vamos querer que falha seja vermelha enquanto a
baixa do dia é outra coisa, e token compartilhado impede isso.

Os apelidos `--up`, `--down` e `--warn` seguem definidos apontando para
os novos, para que componente do artefato seja portado sem reescrita.

### Correções de contraste (medidas, não estimadas)

O tema escuro passou em todos os pares de texto, entre 6:1 e 15:1, sem
nenhuma alteração. O tema claro **reprovou em cinco**, e justamente nos
pixels que mais importam: o verde de alta dava 3,38:1 contra o fundo.

| Token | Antes | Depois | Contraste |
|---|---|---|---|
| `--brand` | `#0e8a6c` | `#0b7058` | 3,30 → 4,63 |
| `--accent` | `#0b7a5a` | `#0a7052` | 4,07 → 4,65 |
| `--alta` | `#0f8a4c` | `#0c713e` | 3,38 → 4,66 |
| `--baixa` | `#c23a2b` | `#b33628` | 4,09 → 4,62 |
| `--atencao` | `#a86a00` | `#8a5700` | 3,40 → 4,67 |

Mesmo matiz, cerca de 10 a 15% mais escuras. A identidade não mudou.

**Mínimos:** texto normal 4,5:1; texto grande (≥24px, ou ≥19px negrito)
e componente de interface 3:1. Medir contra `--bg`, que é o fundo mais
exigente, não contra `--panel`.

**Cor nunca carrega sentido sozinha.** Alta e baixa levam sinal (`+`,
`−`) junto da cor. Daltonismo vermelho-verde é comum entre homens, que
são a maioria deste público.

## Tipografia

| Família | Uso |
|---|---|
| **Archivo** 500/700/800 | Títulos e rótulos de painel |
| **Outfit** 500 | Só o logotipo, `letter-spacing: .2em` |
| **IBM Plex Sans** 400/500/600 | Corpo, controle, formulário |
| **IBM Plex Mono** 400/500 | **Todo número**, código, ticker |

Escala do app: 11, 12, 13, **14 (base)**, 15, 17, 20, 24, 30.
Escala de marketing: **16 (base)**, 18, 21, 26, 34, 44, hero fluido.

Entrelinha 1,15 em título, 1,45 no corpo do app, 1,6 em texto corrido.
Parágrafo de leitura limitado a 70ch no site e 78ch no app.

As fontes **não** são importadas pelo CSS, para não criar cadeia de
carregamento em série. Cada página leva o `<link>` no `<head>`, como
documentado no topo de `tokens.css`.

## Espaçamento, forma, profundidade

Escala de base 2: 2, 4, 6, 8, 10, 12, 14, 16, 20, 24, 32, 48, 64. Não
forcei grade de 4, porque linha de números precisa de 2px e 6px de
verdade e o artefato já usa assim.

Raio: 3 (marcador), 6 (botão, campo, chip), 8 (painel, aviso), 10
(diálogo), 99 (pílula).

Sombra em três níveis e nada além: `--s-elevado` para dica,
`--s-flutuante` para popover, `--s-modal` para diálogo. Painel não tem
sombra, tem borda.

Largura: 1500px no app (aproveita monitor largo, que é onde se opera),
1120px no site.

## Componentes

**Prontos no artefato, para portar:** botão (primário, neutro, perigo,
`.sm`, com cursor armado para confirmação), controle segmentado, chip
alternável, pílula, etiqueta de estado, painel com cabeçalho, aviso,
grade de KPI, grade numérica, tabela com cabeçalho fixo, diálogo
(inclusive flutuante arrastável), formulário com `fieldset`, dica,
tooltip de gráfico, tour de primeiro uso, central de ajuda, chat,
botões de ferramenta de desenho, crachá de idade do dado, abas,
autocomplete de ticker, seletor de tema.

**A construir, não existem:** navegação do site com CTA, hero, seção de
recurso, cartão de preço, FAQ, rodapé, login, cadastro LGPD, recuperação
de senha, faixa de estado de assinatura (teste, ativo, inadimplente,
cancelado), tabela de usuários do admin, painel de consumo de token,
estado de cota esgotada, estado vazio de cada tela.

**Estados obrigatórios** em tudo que carrega dado: vazio, carregando,
erro, sem permissão, cota esgotada. Tela que só prevê o caso bom mostra
número velho com cara de novo.

## Ícones e imagem

SVG em linha, traço de 1,4 a 1,8, `viewBox` 24×24, `currentColor`,
`stroke-linecap: round`. Sem biblioteca de ícones e **sem emoji como
ícone**. Captura de tela real do produto na página de vendas, nunca
ilustração genérica de pessoa olhando gráfico.

## Julgamento: o que o produto afirma

> **Decisão revista em 30/10/2026.** Uma decisão anterior do mesmo dia
> dizia o contrário. Esta é a que vale.

O produto pago **mantém o julgamento do artefato**: a coluna Situação
(Setup, Observar, Risco, Evitar), a Pontuação de 0 a 7, as checklists de
filtro e gatilho, a Entrada, o Stop, o Alvo e o Veredito do parecer. O
método está em `METODO.md`.

Os componentes correspondentes seguem no sistema: `.verdict` com
`.buy/.sell/.hold/.watch`, `.par-v`, `.meter`, `.score`, `.pill` com
`.go/.watch/.no`.

### Duas condições presas a essa decisão

**1. Um analista CNPI-T entra como parceiro na validação.** Emitir
recomendação sobre valor mobiliário específico mediante remuneração é
atividade regulada pela CVM (Resoluções 19 e 20), e o produto emite:
Situação, Entrada, Stop, Alvo e Veredito. O Marcelo já tem a parceria
encaminhada e trata o tema como dele. Registrado aqui como contexto do
projeto, não como pendência a cobrar.

**2. Nenhuma promessa de desempenho, em lugar nenhum.** Esta é
independente da primeira. O CNPI resolve **quem pode** emitir
recomendação; ele não torna um sinal eficaz. Não existe backtest destes
setups. Então a página de vendas, a interface e qualquer texto do
produto não afirmam nem insinuam resultado, acerto, lucro ou vantagem,
mesmo com o registro em dia. São dois problemas e só o primeiro tem
solução contratável.

O artefato já acerta o tom e serve de referência: a conclusão de Setup
diz "Não é recomendação de compra: significa que o plano está completo",
e o rodapé afirma que a decisão é sempre do usuário. Esse registro se
mantém.

## Marketing (landing page)

Direção definida a partir de 12 sistemas reais de fintech e SaaS escuro
no UXKIN: [Copilot Money](https://uxkin.com/web?pack=w_USr6eQAYkKXR),
[Origin Financial](https://uxkin.com/web?pack=w_-aqt7jKe61Ee),
[Slash](https://uxkin.com/web?pack=w_hRT-0V0kqo9n),
[AngelList](https://uxkin.com/web?pack=w_HoMcnlEFwTVm),
[Boostinsurance](https://uxkin.com/web?pack=w_lkK6wG62fIFf),
[Peppermint](https://uxkin.com/web?pack=w_3pEBfCY775SZ),
[Ordinal](https://uxkin.com/web?pack=w_9woLgqYnomoa),
[Basedash](https://uxkin.com/web?pack=w_aTqPP_xF4Amm),
[Assurestor](https://uxkin.com/web?pack=w_2OCpLZPSOgJ3),
[Felt](https://uxkin.com/web?pack=w_u6xhvS7j7_Ac),
[IFTTT](https://uxkin.com/web?pack=w_U7lZq1JxWd0d) e
[Tapbots](https://uxkin.com/web?pack=w_Q-mqyCjYYEwd).

### O que eles confirmam

**Um acento cromático só, reservado à ação.** Cinco dos doze dizem isso
com todas as letras: Copilot ("the one chromatic accent on a dark
canvas"), Ordinal ("the single chromatic accent"), Assurestor ("the sole
chromatic signal"), Slash ("the only chromatic color, used sparingly"),
Felt ("the single warm accent that cuts through"). Nosso esmeralda já é
exatamente isso. **Regra:** `--accent` aparece em botão primário, link e
estado ativo. Em mais nada. Título não é verde, ícone não é verde, borda
não é verde.

**Fundo quase preto com tinta, nunca preto puro.** Copilot usa azulado
`#000814`, Ordinal violáceo `#151316`, AngelList azulado `#001d21`, e o
IFTTT escreve a regra: "never substitute pure `#000000`, the slight
warmth is intentional". Nosso `#0e1412` é um preto esverdeado. Está na
família e não muda.

### Três decisões que estavam em aberto

**Ritmo de faixas, alternando escuro e claro.** O IFTTT põe como regra
dura: "never stack two dark bands consecutively". Aqui isso cai bem,
porque o Gaia Trader **já tem os dois temas**. A landing alterna faixas
usando os mesmos tokens, sem inventar cor nenhuma: herói escuro, prova
em papel quente, recursos escuro, preço em papel, FAQ escuro, rodapé.

**Raio de 6px, sem pílula.** A categoria quase toda usa botão pílula
(100px): IFTTT, Felt, Assurestor, Peppermint, Ordinal. **Divergimos de
propósito.** Pílula lê como fintech de consumo, e o Gaia Trader é
ferramenta de trabalho. Mais importante: o app inteiro usa 6px, e pílula
só no site criaria costura visível entre a página de vendas e o produto
que ela vende. Consistência vale mais que seguir a categoria.

**Archivo continua, sem serifa.** Slash, Origin, Felt e Peppermint
pareiam uma serifa de display para o registro "financeiro confiável".
É bonito e não vamos fazer: trocar a face de display quebra a marca que
já existe no artefato e nas telas.

### Blocos da página

Navegação com CTA, herói, faixa de números, seções de recurso, captura
de e-mail do beta, tabela de preço, FAQ em acordeão, rodapé.

**O herói carrega captura real do produto**, emoldurada. Ordinal, Slash
e Basedash fazem assim, e nós temos produto de verdade para mostrar: a
tela de rastreamento com os 76 ativos ordenados por liquidez. Nada de
ilustração genérica de pessoa olhando gráfico.

**A faixa de números usa fatos do sistema, nunca desempenho.** Os
sistemas examinados usam esse bloco para prova social (usuários, volume
transacionado). Não temos nada disso e inventar está fora de questão.
Temos fatos reais e verificáveis: **235 mil candles**, **96 ativos**,
**10 anos de histórico**, **varredura diária às 21h30**. Isso mostra
substância sem prometer retorno, que é exatamente a linha que o produto
precisa segurar.

**Captura de e-mail no lugar do checkout, durante o beta.** O Slash tem
esse componente pronto na categoria. O botão principal leva à lista de
espera; a tabela de preço já aparece, marcada como preço de lançamento.
Na virada, troca o destino do botão e a página não precisa ser
reescrita.

### Identificação no rodapé

Exigência para venda online no Brasil (Decreto 7.962). Razão social
**GAIABELE NEGOCIOS E SERVICOS LTDA**, CNPJ 48.342.002/0001-95, Rua
Heimberto R. C. Puhlmann, 236, Higienópolis, Santa Cruz do Sul, RS,
CEP 96.825-200. O objeto social cobre a atividade: CNAE 6203-1/00,
desenvolvimento e licenciamento de programas não-customizáveis (SaaS).

### Preço

R$ 97 por mês, ou R$ 970 no PIX à vista para o plano anual (dois meses
de desconto). Dois cartões, o anual destacado, sem terceiro plano
inventado para fazer o do meio parecer barato.
