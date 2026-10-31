# Como ligar o login com Google

Guia para o Marcelo. O código já está pronto; falta criar as credenciais no
Google e colar duas delas no Worker. **Os segredos não passam por mim**: você
cria, copia e cola direto no painel da Cloudflare.

Leva uns 10 minutos.

## Parte 1: criar o projeto no Google

1. Abra `console.cloud.google.com` e entre com a conta **mleifheit@gmail.com**
2. No topo da página tem um seletor de projeto. Clique nele e depois em **Novo
   projeto** (ou **New project**)
3. Nome do projeto: **Gaia Trader**. Clique em **Criar**
4. Espere uns segundos e confirme que o seletor do topo agora mostra "Gaia Trader"

## Parte 2: a tela de permissão

É a tela que aparece para o usuário dizendo "o Gaia Trader quer acessar sua conta".

O Google tem duas interfaces para isso, e a que você vai ver depende da conta.
A nova se chama **Google Auth Platform** e o menu da esquerda tem: Visão geral,
Branding, Público-alvo, Clientes, Acesso a dados, Central de verificação.

### Passo 1, Informações do app

- **Nome do app:** `Gaia Trader`
- **E-mail para suporte do usuário:** escolha **`mleifheit@gmail.com`** na lista

> **Atenção, isto confunde:** esse campo **não é de digitar**. É uma lista
> suspensa, e o Google só aceita ali o e-mail da conta que está logada ou um
> grupo do Google que você administre. O `contato@gaiatrader.com.br` é uma
> caixa do Hostinger, não uma conta Google, então ele **não pode** aparecer
> nessa lista. Use o seu Gmail e siga em frente: esse endereço serve só para
> o usuário ter como te contatar a respeito da permissão.

Clique em **Avançar**.

### Passo 2, Público

Escolha **Externo** (**External**).

Interno só existe para contas do Google Workspace com domínio próprio, e deixa
entrar apenas gente da mesma empresa. Não é o nosso caso.

Clique em **Avançar**.

### Passo 3, Dados de contato

Aqui **você digita**. É o endereço que o Google usa para te avisar sobre
mudanças no projeto. Pode usar `mleifheit@gmail.com` ou
`contato@gaiatrader.com.br`, tanto faz, porque aqui aceita texto livre.

Clique em **Avançar**, aceite os termos e **Criar**.

### Passo 4, quem pode entrar durante o beta

No menu da esquerda, vá em **Público-alvo**.

Se o estado estiver como **Em teste** (**Testing**), existe uma seção
**Usuários de teste**. Clique em **Adicionar usuários** e cadastre:

- `mleifheit@gmail.com`
- `laghettogolden@gmail.com`

> **Isso é melhor do que parece.** Enquanto o app estiver "Em teste", **só os
> e-mails dessa lista conseguem entrar**, e mais ninguém. É uma porta de
> convidados pronta para o beta fechado, sem você precisar programar nada.
> Quando for abrir para o público, você publica o app, e aí o Google pode
> pedir uma verificação.

### Passo 5, escopos

No menu da esquerda, **Acesso a dados**. **Não adicione nada.**

Nosso login pede só nome, e-mail e foto, que o Google já entrega por padrão.
Pedir permissão que não se usa é pedir risco de graça, e ainda complica a
verificação lá na frente.

## Parte 3: criar as credenciais

1. No menu da esquerda, clique em **Clientes** (na interface antiga é
   **Credenciais**)
2. Clique em **Criar cliente** (ou **Criar credenciais**, depois **ID do
   cliente OAuth**)
3. **Tipo de aplicativo:** `Aplicativo da Web` (**Web application**)
4. **Nome:** `Gaia Trader Web`
5. Em **URIs de redirecionamento autorizados** (**Authorized redirect URIs**),
   clique em **Adicionar URI** e cole **exatamente** isto:

   ```
   https://gaiatrader.com.br/auth/google/callback
   ```

   > Esse endereço tem que bater **caractere por caractere** com o que o nosso
   > servidor usa. Uma barra a mais no fim já faz o Google recusar com
   > `redirect_uri_mismatch`, que é o erro mais comum nessa montagem.

   Não precisa preencher "Origens JavaScript autorizadas": o nosso login não
   usa JavaScript para falar com o Google, é o servidor que faz isso.

6. Clique em **Criar**

Vai abrir uma janela com duas informações: **ID do cliente** e **Chave secreta
do cliente**. Não feche essa janela ainda.

## Parte 4: colar no Worker

1. Abra `dash.cloudflare.com`, vá em **Compute**, **Workers e Pages**, e clique
   no worker **gaiatrader**
2. Aba **Settings**, seção **Variables and Secrets**
3. Clique em **Add**, e cadastre as duas, **as duas como Secret** (não como
   Text), porque são credenciais:

   | Nome | Valor |
   |---|---|
   | `GOOGLE_CLIENT_ID` | o ID do cliente que o Google mostrou |
   | `GOOGLE_CLIENT_SECRET` | a chave secreta do cliente |

4. Clique em **Deploy** para aplicar

## Parte 5: conferir

1. Abra `https://gaiatrader.com.br/entrar.html`
2. Se aparecer o aviso amarelo "Login ainda não configurado", alguma das duas
   variáveis não entrou. Confira o nome, que é sensível a maiúsculas
3. Clique em **Entrar com a conta Google** e escolha **mleifheit@gmail.com**
4. Você deve cair na página de consumo do admin

Se der errado, a tela de entrada mostra a mensagem real do erro no topo. Me
manda essa mensagem e eu te digo o que é.

## Os erros mais comuns, e o que significam

| Mensagem | O que aconteceu |
|---|---|
| `redirect_uri_mismatch` | o endereço de retorno no Google não bate com o nosso, letra por letra |
| `access_denied` | você clicou em cancelar, ou o e-mail não está na lista de usuários de teste |
| `invalid_client` | o ID ou a chave secreta foram colados errados, ou com espaço sobrando |
| A entrada expirou ou veio de um caminho inesperado | demorou mais de 10 minutos na tela do Google, ou o cookie foi bloqueado. Tente de novo |

## Quem entra como administrador

A lista está gravada no banco, na tabela de configuração, e hoje tem:

- `mleifheit@gmail.com`
- `laghettogolden@gmail.com`

Os dois nascem administradores no primeiro login. **O papel é recalculado a
cada login**, então tirar um e-mail da lista rebaixa a pessoa na próxima vez
que ela entrar, sem precisar mexer em mais nada.

Só vira administrador quem está na lista **e** tem o e-mail verificado pelo
Google. Sem essa segunda condição, bastaria alguém conseguir uma conta que
alegasse aquele endereço para virar dono do sistema.
