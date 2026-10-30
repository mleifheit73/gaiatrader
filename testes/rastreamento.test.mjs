import { apurarLote, rastrear, selecionarParaApurar } from "../src/rastreamento.js";

let falhas = 0;
function ok(nome, cond, extra = "") {
  console.log(`${cond ? "PASSOU" : "FALHOU"}  ${nome}${extra ? "  " + extra : ""}`);
  if (!cond) falhas++;
}

/*
 * Banco falso: reconhece as consultas pelo trecho de SQL e devolve dado
 * controlado. Nao e um SQLite, e nem precisa ser: o que esta sendo testado e a
 * logica de apuracao, nao o banco.
 */
function bancoFalso({ ativos, candles, eventos = {} }) {
  const gravadas = [];
  const errosGravados = [];

  return {
    gravadas, errosGravados,
    prepare(sql) {
      let args = [];
      const self = {
        bind(...a) { args = a; return self; },
        async all() {
          if (sql.includes("FROM assets a") && sql.includes("asset_metrics")) {
            return { results: ativos };
          }
          if (sql.includes("FROM daily_bars")) {
            const [ticker, limite] = args;
            const serie = candles[ticker] || [];
            return { results: serie.slice(-limite).reverse() };
          }
          if (sql.includes("corporate_events")) {
            return { results: eventos[args[0]] || [] };
          }
          return { results: [] };
        },
        async first() { return null; },
        async run() {
          if (sql.includes("INSERT INTO asset_metrics") && sql.includes("erro = excluded.erro")) {
            errosGravados.push({ ticker: args[0], erro: args[1] });
          } else if (sql.includes("INSERT INTO asset_metrics")) {
            // 13 colunas por linha
            for (let i = 0; i < args.length; i += 13) {
              const [ticker, periodo, d, base, fechamento, mmaC, mmaL,
                     ifrC, ifrL, atr, liq, emForm, cortado] = args.slice(i, i + 13);
              gravadas.push({ ticker, periodo, d, base, fechamento, mma_curta: mmaC,
                mma_longa: mmaL, ifr_curto: ifrC, ifr_longo: ifrL, atr, liquidez: liq,
                em_formacao: emForm, cortado_em: cortado, parametros: args.length });
            }
          }
          return { meta: { changes: 1 } };
        },
      };
      return self;
    },
  };
}

/** Serie diaria sintetica com datas uteis reais. */
function serie(n, precoInicial = 100, inicio = "2024-01-01") {
  const bars = [];
  const d = new Date(inicio + "T00:00:00Z");
  let preco = precoInicial;
  while (bars.length < n) {
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) {
      preco = preco * (1 + Math.sin(bars.length / 7) * 0.01);
      bars.push({
        d: d.toISOString().slice(0, 10),
        o: preco, h: preco * 1.01, l: preco * 0.99, c: preco,
        v: 1_000_000, partial: 0,
      });
    }
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return bars;
}

// ---------------------------------------------------------------------------
// 1. APURACAO: tres linhas por ativo, uma por tempo grafico
// ---------------------------------------------------------------------------
const db1 = bancoFalso({
  ativos: [{ ticker: "AAAA3", market: "b3" }, { ticker: "BBBB3", market: "b3" }],
  candles: { AAAA3: serie(300), BBBB3: serie(300, 50) },
});
const r1 = await apurarLote(db1, { lote: 10 });

ok("dois ativos apurados sem falha", r1.ok === 2 && r1.falhas === 0);
ok("tres linhas por ativo", r1.linhas === 6, `deu ${r1.linhas}`);
ok("um registro por tempo grafico", ["dia", "semana", "mes"].every(
  (p) => db1.gravadas.filter((g) => g.periodo === p).length === 2));
ok("le o ativo UMA vez, nao uma por tempo grafico",
   r1.candles_lidos === 600, `leu ${r1.candles_lidos} candles para 2 ativos de 300`);

