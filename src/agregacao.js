/**
 * Agregacao de candles diarios em semanais e mensais.
 *
 * POR QUE A DATA MANDA, E NAO O CARIMBO DE TEMPO
 *
 * Este arquivo nunca converte data em instante. Tudo acontece sobre o texto
 * YYYY-MM-DD, e quando precisa de aritmetica de calendario usa Date.UTC, que
 * nao tem fuso.
 *
 * Nao e preciosismo. A versao anterior do sistema teve exatamente dois defeitos
 * dessa familia, e os dois custaram caro: candle de cambio caindo no dia
 * anterior e barra mensal duplicada. Os dois nasceram de tratar o pregao como
 * um instante em vez de como uma data. Pregao de um dia e uma data.
 *
 * COMO O PERIODO E IDENTIFICADO, E POR QUE ASSIM
 *
 * A barra semanal leva a data da SEGUNDA-FEIRA da semana, calculada pelo
 * calendario, e nao a data do primeiro pregao daquela semana.
 *
 * A diferenca aparece em semana com feriado na segunda. Se o rotulo viesse do
 * primeiro pregao, o ativo A (que negociou terca) teria barra em 03/03 e o
 * ativo B (que negociou quarta, por qualquer motivo) teria em 04/03, e as duas
 * barras nao se alinhariam. Para uma tela que compara 96 ativos lado a lado,
 * isso e inaceitavel: cada linha estaria falando de uma semana diferente.
 *
 * Com o rotulo vindo do calendario, a semana de todo mundo comeca no mesmo dia,
 * tenha havido pregao nele ou nao.
 *
 * Mesma logica no mensal: a barra leva o dia 1 do mes.
 *
 * QUANDO A BARRA ESTA EM FORMACAO
 *
 * Uma barra semanal ou mensal e parcial em dois casos:
 *   1. o periodo dela ainda nao terminou (a semana corrente, o mes corrente)
 *   2. qualquer candle diario dentro dela e parcial
 *
 * O segundo caso importa: se o pregao de hoje ainda esta aberto, a semana
 * inteira esta em formacao, mesmo que ja seja sexta-feira.
 */

/** Segunda-feira da semana a que a data pertence. Domingo pertence a semana que comecou na segunda anterior. */
export function segundaDaSemana(data) {
  const t = new Date(data + "T00:00:00Z");
  const diaDaSemana = t.getUTCDay();              // 0 = domingo, 1 = segunda
  const recuo = diaDaSemana === 0 ? 6 : diaDaSemana - 1;
  t.setUTCDate(t.getUTCDate() - recuo);
  return t.toISOString().slice(0, 10);
}

/** Primeiro dia do mes a que a data pertence. */
export function primeiroDoMes(data) {
  return data.slice(0, 7) + "-01";
}

/** Ultimo dia do periodo que comeca na data informada. */
function fimDoPeriodo(inicio, periodo) {
  const t = new Date(inicio + "T00:00:00Z");
  if (periodo === "semana") {
    t.setUTCDate(t.getUTCDate() + 6);             // segunda + 6 = domingo
  } else {
    t.setUTCMonth(t.getUTCMonth() + 1);
    t.setUTCDate(0);                              // dia 0 do mes seguinte = ultimo do mes
  }
  return t.toISOString().slice(0, 10);
}

const rotulo = { semana: segundaDaSemana, mes: primeiroDoMes };

/**
 * Agrega candles diarios.
 *
 * @param {Array}  bars    candles diarios em ordem CRESCENTE de data
 * @param {string} periodo "semana" | "mes"
 * @param {string} [hoje]  data de referencia para decidir o que ainda esta em
 *                         formacao. Padrao: hoje em UTC. Parametro explicito
 *                         porque teste que depende do relogio nao e teste.
 */
export function agregar(bars, periodo, hoje) {
  if (!bars?.length) return [];
  if (!rotulo[periodo]) throw new Error(`periodo invalido: ${periodo}`);

  const hojeRef = hoje || new Date().toISOString().slice(0, 10);
  const daData = rotulo[periodo];

  const grupos = new Map();

  for (const b of bars) {
    const chave = daData(b.d);
    let g = grupos.get(chave);

    if (!g) {
      g = {
        d: chave,
        o: b.o, h: b.h, l: b.l, c: b.c,
        v: 0,
        dias: 0,
        // Guardamos o intervalo real coberto para poder relatar quantos pregoes
        // de verdade formaram a barra. Barra semanal feita de um pregao so nao
        // e igual a uma feita de cinco, e quem le precisa poder saber disso.
        primeiro_pregao: b.d,
        ultimo_pregao: b.d,
        algum_parcial: false,
      };
      grupos.set(chave, g);
    } else {
      // A abertura e a do PRIMEIRO pregao do periodo e ja esta fixada.
      if (b.h > g.h) g.h = b.h;
      if (b.l < g.l) g.l = b.l;
      g.c = b.c;                                  // fechamento e o do ULTIMO pregao
      g.ultimo_pregao = b.d;
    }

    g.v += b.v || 0;
    g.dias += 1;
    if (b.partial) g.algum_parcial = true;
  }

  return [...grupos.values()]
    .sort((a, b) => (a.d < b.d ? -1 : 1))
    .map((g) => {
      const fim = fimDoPeriodo(g.d, periodo);
      const periodoAberto = fim >= hojeRef;

      return {
        d: g.d,
        o: g.o, h: g.h, l: g.l, c: g.c,
        v: g.v,
        partial: periodoAberto || g.algum_parcial ? 1 : 0,
        pregoes: g.dias,
        primeiro_pregao: g.primeiro_pregao,
        ultimo_pregao: g.ultimo_pregao,
      };
    });
}
