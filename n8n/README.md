# Cockpit Financeiro Estratégico — Workflows n8n

Esta pasta contém os três workflows n8n importáveis que implementam a **camada de
orquestração** do *Cockpit Financeiro Estratégico* do Grupo Aurora (n8n + PostgreSQL 16 +
pgvector + RAG/Claude). Todos os nomes de tabela, coluna, `account_code`, `company_id` e
fórmulas seguem o **`SPEC.md`** na raiz do projeto (fonte única da verdade).

> ⚠️ Os workflows são entregues **inativos** (`active: false`). Ative-os no n8n só depois de
> configurar credenciais, variáveis de ambiente e o schema do banco (`db/schema.sql`,
> `db/rbac.sql`, `db/seed_reference.sql`).

## Conteúdo

| Arquivo | Fase | O que faz |
|---|---|---|
| `workflows/01_ingestao_planilhas.json` | 1 — Ingestão | Lê planilhas `.xlsx` de `data/raw`, valida o schema, faz upsert em `cockpit.fact_financials` e quarentena das linhas inválidas, com `pipeline_runs` / `ingestion_log`. |
| `workflows/02_pipeline_embeddings.json` | 2 — Embeddings | Lê as views de KPI, gera narrativas em `cockpit.kb_documents`, chama o endpoint de embeddings e faz upsert em `cockpit.kb_embeddings`. |
| `workflows/03_rag_consulta.json` | 2 — RAG | Webhook `POST /cockpit-ask`: embedda a pergunta, faz busca vetorial top‑k, monta prompt ancorado, chama o **Claude** e devolve resposta + fontes, auditando em `cockpit.ai_query_audit`. |

---

## 1. Pré‑requisitos

- **n8n** ≥ 1.x (testado com nós `scheduleTrigger@1.2`, `postgres@2.6`, `httpRequest@4.2`,
  `spreadsheetFile@2`, `readWriteFile@1`, `webhook@2`, `respondToWebhook@1.1`, `code@2`,
  `errorTrigger@1`, `stickyNote@1`).
- **PostgreSQL 16** com a extensão **pgvector** instalada e o schema `cockpit` já criado
  (`db/schema.sql`, `db/rbac.sql`, `db/seed_reference.sql` do projeto).
- Acesso de rede do n8n a:
  - ao banco PostgreSQL;
  - ao **endpoint de embeddings** (`EMBED_ENDPOINT`);
  - a **`api.anthropic.com`** (Claude).
- Para o workflow 01, o diretório **`data/raw`** do projeto deve estar **montado/visível
  para o container do n8n** no caminho `/data/raw` (veja a seção *Caminho dos arquivos*).

---

## 2. Como importar os workflows

No n8n (UI):

1. Menu **☰ → Import from File** (ou, na tela de workflows, **Add workflow → Import from File**).
2. Selecione cada arquivo em `n8n/workflows/`:
   - `01_ingestao_planilhas.json`
   - `02_pipeline_embeddings.json`
   - `03_rag_consulta.json`
3. Após importar, abra cada workflow e **vincule as credenciais reais** nos nós Postgres e
   HTTP (os JSON referenciam credenciais por `id`/`name` placeholders — veja abaixo).
4. Salve. **Não ative ainda** — primeiro confirme credenciais e variáveis de ambiente.

Via **CLI** (alternativa, dentro do host/container do n8n):

```bash
n8n import:workflow --separate --input=./n8n/workflows
```

---

## 3. Credenciais necessárias

Crie estas credenciais no n8n (**Credentials → New**) e selecione‑as nos respectivos nós.
Os JSON referenciam os nomes/ids abaixo como placeholders; ao importar, basta apontar para
as credenciais reais que você criar.

| Referência no JSON | Tipo de credencial n8n | Usada em | Configuração |
|---|---|---|---|
| `Postgres Cockpit` (`POSTGRES_COCKPIT`) | **Postgres** | 01, 02, 03 | Host, porta, database, usuário e senha do PostgreSQL. Recomenda‑se usar um usuário com a role apropriada (ex.: `cockpit_admin` para ingestão; um usuário de aplicação para o RAG). |
| `Embeddings API (header auth)` (`EMBEDDINGS_API`) | **Header Auth** (`httpHeaderAuth`) | 02, 03 | Para OpenAI: nome do header `Authorization`, valor `Bearer <SUA_CHAVE>`. Para outro provedor, ajuste header/valor conforme o endpoint. |
| `Anthropic API (x-api-key)` (`ANTHROPIC_API`) | **Header Auth** (`httpHeaderAuth`) | 03 | Nome do header `x-api-key`, valor = sua **`ANTHROPIC_API_KEY`**. O header `anthropic-version: 2023-06-01` já está fixo no nó. |