const diaA = db1.gravadas.find((g) => g.ticker === "AAAA3" && g.periodo === "dia");
ok("diario tem MMA de 200 com 300 pregoes", diaA.mma_longa !== null);
ok("diario traz IFR, ATR e liquidez", diaA.ifr_curto !== null && diaA.atr !== null && diaA.liquidez !== null);

const mesA = db1.gravadas.find((g) => g.ticker === "AAAA3" && g.periodo === "mes");
ok("mensal com 300 pregoes NAO tem MMA de 200 (sem base)", mesA.mma_longa === null);
ok("mensal informa a base real em barras mensais", mesA.base < 20, `base ${mesA.base}`);

// ---------------------------------------------------------------------------
// 2. LIMITE DE PARAMETROS DO D1: nunca pode passar de 100 por comando
// ---------------------------------------------------------------------------
ok("nenhum comando passa de 100 parametros",
   db1.gravadas.every((g) => g.parametros <= 100),
   `maior foi ${Math.max(...db1.gravadas.map((g) => g.parametros))}`);

// ---------------------------------------------------------------------------
// 2b. O COMANDO PRECISA PREENCHER AS COLUNAS OBRIGATORIAS
//
// A primeira versao nao preenchia calculado_em, que e NOT NULL, e toda gravacao
// falhava na restricao do banco. O banco falso daqui exercita a logica, nao o
// esquema, entao o teste precisa olhar o proprio comando gerado.
// ---------------------------------------------------------------------------
const sqlVistos = [];
const dbSql = bancoFalso({ ativos: [{ ticker: "GGGG3", market: "b3" }], candles: { GGGG3: serie(300) } });
const prepareOriginal = dbSql.prepare.bind(dbSql);
dbSql.prepare = (sql) => { sqlVistos.push(sql); return prepareOriginal(sql); };
await apurarLote(dbSql, { lote: 1, periodos: ["dia"] });

const insert = sqlVistos.find((q) => q.includes("INSERT INTO asset_metrics") && q.includes("VALUES"));
ok("o comando de insercao preenche calculado_em", /calculado_em/.test(insert));
ok("calculado_em entra como expressao, sem gastar parametro",
   /datetime\('now'\)\)/.test(insert));

// ---------------------------------------------------------------------------
// 3. A APURACAO USA A SERIE AJUSTADA, SEMPRE
// Um provento no meio da serie tem que mudar a media longa. Se nao mudar, o
// ajuste nao esta sendo aplicado.
// ---------------------------------------------------------------------------
const base = serie(300);
const semEvento = bancoFalso({ ativos: [{ ticker: "CCCC3", market: "b3" }], candles: { CCCC3: base } });
const comEvento = bancoFalso({
  ativos: [{ ticker: "CCCC3", market: "b3" }],
  candles: { CCCC3: base },
  eventos: { CCCC3: [{ d: base[250].d, kind: "div", valor: base[250].c * 0.1 }] },
});
await apurarLote(semEvento, { lote: 1, periodos: ["dia"] });
await apurarLote(comEvento, { lote: 1, periodos: ["dia"] });

const mmSem = semEvento.gravadas[0].mma_longa;
const mmCom = comEvento.gravadas[0].mma_longa;
ok("provento muda a media longa, provando que o ajuste e aplicado",
   Math.abs(mmSem - mmCom) > 0.01, `sem ${mmSem?.toFixed(4)}, com ${mmCom?.toFixed(4)}`);
ok("o fechamento NAO muda, porque o ajuste e retroativo",
   Math.abs(semEvento.gravadas[0].fechamento - comEvento.gravadas[0].fechamento) < 1e-9);

// ---------------------------------------------------------------------------
// 4. BURACO NA SERIE: so o trecho recente vale, e o corte fica registrado
// ---------------------------------------------------------------------------
const antigo = serie(100, 30, "2016-01-04");
const recente = serie(60, 10, "2024-06-03");
const comBuraco = bancoFalso({
  ativos: [{ ticker: "DDDD3", market: "b3" }],
  candles: { DDDD3: [...antigo, ...recente] },
});
await apurarLote(comBuraco, { lote: 1, periodos: ["dia"] });
const comCorte = comBuraco.gravadas[0];
ok("a leitura usa so o trecho posterior ao buraco", comCorte.base === 60, `base ${comCorte.base}`);
ok("o corte fica registrado para a tela poder avisar", comCorte.cortado_em === recente[0].d);
ok("com 60 pregoes a MMA de 200 vem nula", comCorte.mma_longa === null);

