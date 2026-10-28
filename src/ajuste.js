/**
 * Ajuste de serie por eventos corporativos.
 *
 * O QUE ESTE ARQUIVO RESOLVE
 *
 * Um dividendo derruba o preco da acao na data ex sem que ninguem tenha
 * vendido: o dinheiro saiu da empresa e foi para o bolso do acionista. No
 * grafico isso aparece como um buraco. A auditoria pegou um caso claro: o PETR4
 * fechou 58,68 num dia e abriu 51,20 no seguinte, queda de 12,7%, confirmada em
 * tres fontes independentes.
 *
 * Para quem olha o preco, o buraco e real e deve aparecer: foi o preco que a
 * corretora mostrou. Para qualquer CALCULO de tendencia, o buraco e ruido puro.
 * Uma media de 200 periodos atravessada por ele indica rompimento que nao
 * houve, e um IFR calculado em cima dele acusa sobrevenda que nao existiu.
 *
 * Por isso a serie bruta vai para o grafico e a serie ajustada vai para os
 * indicadores. O ajuste e calculado aqui, na leitura, a partir dos eventos
 * guardados, e nunca gravado. O porque esta em migrations/0004_eventos.sql.
 *
 * O METODO: AJUSTE RETROATIVO
 *
 * O preco de hoje fica intocado e o passado e corrigido. Assim o ultimo preco
 * da serie ajustada e sempre igual ao ultimo preco real, o que evita a confusao
 * de ver um numero na tela diferente do da corretora.
 *
 * Para cada evento, um fator multiplica tudo que veio ANTES dele:
 *   dividendo de D, com fechamento anterior P  ->  fator = (P - D) / P
 *   desdobramento de razao R                   ->  fator = 1 / R   (volume x R)
 *
 * O fator de um candle e o produto dos fatores de todos os eventos posteriores
 * a ele. Caminhando do candle mais novo para o mais antigo, basta ir
 * acumulando, o que faz o calculo custar uma passada so.
 */

/** Limites de sanidade. Evento fora disso e dado ruim, nao evento. */
const RAZAO_MINIMA = 0.001;
const RAZAO_MAXIMA = 1000;

/** Ultimo fechamento estritamente anterior a uma data, por busca binaria. */
function fechamentoAntesDe(bars, data) {
  let lo = 0, hi = bars.length - 1, achado = -1;
  while (lo <= hi) {
    const meio = (lo + hi) >> 1;
    if (bars[meio].d < data) {
      achado = meio;
      lo = meio + 1;
    } else {
      hi = meio - 1;
    }
  }
  return achado >= 0 ? bars[achado].c : null;
}

/**
 * Converte cada evento no par de fatores que ele aplica ao passado.
 * Devolve tambem a lista de eventos recusados, para que dado ruim apareca em
 * vez de corromper a serie em silencio.
 */
export function fatoresDosEventos(bars, eventos) {
  const fatores = [];
  const recusados = [];

  for (const e of eventos || []) {
    const valor = Number(e.valor);

    if (!e.d || !(valor > 0)) {
      recusados.push({ ...e, motivo: "valor ausente ou nao positivo" });
      continue;
    }

    if (e.kind === "split") {
      if (valor < RAZAO_MINIMA || valor > RAZAO_MAXIMA) {
        recusados.push({ ...e, motivo: `razao fora da faixa plausivel: ${valor}` });
        continue;
      }
      fatores.push({ d: e.d, kind: "split", fatorPreco: 1 / valor, fatorVolume: valor });
      continue;
    }

    // Dividendo.
    const anterior = fechamentoAntesDe(bars, e.d);

    if (!(anterior > 0)) {
      // Provento anterior ao inicio da nossa serie nao tem o que ajustar.
      recusados.push({ ...e, motivo: "sem fechamento anterior na serie carregada" });
      continue;
    }

    if (valor >= anterior) {
      // Um provento maior que o proprio preco zeraria ou inverteria todo o
      // passado. Quase sempre e erro de cadastro na origem, as vezes e
      // reducao de capital. Em qualquer caso, recusar e mais seguro que
      // aplicar: aplicar destruiria o historico inteiro sem acusar erro.
      recusados.push({
        ...e,
        motivo: `provento ${valor} maior ou igual ao fechamento anterior ${anterior}`,
      });
      continue;
    }

    fatores.push({
      d: e.d,
      kind: "div",
      fatorPreco: (anterior - valor) / anterior,
      fatorVolume: 1,
    });
  }

  // Ordem decrescente por data: e a ordem em que serao consumidos ao caminhar
  // do candle mais novo para o mais antigo.
  fatores.sort((a, b) => (a.d < b.d ? 1 : -1));

  return { fatores, recusados };
}

