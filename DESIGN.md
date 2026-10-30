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

## O que não existe, de propósito

**Nenhum componente de veredito.** As classes `.verdict.buy`,
`.verdict.sell`, `.verdict.hold` e o medidor de 0 a 100 do artefato
**não entram** no produto pago. Dois motivos:

1. Emitir recomendação sobre valor mobiliário específico mediante
   remuneração é atividade regulada pela CVM (Resoluções 19 e 20).
2. Não existe backtest nenhum destes setups. Afirmar desempenho sem
   teste é propaganda falsa, mesmo que involuntária.

**A IA é professora, não oráculo.** Ela trabalha sobre o plano que o
usuário propõe: ele diz onde quer entrar e por quê, e ela explica o que
o gráfico mostra, aponta o que ele não considerou e critica o risco
retorno que ele mesmo calculou. Ela **não origina** entrada, stop ou
alvo. Isso é restrição de projeto, não de redação, e vale para o prompt
tanto quanto para a interface.

**Nada de copy prometendo desempenho**, lucro, acerto ou vantagem, em
nenhuma página. Sem teste, não há o que prometer.

## Marketing, pendente

A direção da página de vendas (hero, prova, tabela de preço) ficou
pendente de referências reais. Decisões já tomadas: base 16px, display
fluido, largura 1120px, captura real do produto, sem depoimento
inventado, preço de lançamento R$ 97/mês ou R$ 970/ano no PIX, e na fase
de beta fechado o botão principal leva à lista de espera, não ao
checkout.
