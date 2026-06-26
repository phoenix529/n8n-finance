# 02 — Runbook Operacional

> Procedimentos para instalar, operar e diagnosticar o Cockpit. Caminhos e nomes conforme
> [`SPEC.md`](../SPEC.md). Ambiente de referência: **Windows + PowerShell**.

Sumário:
1. [Pré-requisitos](#1-pré-requisitos)
2. [Instalar e rodar PostgreSQL 16 + pgvector](#2-instalar-e-rodar-postgresql-16--pgvector)
3. [Carregar schema + RBAC + seed + dados](#3-carregar-schema--rbac--seed--dados)
4. [Importar workflows n8n](#4-importar-workflows-n8n)
5. [Agendar ingestão diária](#5-agendar-ingestão-diária)
6. [Rodar embeddings (RAG)](#6-rodar-embeddings-rag)
7. [Subir o dashboard](#7-subir-o-dashboard)
8. [Monitoramento](#8-monitoramento)
9. [Retry e alertas](#9-retry-e-alertas)
10. [Backup e restore](#10-backup-e-restore)
11. [Troubleshooting](#11-troubleshooting)

---

## 1. Pré-requisitos

- [ ] **Windows 10/11 / Server 2019+**, **PowerShell 5.1+**.
- [ ] **Python 3.10+** no `PATH` (`python --version`).
- [ ] **n8n** (Docker Desktop **ou** `npm i -g n8n`).
- [ ] Acesso de saída à API Anthropic (Fase 2) e chave `ANTHROPIC_API_KEY`.
- [ ] ~2 GB livres (binários do Postgres + dados).

---

## 2. Instalar e rodar PostgreSQL 16 + pgvector

O script `scripts/bootstrap_postgres.ps1` é **idempotente** (seguro re-executar): baixa os binários
portáteis do EDB, roda `initdb`, sobe o servidor, cria o banco `cockpit` e aplica os SQLs.

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\bootstrap_postgres.ps1
```

Etapas que o script ecoa:

```
[1/7] Verificar/baixar PostgreSQL 16 (EDB zip)        → scripts\.pg\pgsql\
[2/7] initdb do cluster (se ainda não existe)         → scripts\.pg\data\
[3/7] Iniciar servidor (pg_ctl start) na porta 5432
[4/7] Criar banco "cockpit" (se não existe)
[5/7] Aplicar db\schema.sql
[6/7] Aplicar db\rbac.sql
[7/7] Aplicar db\seed_reference.sql
```

### Nota de fallback: pgvector no Windows

O **binário EDB do Postgres não inclui `pgvector`**. Escolha UMA opção (o script imprime esta nota e
**não falha** se a extensão não puder ser criada — a Fase 1 funciona sem ela; a Fase 2 exige):

| Opção | Quando usar | Como |
|-------|-------------|------|
| **A. Prebuilt** | Mais rápido no Windows nativo. | Baixe a DLL `vector` compatível com PG16 (ex.: release do projeto), copie `vector.dll` → `pgsql\lib\` e os `.sql`/`.control` → `pgsql\share\extension\`, depois `CREATE EXTENSION vector;`. |
| **B. Build (MSVC)** | Sem prebuilt disponível. | Visual Studio Build Tools + `nmake /F Makefile.win` no repo do pgvector; instalar artefatos como na opção A. |
| **C. Docker / WSL** | **Recomendado** se Docker já existe. | `docker run -e POSTGRES_PASSWORD=postgres -p 5432:5432 pgvector/pgvector:pg16`. Aponte `PGHOST=localhost`. Dispensa o build no host. |

Após qualquer opção, valide:

```powershell
.\scripts\.pg\pgsql\bin\psql.exe -d cockpit -c "CREATE EXTENSION IF NOT EXISTS vector; SELECT extversion FROM pg_extension WHERE extname='vector';"
```

> O `db/schema.sql` deve conter `CREATE EXTENSION IF NOT EXISTS vector;` antes de criar
> `kb_embeddings`. Se a extensão não existir, crie-a primeiro (opções acima) e re-rode o schema.

---

## 3. Carregar schema + RBAC + seed + dados

Se preferir aplicar manualmente (o bootstrap já faz isto):

```powershell
$psql = ".\scripts\.pg\pgsql\bin\psql.exe"      # ou "psql" se estiver no PATH
& $psql -d cockpit -f .\db\schema.sql           # tabelas, views, índices, extensão vector
& $psql -d cockpit -f .\db\rbac.sql             # papéis, GRANTs, RLS, user_company_access
& $psql -d cockpit -f .\db\seed_reference.sql   # dim_company, dim_account (dados de referência)
```

Gerar os dados financeiros sintéticos e o contrato do dashboard:

```powershell
python .\data\generate_data.py
# → escreve data\raw\*.xlsx, data\out\dashboard_data.json e *.csv
# → copia dashboard_data.json para dashboard\dashboard_data.json (determinístico)
```

Checagem rápida pós-carga:

```sql
SELECT count(*) FROM cockpit.dim_company;     -- esperado: 6 (inclui ELIM)
SELECT count(*) FROM cockpit.dim_account;     -- esperado: 16 (10 PNL + 6 POSICAO)
SELECT count(*) FROM cockpit.fact_financials; -- > 0 após ingestão
SELECT * FROM cockpit.v_kpi_consolidado_ltm;  -- snapshot LTM
```

---

## 4. Importar workflows n8n

1. Suba o n8n:
   - Docker: `docker run -it --rm -p 5678:5678 -v n8n_data:/home/node/.n8n n8nio/n8n`
   - npm: `n8n start` (UI em `http://localhost:5678`).
2. Na UI: **Workflows → Import from File** e importe, nesta ordem:
   - `n8n/workflows/01_ingestao_planilhas.json`
   - `n8n/workflows/02_pipeline_embeddings.json`
   - `n8n/workflows/03_rag_consulta.json`
3. Configure as **credenciais/variáveis** (ver `rag/.env.example` e `n8n/README.md`):
   `PGHOST`, `PGPORT`, `PGDATABASE=cockpit`, `PGUSER`, `PGPASSWORD`, `ANTHROPIC_API_KEY`,
   `LLM_MODEL`, `EMBED_MODEL`.
4. Teste o webhook do RAG:
   ```powershell
   curl -X POST http://localhost:5678/webhook/cockpit-ask `
     -H "Content-Type: application/json" `
     -d '{"question":"Qual o EBITDA consolidado do último mês?"}'
   ```

---

## 5. Agendar ingestão diária

Objetivo da Fase 1: **rodar 10 dias sem intervenção manual**.

- **Via n8n (preferido):** no `01_ingestao_planilhas.json` o nó **Schedule Trigger** dispara
  diariamente (ex.: 06:00 America/Sao_Paulo). Ative o workflow (toggle **Active**). Cada execução:
  cria `load_id`, registra em `pipeline_runs`, processa novos arquivos de `data/raw/`, separa
  válidos/quarentena e grava `ingestion_log`.
- **Via Agendador do Windows (alternativa sem n8n ativo):**
  ```powershell
  schtasks /Create /SC DAILY /ST 06:00 /TN "CockpitIngestao" `
    /TR "powershell -ExecutionPolicy Bypass -File C:\Users\Administrator\Documents\n8n\scripts\bootstrap_postgres.ps1 -IngestOnly"
  ```
  (ajuste conforme um entrypoint de ingestão dedicado, se existir).

Critério de aceite (Fase 1): por **10 dias corridos**, `pipeline_runs` mostra uma execução/dia com
`status='success'` e `rows_quarantined` tratada — **sem** intervenção manual. Ver §8.

---

## 6. Rodar embeddings (RAG)

```powershell
python -m venv .venv; .\.venv\Scripts\Activate.ps1
pip install -r .\rag\requirements.txt
Copy-Item .\rag\.env.example .\rag\.env    # preencha ANTHROPIC_API_KEY, PG*, LLM_MODEL, EMBED_MODEL
python .\rag\embed.py                       # views → kb_documents → kb_embeddings (ivfflat cosine)
python .\rag\ask.py "Qual a margem EBITDA da Aurora Indústria em 2026-05?"
```

Ou automatize pelo n8n `02_pipeline_embeddings.json` (após cada fechamento/ingestão). Validação:

```sql
SELECT count(*) FROM cockpit.kb_documents;
SELECT count(*) FROM cockpit.kb_embeddings;
SELECT question, latency_ms, model FROM cockpit.ai_query_audit ORDER BY created_at DESC LIMIT 5;
```

> **SLA:** `latency_ms < 30000` (critério Fase 2). Ver orçamento de latência em
> [`04-rag-e-ia.md`](04-rag-e-ia.md).

---

## 7. Subir o dashboard

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\serve_dashboard.ps1
# → http://localhost:8088  (serve a pasta dashboard\)
```

O dashboard lê **apenas** `dashboard/dashboard_data.json`. Se atualizar os dados, re-rode
`python data\generate_data.py` (ele recopia o JSON) e recarregue o navegador (Ctrl+F5).

---

## 8. Monitoramento

Três tabelas de telemetria (`SPEC.md` §6). Consultas operacionais:

**Execuções do pipeline (saúde diária — base do critério "10 dias"):**
```sql
SELECT load_id, workflow, source_file, status,
       rows_total, rows_ok, rows_quarantined, retries,
       started_at, finished_at,
       finished_at - started_at AS duracao
FROM cockpit.pipeline_runs
ORDER BY started_at DESC
LIMIT 15;
```

**Linhas em quarentena (precisam de tratamento):**
```sql
SELECT error_code, count(*) AS qtd
FROM cockpit.quarantine_rows
GROUP BY error_code
ORDER BY qtd DESC;

SELECT id, load_id, source_file, row_num, error_code, error_detail, raw_payload
FROM cockpit.quarantine_rows
ORDER BY created_at DESC
LIMIT 50;
```

**Log de ingestão (passo a passo / erros):**
```sql
SELECT created_at, load_id, level, step, message
FROM cockpit.ingestion_log
WHERE level IN ('ERROR','WARN')
ORDER BY created_at DESC
LIMIT 50;
```

**Painel de "10 dias sem intervenção":**
```sql
SELECT date(started_at) AS dia,
       count(*) FILTER (WHERE status='success') AS ok,
       count(*) FILTER (WHERE status<>'success') AS falhas,
       sum(rows_quarantined) AS quarentena
FROM cockpit.pipeline_runs
WHERE started_at >= now() - interval '10 days'
GROUP BY 1 ORDER BY 1 DESC;
```

Metas: `falhas = 0` por dia; `quarentena` estável/decrescente e tratada; uma execução `success`/dia.

---

## 9. Retry e alertas

**Retry (no n8n):**
- O nó de processamento usa **retry com backoff** (ex.: 3 tentativas, espera crescente). Cada
  retentativa incrementa `pipeline_runs.retries`.
- Erros **transitórios** (conexão/lock/IO) → retry automático. Erros de **dados** (linha inválida)
  **não** geram retry — vão para `quarantine_rows` e a execução segue (degradação graciosa).
- Idempotência garante que reprocessar o mesmo arquivo não duplica fatos (`UNIQUE(company_id,
  period_date, account_code)` + `UPSERT`).

**Alertas:**
- Ao final de cada execução, se `status<>'success'` **ou** `rows_quarantined > limiar`, o workflow
  dispara notificação (e-mail/Slack/Teams via nó n8n). Mensagem inclui `load_id`, `source_file`,
  contadores e o último `ingestion_log` de nível `ERROR`.
- Recomendado: alerta de "**heartbeat ausente**" — se não houver execução `success` nas últimas 26h,
  notificar (cobre o caso de o agendador ter parado).

**Runbook de incidente (resumo):**
1. Identifique o `load_id` falho em `pipeline_runs`.
2. Leia `ingestion_log` (level `ERROR`) desse `load_id`.
3. Se for dado: corrija a planilha de origem ou aceite a quarentena e reprocessse.
4. Se for infra: corrija (banco/credencial/disco) e **re-rode** — é idempotente.

---

## 10. Backup e restore

**Backup lógico (recomendado, diário):**
```powershell
$pgdump = ".\scripts\.pg\pgsql\bin\pg_dump.exe"
& $pgdump -d cockpit -n cockpit -Fc -f ("backup_cockpit_{0}.dump" -f (Get-Date -Format yyyyMMdd))
```

**Restore:**
```powershell
$pgrestore = ".\scripts\.pg\pgsql\bin\pg_restore.exe"
& $pgrestore -d cockpit --clean --if-exists .\backup_cockpit_YYYYMMDD.dump
```

Recomendações:
- Agende o `pg_dump` diário (Agendador do Windows) e retenha 7–30 dias.
- O `dashboard_data.json` e os `data/raw/*.xlsx` são **reproduzíveis** (`generate_data.py`), mas
  versione-os se contiverem dados reais do cliente.
- Teste o restore periodicamente num banco descartável (`createdb cockpit_test` → restore → contagens).

---

## 11. Troubleshooting

| Sintoma | Causa provável | Ação |
|--------|----------------|------|
| `CREATE EXTENSION vector` falha | pgvector não instalado nos binários EDB | Aplique a nota de fallback (§2: prebuilt / build / Docker) e re-rode `schema.sql`. |
| `psql: could not connect ... 5432` | Servidor parado ou porta ocupada | `pg_ctl status`; suba via `bootstrap_postgres.ps1`; verifique outra instância na 5432. |
| Ingestão sobe `rows_quarantined` alto | `company_id`/`account_code` fora do `dim_*`, período inválido, valor não-numérico | Inspecione `quarantine_rows.error_detail`; corrija a planilha; reprocessse o `load_id`. |
| Fatos duplicados | Re-execução sem UPSERT | Confirme `UNIQUE(company_id, period_date, account_code)` e o `ON CONFLICT` no fluxo. |
| KPIs "estranhos" (margem somada) | Consolidação somando margens em vez de contas folha | Consolide **contas folha** e só então derive (`SPEC.md` §4). |
| Dashboard em branco / dados velhos | `dashboard_data.json` ausente/desatualizado ou cache | Re-rode `generate_data.py`; Ctrl+F5; confira `dashboard/dashboard_data.json`. |
| Caixa de IA não responde online | Webhook do n8n inativo | Ative `03_rag_consulta.json`; teste `POST /webhook/cockpit-ask`; offline usa `respostas_demo`. |
| RAG > 30s | _top-k_/índice/modelo | Confira índice `ivfflat`; reduza `k`; use `claude-sonnet-4-6`; ver orçamento em `04-rag-e-ia.md`. |
| `ANTHROPIC_API_KEY` inválida | `.env` não carregado | Verifique `rag/.env` (cópia de `.env.example`) e as credenciais no n8n. |
| Agendador não disparou | Workflow inativo ou task removida | Ative o workflow n8n; cheque `schtasks /Query /TN CockpitIngestao`; veja alerta de heartbeat (§9). |
| `python: command not found` | Python fora do `PATH` | Instale Python 3.10+ e marque "Add to PATH"; reabra o PowerShell. |

---

## 12. Notas desta instância (validação ao vivo — 2026-06-23)

O que foi efetivamente provisionado e verificado neste servidor (Windows Server 2022):

- **PostgreSQL 16.4** subido a partir dos binários portáteis EDB em `C:\pg16\pgsql\bin`
  (sem instalador/serviço), dados em `C:\pgdata`, porta **5432**, auth `trust` (local/demo).
  - `createdb cockpit`; aplicados `db/schema.sql`, `db/rbac.sql`, `db/seed_reference.sql`.
  - `\copy cockpit.fact_financials(...) FROM 'data/out/fact_financials.csv' CSV HEADER` →
    **1728 fatos** (18 meses × 6 empresas × 16 contas).
  - Conferência das views (devem casar com o `dashboard_data.json`):
    `SELECT receita_liquida_ltm, ebitda_ltm FROM cockpit.v_kpi_consolidado_ltm;`
    → **R$ 422,8 mi / R$ 78,7 mi** ✔ (idêntico ao gerador/dashboard).
- **pgvector**: os binários EDB **não** incluem a extensão; `CREATE EXTENSION vector`
  falha e os objetos `kb_embeddings`/`ivfflat` são pulados (ver §11). As camadas de
  dimensões/fatos/**views de KPI** carregam normalmente — a camada RAG exige instalar o
  pgvector (prebuilt/build/WSL/Docker) ou usar o fallback local de `rag/embed.py`.

### 12.1 Ingestão Fase 1 via CLI (`scripts/run_ingestion.py`)

Implementação Python da MESMA lógica do `Code` node "Validação de Schema" do workflow
`01_ingestao_planilhas.json` — útil para rodar a ingestão sem subir o n8n e para CI/testes.

```powershell
$env:PGHOST="127.0.0.1"; $env:PGPORT="5432"; $env:PGDATABASE="cockpit"
$env:PGUSER="postgres"; $env:PGPASSWORD="postgres"
python scripts\run_ingestion.py                      # ingere data\raw\upload_*.xlsx
python scripts\run_ingestion.py data\raw\historico_*.xlsx   # carga histórica
```

Resultado verificado ao vivo (arquivo `*_INVALIDO.xlsx` desenhado para exercitar a quarentena):

| load_id | status | total | ok | quarentena |
|---|---|---|---|---|
| `cli-upload_AUR-VAR_2026-06` | OK | 16 | 16 | 0 |
| `cli-upload_AUR-IND_2026-06_INVALIDO` | PARTIAL | 19 | 16 | 3 |

`cockpit.quarantine_rows` capturou as 3 linhas com motivo: **PERIODO_INVALIDO** (`2026-13`),
**VALOR_NAO_NUMERICO** (`R$ doze mil`), **CONTA_DESCONHECIDA** (`CONTA_FANTASMA`). Telemetria
em `cockpit.pipeline_runs` e `cockpit.ingestion_log`.

### 12.2 n8n — requisito de versão do Node

> ⚠️ O n8n exige **Node.js ≤ 22 LTS**. Neste servidor o Node padrão é **23.11.1**, no qual o
> `npm install -g n8n` produz instalação incompleta (`Cannot find module .../bin/n8n`). Para
> subir a GUI do n8n e importar os workflows:
>
> ```powershell
> nvm install 22.16.0; nvm use 22.16.0      # ou Node 22 portátil
> npm install -g n8n
> $env:N8N_USER_MANAGEMENT_DISABLED="true"  # evita criação de conta na 1ª execução
> n8n start                                  # http://localhost:5678
> ```
>
> Importar credencial + workflows (a credencial `Postgres Cockpit` usa id fixo `POSTGRES_COCKPIT`,
> casando automaticamente com os nós Postgres dos fluxos):
>
> ```powershell
> n8n import:credentials --input=<creds.json>          # host 127.0.0.1:5432 db cockpit
> n8n import:workflow --separate --input=n8n\workflows
> n8n execute --id <id-do-01_ingestao>                 # execução headless da Fase 1
> ```

### 12.3 n8n — execução ao vivo do fluxo 01 e correções aplicadas

O fluxo `01_ingestao_planilhas.json` foi executado ao vivo no editor n8n (Node 22) contra o
PostgreSQL real. Durante a validação foram corrigidos 4 bugs do fluxo gerado:

1. **Binário descartado no meio do caminho** — o nó Postgres `Registrar pipeline_runs` ficava
   na rota de dados e destruía o binário do arquivo antes do parser. Corrigido: virou um
   **ramo lateral** (`Abrir Run do Pipeline → [Parsear XLSX, Registrar pipeline_runs]`).
2. **Nó Code com 2 saídas** — `return [valid, invalid]` é inválido (o nó Code tem saída única).
   Corrigido: dividido em **`Validar — Válidas`** e **`Validar — Inválidas`** (saída única cada).
3. **Sinônimo de coluna** — a lista de `account_code` não incluía `conta_codigo` (nome real da
   coluna), classificando tudo como `MISSING_ACCOUNT_CODE`. Corrigido.
4. **Empresa por NOME** — a planilha traz o **nome** ("Aurora Indústria Ltda."), não o código
   (`AUR-IND`). Adicionado resolver **nome → company_id** no validador.

Resultado verificado em `cockpit.*`: **32 linhas válidas** → `stg_financials`/`fact_financials`;
**3 linhas** → `quarantine_rows` com os motivos exatos (`INVALID_PERIOD` `2026-13`,
`INVALID_VALOR` `R$ doze mil`, `UNKNOWN_ACCOUNT_CODE` `CONTA_FANTASMA`).

> ⚠️ **Item de polimento remanescente:** o sumário do run (`pipeline_runs.status`/contagens e
> `ingestion_log`) não é atualizado corretamente quando o lote tem **múltiplos arquivos** — a
> agregação por `load_id` no nó `Agregar Contagens`/`Fechar pipeline_runs` precisa ser ajustada
> para o caso multi-arquivo. O caminho de dados (fato + quarentena) está correto. A
> implementação de referência **`scripts/run_ingestion.py`** já trata isso corretamente
> (gera `pipeline_runs` com status `OK`/`PARTIAL` e contagens, e popula `ingestion_log`).

### 12.4 Caixa de IA ao vivo (RAG) — `rag/rag_server.py`

Endpoint local (`POST http://127.0.0.1:5680/ask`) que faz **retrieval** dos números do
fechamento nas views `cockpit.*` (PostgreSQL) e **geração** com Claude (`claude-opus-4-8`),
fundamentado apenas nesses números; audita em `cockpit.ai_query_audit`. O dashboard aponta
para ele via `window.RAG_ENDPOINT` (em `dashboard/index.html`).

```powershell
# preencha a chave em rag/.env (ANTHROPIC_API_KEY=...) e rode:
python rag\rag_server.py        # sobe na porta 5680
```

A integração foi validada de ponta a ponta (autentica, recupera contexto do Postgres e chama
a Messages API com `request_id` válido). Se a conta Anthropic estiver sem saldo, a API retorna
`400 invalid_request_error` ("credit balance too low") — adicione créditos no console; o
dashboard cai graciosamente nas `respostas_demo` offline enquanto isso.

### 12.5 Fase 1 — confiabilidade: retry, carga histórica, monitor e agendamento

Itens de "código 100%" concluídos e verificados nesta instância:

- **Carga histórica ATRAVÉS do pipeline** (não `\copy`): `python scripts/run_ingestion.py data/raw/historico_*.xlsx`
  ingere **6 arquivos × 288 = 1728 linhas** validadas → `fact_financials`; cada arquivo gera um
  `pipeline_runs` com `status='OK'` e contagens, e um `ingestion_log`.
- **Telemetria de run correta**: após a carga, `cockpit.pipeline_runs` mostra **8 runs fechados**
  (6 `OK` histórico, 1 `OK` upload limpo, 1 `PARTIAL` 19/16/3) com `finished_at` e contagens;
  `cockpit.ingestion_log` tem 1 INFO por arquivo. (No fluxo n8n, as mesmas correções foram
  aplicadas — ver §12.3 — adotando semântica **um arquivo por execução**.)
- **Retry com backoff exponencial** (`with_retry` em `run_ingestion.py`, espelha o `retryOnFail`
  dos nós Postgres do n8n). Prova: `python scripts/run_ingestion.py --selftest-retry`
  (falha transitória 2×, sucesso na 3ª).
- **Heartbeat / alerta**: `python scripts/monitor_pipeline.py` — checa runs presas, silêncio
  (> 26h sem run), erros, taxa de quarentena e nº de runs nos últimos 10 dias. Código de saída
  `0=OK / 1=WARN / 2=ALERT` para integrar com alertas.
- **Agendamento (operação não assistida)**: `powershell -File scripts/schedule_ingestion.ps1`
  registra `CockpitIngestao` (diária 05:30) e `CockpitMonitor` (horária) no Windows Task
  Scheduler. **O relógio dos 10 dias começa na 1ª execução agendada.** Alternativa: ativar o
  Schedule Trigger do workflow n8n.

> Resumo de status da Fase 1: o **núcleo de dados** (ingestão Excel, validação de schema,
> quarentena com motivos, carga histórica de 12+ meses pela pipeline, banco estruturado) e a
> **confiabilidade de código** (retry, logs/telemetria de run, monitor, agendamento) estão
> **completos e verificados**. O **critério contratual de 10 dias sem intervenção** é
> intrinsecamente temporal: o código e o agendamento para executá-lo de forma não assistida
> estão prontos; faltam os 10 dias de calendário com o monitor acompanhando.
