# 01 — Arquitetura

> Espelha o [`SPEC.md`](../SPEC.md) (§6 objetos de banco, §7 RAG, §9 layout). Em caso de divergência,
> **o `SPEC.md` vence**.

---

## 1. Componentes

| Componente | Papel | Tecnologia | Artefatos |
|------------|-------|------------|-----------|
| **Orquestração / ingestão** | Lê planilhas, valida, carrega `fact_financials`, agenda execução diária, expõe webhook do RAG. | **n8n** | `n8n/workflows/01_ingestao_planilhas.json`, `02_pipeline_embeddings.json`, `03_rag_consulta.json` |
| **Banco analítico** | Armazena dimensões, fatos, staging, quarentena, telemetria, views de KPI e a base vetorial. | **PostgreSQL 16 + pgvector** | `db/schema.sql`, `db/rbac.sql`, `db/seed_reference.sql`, `db/queries/*.sql` |
| **Camada de IA (RAG)** | Transforma números em narrativas, embeda, recupera por similaridade e responde em PT-BR fundamentado. | **Anthropic Claude** (`claude-opus-4-8` / `claude-sonnet-4-6`) + embeddings `EMBED_MODEL` (dim 1536) | `rag/embed.py`, `rag/ask.py`, `rag/requirements.txt`, `rag/.env.example` |
| **Geração de dados / contrato** | Gera dados sintéticos determinísticos e o `dashboard_data.json` (contrato com o dashboard). | **Python** | `data/generate_data.py`, `data/raw/*.xlsx`, `data/out/*` |
| **Dashboard executivo** | Cockpit visual: KPIs, DRE, por empresa, orçado×realizado, aging, gastos, caixa/runway, caixa de IA. | **HTML + CSS + JS vanilla** (SVG inline) | `dashboard/index.html`, `dashboard/styles.css`, `dashboard/app.js`, `dashboard/dashboard_data.json` |
| **Ops / bootstrap** | Sobe o Postgres portátil e serve o dashboard localmente. | **PowerShell** | `scripts/bootstrap_postgres.ps1`, `scripts/serve_dashboard.ps1` |

Schema único no banco: **`cockpit`** (todos os objetos qualificados como `cockpit.*`).

---

## 2. Fluxo de dados (ponta a ponta)

```
Excel  ─►  staging  ─►  validação  ─►  (falha) quarentena
                              │
                              ▼ (ok)
                           fact_financials  ─►  views  ─►  KPIs  ─►  embeddings  ─►  RAG  ─►  dashboard
```

Detalhando cada salto:

1. **Excel → `stg_financials`** — o fluxo n8n `01_ingestao_planilhas.json` lê cada `.xlsx` de
   `data/raw/`, cria um `load_id` (registrado em `pipeline_runs`) e insere **todas as linhas como
   texto** em `cockpit.stg_financials` (mirror cru, sem coerção). Nada é descartado nesta etapa.

2. **Validação** — para cada linha de staging valida-se: `company_id` ∈ `dim_company`;
   `account_code` ∈ `dim_account`; `period_date` é primeiro-dia-do-mês válido; `valor_realizado`
   e `valor_orcado` numéricos; chave `(company_id, period_date, account_code)` única no lote.

3. **Validação falha → `quarantine_rows`** — a linha vai para `cockpit.quarantine_rows` com
   `raw_payload jsonb`, `error_code` e `error_detail`. **Nunca** contamina `fact_financials`. O
   contador `rows_quarantined` sobe em `pipeline_runs`. Cada passo registra em `ingestion_log`.

4. **Validação ok → `fact_financials`** — `UPSERT` em `cockpit.fact_financials` respeitando
   `UNIQUE(company_id, period_date, account_code)` (re-execução é idempotente). Incrementa `rows_ok`.

5. **`fact_financials` → views** — as views de consolidação/KPI derivam tudo a partir das contas
   folha (ver `SPEC.md` §6):
   - `v_pnl_company_month`, `v_pnl_consolidado_month`, `v_kpi_consolidado_ltm`,
     `v_position_company_month`, `v_budget_vs_actual`.

