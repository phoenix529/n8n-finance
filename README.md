# Cockpit Financeiro Estratégico — Grupo Aurora

> Plataforma de _CFO cockpit_ (fechamento mensal _board-grade_) para um grupo empresarial
> brasileiro multi-empresa. Stack: **n8n + PostgreSQL 16 + pgvector + RAG (Claude) + dashboard executivo**.
> Idioma de produto: **PT-BR**, moeda **BRL (R$)**.

A fonte única de verdade para nomes de tabelas, colunas, `account_code`, `company_id`, fórmulas de
KPI, caminhos de arquivo e o formato do `dashboard_data.json` é o **[`SPEC.md`](SPEC.md)**. Esta
documentação **espelha** o spec — nunca o contradiz.

---

## 1. O que é

Um _cockpit_ financeiro consolidado para a holding **Grupo Aurora** (`Aurora Participações S.A.`) e
suas controladas. Replica o vocabulário de dashboards de CFO de referência (cash position, burn &
runway, EBITDA, margens, orçado vs. realizado, gasto por categoria) e adiciona um painel de
**"Key Insights"** com IA (RAG sobre os próprios números do grupo).

Perímetro de consolidação (ver `SPEC.md` §2):

| company_id | Empresa                   | Setor      | Cor      |
|------------|---------------------------|------------|----------|
| `AUR-VAR`  | Aurora Varejo S.A.        | Varejo     | `#4F6BED`|
| `AUR-IND`  | Aurora Indústria Ltda.    | Indústria  | `#0EA5E9`|
| `AUR-SVC`  | Aurora Serviços Ltda.     | Serviços   | `#10B981`|
| `AUR-LOG`  | Aurora Logística Ltda.    | Logística  | `#F59E0B`|
| `AUR-HLD`  | Aurora Participações S.A. | Holding    | `#6B7280`|
| `ELIM`     | Eliminações Intercompany  | Eliminação | `#94A3B8`|

> **Marca = placeholder.** "Grupo Aurora" vive em UM bloco de config (`dashboard/app.js` → `BRAND`
> e no `meta` do JSON), trivialmente substituível pela identidade real do cliente.

---

## 2. Arquitetura (visão ASCII)

```
                         FONTES                         INGESTÃO / CONFIABILIDADE (Fase 1)
   ┌───────────────────────────────┐      ┌──────────────────────────────────────────────────┐
   │  Planilhas Excel (.xlsx)       │      │  n8n  01_ingestao_planilhas.json                  │
   │  data/raw/<gerados xlsx>       │ ───► │   ┌────────────┐  validação  ┌──────────────────┐ │
   │  (hoje: dados sintéticos       │      │   │ stg_finan- │ ──────────► │ quarantine_rows  │ │
   │   determinísticos seeded)      │      │   │  cials     │   (falha)   │ (linhas inválidas│ │
   │  Fase 3: ERP/API               │      │   └─────┬──────┘             └──────────────────┘ │
   └───────────────────────────────┘      │         │ (ok)                                     │
                                          │         ▼                pipeline_runs / ingestion_log│
                                          │   ┌──────────────┐  (telemetria de cada execução)   │
                                          │   │fact_financials│ UNIQUE(company,period,account)  │
                                          │   └──────┬───────┘                                  │
                                          └──────────┼───────────────────────────────────────────┘
                                                     ▼
                  CONSOLIDAÇÃO / KPIs (SQL views)            ┌───────────────────────────────┐
   ┌──────────────────────────────────────────────┐        │ db/queries/*.sql               │
   │ v_pnl_company_month   v_pnl_consolidado_month │        │  kpis / consolidacao /         │
   │ v_kpi_consolidado_ltm v_position_company_month│ ◄──────┤  qualidade_dados / rag_documents│
   │ v_budget_vs_actual                            │        └───────────────────────────────┘
   └───────┬──────────────────────────────┬────────┘
           │                              │
           ▼                              ▼
   ┌────────────────────┐        RAG / IA (Fase 2)
   │ data/generate_     │   ┌──────────────────────────────────────────────┐
   │  data.py           │   │ rag/embed.py → kb_documents → kb_embeddings   │
   │ → out/dashboard_   │   │   (pgvector vector(1536), ivfflat cosine)     │
   │   data.json        │   │ rag/ask.py: pergunta NL → top-k → prompt       │
   │ → dashboard/       │   │   grounded → Claude → ai_query_audit           │
   │   dashboard_data.  │   │ n8n 03_rag_consulta.json → POST /webhook/      │
   │   json             │   │   cockpit-ask                                  │
   └─────────┬──────────┘   └──────────────────────┬───────────────────────┘
             │                                     │
             ▼                                     ▼
   ┌──────────────────────────────────────────────────────────────────────┐
   │ DASHBOARD EXECUTIVO (dashboard/index.html + app.js + styles.css)      │
   │  KPIs · DRE waterfall · por empresa · orçado×realizado · aging ·      │
   │  gastos por categoria · caixa/runway · CAIXA AI "Key Insights"        │
   │  (offline: lê dashboard_data.json; online: chama /webhook/cockpit-ask)│
   └──────────────────────────────────────────────────────────────────────┘
```

