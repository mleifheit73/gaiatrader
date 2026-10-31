/*
 * Testes dos niveis de acesso.
 *
 * A regra do Marcelo: o assinante atrasado nao e bloqueado. Ele entra, le
 * tudo o que construiu, e perde duas coisas: nao gasta IA e nao salva nada
 * novo. Estes testes existem para que essa regra nao escorregue para
 * "bloqueia o login" numa sessao futura.
 */
import {
  nivel, podeEntrar, podeLer, podeEscrever, podeGastarIA, podeSalvarConteudo,
  aviso, podePedirParecer, motivoEmTexto, precisaAlertarAdmin,
  SEM_ACESSO, SO_LEITURA, COMPLETO,
} from "../src/acesso.js";

let falhas = 0;
function ok(nome, cond, extra = "") {
  console.log(`${cond ? "PASSOU" : "FALHOU"}  ${nome}${extra ? "  " + extra : ""}`);
  if (!cond) falhas++;
}

const ativo = { id: "u1", ativo: 1 };
const assin = (status) => ({ status, plano: "mensal" });

/* ---- Os tres niveis ----------------------------------------------------- */

{
  ok("assinatura ativa da acesso completo", nivel(ativo, assin("ativa")) === COMPLETO);
  ok("beta da acesso completo", nivel(ativo, assin("beta")) === COMPLETO);
  ok("atrasada cai em so leitura", nivel(ativo, assin("atrasada")) === SO_LEITURA);
  ok("cancelada cai em so leitura", nivel(ativo, assin("cancelada")) === SO_LEITURA);
  ok("sem assinatura nenhuma cai em so leitura", nivel(ativo, null) === SO_LEITURA);
  ok("bloqueado pelo admin fica sem acesso", nivel({ ...ativo, ativo: 0 }, assin("ativa")) === SEM_ACESSO);
  ok("sem usuario fica sem acesso", nivel(null, null) === SEM_ACESSO);
}

{
  // Padrao seguro: status desconhecido NUNCA vira acesso completo.
  for (const s of ["pendente", "suspensa", "", "ATIVA", "trial", "xyz"]) {
    ok(`status desconhecido "${s}" nao vira acesso completo`,
       nivel(ativo, assin(s)) !== COMPLETO, `veio ${nivel(ativo, assin(s))}`);
  }
}

/* ---- A regra central ---------------------------------------------------- */

{
  const n = nivel(ativo, assin("atrasada"));
  ok("o atrasado ENTRA no sistema", podeEntrar(n) === true,
     "bloquear o login o impediria de entrar para pagar");
  ok("o atrasado LE tudo o que construiu", podeLer(n) === true);
  ok("o atrasado NAO salva nada novo", podeEscrever(n) === false);
  ok("o atrasado NAO gasta credito de IA", podeGastarIA(n) === false);
  ok("podeSalvarConteudo acompanha podeEscrever", podeSalvarConteudo(n) === podeEscrever(n));
}

{
  const n = nivel(ativo, assin("ativa"));
  ok("o assinante em dia faz tudo",
     podeEntrar(n) && podeLer(n) && podeEscrever(n) && podeGastarIA(n));
}

{
  const n = nivel({ ...ativo, ativo: 0 }, assin("ativa"));
  ok("o bloqueado pelo admin nao entra nem le", !podeEntrar(n) && !podeLer(n));
}

/* ---- A mensagem na tela ------------------------------------------------- */

{
  ok("quem esta em dia nao ve aviso nenhum", aviso(COMPLETO, assin("ativa")) === null);

  const a = aviso(SO_LEITURA, assin("atrasada"));
  ok("o atrasado ve convite a regularizar", a && a.acao === "Regularizar assinatura");
  ok("o aviso diz que os dados continuam la", /continuam aqui/.test(a.texto),
     "e o que impede o usuario achar que perdeu o trabalho");
  ok("o aviso diz o que ele ainda pode fazer", /consultar tudo/.test(a.texto));

  const c = aviso(SO_LEITURA, assin("cancelada"));
  ok("cancelada tem titulo proprio", c.titulo === "Assinatura cancelada");

  const b = aviso(SEM_ACESSO, null);
  ok("conta bloqueada nao oferece botao de pagar", b.acao === null);
}