6. **views → KPIs** — fórmulas canônicas (`SPEC.md` §4) implementadas **identicamente** em SQL
   (views/`db/queries/kpis.sql`) e no Python que monta o JSON. Consolidado = soma das contas folha
   das empresas, **depois** deriva (nunca somar margens).

7. **KPIs → embeddings** — `rag/embed.py` (ou n8n `02_pipeline_embeddings.json`) materializa
   "narrativas de fato" em `cockpit.kb_documents` (uma frase por fato, ex.: _"EBITDA da Aurora
   Varejo em 2026-05 foi R$ ..."_) e grava os vetores em `cockpit.kb_embeddings`
   (`vector(1536)`, índice `ivfflat` `vector_cosine_ops`).

8. **embeddings → RAG** — `rag/ask.py` embeda a pergunta, faz _top-k_ por cosseno em
   `kb_embeddings`, monta _prompt grounded_ com os fatos recuperados, chama Claude e grava
   `cockpit.ai_query_audit` (inclui `latency_ms`). Exposto por n8n via `POST /webhook/cockpit-ask`.

9. **KPIs → dashboard** — `data/generate_data.py` escreve `data/out/dashboard_data.json` e **copia**
   para `dashboard/dashboard_data.json`. O dashboard lê **somente** esse arquivo (offline-first);
   a caixa de IA usa `respostas_demo` offline ou o webhook do RAG online.

> **Por que staging + quarentena?** Confiabilidade da Fase 1: nenhuma linha ruim entra no fato, toda
> execução é auditável (`pipeline_runs` + `ingestion_log`) e re-executável sem efeitos colaterais —
> é o que sustenta o critério "10 dias sem intervenção".

---

## 3. Diagrama de arquitetura (ASCII)

```
┌──────────────────────────────────────────────────────────────────────────────────────────┐
│                                  COCKPIT FINANCEIRO ESTRATÉGICO                             │
│                                       (schema  cockpit)                                     │
└──────────────────────────────────────────────────────────────────────────────────────────┘

  FONTE                       n8n (orquestração)                       PostgreSQL 16 + pgvector
┌─────────────┐   01_ingestao_planilhas.json     ┌───────────────────────────────────────────┐
│ data/raw/   │   ┌───────────────────────────┐  │  DIMENSÕES   dim_company   dim_account     │
│  *.xlsx     │──►│ ler xlsx → stg_financials │──┼─►┌──────────────┐                          │
│ (Fase 3:    │   │ validar linha a linha     │  │  │stg_financials│                          │
│  ERP/API)   │   │   ├─ ok  → fact_financials │  │  └──────┬───────┘                          │
└─────────────┘   │   └─ erro→ quarantine_rows │  │         │ valida                           │
                  │ telemetria:                │  │   ┌─────▼──────┐    ┌──────────────────┐   │
                  │  pipeline_runs             │  │   │fact_finan- │    │ quarantine_rows  │   │
                  │  ingestion_log             │  │   │ cials      │    │ pipeline_runs    │   │
                  └───────────────────────────┘  │   └─────┬──────┘    │ ingestion_log    │   │
                                                 │         │            └──────────────────┘   │
                  02_pipeline_embeddings.json    │   ┌─────▼───────────────────────────────┐  │
                  ┌───────────────────────────┐  │   │ VIEWS                                │  │
                  │ views → kb_documents      │◄─┼───│ v_pnl_company_month                  │  │
                  │ embeddings → kb_embeddings│  │   │ v_pnl_consolidado_month              │  │
                  └───────────────────────────┘  │   │ v_kpi_consolidado_ltm                │  │
                                                 │   │ v_position_company_month             │  │
                  03_rag_consulta.json           │   │ v_budget_vs_actual                   │  │
                  ┌───────────────────────────┐  │   └─────┬───────────────────────────┬────┘  │
   POST /webhook/ │ pergunta NL               │  │         │                           │       │
   cockpit-ask ──►│  → embed → top-k cosseno  │◄─┼─────────┘           ┌───────────────▼────┐  │
                  │  → prompt grounded        │  │  RAG / pgvector      │ kb_documents       │  │
                  │  → Claude                 │  │  ┌────────────────┐  │ kb_embeddings      │  │
                  │  → ai_query_audit         │──┼─►│ vector(1536)   │  │ (ivfflat cosine)   │  │
                  └───────────┬───────────────┘  │  │ ai_query_audit │  └────────────────────┘  │
                              │                  └──┴────────────────┴──────────────────────────┘
                              │
   data/generate_data.py      │                          DASHBOARD EXECUTIVO
  ┌───────────────────────┐   │   ┌──────────────────────────────────────────────────────────┐
  │ views/contas → JSON   │   │   │ dashboard/index.html + app.js + styles.css                │
  │ out/dashboard_data.   │───┼──►│  KPIs · DRE waterfall · por empresa · orçado×realizado ·  │
  │  json  → dashboard/   │   └──►│  aging AR/AP · gastos por categoria · caixa/runway ·      │
  │  dashboard_data.json  │       │  CAIXA AI "Key Insights" (offline: respostas_demo;        │
  └───────────────────────┘       │  online: POST /webhook/cockpit-ask)                       │
                                  └──────────────────────────────────────────────────────────┘

  RBAC/RLS: cockpit_admin · cockpit_analyst · cockpit_executive · cockpit_auditor
            RLS em fact_financials por empresa via user_company_access  (ver db/rbac.sql)
```

---

## 4. Modelo de implantação (demo local)

```
Windows host
├─ PostgreSQL 16 portátil (EDB zip)  ── scripts/bootstrap_postgres.ps1 ── porta 5432, DB "cockpit"
├─ n8n (Docker ou npm)               ── webhook em :5678, cron diário de ingestão
├─ Python venv (.venv)               ── data/generate_data.py · rag/embed.py · rag/ask.py
└─ Servidor estático                 ── scripts/serve_dashboard.ps1 ── http://localhost:8088
```

Tudo roda numa única máquina para a demo. Em produção os mesmos componentes escalam
horizontalmente (n8n em fila, Postgres gerenciado com pgvector, dashboard atrás de CDN).

---

## 5. Como a Fase 3 (ERP) encaixa sem retrabalho

O ponto de extensão é **`cockpit.stg_financials`**: ele é o _contrato de entrada_ do pipeline.
Hoje quem o preenche é o leitor de Excel; na Fase 3, quem o preenche é um conector ERP/API.

```
  HOJE (Fase 1/2)                         FASE 3 (ERP)
  Excel ──► [leitor xlsx n8n] ─┐          ERP/API ──► [conector n8n/REST] ─┐
                               ├─► stg_financials ◄────────────────────────┘
                               │
                               ▼ (validação · quarentena · upsert idênticos)
                          fact_financials ──► views ──► KPIs ──► JSON / RAG / dashboard
```

Garantias de "zero retrabalho":

1. **Contrato estável de staging** — a forma de `stg_financials` (mesmas colunas de
   `company_id`, `period_date`, `account_code`, `valor_realizado`, `valor_orcado`, `source_file`)
   não muda. Troca-se apenas o **produtor** das linhas.
2. **Validação e idempotência reaproveitadas** — o mesmo passo de validação → quarentena → `UPSERT`
   com `UNIQUE(company_id, period_date, account_code)` serve para qualquer fonte. Re-sincronizações
   incrementais do ERP são naturalmente idempotentes.
3. **Tudo a jusante é agnóstico à fonte** — views, fórmulas de KPI (`SPEC.md` §4), `dashboard_data.json`
   e o RAG dependem apenas de `fact_financials`, nunca do formato de origem.
4. **Telemetria reutilizada** — `pipeline_runs` / `ingestion_log` / `quarantine_rows` registram a
   ingestão do ERP exatamente como registram a do Excel; o monitoramento do runbook continua valendo.
5. **Mapeamento de contas isolado** — a tradução "código de conta do ERP → `account_code` canônico"
   vive num nó de mapeamento no n8n (ou numa tabela de _crosswalk_), sem tocar o schema analítico.
6. **`ELIM` já previsto** — a empresa `ELIM` (Eliminações Intercompany) já existe no perímetro, então
   eliminações reais do ERP entram como linhas de fato normais, sem mudança estrutural.

Resultado: a Fase 3 é uma **substituição de fonte plugável**, não uma reescrita.