> **Por que Header Auth para o Anthropic?** A API do Claude autentica via header `x-api-key`
> (não `Authorization: Bearer`). A credencial *Header Auth* do n8n injeta exatamente esse
> header, mantendo a chave fora do corpo do workflow.

---

## 4. Variáveis de ambiente

Configure no ambiente do n8n (arquivo `.env`, `docker-compose`, ou *Settings → Variables*).
Os workflows leem estes valores via `$env.<NOME>` com *fallbacks* sensatos:

| Variável | Default no workflow | Descrição |
|---|---|---|
| `EMBED_ENDPOINT` | `https://api.openai.com/v1/embeddings` | URL do serviço de embeddings (pluggável). |
| `EMBED_MODEL` | `text-embedding-3-small` | Modelo de embeddings. **Deve produzir vetores de dimensão 1536** (igual a `kb_embeddings.embedding vector(1536)`). |
| `LLM_MODEL` | `claude-opus-4-8` | Modelo de geração do Claude (use `claude-sonnet-4-6` para reduzir custo). |
| `ANTHROPIC_API_KEY` | — | Chave da API Anthropic. **Configure como credencial Header Auth** (`x-api-key`), não como variável solta. |
| `PGHOST` / `PGPORT` / `PGDATABASE` / `PGUSER` / `PGPASSWORD` | — | Conexão PostgreSQL. No n8n, prefira configurar pela **credencial Postgres**; estas variáveis são as do contrato do projeto (usadas também pelos scripts `rag/`). |

Exemplo de `.env` (host do n8n):

```dotenv
EMBED_ENDPOINT=https://api.openai.com/v1/embeddings
EMBED_MODEL=text-embedding-3-small
LLM_MODEL=claude-opus-4-8
ANTHROPIC_API_KEY=sk-ant-...

PGHOST=postgres
PGPORT=5432
PGDATABASE=cockpit
PGUSER=cockpit_app
PGPASSWORD=troque-me

# Necessário para o n8n expor variáveis via $env nos nós Code:
N8N_BLOCK_ENV_ACCESS_IN_NODE=false
```

> Em algumas versões do n8n, o acesso a `process.env` / `$env` dentro de nós **Code** é
> bloqueado por padrão. Defina `N8N_BLOCK_ENV_ACCESS_IN_NODE=false` para permitir a leitura
> de `EMBED_MODEL`, `EMBED_ENDPOINT` e `LLM_MODEL` nos nós Code.

### Caminho dos arquivos (workflow 01)

O nó *Listar Planilhas em data/raw* usa o seletor `=/data/raw/*.xlsx`. Garanta que o
diretório `data/raw` do projeto esteja montado no container do n8n nesse caminho, por exemplo:

```yaml
# docker-compose.yml (trecho)
services:
  n8n:
    volumes:
      - ./data/raw:/data/raw:ro
```

Se você usa outro caminho, ajuste o `fileSelector` no nó correspondente.

---

## 5. Agendamentos e endpoint

| Workflow | Disparo | Observação |
|---|---|---|
| 01 — Ingestão | `Schedule Trigger` diário às **05:30** | Cron `0 30 5 * * *` (timezone `America/Sao_Paulo`). |
| 02 — Embeddings | `Schedule Trigger` diário às **06:00** | Roda **após** a ingestão para refletir os dados já consolidados. |
| 03 — RAG | `Webhook` `POST /webhook/cockpit-ask` | Não é agendado; é acionado sob demanda pelo dashboard/cliente. |

### Contrato do webhook (workflow 03)

Requisição:

```bash
curl -X POST "https://<seu-n8n>/webhook/cockpit-ask" \
  -H "Content-Type: application/json" \
  -d '{
        "question": "Qual o EBITDA consolidado do último mês fechado?",
        "user_role": "cockpit_executive",
        "top_k": 6
      }'
```

Resposta (sucesso):

```json
{
  "ok": true,
  "answer": "O EBITDA consolidado de 2026-05 foi de R$ ...",
  "sources": ["Desempenho da Aurora Varejo em 2026-05", "..."],
  "model": "claude-opus-4-8",
  "latency_ms": 2310,
  "usage": { "prompt_tokens": 1234, "completion_tokens": 210 }
}
```

