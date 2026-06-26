# 03 — Modelo de Dados

> Espelha o [`SPEC.md`](../SPEC.md) §2 (empresas), §3 (plano de contas), §4 (fórmulas de KPI),
> §5 (períodos) e §6 (objetos de banco). Em divergência, **o `SPEC.md` vence**. Schema: `cockpit`.

---

## 1. Visão ER (ASCII)

```
                          ┌────────────────────┐
                          │   dim_company      │
                          │  company_id (PK)   │
                          │  name, sector      │
                          │  color, is_conso-  │
                          │  lidating, sort    │
                          └─────────┬──────────┘
                                    │ 1
                                    │
                                    │ N            ┌────────────────────┐
   ┌────────────────────┐           │              │   dim_account      │
   │  stg_financials    │           │              │ account_code (PK)  │
   │  (mirror cru, text)│           │              │ account_name       │
   └─────────┬──────────┘           │              │ account_kind       │
             │ validação            │              │ group_code, sign   │
             ▼                      │              └─────────┬──────────┘
   ┌────────────────────┐  ┌────────▼─────────────────────────▼────────┐
   │  quarantine_rows   │  │            fact_financials                 │
   │  (linhas inválidas)│  │ id, company_id(FK), period_date,          │
   └────────────────────┘  │ account_code(FK), valor_realizado,         │
                           │ valor_orcado, source_file, load_id, ...    │
   ┌────────────────────┐  │ UNIQUE(company_id, period_date, account)   │
   │  pipeline_runs     │  └──────────────────┬─────────────────────────┘
   │  load_id (PK)      │                     │ derivam
   └─────────┬──────────┘                     ▼
             │ 1:N        ┌──────────────────────────────────────────────┐
   ┌─────────▼──────────┐ │ VIEWS                                        │
   │  ingestion_log     │ │ v_pnl_company_month  v_pnl_consolidado_month │
   └────────────────────┘ │ v_kpi_consolidado_ltm v_position_company_... │
                          │ v_budget_vs_actual                           │
                          └──────────────────┬───────────────────────────┘
                                             │ narrativas
                                             ▼
   ┌────────────────────┐   1:N   ┌────────────────────┐
   │   kb_documents     │─────────│   kb_embeddings    │   ┌────────────────────┐
   │ id, doc_type,      │         │ id, doc_id(FK),    │   │  ai_query_audit    │
   │ company_id,        │         │ embedding          │   │ pergunta, doc_ids, │
   │ period_date, ...   │         │ vector(1536),      │   │ answer, latency_ms,│
   └────────────────────┘         │ model, ivfflat     │   │ tokens, model      │
                                  └────────────────────┘   └────────────────────┘

   RBAC: cockpit_admin · cockpit_analyst · cockpit_executive · cockpit_auditor
         RLS em fact_financials por empresa  ◄──  user_company_access(role_name, company_id)
```

---

## 2. Dimensões

### `cockpit.dim_company` (perímetro de consolidação — `SPEC.md` §2)

| Coluna | Tipo | Notas |
|--------|------|-------|
| `company_id` | text **PK** | Chave estável usada em TODO lugar. |
| `name` | text | Razão/nome. |
| `sector` | text | Varejo / Indústria / Serviços / Logística / Holding / Eliminação. |
| `color` | text | Hex da paleta. |
| `is_consolidating` | bool | Entra na soma do consolidado. |
| `sort` | int | Ordem de exibição. |

| company_id | name | sector | color |
|------------|------|--------|-------|
| `AUR-VAR` | Aurora Varejo S.A. | Varejo | `#4F6BED` |
| `AUR-IND` | Aurora Indústria Ltda. | Indústria | `#0EA5E9` |
| `AUR-SVC` | Aurora Serviços Ltda. | Serviços | `#10B981` |
| `AUR-LOG` | Aurora Logística Ltda. | Logística | `#F59E0B` |
| `AUR-HLD` | Aurora Participações S.A. | Holding | `#6B7280` |
| `ELIM` | Eliminações Intercompany | Eliminação | `#94A3B8` |

> **Consolidado = soma de todas as linhas.** `ELIM` existe para suportar eliminações intercompany;
> na demo seus valores são ~0 (documentado).

### `cockpit.dim_account` (plano de contas — `SPEC.md` §3)