/* ---- Cota de parecer ---------------------------------------------------- */

const cota = { pareceres_mes: 200, pareceres_hora: 30, alerta_em: 150 };

{
  const r = podePedirParecer(COMPLETO, cota, { pareceres: 10 }, { pareceres: 2 });
  ok("em dia e dentro da cota, permite", r.permitido === true);
  ok("informa quantos restam", r.restantes === 190, `veio ${r.restantes}`);
}

{
  const r = podePedirParecer(SO_LEITURA, cota, { pareceres: 0 }, null);
  ok("atrasado nao pede parecer mesmo com a cota zerada",
     r.permitido === false && r.motivo === "assinatura");
  ok("o texto da recusa fala de assinatura, nao de limite",
     /assinatura/.test(motivoEmTexto(r)) && !/ciclo/.test(motivoEmTexto(r)));
}

{
  const r = podePedirParecer(COMPLETO, cota, { pareceres: 50 }, { pareceres: 30 });
  ok("o teto de 30 por hora morde antes do mensal",
     r.permitido === false && r.motivo === "limite_hora",
     "50 de 200 no mes, mas 30 de 30 na hora");
  ok("o texto manda tentar na proxima hora", /proxima hora/.test(motivoEmTexto(r)));
}

{
  const r = podePedirParecer(COMPLETO, cota, { pareceres: 200 }, { pareceres: 0 });
  ok("em 200 de 200 bloqueia", r.permitido === false && r.motivo === "limite_mes");
  ok("o texto diz quando renova", /proxima cobranca/.test(motivoEmTexto(r)),
     "renova na data de cobranca dele, nao no dia 1");
}

{
  const r = podePedirParecer(COMPLETO, cota, { pareceres: 199 }, { pareceres: 29 });
  ok("em 199 de 200 e 29 de 30 ainda permite", r.permitido === true,
     "o limite e >=, nao >");
}

{
  // Cota aumentada pelo admin para um usuario especifico.
  const maior = { ...cota, pareceres_mes: 400 };
  const r = podePedirParecer(COMPLETO, maior, { pareceres: 250 }, { pareceres: 1 });
  ok("com a cota aumentada pelo admin, 250 continua permitido", r.permitido === true);
  ok("o limite informado reflete o aumento", r.limite === 400);
}

{
  // Sem linha de cota, cai nos padroes.
  const r = podePedirParecer(COMPLETO, null, null, null);
  ok("sem linha de cota, usa os padroes (200)", r.limite === 200 && r.permitido === true);
}

/* ---- Alerta do admin ---------------------------------------------------- */

{
  ok("em 149 nao alerta", precisaAlertarAdmin(cota, { pareceres: 149, alerta_enviado: 0 }) === false);
  ok("em 150 alerta", precisaAlertarAdmin(cota, { pareceres: 150, alerta_enviado: 0 }) === true);
  ok("em 180 alerta", precisaAlertarAdmin(cota, { pareceres: 180, alerta_enviado: 0 }) === true);
  ok("nao alerta duas vezes no mesmo ciclo",
     precisaAlertarAdmin(cota, { pareceres: 180, alerta_enviado: 1 }) === false,
     "senao o painel vira ruido e o admin para de olhar");
  ok("sem dados nao alerta", precisaAlertarAdmin(null, null) === false);
}

console.log(falhas === 0 ? "\nTODOS OS TESTES PASSARAM" : `\n${falhas} TESTE(S) FALHARAM`);
process.exit(falhas === 0 ? 0 : 1);
