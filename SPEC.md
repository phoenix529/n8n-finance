# SPEC — Cockpit Financeiro Estratégico (n8n + PostgreSQL + pgvector + RAG)

> **Canonical source of truth.** Every artifact in this repo (DB schema, data generator,
> n8n workflows, RAG scripts, dashboard, docs) MUST conform to the names, formulas and
> JSON shapes defined here. Do not invent alternative table/column/metric names.

Reference design the client liked: **thebricks.com/cfo-dashboard** and **cfodashboard.io**
— a board-grade CFO cockpit for monthly close: cash position, burn & runway, EBITDA,
margins, budget vs actual variance, spend-by-category, and an AI "Key Insights /
variance commentary" panel. We replicate that vocabulary in **PT-BR / BRL**.

---

## 1. Brand (placeholder — trivially rebrandable to "nossa cara")

The client is a **multi-company Brazilian business group**. We use a clearly-labelled
placeholder identity that lives in ONE config block (`dashboard/app.js` `BRAND` + the
JSON `meta`) so it can be swapped for the client's real identity/logo/colors.

- Group (holding): **Grupo Aurora** — `Aurora Participações S.A.`
- Locale: `pt-BR`, currency **BRL (R$)**, fiscal calendar = calendar year.
- Palette: navy `#0B1F3A`, indigo accent `#4F6BED`, ink `#10182B`, muted `#6B7280`,
  surface `#FFFFFF`, canvas `#F6F8FC`, positive `#10B981`, negative `#EF4444`,
  warning `#F59E0B`. Font: Inter / system-ui. Rounded cards (16px), soft shadows.

## 2. Companies (the consolidation perimeter)

Fixed list. `company_id` is the stable key used EVERYWHERE.

| company_id | name                       | sector     | color    | rough annual net revenue |
|------------|----------------------------|------------|----------|--------------------------|
| AUR-VAR    | Aurora Varejo S.A.         | Varejo     | #4F6BED  | ~R$ 210M                 |
| AUR-IND    | Aurora Indústria Ltda.     | Indústria  | #0EA5E9  | ~R$ 150M                 |
| AUR-SVC    | Aurora Serviços Ltda.      | Serviços   | #10B981  | ~R$ 70M                  |
| AUR-LOG    | Aurora Logística Ltda.     | Logística  | #F59E0B  | ~R$ 50M                  |
| AUR-HLD    | Aurora Participações S.A.  | Holding    | #6B7280  | ~R$ 0 (corporate only)   |
| ELIM       | Eliminações Intercompany   | Eliminação | #94A3B8  | (architecture-ready; ~0) |

Consolidated = sum of all rows. The `ELIM` company exists so the architecture supports
intercompany eliminations; for the demo its values are ~0 (documented).

## 3. Chart of accounts (leaf accounts only — subtotals are DERIVED)

P&L flow accounts (monthly), `account_kind = 'PNL'`. Sign convention: revenue positive,
costs/expenses stored as **negative** numbers.

| account_code | account_name (PT-BR)              | group_code | sign |
|--------------|-----------------------------------|------------|------|
| R_BRUTA      | Receita Bruta de Vendas           | RECEITA    | +    |
| DEDUCOES     | Impostos e Deduções s/ Vendas     | RECEITA    | -    |
| CMV          | Custo dos Produtos/Serviços (CMV) | CUSTO      | -    |
| DESP_PESSOAL | Despesas com Pessoal              | OPEX       | -    |
| DESP_VENDAS  | Despesas Comerciais e Marketing   | OPEX       | -    |
| DESP_ADM     | Despesas Administrativas          | OPEX       | -    |
| DESP_OUTRAS  | Outras Despesas Operacionais      | OPEX       | -    |
| DEPRECIACAO  | Depreciação e Amortização         | DA         | -    |
| RESULT_FIN   | Resultado Financeiro Líquido      | FINANC     | +/-  |
| IRPJ_CSLL    | IR e CSLL                         | IMPOSTO    | -    |

Position / balance accounts (end-of-month stock), `account_kind = 'POSICAO'`, all positive:

