/**
 * Indicadores de analise tecnica.
 *
 * REGRA QUE VALE PARA TODOS: SEM BASE, SEM NUMERO.
 *
 * Toda funcao aqui devolve um vetor do mesmo tamanho da serie, com `null` em
 * toda posicao onde nao havia historico suficiente para o calculo. Nunca
 * devolve um numero aproximado, nunca encurta o periodo em silencio.
 *
 * Isto nao e rigor academico, e consequencia direta do que a auditoria da base
 * mostrou: o erro que custa caro nao e o que quebra, e o que produz numero
 * plausivel e errado. Uma media de 200 calculada sobre 30 pregoes sai, tem
 * cara de media de 200, e esta errada. Melhor nao existir.
 *
 * Quem consome decide o que mostrar no lugar do nulo, e a resposta certa quase
 * sempre e "sem base", escrito na tela.
 *
 * SOBRE O SUAVIZAMENTO DE WILDER
 *
 * IFR e ATR usam o suavizamento de Wilder, nao a media simples: o primeiro
 * valor e a media simples do periodo, e dali em diante cada novo valor entra
 * com peso 1/periodo. E a formula original e a que as plataformas de mercado
 * usam, entao os numeros batem com o que o usuario ve em outro lugar.
 */

/** Serie de fechamentos. */
const fechamentos = (bars) => bars.map((b) => b.c);

/**
 * Media movel aritmetica.
 * @returns {Array<number|null>} mesmo tamanho da entrada
 */
export function mediaMovel(valores, periodo) {
  const n = valores.length;
  const saida = new Array(n).fill(null);
  if (!(periodo > 0) || n < periodo) return saida;

  let soma = 0;
  for (let i = 0; i < n; i++) {
    soma += valores[i];
    if (i >= periodo) soma -= valores[i - periodo];
    if (i >= periodo - 1) saida[i] = soma / periodo;
  }
  return saida;
}

/** Media movel aritmetica sobre os fechamentos. */
export function mma(bars, periodo) {
  return mediaMovel(fechamentos(bars), periodo);
}

/**
 * Indice de Forca Relativa (IFR), formula de Wilder.
 *
 * Convencao nos extremos, declarada de proposito:
 *   so ganhos, nenhuma perda  -> 100
 *   so perdas, nenhum ganho   -> 0
 *   serie totalmente parada   -> 50, porque nao ha pressao em direcao nenhuma
 *
 * O terceiro caso e divisao de zero por zero e cada plataforma resolve de um
 * jeito. Escolhemos 50 por ser o unico valor que nao sugere forca que nao
 * existe. Serie parada, alias, costuma ser sinal de dado ruim.
 */
export function ifr(bars, periodo) {
  const c = fechamentos(bars);
  const n = c.length;
  const saida = new Array(n).fill(null);
  if (!(periodo > 0) || n < periodo + 1) return saida;

  let ganho = 0, perda = 0;
  for (let i = 1; i <= periodo; i++) {
    const d = c[i] - c[i - 1];
    if (d > 0) ganho += d; else perda -= d;
  }
  ganho /= periodo;
  perda /= periodo;

  const valor = (g, p) => {
    if (p === 0 && g === 0) return 50;
    if (p === 0) return 100;
    if (g === 0) return 0;
    return 100 - 100 / (1 + g / p);
  };

  saida[periodo] = valor(ganho, perda);

  for (let i = periodo + 1; i < n; i++) {
    const d = c[i] - c[i - 1];
    ganho = (ganho * (periodo - 1) + (d > 0 ? d : 0)) / periodo;
    perda = (perda * (periodo - 1) + (d < 0 ? -d : 0)) / periodo;
    saida[i] = valor(ganho, perda);
  }

  return saida;
}

/**
 * Amplitude media verdadeira (ATR), formula de Wilder.
 *
 * A amplitude verdadeira de um pregao e a maior entre:
 *   maxima - minima
 *   |maxima - fechamento anterior|
 *   |minima - fechamento anterior|
 *
 * As duas ultimas existem para o gap de abertura contar. Sem elas, um papel que
 * abre 10% abaixo e fica parado o dia todo teria amplitude quase zero, e um
 * stop dimensionado por ATR ficaria absurdamente apertado justo no dia em que
 * o risco aumentou.
 */
export function atr(bars, periodo) {
  const n = bars.length;
  const saida = new Array(n).fill(null);
  if (!(periodo > 0) || n < periodo + 1) return saida;

  const tr = new Array(n).fill(null);
  for (let i = 1; i < n; i++) {
    const anterior = bars[i - 1].c;
    tr[i] = Math.max(
      bars[i].h - bars[i].l,
      Math.abs(bars[i].h - anterior),
      Math.abs(bars[i].l - anterior)
    );
  }

  let media = 0;
  for (let i = 1; i <= periodo; i++) media += tr[i];
  media /= periodo;
  saida[periodo] = media;

  for (let i = periodo + 1; i < n; i++) {
    media = (media * (periodo - 1) + tr[i]) / periodo;
    saida[i] = media;
  }

  return saida;
}

/**
 * Liquidez media diaria, em dinheiro.
 *
 * Volume em quantidade nao serve para comparar ativos: 1 milhao de acoes de
 * R$ 2 e 1 milhao de acoes de R$ 200 sao negocios de tamanhos completamente
 * diferentes. O filtro de liquidez tem que ser em dinheiro.
 */
export function liquidezMedia(bars, periodo) {
  return mediaMovel(bars.map((b) => b.c * (b.v || 0)), periodo);
}

/**
 * Calcula tudo de uma vez e devolve apenas a leitura do ULTIMO pregao, que e o
 * que uma tela de rastreamento precisa.
 *
 * O campo `base` conta quantos pregoes havia. Quem mostra a tela usa isso para
 * escrever "sem base" em vez de deixar a celula vazia, que o usuario leria como
 * zero.
 */
export function leituraAtual(bars, cfg = {}) {
  const periodos = {
    mmaCurta: cfg.mmaCurta ?? 5,
    mmaLonga: cfg.mmaLonga ?? 200,
    ifrCurto: cfg.ifrCurto ?? 2,
    ifrLongo: cfg.ifrLongo ?? 14,
    atr: cfg.atr ?? 14,
    liquidez: cfg.liquidez ?? 21,
  };

  const ultimo = (v) => (v.length ? v[v.length - 1] : null);
  const b = bars || [];

  return {
    base: b.length,
    data: b.length ? b[b.length - 1].d : null,
    fechamento: b.length ? b[b.length - 1].c : null,
    em_formacao: b.length ? !!b[b.length - 1].partial : null,
    mma_curta: ultimo(mma(b, periodos.mmaCurta)),
    mma_longa: ultimo(mma(b, periodos.mmaLonga)),
    ifr_curto: ultimo(ifr(b, periodos.ifrCurto)),
    ifr_longo: ultimo(ifr(b, periodos.ifrLongo)),
    atr: ultimo(atr(b, periodos.atr)),
    liquidez_media: ultimo(liquidezMedia(b, periodos.liquidez)),
    periodos,
  };
}
