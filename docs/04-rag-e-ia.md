# 04 — RAG e IA

> Espelha o [`SPEC.md`](../SPEC.md) §6 (objetos RAG/pgvector) e §7 (RAG/LLM). Critério de sucesso
> da Fase 2: **resposta executiva fundamentada em < 30s** (`ai_query_audit.latency_ms < 30000`).

---

## 1. Por que RAG (e não LLM "puro")

O cockpit responde perguntas em linguagem natural sobre os **números reais do grupo** ("Qual o
EBITDA consolidado do último mês?", "Por que a margem da Indústria caiu?"). Para isso o modelo
**não inventa**: ele recebe, no prompt, os fatos recuperados do próprio banco (_grounding_). Assim:

- Respostas **fundamentadas** e citáveis (com fontes: "DRE 2026-05", "EBITDA AUR-IND 2026-05").
- Sem alucinação de cifras — o LLM só **redige** sobre fatos fornecidos.
- Auditável: cada resposta grava pergunta, documentos usados, modelo, tokens e latência.

---

## 2. Arquitetura RAG

```
                          INDEXAÇÃO (offline, após cada fechamento)
  views/contas ──► rag/embed.py ──► kb_documents (narrativas) ──► embeddings ──► kb_embeddings
   (v_pnl_*,        "EBITDA da Aurora Varejo      doc_type, company_id,           vector(1536)
    v_position_*,    em 2026-05 foi R$ ..."       period_date, title, content     model, ivfflat
    v_budget_*)                                   metadata jsonb                  vector_cosine_ops

                          CONSULTA (online, < 30s)
  pergunta NL ─► embed ─► top-k cosseno (kb_embeddings) ─► monta PROMPT GROUNDED ─► Claude ─► resposta
       │                         │                                                     │
       │                         └─ retrieved_doc_ids[]                                │
       └──────────────────────────────────────────────────────────────────────► ai_query_audit
                                                                  (question, doc_ids, answer,
                                                                   model, tokens, latency_ms)

  Exposição: n8n 03_rag_consulta.json  ──►  POST /webhook/cockpit-ask
  Dashboard: caixa "Key Insights / AI"  ──►  offline: respostas_demo | online: webhook acima
```

### Componentes

| Peça | Arquivo | Função |
|------|---------|--------|
| Construção de narrativas + embeddings | `rag/embed.py` | Lê as views, materializa `kb_documents` (uma frase por fato) e faz **upsert** em `kb_embeddings`. |
| Pergunta → resposta | `rag/ask.py` | Embeda a pergunta → top-k cosseno → prompt grounded → Claude → grava `ai_query_audit`; retorna em < 30s. |
| Webhook | `n8n/workflows/03_rag_consulta.json` | Mesma lógica via `POST /webhook/cockpit-ask`. |
| Narrativas-fonte | `db/queries/rag_documents.sql` | SQL que gera o texto de cada `kb_documents`. |

---

## 3. Embeddings e pgvector

- **Tabela vetorial:** `cockpit.kb_embeddings(id, doc_id FK → kb_documents, embedding vector(1536),
  model, created_at)`.
- **Dimensão:** **1536** (configurável via `EMBED_MODEL`; endpoint plugável).
- **Índice:** `ivfflat` com `vector_cosine_ops` — busca por **similaridade de cosseno**.
  ```sql
  CREATE INDEX IF NOT EXISTS kb_embeddings_ivfflat
    ON cockpit.kb_embeddings USING ivfflat (embedding vector_cosine_ops)
    WITH (lists = 100);
  ANALYZE cockpit.kb_embeddings;   -- após carga, para o planner usar o índice
  ```
- **Recuperação (top-k):**
  ```sql
  SELECT d.id, d.title, d.content, 1 - (e.embedding <=> $1) AS score
  FROM cockpit.kb_embeddings e
  JOIN cockpit.kb_documents d ON d.id = e.doc_id
  ORDER BY e.embedding <=> $1          -- distância cosseno (<=>)
  LIMIT $2;                            -- k (tipicamente 6–10)
  ```
- **Granularidade dos documentos:** uma narrativa por fato relevante (EBITDA, margem, caixa, dívida,
  DSO, orçado×realizado por empresa-mês e consolidado). `metadata jsonb` carrega `company_id`,
  `period_date`, `account_code`/KPI e valores, permitindo filtro pré/pós-recuperação.

---

## 4. Prompt grounding

O `ask.py` monta um prompt com três blocos: **papel/instrução**, **fatos recuperados** e **pergunta**.

```
[SISTEMA]
Você é o analista financeiro do Grupo Aurora. Responda em PT-BR, de forma objetiva e executiva.
Use SOMENTE os FATOS fornecidos. Não invente números. Cite as fontes entre colchetes ao final.
Valores em BRL; quando útil, traga a variação (mês a mês, YoY ou vs. orçado).

[FATOS RECUPERADOS]
- [DRE 2026-05] EBITDA consolidado de 2026-05: R$ ... (margem ...%); mês anterior R$ ...
- [EBITDA AUR-IND 2026-05] EBITDA da Aurora Indústria: R$ ... (margem ...%), YoY ...%
- ... (top-k documentos)

[PERGUNTA]
{pergunta do usuário}
```

Regras de _grounding_:
- **Fechamento ao contexto:** se a resposta não estiver nos fatos, o modelo declara que não há dado
  suficiente — **não** estima.
- **Citação obrigatória:** cada cifra referencia o `kb_documents` de origem (título/`doc_type`).
- **Determinismo:** `temperature` baixa (≈0–0.2) para respostas estáveis e auditáveis.

---

## 5. Auditoria — `ai_query_audit`

Toda consulta grava (`SPEC.md` §6):

| Coluna | Conteúdo |
|--------|----------|
| `user_role` | Papel RBAC do solicitante (ver [`05-seguranca-rbac-lgpd.md`](05-seguranca-rbac-lgpd.md)). |
| `question` | Pergunta NL (cuidado LGPD: não logar PII desnecessária). |
| `retrieved_doc_ids` | `int[]` dos `kb_documents` usados (rastreabilidade da fonte). |
| `answer` | Resposta entregue. |
| `model` | `claude-opus-4-8` ou `claude-sonnet-4-6`. |
| `prompt_tokens` / `completion_tokens` | Custo/uso. |
| `latency_ms` | **SLA < 30000** (critério Fase 2). |
| `created_at` | Carimbo. |

Consulta de SLA:
```sql
SELECT date(created_at) AS dia,
       count(*) AS consultas,
       percentile_disc(0.95) WITHIN GROUP (ORDER BY latency_ms) AS p95_ms,
       max(latency_ms) AS max_ms,
       count(*) FILTER (WHERE latency_ms >= 30000) AS fora_sla
FROM cockpit.ai_query_audit
GROUP BY 1 ORDER BY 1 DESC;
```

---

## 6. Orçamento de latência (< 30s)

Meta de ponta a ponta para `POST /webhook/cockpit-ask` → resposta:

| Etapa | Alvo | Observações |
|-------|------|-------------|
| Embedding da pergunta | ~150–400 ms | 1 chamada ao `EMBED_MODEL`. |
| Recuperação top-k (pgvector) | < 50 ms | `ivfflat` + `ANALYZE`; `k` pequeno (6–10). |
| Montagem do prompt | < 20 ms | concatenação dos fatos. |
| Geração (Claude) | ~3–15 s | maior parcela; `opus` ↑ qualidade, `sonnet` ↓ latência/custo. |
| Auditoria/IO | < 50 ms | insert em `ai_query_audit`. |
| **Total** | **< 30 s** | folga ampla; p95 esperado bem abaixo. |

Alavancas se aproximar do limite:
- Trocar `LLM_MODEL` para `claude-sonnet-4-6` (mais rápido/barato).
- Reduzir `k` e o tamanho das narrativas (fatos concisos).
- Habilitar **streaming** no webhook (primeiro token mais cedo).
- Garantir o índice `ivfflat` e `ANALYZE` recentes.

---

## 7. Escolha de modelo

- **Geração:** `claude-opus-4-8` (qualidade/raciocínio para comentário de variância _board-grade_)
  ou `claude-sonnet-4-6` quando custo/latência forem prioridade. Configurável por `LLM_MODEL`.
- **Embeddings:** endpoint configurável via `EMBED_MODEL`, **dimensão 1536** (plugável — qualquer
  provedor de embeddings 1536-d serve; basta manter a dimensão da coluna `vector(1536)`).
- **Config por ambiente** (`rag/.env.example`): `ANTHROPIC_API_KEY`, `PGHOST/PGPORT/PGDATABASE/
  PGUSER/PGPASSWORD`, `LLM_MODEL`, `EMBED_MODEL`.

> Antes de fixar IDs/preços de modelo, consulte a referência atual da API Claude (skill `claude-api`).
> O `SPEC.md` define `claude-opus-4-8` / `claude-sonnet-4-6` como padrões.

---

## 8. Integração com a caixa de IA do dashboard

A caixa **"Key Insights / variance commentary"** (estilo Bricks) tem dois modos:

- **Offline (default da demo):** o dashboard lê do `dashboard_data.json`:
  - `insights_ia[]` → cartões de insight (`severity` = `info|warning|positive`, `titulo`, `texto`).
  - `perguntas_sugeridas[]` → chips de perguntas prontas.
  - `respostas_demo[]` → respostas fundamentadas pré-geradas (`q`, `a`, `fontes[]`), para a caixa
    de pergunta funcionar **sem internet**.
- **Online (produção):** ao digitar/escolher uma pergunta, o `app.js` faz
  `POST /webhook/cockpit-ask` com `{ "question": "..." }`; o n8n executa o RAG (`ask.py`) e devolve
  `{ "answer": "...", "fontes": [...], "latency_ms": ... }`, que a caixa renderiza com as fontes.

```
  Dashboard (caixa IA)
        │ pergunta
        ▼
   offline? ──sim──► respostas_demo (match por pergunta) ──► render + fontes
        │ não
        ▼
   POST /webhook/cockpit-ask ──► n8n 03_rag_consulta.json ──► RAG ──► resposta + fontes (+ audit)
```

Assim o cockpit é **demonstrável offline** e, ligado ao n8n, vira um assistente de variância ao vivo
sobre os números do grupo — sempre dentro do orçamento de **< 30s**.
