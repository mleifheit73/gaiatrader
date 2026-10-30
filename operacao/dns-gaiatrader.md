# DNS do gaiatrader.com.br

Inventário tirado do painel da Hostinger em 30/10/2026, logo depois de
ativar a caixa `contato@gaiatrader.com.br`. Serve de conferência para a
migração dos nameservers para a Cloudflare: **se algum destes nove
registros de e-mail não aparecer lá, o e-mail quebra.**

## Situação em 30/10/2026

Nameservers: `aurora.dns-parking.com` e `nebula.dns-parking.com`
(estacionamento da Hostinger). Registrador: Hostinger, expira 2027-10-22.

## Preservar: e-mail (9 registros)

| Tipo | Nome | Valor | Prioridade | TTL |
|---|---|---|---|---|
| MX | @ | mx1.hostinger.com | 5 | 14400 |
| MX | @ | mx2.hostinger.com | 10 | 14400 |
| TXT | @ | `v=spf1 include:_spf.mail.hostinger.com ~all` | | 3600 |
| TXT | _dmarc | `v=DMARC1; p=none` | | 3600 |
| CNAME | hostingermail-a._domainkey | hostingermail-a.dkim.mail.hostinger.com | | 300 |
| CNAME | hostingermail-b._domainkey | hostingermail-b.dkim.mail.hostinger.com | | 300 |
| CNAME | hostingermail-c._domainkey | hostingermail-c.dkim.mail.hostinger.com | | 300 |
| CNAME | autodiscover | autodiscover.mail.hostinger.com | | 300 |
| CNAME | autoconfig | autoconfig.mail.hostinger.com | | 300 |

**O que cada grupo faz.** Os dois MX dizem para onde entregar as
mensagens recebidas. O SPF autoriza os servidores da Hostinger a enviar
em nome do domínio. Os três DKIM assinam as mensagens enviadas. O DMARC
diz o que fazer quando SPF ou DKIM falham (`p=none` apenas observa, não
rejeita). O autodiscover e o autoconfig fazem clientes de e-mail
acharem as configurações sozinhos.

## Substituir: site (2 registros)

| Tipo | Nome | Valor atual | Vira |
|---|---|---|---|
| A | @ | 2.57.91.91 | o Worker do Gaia Trader |
| CNAME | www | gaiatrader.com.br | o Worker do Gaia Trader |

O `2.57.91.91` é o IP da página de estacionamento da Hostinger, aquela
roxa. Estes dois saem quando o domínio apontar para o Worker.

## Conta de e-mail

`contato@gaiatrader.com.br`, plano Starter Business Email em teste
gratuito de 12 meses, ativado em 30/10/2026. **Cobra automaticamente
por volta de 30/10/2027** se a renovação automática não for desligada.
Existe tarefa agendada para avisar em 30/09/2027.

A senha fica no gerenciador de senhas do Marcelo. Não é guardada aqui
nem em lugar nenhum do projeto.

## Andamento (30/10/2026, 17h40)

**Feito.** O domínio foi adicionado à conta `gaiatrader` da Cloudflare,
no plano Free. A importação automática trouxe os onze registros, número
que bate com o inventário acima.

**Defeito encontrado e corrigido na importação.** A Cloudflare marcou
cinco registros como **Proxied** que precisam ser **DNS only**: os três
DKIM (`hostingermail-a/b/c._domainkey`), o `autoconfig` e o
`autodiscover`. Proxied, a Cloudflare responde com o IP dela em vez de
resolver o endereço real da Hostinger: a assinatura DKIM falha e os
e-mails enviados passam a cair em spam, sem mensagem de erro nenhuma.
Os cinco foram passados para DNS only e conferidos na tela.

O `A @` e o `CNAME www` seguem Proxied de propósito: são tráfego web e
vão dar lugar ao Worker.

**Parou aqui.** A extensão do Chrome desconectou logo após o clique em
"Continue to activation". Nada ficou num estado perigoso: os nameservers
na Hostinger continuam os de estacionamento, então o domínio se comporta
como antes, e a zona na Cloudflare fica em "Pending" sem efeito algum
até os nameservers mudarem.

## Nameservers da Cloudflare para este domínio

```
nile.ns.cloudflare.com
rosalyn.ns.cloudflare.com
```