| account_code | account_name (PT-BR)              |
|--------------|-----------------------------------|
| CAIXA        | Caixa e Equivalentes              |
| AR           | Contas a Receber                  |
| AP           | Contas a Pagar                    |
| ESTOQUE      | Estoques                          |
| DIVIDA       | Dívida Bruta (Empréstimos)        |
| PATRIMONIO   | Patrimônio Líquido                |

Each monthly fact row ALSO carries `valor_orcado` (budget) so Budget-vs-Actual works.

## 4. Derived metrics / KPI formulas (canonical — implement identically in SQL + JSON)

Per company-month (and consolidated by summing leaf accounts first, then deriving):

- `receita_liquida   = R_BRUTA + DEDUCOES`           (DEDUCOES is negative)
- `lucro_bruto       = receita_liquida + CMV`
- `ebitda            = lucro_bruto + DESP_PESSOAL + DESP_VENDAS + DESP_ADM + DESP_OUTRAS`
- `ebit              = ebitda + DEPRECIACAO`
- `lucro_liquido     = ebit + RESULT_FIN + IRPJ_CSLL`
- `margem_bruta_pct  = lucro_bruto / receita_liquida * 100`
- `margem_ebitda_pct = ebitda / receita_liquida * 100`
- `margem_liquida_pct= lucro_liquido / receita_liquida * 100`
- `divida_liquida    = DIVIDA - CAIXA`
- `divida_ebitda     = divida_liquida / ebitda_ltm`         (ebitda_ltm = soma 12 meses)
- `dso_dias          = AR / R_BRUTA * 30`
- `capital_giro      = AR + ESTOQUE - AP`
- `fluxo_caixa_mes   = CAIXA(m) - CAIXA(m-1)`               (proxy de variação de caixa)
- `burn_mensal       = média( -fluxo_caixa_mes ) dos últimos 3 meses, quando negativo`
- `runway_meses      = CAIXA / burn_mensal`  (se burn>0; senão "n/a / fluxo positivo")
- `receita_yoy_pct   = receita_liquida(m) / receita_liquida(m-12) - 1, em %`
- `variacao_orcado_pct (por linha) = realizado / orcado - 1, em %`

LTM = last twelve months ending at `last_closed_period`.

## 5. Periods

- Monthly grain, `period_date` = first day of month (DATE).
- History: **2025-01-01 .. 2026-05-01** (17 closed months) + **2026-06-01** partial.
- `last_closed_period = 2026-05-01`. "Today" = 2026-06-23.
- Deterministic generation (seeded) with seasonality (Nov/Dec retail peak) and YoY growth.

## 6. Database object names (PostgreSQL 16 + pgvector) — schema `cockpit`

Dimensions / facts:
- `cockpit.dim_company(company_id PK, name, sector, color, is_consolidating bool, sort)`
- `cockpit.dim_account(account_code PK, account_name, account_kind, group_code, sign)`
- `cockpit.fact_financials(id, company_id FK, period_date, account_code FK, valor_realizado numeric(18,2), valor_orcado numeric(18,2), source_file, load_id, created_at)`
  - UNIQUE(company_id, period_date, account_code)

Ingestion reliability (Phase 1):
- `cockpit.stg_financials(...)` — raw staging mirror of incoming spreadsheet rows (all text).
- `cockpit.quarantine_rows(id, load_id, source_file, row_num, raw_payload jsonb, error_code, error_detail, created_at)`
- `cockpit.pipeline_runs(load_id PK, workflow, source_file, status, rows_total, rows_ok, rows_quarantined, started_at, finished_at, retries, message)`
- `cockpit.ingestion_log(id, load_id, level, step, message, payload jsonb, created_at)`

Consolidation / KPI views:
- `cockpit.v_pnl_company_month`   — derived P&L per company-month (receita_liquida, lucro_bruto, ebitda, ebit, lucro_liquido + margens)
- `cockpit.v_pnl_consolidado_month` — consolidated (sum of companies) per month
- `cockpit.v_kpi_consolidado_ltm`  — latest LTM KPI snapshot
- `cockpit.v_position_company_month` — position accounts per company-month + divida_liquida, capital_giro, dso
- `cockpit.v_budget_vs_actual`     — realizado vs orcado per company/account/month + variance

