# Cockpit Financeiro Estratégico — REF Group

Implementação do **Technical Blueprint** (v1.0). Stack: **n8n · PostgreSQL · Python (pandas) ·
Claude API (FastAPI) · Grafana**. Construído e verificado no Windows; pronto para deploy
no VPS Ubuntu (docker-compose + scripts incluídos).

## Arquitetura (4 camadas desacopladas — Blueprint §3)
| Camada | Tecnologia | Componente |
|---|---|---|
| Orquestração | n8n | `n8n/workflows/10_ref_ingestao_diaria.json`, `11_ref_qualidade.json` |
| Ingestão/transformação | Python 3 + pandas/openpyxl/psycopg2 | `ingestao/` (parser por empresa) |
| Armazenamento | PostgreSQL 16 | banco `cockpit_ref` (`db/schema_ref.sql`) |
| Visualização | **Grafana** (mandato Metabase/Grafana) | `grafana/` (6 painéis provisionados) |
| IA consultiva | Claude API via **FastAPI** | `ia/main.py` (`/perguntar`) |

## Estrutura de diretórios
```
ingestao/   main.py · history.py · cor_loader.py · validators.py · db.py · parsers/{ref,bd,quatro_pr,viv,zup,clientes}.py
ia/         main.py (FastAPI /perguntar) · context_builder.py
db/         schema_ref.sql (modelo estrela do blueprint)
grafana/    provisioning/ (datasource+dashboards) · dashboards/cockpit_ref.json · build_dashboard.py
deploy/     docker-compose.yml (n8n + Metabase, p/ VPS)
backups/    pg_backup.sh (Linux) · pg_backup.ps1 (Windows) — pg_dump retenção 7 dias
data/incoming/   as 5 planilhas .xlsx
docs/       03-integracao-dados-reais.md · 04-mapeamento-planilhas.md
.env        credenciais (DB_*, ANTHROPIC_API_KEY, IA_API_KEY, N8N_*) — NÃO versionar
```

## Configuração (.env — Blueprint §4.4)
```
DB_HOST=127.0.0.1  DB_PORT=5432  DB_NAME=cockpit_ref  DB_USER=cockpit_user  DB_PASSWORD=...
ANTHROPIC_API_KEY=sk-ant-...   LLM_MODEL=claude-opus-4-8   IA_API_KEY=...
N8N_BASIC_AUTH_USER=admin      N8N_BASIC_AUTH_PASSWORD=...
```

## Operação

### 1. Banco de dados
```
psql -U cockpit_user -d cockpit_ref -f db/schema_ref.sql      # cria dimensões, fatos, views
```

### 2. Ingestão (Fase 1)
```
cd ingestao
python main.py        # lê as 5 planilhas, normaliza, valida, carrega fato_dre_mensal + clientes
python history.py     # carrega o histórico anual 2018–2025
python validators.py  # roda as 4 checagens de qualidade (sai 1 se houver alerta)
```
Reprodutibilidade: `SUM(RECEITA BRUTA REF 2026)` = R$ 94.215.954,69 (= TOTAL 2026 da planilha).

### 3. Agendamento (n8n)
Importe `n8n/workflows/10_*.json` e `11_*.json` e ative-os. Workflow 1 roda **07:00**, Workflow 2 **07:30**.

> **Importante (verificado no n8n ao vivo):** o nó **Execute Command** está DESABILITADO nesta
> instância n8n (erro "Unrecognized node type"). O blueprint §3.1 permite a alternativa — rodar o
> script **via HTTP**. Por isso os workflows usam um nó **HTTP Request** → `POST http://127.0.0.1:8501/run/{ingestao|qualidade|cor}`
> (endpoint do serviço FastAPI, autenticado por `X-API-Key`), que executa `main.py`/`validators.py`/`cor_loader.py`
> e devolve `{ok, returncode, stdout, stderr}`. O nó IF ramifica em `{{ $json.ok }}`.
> Testado ao vivo: trigger → HTTP `/run/ingestao` (ok=true) → IF → ramo de sucesso. ✓

Conecte um nó **Email Send** ou **Telegram** nos pontos de notificação (credenciais do cliente).
(No VPS, se o nó Execute Command estiver habilitado, dá para usar o comando shell direto — ambos
são válidos pelo blueprint; o HTTP é portátil e funciona em qualquer instância n8n.)

### 4. Grafana (dashboard executivo)
```
# Windows (já rodando): grafana-server --homepath C:\Users\Administrator\gf
# provisioning aponta para grafana/provisioning (datasource cockpit_ref + dashboard)
```
Acesso: `http://<host>:3000/d/cockpit-ref` · **requer login** (admin / senha do .env, §8) ·
acesso anônimo DESABILITADO · bind apenas `127.0.0.1` (exponha via Nginx/HTTPS ou túnel autenticado).
A senha do datasource vem de `${DB_PASSWORD}` (env), nunca hardcoded no arquivo de provisioning.
Regenerar o JSON do dashboard: `python grafana/build_dashboard.py`.
**6 painéis:** Consolidado do Grupo · Evolução Histórica (2018→) · DRE por Empresa · Composição
de Custos · Receita por Cliente (REF) · Margem Real por Projeto (Fase 2). Negativos em vermelho.

### 5. IA consultiva (FastAPI)
```
cd ia && uvicorn main:app --host 127.0.0.1 --port 8500
curl -X POST http://127.0.0.1:8500/perguntar -H "X-API-Key: $IA_API_KEY" \
     -H "Content-Type: application/json" -d '{"texto":"Qual o EBIT do grupo em 2026?","periodo":"2026"}'
```
`build_context()` monta DRE do período + variação vs anterior + top contas + clientes (REF) e
o Claude responde fundamentado SOMENTE nesses números (não inventa).

### 6. Backups e segurança (Blueprint §8)
- `backups/pg_backup.ps1` (Windows) / `pg_backup.sh` (Linux) — pg_dump diário, retenção 7 dias.
  **Agendado** no Task Scheduler via `backups/register_task.ps1` (tarefa `CockpitRef-PgBackup`, diária 03:00).
- **Sem credenciais hardcoded** — DB password vem do `.env` em db.py/context_builder.py/pg_backup.ps1 e de
  `${DB_PASSWORD}` no datasource do Grafana; `.env` fora do Git (`.gitignore`).
- FastAPI com API key (`X-API-Key`); PostgreSQL e Grafana ligados só em `127.0.0.1`; Grafana exige login.
- VPS: `deploy/docker-compose.yml` sobe n8n + Metabase; Nginx + Let's Encrypt para HTTPS.

## Status dos critérios de aceite
**Fase 1:** mapeamento ✓ · parsers por empresa ✓ · banco/modelo ✓ · pipeline n8n 07:00 ✓ ·
validação de consistência ✓ · histórico (todos os anos) ✓ · reprodutibilidade R$ 0,01 ✓ ·
documentação ✓. Notificação e-mail/Telegram = estrutura pronta, **falta credencial do cliente**.

**Fase 2:** dashboard Grafana (6 painéis) ✓ · serviço de IA `/perguntar` ✓ (geração ao vivo
exige **créditos Anthropic**) · **COR / margem real = BLOQUEADO** até o cliente fornecer o
**token da API do COR** e a tabela **custo/hora por colaborador** (estrutura e view já criadas).