Conferidos caractere a caractere na tela em 30/10/2026. São exclusivos
desta conta. Substituem `aurora.dns-parking.com` e
`nebula.dns-parking.com`, que eram os de estacionamento da Hostinger.

## Nameservers trocados (30/10/2026, 18h)

A Hostinger confirmou a troca por `nile.ns.cloudflare.com` e
`rosalyn.ns.cloudflare.com`, e passou a exibir "O DNS é gerenciado em
outro provedor". O registro do domínio continua com ela.

A Cloudflare está em "Waiting for your registrar to propagate your new
nameservers". A verificação foi disparada manualmente e ela avisa por
e-mail quando a zona ficar ativa. Costuma levar de 1 a 2 horas, podendo
chegar a 24.

**Enquanto não ativa, nada muda para quem acessa:** os nameservers
antigos continuam respondendo, com os mesmos registros de antes.

Também já foi feito: `SUPORTE_EMAIL` no `wrangler.toml` saiu de
`info@gaiabelle.com`, que é de outro projeto, e passou a
`contato@gaiatrader.com.br`.

## Concluído (30/10/2026, 20h15)

O domínio responde pelo sistema. `https://gaiatrader.com.br/api/health`
devolve `ok: true`, com banco conectado, arquivos conectados e os dois
tokens configurados. O certificado HTTPS saiu válido já na primeira
tentativa.

**Os dois domínios personalizados do Worker:** `gaiatrader.com.br` e
`www.gaiatrader.com.br`, ambos em Production.

**Para conectar, foi preciso apagar dois registros primeiro.** A
Cloudflare recusa criar o domínio do Worker sobre um registro que já
existe. Saíram o `A @ → 2.57.91.91` (o IP da página de estacionamento)
e o `CNAME www`. Os nove de e-mail ficaram, conferidos um a um: a lista
fechou em 9 de 9, todos em DNS only, nenhum proxied.

> **Nota de operação.** A exclusão de registro de DNS foi bloqueada para
> mim pelo classificador de segurança, por ser ação destrutiva. Os dois
> cliques foram do Marcelo, com a conferência feita antes por mim. Se
> isso se repetir noutra migração, o caminho é o mesmo: eu preparo e
> confiro, ele executa a exclusão.

## E-mail testado e aprovado (30/10/2026, 20h19)

Teste de ponta a ponta, com evidência:

| Teste | Resultado |
|---|---|
| Gmail → `contato@gaiatrader.com.br` | chegou às 20:17 |
| `contato@` → Gmail | chegou às 20:19, **na aba Principal, não no Spam** |

A segunda linha é a que prova a correção dos DKIM. Um domínio criado há
três horas passando pelo filtro do Gmail direto para a Principal só
acontece com SPF, DKIM e DMARC alinhados. Se os três DKIM tivessem
ficado como "Proxied", essa mensagem teria ido para o spam.

### Correção de uma afirmação minha

Eu disse que o plano Starter não acrescentaria assinatura da Hostinger.
Errado. O plano ativado é **"Starter Business Email Free Trial"**, um
degrau separado do Starter puro, e ele **acrescenta "Sent with Hostinger
Mail"** no rodapé. Os outros dois domínios do Marcelo estão no Starter
sem "Free Trial" e não têm isso. Tirar a assinatura exige upgrade pago.

Decisão: fica como está durante o beta. Reavaliar no lançamento, quando
R$ 2,49 por mês para limpar o rodapé de um produto pago é barato.

### O plano, como está de fato

- `@gaiatrader.com.br`, Starter Business Email **Free Trial**
- **1 de 5 caixas** usadas (os outros planos do Marcelo são 1/1), então
  dá para criar `suporte@` sem custo durante o teste
- Expira **2027-10-30**, renovação automática **ligada**
- Lembrete agendado para 2027-09-30 confere com essa data

## Pendente

**Decidir como o Marcelo lê e responde.** Hoje ele entra no webmail da
Hostinger. O plano tem 5 regras de encaminhamento e 5 aliases livres,
então dá para encaminhar para a caixa que ele já usa, ou configurar
"enviar como" no cliente dele.

O `gaiatrader.com` também é do Marcelo e fica parado por decisão dele.