Detalhe completo em [`docs/01-arquitetura.md`](docs/01-arquitetura.md).

---

## 3. Fases x critérios de sucesso do contrato

| Fase | Escopo | Critério de sucesso (contratual) | Onde provar |
|------|--------|----------------------------------|-------------|
| **Fase 1 — Pipeline confiável** | Ingestão Excel → staging → validação → quarentena → `fact_financials`, com telemetria e _retry_. | **Pipeline roda 10 dias sem intervenção manual.** | `cockpit.pipeline_runs` (10 execuções diárias com `status='success'`), `quarantine_rows` tratada, `ingestion_log` sem erros não resolvidos. Ver runbook §Monitoramento. |
| **Fase 2 — Consolidação + RAG + Dashboard** | Views de KPI, geração do `dashboard_data.json`, embeddings/pgvector, RAG com Claude, dashboard executivo + caixa de IA. | **Resposta executiva (NL → resposta fundamentada) em < 30s.** | `cockpit.ai_query_audit.latency_ms < 30000`; orçamento de latência em [`docs/04-rag-e-ia.md`](docs/04-rag-e-ia.md). |
| **Fase 3 — ERP (futuro)** | Substituir a fonte Excel por conector ERP/API, mantendo `stg_financials` como contrato. | Sem retrabalho de schema/KPIs/dashboard. | Plug-in documentado em [`docs/01-arquitetura.md`](docs/01-arquitetura.md) §"Como a Fase 3 encaixa". |

A separação **staging → fact** é exatamente o que torna a Fase 3 um _drop-in_: troca-se apenas o
produtor de `stg_financials`; tudo a jusante (views, KPIs, JSON, dashboard, RAG) permanece igual.

---

## 4. Estrutura do repositório (autoritativa — `SPEC.md` §9)

```
README.md                      SPEC.md
docs/   01-arquitetura.md 02-runbook-operacional.md 03-modelo-dados.md 04-rag-e-ia.md 05-seguranca-rbac-lgpd.md
db/     schema.sql  rbac.sql  seed_reference.sql  queries/{kpis.sql,consolidacao.sql,qualidade_dados.sql,rag_documents.sql}
data/   generate_data.py  raw/<gerados xlsx>  out/{dashboard_data.json, *.csv}
n8n/    workflows/{01_ingestao_planilhas.json,02_pipeline_embeddings.json,03_rag_consulta.json}  README.md
rag/    embed.py  ask.py  requirements.txt  .env.example
dashboard/  index.html  styles.css  app.js  dashboard_data.json
scripts/    bootstrap_postgres.ps1  serve_dashboard.ps1
```

