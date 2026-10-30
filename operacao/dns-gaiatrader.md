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

## Pendente

1. Retomar na Cloudflare, concluir a ativação e anotar os dois
   nameservers.
2. Trocar os nameservers na Hostinger pelos dois da Cloudflare.
   **Este é o único passo que muda o comportamento do domínio.**
3. Ligar o domínio ao Worker (Workers & Pages, Domains & Routes).
4. Trocar `SUPORTE_EMAIL` no `wrangler.toml`, hoje `info@gaiabelle.com`,
   para `contato@gaiatrader.com.br`.

O `gaiatrader.com` também é do Marcelo e fica parado por decisão dele.
