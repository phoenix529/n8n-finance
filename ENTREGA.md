# Entrega — Cockpit Financeiro Estratégico · REF Group

Documento único de handoff. Resume o que foi entregue, como acessar e operar, o
status dos critérios de aceite do Blueprint e o que ainda depende do cliente.
Detalhe técnico: [README_REF.md](README_REF.md) · [docs/04-mapeamento-planilhas.md](docs/04-mapeamento-planilhas.md) · [docs/03-integracao-dados-reais.md](docs/03-integracao-dados-reais.md).

## 1. O que foi entregue (stack do Blueprint)
| Camada | Tecnologia | Onde |
|---|---|---|
| Orquestração | n8n (self-hosted) | 3 workflows em `n8n/workflows/` (ingestão 07:00, qualidade 07:30, COR fase 2) |
| Ingestão | Python 3 + pandas/openpyxl/psycopg2 | `ingestao/` — 1 parser por empresa, validação, log de carga |
| Banco | PostgreSQL 16 | `cockpit_ref` (schema estrela do Blueprint §5) — `db/schema_ref.sql` |
| Visualização | **Grafana** | dashboard `cockpit-ref` — 6 painéis obrigatórios + status |
| IA consultiva | Claude API via **FastAPI** | `ia/` — `POST /perguntar` fundamentado nos números |

Dados reais das **5 empresas** (REF, BD, 4PR, Viv, Zup) carregados: **2026 mensal** + **histórico 2018–2025**, mais **receita por cliente** (REF). Reprodutibilidade conferida (totais do banco = "TOTAL 2026" da planilha, tolerância R$ 0,01).

## 2. Acessos
| Recurso | URL | Autenticação |
|---|---|---|
| **Grafana** (dashboard executivo) | `http://<IP-do-servidor>:3000/d/cockpit-ref` | **login** (senha em `conf/custom.ini` / não versionada) |
| Cockpit customizado (visão executiva bônus) | https://perl-function-reduce-favour.trycloudflare.com | aberto (demo) |
| IA (FastAPI) | `http://127.0.0.1:8501/perguntar` | header `X-API-Key: <do .env IA_API_KEY>` |
| Runner n8n→Python (FastAPI) | `http://127.0.0.1:8501/run/{ingestao\|qualidade\|cor}` | interno (só 127.0.0.1; scripts fixos) |
| n8n | `http://127.0.0.1:5678` | conta de owner do n8n |

> Os links públicos usam túnel Cloudflare efêmero (mudam se o servidor reiniciar). Para link fixo, usar o domínio/HTTPS do VPS.

## 3. Operação rápida
```bash
# reprocessar a ingestão (idempotente)
cd ingestao && python main.py && python history.py
# checagens de qualidade (§6.4)
python validators.py
# regenerar o dashboard do Grafana
python ../grafana/build_dashboard.py
```
- **Automação:** ative no n8n os workflows *REF — Ingestão Diária* e *REF — Verificação de Qualidade* (toggle **Active**). Rodam 07:00 e 07:30.
- **Backup:** tarefa `CockpitRef-PgBackup` (diária 03:00, retenção 7 dias) já registrada no Task Scheduler.

## 4. Status dos critérios de aceite
**Fase 1 — completa:** mapeamento ✓ · parsers por empresa ✓ · banco/modelo ✓ · pipeline n8n (mecanismo validado: roda `main.py`, exitCode 0, grava log) ✓ · validação de consistência (4 checks §6.4) ✓ · histórico (todos os anos) ✓ · reprodutibilidade R$ 0,01 ✓ · documentação ✓.

**Fase 2 — parcial:** dashboard Grafana com os 6 painéis ✓ · serviço de IA `/perguntar` (contexto correto, auth) ✓ — **geração ao vivo aguarda créditos Anthropic** · **COR/margem real BLOQUEADO** (token + custo/hora).

## 5. O que falta — depende do cliente
1. **Créditos na conta Anthropic** → habilita as respostas de IA ao vivo.
2. **Token da API do COR** + **tabela custo/hora por colaborador** → habilita margem real por projeto (Fase 2). Estrutura, loader e view já prontos.
3. **Credenciais de e-mail (SMTP) ou Telegram** → liga as notificações de sucesso/erro nos workflows.
4. **Dados do VPS Ubuntu** → para o deploy definitivo (kit pronto: `deploy/docker-compose.yml` + scripts).

## 6. Deploy no VPS (quando o servidor estiver disponível)
1. `apt install postgresql` → criar `cockpit_ref` + `cockpit_user`; aplicar `db/schema_ref.sql`.
2. Copiar `ingestao/`, `ia/`, `grafana/` para `/opt/cockpit-ref/`; criar `.env` (sem versionar).
3. `docker compose -f deploy/docker-compose.yml up -d` (n8n + Metabase) **ou** Grafana nativo.
4. Nginx + Let's Encrypt como proxy HTTPS na frente de Grafana e FastAPI.
5. Importar os 3 workflows do n8n; agendar `backups/pg_backup.sh` no cron (03:00).