---

## 5. Quick start (Windows)

Pré-requisitos: **Windows Server / 10+**, **PowerShell 5.1+**, **Python 3.10+** no `PATH`. Sem
necessidade de admin se usar os binários portáteis do EDB (o bootstrap baixa).

```powershell
# 1) Banco: baixa PostgreSQL 16 (EDB zip), initdb, sobe, cria DB e aplica schema/rbac/seed
#    (seguro re-executar; ver nota de fallback pgvector no próprio script)
powershell -ExecutionPolicy Bypass -File .\scripts\bootstrap_postgres.ps1

# 2) Dados: gera xlsx sintéticos + out/dashboard_data.json (determinístico) e copia p/ dashboard/
python .\data\generate_data.py

# 3) RAG (opcional na Fase 2): cria venv, instala deps, embeda narrativas e responde perguntas
python -m venv .venv; .\.venv\Scripts\Activate.ps1
pip install -r .\rag\requirements.txt
Copy-Item .\rag\.env.example .\rag\.env   # preencha ANTHROPIC_API_KEY e PG*
python .\rag\embed.py                      # popula kb_documents + kb_embeddings
python .\rag\ask.py "Qual o EBITDA consolidado do último mês?"

# 4) Dashboard: servidor estático local em http://localhost:8088
powershell -ExecutionPolicy Bypass -File .\scripts\serve_dashboard.ps1
```

n8n (ingestão diária + webhook RAG): importe os fluxos em `n8n/workflows/` e siga o
[runbook](docs/02-runbook-operacional.md) §"Importar workflows n8n" e §"Agendar ingestão diária".

> O dashboard funciona **100% offline** lendo `dashboard/dashboard_data.json`. Sem internet, a
> caixa de IA usa `respostas_demo`; com n8n no ar, ela chama `POST /webhook/cockpit-ask`.

---

## 6. Mapa da documentação

| Documento | Conteúdo |
|-----------|----------|
| [`docs/01-arquitetura.md`](docs/01-arquitetura.md) | Componentes, fluxo de dados, diagrama ASCII, encaixe da Fase 3 (ERP). |
| [`docs/02-runbook-operacional.md`](docs/02-runbook-operacional.md) | Instalar/rodar Postgres+pgvector, carregar schema/seed/dados, n8n, embeddings, dashboard, monitoramento, retry/alertas, backup, troubleshooting. |
| [`docs/03-modelo-dados.md`](docs/03-modelo-dados.md) | Tabelas, colunas, plano de contas, referência de fórmulas de KPI, visão ER. |
| [`docs/04-rag-e-ia.md`](docs/04-rag-e-ia.md) | Arquitetura RAG, embeddings/pgvector, _prompt grounding_, `ai_query_audit`, orçamento de latência < 30s, escolha de modelo, integração com a caixa de IA do dashboard. |
| [`docs/05-seguranca-rbac-lgpd.md`](docs/05-seguranca-rbac-lgpd.md) | Os quatro papéis, RLS por empresa, trilha de auditoria, LGPD/anonimização. |

---

## 7. Convenções (resumo — `SPEC.md` §10)

- Sinais: receita **positiva**, custos/despesas armazenados como **negativos**.
- Dinheiro no JSON: **números** em BRL (não strings); percentuais como número (`18.4` = 18,4%).
- UI: `R$ 1,2 mi` / `R$ 850 mil`; valor cheio no tooltip.
- Sem CDNs externos no runtime do dashboard — gráficos em SVG/canvas vanilla.
- Tudo reproduzível: `python data/generate_data.py` regenera dados + JSON deterministicamente.

---

## 8. Licença / marca

Identidade "Grupo Aurora" é **placeholder** (`is_placeholder_brand: true` no `meta`). Rebranding =
editar o bloco `BRAND` em `dashboard/app.js` e o `meta` do gerador. Nenhum dado real de cliente
está incluído neste repositório.
