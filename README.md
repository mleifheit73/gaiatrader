# Gaia Trader

Plataforma de análise técnica para ações da B3 e criptomoedas. Ferramenta de
estudo e planejamento para swing trade e position trade, voltada a quem tem outra
profissão e pouco tempo para analisar.

**Não é sistema de recomendação de investimentos.** Não indica ativo, não diz
quando comprar e não promete rentabilidade.

---

## Situação atual: Fase 0 (esqueleto)

O objetivo da Fase 0 é provar o caminho completo de dados antes de portar
qualquer funcionalidade: provedor, ingestão, banco, API e gráfico.

Sem login, sem IA, sem cobrança, sem cadastro. Um único ativo (PETR4).

## Arquitetura

```
Navegador
    │
    ▼
Cloudflare Worker  (gaiatrader-api)
    ├── /api/health         estado do serviço
    ├── /api/bars           série de candles, lida do NOSSO banco
    ├── /api/status         últimas cargas e totais
    ├── /api/admin/ingest   dispara carga manual (protegido por segredo)
    └── /                   arquivos estáticos
    │
    ├──► D1 (gaiatrader-db)      cotações, ativos, histórico de cargas
    └──► Cron diário 21h30 UTC   = 18h30 de Brasília, seg a sex
             │
             ▼
         Provedor de cotações (trocável)
```

### O provedor de dados é trocável de propósito

O Yahoo Finance **não autoriza uso comercial**. Ele está aqui para
desenvolvimento e validação.

Todo o sistema fala com `getProvider()` e nunca com um provedor concreto. Trocar
para um provedor licenciado deve custar **uma linha** em `src/providers/index.js`,
mais o arquivo do provedor novo cumprindo o mesmo contrato. Se algum dia for
preciso mudar mais que isso, a camada vazou e precisa ser consertada.

Contrato de um provedor:

```js
daily(ticker, market, opts) -> {
  name, currency,
  bars: [{ d: "YYYY-MM-DD", o, h, l, c, v, partial }]
}
```

### Decisões de projeto que valem registro

**A data do pregão é guardada como texto `YYYY-MM-DD`, não como carimbo de tempo.**
O pregão de um dia é uma data, não um instante. Guardar como instante foi a origem
dos defeitos de fuso horário que custaram caro na versão anterior do sistema
(candle de câmbio caindo no dia anterior, barra mensal duplicada). Data como data
elimina a classe inteira de erro.

**A ingestão é idempotente.** A chave primária `(ticker, d)` com `ON CONFLICT DO
UPDATE` faz com que rodar a mesma carga duas vezes atualize, nunca duplique.

**Toda carga é registrada** na tabela `ingest_runs`, com início, fim, quantos
ativos deram certo, quantos falharam e por quê. Carga que falha em silêncio é o
pior defeito possível num sistema de dados: pode quebrar numa terça e só ser
notada um mês depois.

**A falha de um ativo não derruba a carga dos outros.**

## Estrutura

```
migrations/0001_init.sql    esquema do banco
src/index.js                Worker: rotas da API e rotina agendada
src/ingest.js               ingestão, idempotente e observável
src/providers/index.js      escolha do provedor (ponto único de troca)
src/providers/yahoo.js      provedor Yahoo Finance
public/index.html           página do gráfico, lê do nosso banco
wrangler.toml               configuração do Worker, banco e agendamento
```

## Publicação

O repositório é a fonte da verdade. A publicação acontece pelo Workers Builds da
Cloudflare: todo envio para a ramificação principal publica automaticamente.

Para rodar localmente:

```bash
npm install
cp .dev.vars.example .dev.vars    # e troque o ADMIN_TOKEN
npm run dev
```

Segredos nunca ficam no repositório. São definidos com:

```bash
npx wrangler secret put ADMIN_TOKEN
```

## Disparar uma carga manualmente

```bash
curl -X POST https://<endereco>/api/admin/ingest -H "x-admin-token: <segredo>"
```

## Próximas fases

| Fase | Escopo |
|---|---|
| 0 | Esqueleto: um ativo, do provedor ao gráfico (atual) |
| 1 | Mercado completo, histórico de 10 anos, indicadores |
| 2 | Cadastro, login e separação de dados por usuário |
| 3 | Funções de inteligência artificial, com cota por usuário |
| 4 | Diário de trades, pareceres e estudos salvos |
| 5 | Cobrança e controle de assinatura |

## Limites da plataforma que o projeto respeita

Números da documentação da Cloudflare, não do SQLite. A diferença entre os dois
já custou uma carga falha: o SQLite permite 999 parâmetros por comando, o D1
permite 100.

| Limite | Valor | Onde nos afeta |
|---|---|---|
| Parâmetros por comando (D1) | 100 | Gravação de candles: 9 linhas por comando |
| Comandos por lote (D1) | sem limite documentado | Um lote conta como uma operação só |
| Tamanho do banco (plano gratuito) | 500 MB | 96 ativos com 10 anos dão cerca de 36 MB |
| Chamadas externas por execução (plano gratuito) | 50 | Ingestão em lotes de até 20 ativos |
| Consultas ao provedor (teto nosso) | 120 por hora | Um terço do limite rumorado do Yahoo |

## Pendências conhecidas

- Licença de dados para uso comercial: obrigatória antes da primeira cobrança
- Base legal de LGPD e política de privacidade: antes da Fase 2
- Registro de consumo de tokens por usuário: precisa existir desde a Fase 3
- Registro de eventos de uso: precisa existir desde a Fase 2