RAG / pgvector (Phase 2):
- `cockpit.kb_documents(id, doc_type, company_id, period_date, title, content, metadata jsonb, created_at)`
  - one row per "fact narrative" chunk (e.g. "EBITDA da Aurora Varejo em 2026-05 foi R$ ...")
- `cockpit.kb_embeddings(id, doc_id FK, embedding vector(1536), model, created_at)` + ivfflat index (vector_cosine_ops)
- `cockpit.ai_query_audit(id, user_role, question, retrieved_doc_ids int[], answer, model, prompt_tokens, completion_tokens, latency_ms, created_at)`

RBAC (Phase 2):
- Roles: `cockpit_admin`, `cockpit_analyst`, `cockpit_executive`, `cockpit_auditor`.
- Row-Level Security on `fact_financials` by company via `cockpit.user_company_access(role_name, company_id)` (executives may be scoped to a subset of companies). Documented + GRANTs.

## 7. RAG / LLM

- Provider: **Anthropic Claude** (per task "Claude or similar via API"). Latest models per
  the claude-api skill — generation `claude-opus-4-8` (or `claude-sonnet-4-6` for cost),
  embeddings via a configurable embeddings endpoint (`EMBED_MODEL`, dim 1536; pluggable).
- `rag/embed.py` — builds `kb_documents` narratives from the views, embeds, upserts `kb_embeddings`.
- `rag/ask.py` — given a NL question: embed → cosine top-k from `kb_embeddings` → build grounded
  prompt with retrieved facts → call Claude → write `ai_query_audit`. Returns answer < 30s.
- n8n workflow `03_rag_consulta.json` exposes the same via Webhook (`POST /webhook/cockpit-ask`).
- Config via env: `ANTHROPIC_API_KEY`, `PGHOST/PGPORT/PGDATABASE/PGUSER/PGPASSWORD`, `LLM_MODEL`, `EMBED_MODEL`.

## 8. dashboard_data.json — CONTRACT between data generator and dashboard

The generator (`data/generate_data.py`) writes `data/out/dashboard_data.json` AND copies it
to `dashboard/dashboard_data.json`. The dashboard reads ONLY this file (works fully offline).
All money in BRL (numbers, not strings). Percentages as numbers (e.g. 18.4 = 18.4%).

