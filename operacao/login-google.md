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

## Parte 2: a tela de consentimento

É a tela que aparece para o usuário dizendo "o Gaia Trader quer acessar sua conta".

1. No menu da esquerda, vá em **APIs e serviços**, depois **Tela de permissão
   OAuth** (ou **OAuth consent screen**)
2. Escolha **Externo** (**External**) e clique em **Criar**
3. Preencha:
   - Nome do app: **Gaia Trader**
   - E-mail de suporte do usuário: **contato@gaiatrader.com.br**
   - Domínio do app, página inicial: **https://gaiatrader.com.br**
   - Domínios autorizados: **gaiatrader.com.br**
   - E-mail do desenvolvedor: **mleifheit@gmail.com**
4. Clique em **Salvar e continuar**
5. Na tela de **Escopos**, não adicione nada. Clique em **Salvar e continuar**
6. Na tela de **Usuários de teste**, adicione **mleifheit@gmail.com** e
   **laghettogolden@gmail.com**. Clique em **Salvar e continuar**

> **Importante sobre o modo de teste:** enquanto o app estiver como "Em teste",
> **só os e-mails que você cadastrar como usuários de teste conseguem entrar**.
> Isso é perfeito para o beta fechado. Quando for abrir para o público, você
> publica o app, e aí o Google pode pedir uma verificação.

## Parte 3: criar as credenciais

1. Ainda em **APIs e serviços**, vá em **Credenciais** (**Credentials**)
2. Clique em **Criar credenciais**, depois **ID do cliente OAuth**
3. Tipo de aplicativo: **Aplicativo da Web** (**Web application**)
4. Nome: **Gaia Trader Web**
5. Em **URIs de redirecionamento autorizados** (**Authorized redirect URIs**),
   clique em **Adicionar URI** e cole **exatamente** isto:

   ```
   https://gaiatrader.com.br/auth/google/callback
   ```

   > Esse endereço tem que bater **caractere por caractere** com o que o nosso
   > servidor usa. Uma barra a mais no fim já faz o Google recusar com
   > `redirect_uri_mismatch`, que é o erro mais comum nessa montagem.

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