// ---------------------------------------------------------------------------
// 5. FALHA DE UM ATIVO NAO DERRUBA OS OUTROS, E FICA REGISTRADA
// ---------------------------------------------------------------------------
const comFalha = bancoFalso({
  ativos: [{ ticker: "EEEE3", market: "b3" }, { ticker: "VAZIO3", market: "b3" },
           { ticker: "FFFF3", market: "b3" }],
  candles: { EEEE3: serie(300), VAZIO3: [], FFFF3: serie(300, 20) },
});
const r5 = await apurarLote(comFalha, { lote: 10, periodos: ["dia"] });
ok("os dois ativos bons sao apurados", r5.ok === 2);
ok("o ativo sem candle conta como falha", r5.falhas === 1);
ok("a falha e relatada com o motivo", r5.problemas[0].ticker === "VAZIO3" && /sem candles/.test(r5.problemas[0].erro));
ok("o erro e gravado na linha do ativo, nao so no log",
   comFalha.errosGravados.length === 1 && comFalha.errosGravados[0].ticker === "VAZIO3");

// ---------------------------------------------------------------------------
// 6. CRIPTO: o intervalo maximo entre pregoes e diferente
// Fim de semana nao pode ser lido como buraco em cripto nem na B3.
// ---------------------------------------------------------------------------
const criptoSerie = [];
const dc = new Date("2024-01-01T00:00:00Z");
for (let i = 0; i < 300; i++) {
  criptoSerie.push({ d: dc.toISOString().slice(0, 10), o: 100, h: 101, l: 99, c: 100, v: 1e6, partial: 0 });
  dc.setUTCDate(dc.getUTCDate() + 1);
}
const dbCripto = bancoFalso({ ativos: [{ ticker: "BTC", market: "cripto" }], candles: { BTC: criptoSerie } });
await apurarLote(dbCripto, { lote: 1, periodos: ["dia"] });
// Le 280 pregoes de proposito para o tempo diario: 200 da media longa mais
// folga. Entao a base ser 280 significa que NADA foi cortado.
ok("cripto com dias corridos nao e cortado por causa do fim de semana",
   dbCripto.gravadas[0].base === 280, `base ${dbCripto.gravadas[0].base}`);
ok("cripto nao registra corte", dbCripto.gravadas[0].cortado_em === null);

// E a prova pelo contrario: em cripto, um buraco de 5 dias DEVE cortar.
const criptoComBuraco = [...criptoSerie.slice(0, 100)];
const dd = new Date(criptoComBuraco.at(-1).d + "T00:00:00Z");
dd.setUTCDate(dd.getUTCDate() + 10);
for (let i = 0; i < 50; i++) {
  criptoComBuraco.push({ d: dd.toISOString().slice(0, 10), o: 50, h: 51, l: 49, c: 50, v: 1e6, partial: 0 });
  dd.setUTCDate(dd.getUTCDate() + 1);
}
const dbCriptoBuraco = bancoFalso({ ativos: [{ ticker: "ETH", market: "cripto" }], candles: { ETH: criptoComBuraco } });
await apurarLote(dbCriptoBuraco, { lote: 1, periodos: ["dia"] });
ok("em cripto, buraco de 10 dias corta a serie", dbCriptoBuraco.gravadas[0].base === 50,
   `base ${dbCriptoBuraco.gravadas[0].base}`);

console.log(falhas === 0 ? "\nTODOS OS TESTES PASSARAM" : `\n${falhas} TESTE(S) FALHARAM`);
process.exit(falhas === 0 ? 0 : 1);