```jsonc
{
  "meta": {
    "group_name": "Grupo Aurora",
    "currency": "BRL",
    "locale": "pt-BR",
    "generated_at": "2026-06-23",
    "period_start": "2025-01",
    "period_end": "2026-06",
    "last_closed_period": "2026-05",
    "companies": [ { "id": "AUR-VAR", "name": "...", "sector": "...", "color": "#4F6BED" }, ... ],
    "is_placeholder_brand": true
  },
  // KPI tiles (consolidated, latest closed month vs previous month). spark = 12 monthly values.
  "kpis": {
    "caixa":            { "value": 0, "prev": 0, "delta_pct": 0, "spark": [12 nums] },
    "runway_meses":     { "value": 0, "prev": 0, "delta_pct": 0, "label_extra": "burn R$ x/mês" },
    "receita_liquida":  { "value": 0, "prev": 0, "delta_pct": 0, "spark": [...], "yoy_pct": 0 },
    "ebitda":           { "value": 0, "prev": 0, "delta_pct": 0, "spark": [...], "margem_pct": 0 },
    "lucro_liquido":    { "value": 0, "prev": 0, "delta_pct": 0, "spark": [...], "margem_pct": 0 },
    "divida_liquida":   { "value": 0, "prev": 0, "delta_pct": 0, "divida_ebitda": 0 },
    "dso_dias":         { "value": 0, "prev": 0, "delta_pct": 0 },
    "capital_giro":     { "value": 0, "prev": 0, "delta_pct": 0 }
  },
  // consolidated monthly series, ascending by period "YYYY-MM"
  "series_mensal": [
    { "period":"2025-01", "receita_bruta":0,"receita_liquida":0,"lucro_bruto":0,"ebitda":0,
      "ebit":0,"lucro_liquido":0,"caixa":0,"divida_liquida":0,"fluxo_caixa":0,
      "margem_ebitda_pct":0,"receita_orcada":0,"ebitda_orcado":0 }, ...
  ],
  // per company, LTM aggregates + monthly receita/ebitda for sparklines + share
  "por_empresa": [
    { "company_id":"AUR-VAR","name":"...","sector":"...","color":"#4F6BED",
      "receita_ltm":0,"ebitda_ltm":0,"margem_ebitda_pct":0,"lucro_liquido_ltm":0,
      "share_receita_pct":0,"yoy_pct":0,
      "serie_receita":[12 nums],"serie_ebitda":[12 nums] }, ...
  ],
  // DRE consolidada (waterfall/table) — latest closed month + LTM + orçado
  "dre_consolidada": [
    { "linha":"Receita Líquida","code":"receita_liquida","mes":0,"ltm":0,"orcado_mes":0,"var_pct":0 }, ...
  ],
  // spend by category (donut) — OPEX+CMV breakdown, latest month, consolidated
  "gastos_por_categoria": [ { "categoria":"Pessoal","valor":0,"pct":0,"color":"#..." }, ... ],
  // budget vs actual per company (latest month) for variance bars
  "orcado_vs_realizado": [
    { "company_id":"AUR-VAR","name":"...","realizado":0,"orcado":0,"var_pct":0 }, ...
  ],
  // AR/AP aging buckets (consolidated, latest month)
  "aging": {
    "receber": [ {"faixa":"0-30","valor":0}, {"faixa":"31-60","valor":0}, {"faixa":"61-90","valor":0}, {"faixa":"90+","valor":0} ],
    "pagar":   [ {"faixa":"0-30","valor":0}, {"faixa":"31-60","valor":0}, {"faixa":"61-90","valor":0}, {"faixa":"90+","valor":0} ]
  },
  // AI "Key Insights / variance commentary" — plain-PT-BR, mirrors Bricks panel; in prod comes from RAG
  "insights_ia": [
    { "severity":"info|warning|positive", "titulo":"...", "texto":"..." }, ...
  ],
  // suggested NL questions for the AI query box
  "perguntas_sugeridas": [ "Qual o EBITDA consolidado do último mês?", ... ],
  // canned grounded answers so the AI box demos offline; prod hits /webhook/cockpit-ask
  "respostas_demo": [ { "q":"...", "a":"...", "fontes":["DRE 2026-05", ...] }, ... ]
}
```

## 9. File layout (authoritative)

```
README.md                      SPEC.md
docs/  01-arquitetura.md 02-runbook-operacional.md 03-modelo-dados.md 04-rag-e-ia.md 05-seguranca-rbac-lgpd.md
db/    schema.sql  rbac.sql  seed_reference.sql  queries/{kpis.sql,consolidacao.sql,qualidade_dados.sql,rag_documents.sql}
data/  generate_data.py  raw/<gerados xlsx>  out/{dashboard_data.json, *.csv}
n8n/   workflows/{01_ingestao_planilhas.json,02_pipeline_embeddings.json,03_rag_consulta.json}  README.md
rag/   embed.py  ask.py  requirements.txt  .env.example
dashboard/  index.html  styles.css  app.js  dashboard_data.json
scripts/  bootstrap_postgres.ps1  serve_dashboard.ps1
```

## 10. Conventions

- Money formatted in UI as `R$ 1,2 mi` / `R$ 850 mil` (pt-BR), full value in tooltips.
- No external CDNs required at runtime for the dashboard core: charts drawn with inline SVG / canvas
  (vanilla JS). If a chart lib is used it must degrade gracefully offline. Prefer vanilla SVG.
- Everything reproducible: `python data/generate_data.py` regenerates data + JSON deterministically.