| Coluna | Tipo | Notas |
|--------|------|-------|
| `account_code` | text **PK** | Código canônico da conta folha. |
| `account_name` | text | Nome PT-BR. |
| `account_kind` | text | `PNL` (fluxo mensal) ou `POSICAO` (estoque fim de mês). |
| `group_code` | text | Agrupamento para subtotais derivados. |
| `sign` | text | Convenção de sinal (`+`, `-`, `+/-`). |

**Contas de P&L** (`account_kind='PNL'`) — receita **positiva**, custos/despesas **negativos**:

| account_code | account_name | group_code | sign |
|--------------|--------------|------------|------|
| `R_BRUTA` | Receita Bruta de Vendas | RECEITA | + |
| `DEDUCOES` | Impostos e Deduções s/ Vendas | RECEITA | - |
| `CMV` | Custo dos Produtos/Serviços (CMV) | CUSTO | - |
| `DESP_PESSOAL` | Despesas com Pessoal | OPEX | - |
| `DESP_VENDAS` | Despesas Comerciais e Marketing | OPEX | - |
| `DESP_ADM` | Despesas Administrativas | OPEX | - |
| `DESP_OUTRAS` | Outras Despesas Operacionais | OPEX | - |
| `DEPRECIACAO` | Depreciação e Amortização | DA | - |
| `RESULT_FIN` | Resultado Financeiro Líquido | FINANC | +/- |
| `IRPJ_CSLL` | IR e CSLL | IMPOSTO | - |

**Contas de posição** (`account_kind='POSICAO'`, estoque fim de mês, todas positivas):

| account_code | account_name |
|--------------|--------------|
| `CAIXA` | Caixa e Equivalentes |
| `AR` | Contas a Receber |
| `AP` | Contas a Pagar |
| `ESTOQUE` | Estoques |
| `DIVIDA` | Dívida Bruta (Empréstimos) |
| `PATRIMONIO` | Patrimônio Líquido |

> Subtotais (Receita Líquida, Lucro Bruto, EBITDA, ...) são **DERIVADOS**, nunca contas folha.

---

## 3. Fato

### `cockpit.fact_financials`

| Coluna | Tipo | Notas |
|--------|------|-------|
| `id` | bigserial PK | |
| `company_id` | text **FK** → `dim_company` | |
| `period_date` | date | Primeiro dia do mês. |
| `account_code` | text **FK** → `dim_account` | |
| `valor_realizado` | numeric(18,2) | Realizado (respeita convenção de sinal). |
| `valor_orcado` | numeric(18,2) | Orçado, para Budget-vs-Actual. |
| `source_file` | text | Planilha de origem. |
| `load_id` | text | Liga a `pipeline_runs`. |
| `created_at` | timestamptz | |
| — | — | **UNIQUE(`company_id`, `period_date`, `account_code`)** (idempotência/UPSERT). |

Cada linha mensal carrega **`valor_realizado` e `valor_orcado`** (`SPEC.md` §3, último parágrafo).

---

## 4. Ingestão / confiabilidade (Fase 1)

| Tabela | Papel | Colunas-chave |
|--------|-------|---------------|
| `cockpit.stg_financials` | Mirror cru das linhas da planilha (**tudo texto**). | espelha colunas da fonte + `source_file`, `load_id`. |
| `cockpit.quarantine_rows` | Linhas que falharam na validação. | `id, load_id, source_file, row_num, raw_payload jsonb, error_code, error_detail, created_at`. |
| `cockpit.pipeline_runs` | Uma linha por execução (telemetria). | `load_id PK, workflow, source_file, status, rows_total, rows_ok, rows_quarantined, started_at, finished_at, retries, message`. |
| `cockpit.ingestion_log` | Log passo a passo. | `id, load_id, level, step, message, payload jsonb, created_at`. |

---

## 5. Views de consolidação / KPI

| View | O que entrega |
|------|---------------|
| `cockpit.v_pnl_company_month` | P&L derivado por empresa-mês: `receita_liquida, lucro_bruto, ebitda, ebit, lucro_liquido` + margens. |
| `cockpit.v_pnl_consolidado_month` | Consolidado (soma das empresas) por mês. |
| `cockpit.v_kpi_consolidado_ltm` | Snapshot LTM mais recente dos KPIs. |
| `cockpit.v_position_company_month` | Contas de posição por empresa-mês + `divida_liquida, capital_giro, dso`. |
| `cockpit.v_budget_vs_actual` | Realizado vs. orçado por empresa/conta/mês + variância. |