- `user_role` aceita `cockpit_admin`, `cockpit_analyst`, `cockpit_auditor`, `cockpit_executive`.
  Executivos são escopados às empresas listadas em `cockpit.user_company_access` (RBAC aplicado
  diretamente na consulta vetorial). Default: `cockpit_executive`.
- `top_k` entre 1 e 20 (default 6).

> Durante o desenvolvimento, o n8n expõe o webhook em
> `…/webhook-test/cockpit-ask` (modo *Listen for test event*) e, com o workflow ativo, em
> `…/webhook/cockpit-ask`.

---

## 6. Tabelas tocadas (conforme `SPEC.md`)

- **Ingestão (01):** `cockpit.stg_financials`, `cockpit.fact_financials`,
  `cockpit.quarantine_rows`, `cockpit.pipeline_runs`, `cockpit.ingestion_log`.
- **Embeddings (02):** lê `cockpit.v_pnl_company_month` e `cockpit.v_position_company_month`;
  escreve `cockpit.kb_documents` e `cockpit.kb_embeddings`; registra `cockpit.pipeline_runs`
  e `cockpit.ingestion_log`.
- **RAG (03):** lê `cockpit.kb_embeddings` + `cockpit.kb_documents` (com RBAC via
  `cockpit.user_company_access`); escreve `cockpit.ai_query_audit`.

### Premissas de schema (índices que os upserts exigem)

Para os `ON CONFLICT` funcionarem, o `db/schema.sql` deve declarar:

- `cockpit.fact_financials`: `UNIQUE (company_id, period_date, account_code)` *(já no SPEC)*.
- `cockpit.pipeline_runs`: `load_id` como **PRIMARY KEY** *(já no SPEC)*.
- `cockpit.kb_documents`: índice único **`(doc_type, company_id, period_date)`** — necessário
  para o upsert de narrativas no workflow 02.
- `cockpit.kb_embeddings`: índice único **`(doc_id)`** — necessário para o upsert de vetores.
- `cockpit.kb_embeddings`: índice **ivfflat** `(embedding vector_cosine_ops)` para a busca
  top‑k *(já no SPEC)*.

> Se o `db/schema.sql` não tiver os índices únicos de `kb_documents`/`kb_embeddings`, adicione‑os
> (ou troque o upsert por delete+insert). Tudo o mais já está no contrato do `SPEC.md`.

---

## 7. Confiabilidade (RETRY e erros)

- **RETRY automático** está habilitado em todos os nós Postgres e HTTP via
  `retryOnFail` + `maxTries` + `waitBetweenTries` (tipicamente 3 tentativas, 5s entre elas;
  4 tentativas/4s no HTTP de embeddings). Protege contra falhas transitórias de banco/rede.
- **Error Trigger:** os workflows 01 e 02 têm um caminho de erro dedicado (`errorTrigger`)
  que grava o incidente em `cockpit.ingestion_log` (nível `ERROR`) e marca o
  `pipeline_runs` em aberto como `FAILED`. Para erros globais, você pode opcionalmente
  apontar o **Error Workflow** das configurações do n8n para esses workflows.
- **Falhas pontuais de embedding** (saída de erro do HTTP no workflow 02) são registradas como
  `WARN` em `ingestion_log` **sem** derrubar o run inteiro.
- **Falha do Claude** (workflow 03) retorna um **fallback em PT‑BR** ao chamador (`ok:false`)
  e também é auditada em `ai_query_audit` (resposta prefixada com `[ERRO]`).

---

## 8. Notas de implementação

- Os nós **Code** já tratam formatos PT‑BR de planilha: competência (`YYYY-MM`, `MM/YYYY`,
  `DD/MM/YYYY`) e valores (`R$ 1.234.567,89`). Sinônimos de cabeçalho (`empresa`, `conta`,
  `periodo`, `realizado`, `orcado`, …) são reconhecidos na validação.
- A convenção de sinais do `SPEC.md` (receita positiva; custos/despesas negativos) é
  **preservada como veio na planilha** — a derivação das margens/EBITDA acontece nas *views*
  do banco, não nos workflows.
- Os vetores são serializados como **literal pgvector** (`[0.1,0.2,...]`) e inseridos com
  `::vector`. Confirme que `EMBED_MODEL` gera **1536 dimensões**.
- Todos os textos de UI, *sticky notes* e mensagens de log estão em **português do Brasil**;
  identificadores técnicos do SPEC permanecem como definidos.