/**
 * Devolve a serie ajustada.
 *
 * @param {Array} bars    candles em ordem CRESCENTE de data, no preco bruto
 * @param {Array} eventos [{ d, kind: 'div'|'split', valor }]
 * @returns {{ bars: Array, aplicados: number, recusados: Array }}
 */
export function ajustar(bars, eventos) {
  if (!bars?.length) return { bars: [], aplicados: 0, recusados: [] };

  const { fatores, recusados } = fatoresDosEventos(bars, eventos);

  if (!fatores.length) {
    return { bars: bars.map((b) => ({ ...b })), aplicados: 0, recusados };
  }

  const saida = new Array(bars.length);
  let fatorPreco = 1;
  let fatorVolume = 1;
  let j = 0;
  let aplicados = 0;

  for (let i = bars.length - 1; i >= 0; i--) {
    // Todo evento posterior a este candle entra no fator acumulado. Como os
    // candles sao percorridos do mais novo para o mais antigo e os fatores
    // estao em ordem decrescente, cada evento e consumido uma unica vez.
    while (j < fatores.length && fatores[j].d > bars[i].d) {
      fatorPreco *= fatores[j].fatorPreco;
      fatorVolume *= fatores[j].fatorVolume;
      j++;
      aplicados++;
    }

    const b = bars[i];
    saida[i] = {
      ...b,
      o: b.o * fatorPreco,
      h: b.h * fatorPreco,
      l: b.l * fatorPreco,
      c: b.c * fatorPreco,
      v: b.v * fatorVolume,
    };
  }

  return { bars: saida, aplicados, recusados };
}

/**
 * TRECHO CONTINUO
 *
 * Nem toda serie e um instrumento continuo. O NATU3 tem um buraco de 2.017 dias
 * porque o papel negociou como NTCO3 nesse periodo. O AVAX tem dois candles
 * soltos antes do lancamento da rede e so depois comeca de verdade.
 *
 * Calcular media de 200 periodos atravessando um buraco desses compara preco de
 * 2019 com preco de 2025 como se fossem dias consecutivos. O numero sai, nada
 * acusa erro, e o sinal esta errado.
 *
 * Esta funcao devolve apenas o ultimo trecho sem buraco, que e o unico onde um
 * indicador tem significado. Nada e apagado do banco: o corte acontece na
 * leitura.
 *
 * @param {Array}  bars        candles em ordem crescente
 * @param {number} maxIntervalo maior intervalo aceitavel, em dias corridos
 */
export function trechoContinuo(bars, maxIntervalo) {
  if (!bars?.length) return { bars: [], cortado: false, buraco: null };

  const DIA = 86400000;
  const limite = maxIntervalo > 0 ? maxIntervalo : 10;

  for (let i = bars.length - 1; i > 0; i--) {
    const dias = (Date.parse(bars[i].d) - Date.parse(bars[i - 1].d)) / DIA;
    if (dias > limite) {
      return {
        bars: bars.slice(i),
        cortado: true,
        buraco: { parou_em: bars[i - 1].d, retomou_em: bars[i].d, dias: Math.round(dias) },
      };
    }
  }

  return { bars, cortado: false, buraco: null };
}

/**
 * Maior intervalo plausivel entre dois pregoes, por mercado.
 * B3: fim de semana mais feriados emendados. Cripto: negocia todo dia.
 */
export function intervaloMaximo(market) {
  return market === "cripto" ? 2 : 6;
}