Consultas reutilizáveis: `db/queries/{kpis.sql, consolidacao.sql, qualidade_dados.sql, rag_documents.sql}`.

---

## 6. RAG / pgvector (Fase 2)

| Tabela | Papel | Colunas-chave |
|--------|-------|---------------|
| `cockpit.kb_documents` | Uma linha por "narrativa de fato". | `id, doc_type, company_id, period_date, title, content, metadata jsonb, created_at`. |
| `cockpit.kb_embeddings` | Vetores + índice `ivfflat` `vector_cosine_ops`. | `id, doc_id FK, embedding vector(1536), model, created_at`. |
| `cockpit.ai_query_audit` | Auditoria de cada pergunta NL. | `id, user_role, question, retrieved_doc_ids int[], answer, model, prompt_tokens, completion_tokens, latency_ms, created_at`. |

---

## 7. Períodos (`SPEC.md` §5)

- Grão **mensal**; `period_date` = primeiro dia do mês (DATE).
- Histórico: **2025-01-01 .. 2026-05-01** (17 meses fechados) + **2026-06-01** parcial.
- `last_closed_period = 2026-05-01`. "Hoje" = **2026-06-23**.
- Geração **determinística (seeded)** com sazonalidade (pico de varejo Nov/Dez) e crescimento YoY.
- **LTM** = últimos 12 meses terminando em `last_closed_period`.

---

## 8. Referência de fórmulas de KPI (canônica — `SPEC.md` §4)

Implementadas **identicamente** em SQL e no JSON. Consolidado = somar contas folha primeiro, depois
derivar. `DEDUCOES`, `CMV`, despesas, `DEPRECIACAO`, `IRPJ_CSLL` já são **negativos**.

| KPI | Fórmula |
|-----|---------|
| `receita_liquida` | `R_BRUTA + DEDUCOES` |
| `lucro_bruto` | `receita_liquida + CMV` |
| `ebitda` | `lucro_bruto + DESP_PESSOAL + DESP_VENDAS + DESP_ADM + DESP_OUTRAS` |
| `ebit` | `ebitda + DEPRECIACAO` |
| `lucro_liquido` | `ebit + RESULT_FIN + IRPJ_CSLL` |
| `margem_bruta_pct` | `lucro_bruto / receita_liquida * 100` |
| `margem_ebitda_pct` | `ebitda / receita_liquida * 100` |
| `margem_liquida_pct` | `lucro_liquido / receita_liquida * 100` |
| `divida_liquida` | `DIVIDA - CAIXA` |
| `divida_ebitda` | `divida_liquida / ebitda_ltm`  (`ebitda_ltm` = soma 12 meses) |
| `dso_dias` | `AR / R_BRUTA * 30` |
| `capital_giro` | `AR + ESTOQUE - AP` |
| `fluxo_caixa_mes` | `CAIXA(m) - CAIXA(m-1)`  (proxy de variação de caixa) |
| `burn_mensal` | média de `-fluxo_caixa_mes` dos últimos 3 meses, quando negativo |
| `runway_meses` | `CAIXA / burn_mensal`  (se `burn>0`; senão "n/a / fluxo positivo") |
| `receita_yoy_pct` | `receita_liquida(m) / receita_liquida(m-12) - 1`, em % |
| `variacao_orcado_pct` (por linha) | `realizado / orcado - 1`, em % |

> **Cuidado com consolidação:** nunca some margens nem KPIs derivados entre empresas. Some as
> **contas folha** (`fact_financials`) por mês e só então aplique as fórmulas acima.

---

## 9. Mapa de objetos × arquivos

| Objeto | Definido em |
|--------|-------------|
| `dim_company`, `dim_account`, `fact_financials`, staging, quarentena, telemetria, views, `kb_*`, `ai_query_audit` | `db/schema.sql` |
| Papéis, GRANTs, RLS, `user_company_access` | `db/rbac.sql` |
| Dados de referência (`dim_company`, `dim_account`) | `db/seed_reference.sql` |
| Consultas de KPI / consolidação / qualidade / narrativas RAG | `db/queries/*.sql` |
| Geração de fatos + `dashboard_data.json` | `data/generate_data.py` |
