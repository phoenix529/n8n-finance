# 05 — Segurança, RBAC e LGPD

> Espelha o [`SPEC.md`](../SPEC.md) §6 (RBAC/RLS). Implementação em `db/rbac.sql`. Idioma e contexto
> legal: **Brasil / LGPD (Lei 13.709/2018)**.

---

## 1. Os quatro papéis (RBAC)

Papéis de banco (`SPEC.md` §6), do mais ao menos privilegiado:

| Papel | Quem | Pode | Não pode |
|-------|------|------|----------|
| `cockpit_admin` | DBA / engenharia de dados | DDL, ingestão, gerenciar papéis e `user_company_access`, ler tudo. | — (papel de plataforma; uso auditado). |
| `cockpit_analyst` | Analistas FP&A | Ler views/fatos do **seu escopo de empresas**, rodar consultas, disparar embeddings/RAG. | Alterar schema, conceder acessos, ler empresas fora do escopo. |
| `cockpit_executive` | C-level / diretoria | Ler **KPIs/dashboards** do seu escopo (pode ser um subconjunto de empresas), usar a caixa de IA. | Ver linha-a-linha sensível além do escopo; DDL; conceder acessos. |
| `cockpit_auditor` | Auditoria / compliance | **Somente leitura** de fatos, views e **trilhas de auditoria** (`ai_query_audit`, `ingestion_log`, `pipeline_runs`). | Escrever/alterar qualquer dado. |

Princípio: **menor privilégio**. Pessoas recebem o papel; empresas visíveis vêm da tabela de acesso.

---

## 2. RLS por empresa (Row-Level Security)

`fact_financials` tem **RLS habilitada**; a visibilidade por empresa é decidida em
`cockpit.user_company_access(role_name, company_id)` (`SPEC.md` §6). Executivos podem ser
**escopados a um subconjunto** de empresas (ex.: um diretor só vê `AUR-VAR` e `AUR-LOG`).

Esboço (a forma canônica está em `db/rbac.sql`):

```sql
-- Mapeia papel -> empresas que ele pode ver
CREATE TABLE IF NOT EXISTS cockpit.user_company_access (
  role_name  text NOT NULL,
  company_id text NOT NULL REFERENCES cockpit.dim_company(company_id),
  PRIMARY KEY (role_name, company_id)
);

ALTER TABLE cockpit.fact_financials ENABLE ROW LEVEL SECURITY;

-- Cada sessão enxerga apenas empresas liberadas para o papel corrente
CREATE POLICY rls_fact_por_empresa ON cockpit.fact_financials
  USING (
    company_id IN (
      SELECT uca.company_id
      FROM cockpit.user_company_access uca
      WHERE uca.role_name = current_user        -- ou current_setting('cockpit.role')
    )
  );

-- admin/auditor: política de leitura ampla (auditor é read-only; admin é plataforma)
-- (definida em db/rbac.sql com BYPASSRLS apenas para cockpit_admin)
```

Regras:
- **Toda** consulta a `fact_financials` (e às views que dela derivam) respeita o escopo do papel.
- `cockpit_admin` pode usar `BYPASSRLS` (uso restrito e auditado).
- `cockpit_auditor` lê fatos para auditoria, mas é **read-only** via GRANTs (sem `INSERT/UPDATE/DELETE`).
- O consolidado mostrado a um executivo escopado reflete **apenas** suas empresas (a consolidação a
  jusante respeita a RLS), evitando vazamento por agregação.

---

## 3. GRANTs (resumo)

Definidos em `db/rbac.sql`. Diretrizes:

| Objeto | `admin` | `analyst` | `executive` | `auditor` |
|--------|:------:|:--------:|:----------:|:--------:|
| DDL / schema | ✓ | ✗ | ✗ | ✗ |
| `dim_*` (SELECT) | ✓ | ✓ | ✓ | ✓ |
| `fact_financials` (SELECT, com RLS) | ✓ | ✓* | ✓* | ✓* |
| `fact_financials` (INSERT/UPSERT) | ✓ | ✗ | ✗ | ✗ |
| `stg_*`, `quarantine_rows`, `pipeline_runs`, `ingestion_log` | ✓ | leitura | ✗ | leitura |
| views de KPI (SELECT, com RLS) | ✓ | ✓* | ✓* | ✓* |
| `kb_*` (RAG) | ✓ | leitura/escrita | leitura | leitura |
| `ai_query_audit` (SELECT) | ✓ | próprio | próprio | ✓ (todos) |
| `user_company_access` (escrita) | ✓ | ✗ | ✗ | ✗ |

`*` limitado ao escopo de empresas do papel (RLS).

---

## 4. Trilha de auditoria

| Trilha | Tabela | O que registra |
|--------|--------|----------------|
| Ingestão | `cockpit.pipeline_runs`, `cockpit.ingestion_log` | Quem/quando/como cada carga rodou, contadores, retries, erros. |
| Qualidade | `cockpit.quarantine_rows` | Cada linha rejeitada, com payload cru e motivo (`error_code`, `error_detail`). |
| Consultas de IA | `cockpit.ai_query_audit` | Papel, pergunta, documentos usados, resposta, modelo, tokens, `latency_ms`. |

Boas práticas:
- Tabelas de auditoria são **append-only** na prática (sem `UPDATE/DELETE` por papéis de aplicação).
- `cockpit_auditor` tem leitura total das trilhas; demais papéis veem apenas o próprio rastro.
- Carimbos sempre em `timestamptz`.

---

## 5. LGPD — privacidade e proteção de dados

O cockpit lida com **dados financeiros agregados por empresa-mês** — naturalmente de baixa
exposição a PII. Ainda assim, aplicamos os princípios da LGPD:

### 5.1 Minimização de dados
- O modelo analítico (`fact_financials`) guarda **valores agregados por conta/empresa/mês**, **sem**
  dados de pessoas (clientes, funcionários, fornecedores nominais). Nada de CPF, nome, salário
  individual ou transação identificável.
- `DESP_PESSOAL` é um **total de folha**, não registros por colaborador.
- Na Fase 3 (ERP), o **conector** deve agregar na origem e **não** trazer PII para o staging.

### 5.2 Tratamento de PII / anonimização
- Se uma fonte trouxer campos pessoais, eles **não** entram em `fact_financials`; ficam (se
  necessário) apenas em `stg_financials`/`quarantine_rows` temporários e devem ser
  **anonimizados/pseudonimizados** ou descartados após o processamento.
- Em `ai_query_audit`, a coluna `question` pode conter texto livre do usuário: orientar usuários a
  **não** inserir PII; opcionalmente aplicar _masking_ antes de persistir.
- Nomes de empresas do grupo são **dados de pessoa jurídica** (não PII de pessoa física); a marca é
  inclusive um **placeholder** (`is_placeholder_brand: true`).

### 5.3 Base legal, finalidade e acesso
- **Finalidade:** gestão financeira/consolidação do próprio grupo (legítimo interesse / execução de
  contrato). Uso restrito a esse fim.
- **Controle de acesso:** RBAC + RLS (§1–§2) garantem que cada pessoa só vê o que sua função exige.
- **Segregação por empresa:** `user_company_access` impede acesso cruzado indevido.

### 5.4 Auditoria e rastreabilidade (responsabilização)
- Todas as consultas de IA e cargas ficam auditadas (§4), permitindo demonstrar **quem acessou o
  quê e quando** — princípio de _accountability_ da LGPD.

### 5.5 Retenção e descarte
- **Dados financeiros (`fact_financials`, views):** retidos pelo período fiscal/contábil exigido.
- **Staging (`stg_financials`):** efêmero — pode ser truncado após carga bem-sucedida.
- **Quarentena (`quarantine_rows`):** retida o necessário para correção; expurgar periodicamente.
- **Telemetria/auditoria (`pipeline_runs`, `ingestion_log`, `ai_query_audit`):** retenção definida
  por política (ex.: 12–24 meses), depois arquivar/expurgar.
- Implementar rotina de expurgo (job agendado) coerente com a política de retenção.

### 5.6 Segurança técnica
- **Em trânsito:** TLS para API Anthropic, webhook do n8n e conexões ao banco quando expostas.
- **Em repouso:** controle de acesso ao host/cluster; backups protegidos (ver runbook §10).
- **Segredos:** `ANTHROPIC_API_KEY`, `PGPASSWORD` etc. **fora do código** — via `rag/.env`
  (não versionado) e credenciais do n8n. Use `.env.example` como gabarito sem valores reais.
- **Princípio de menor privilégio** em todos os GRANTs (§3).

### 5.7 Direitos dos titulares
- Como o cockpit é agregado e sem PII de pessoa física, pedidos de titulares (acesso, correção,
  exclusão) normalmente se resolvem nos **sistemas-fonte** (ERP/RH), não aqui. Caso PII chegue
  indevidamente, o fluxo de anonimização/descarte (§5.2) e a auditoria (§4) suportam o atendimento.

---

## 6. Checklist de segurança (operacional)

- [ ] Papéis `cockpit_admin/analyst/executive/auditor` criados (`db/rbac.sql`).
- [ ] RLS **habilitada** em `fact_financials` e políticas testadas por papel.
- [ ] `user_company_access` populado conforme o escopo real de cada executivo/analista.
- [ ] GRANTs aplicados no princípio de menor privilégio; `auditor` é read-only.
- [ ] Segredos fora do versionamento (`.env` ignorado; só `.env.example` no repo).
- [ ] Trilhas de auditoria ativas e legíveis pelo `auditor`.
- [ ] Política de retenção/expurgo agendada.
- [ ] TLS nas conexões expostas (API, webhook, banco remoto).
- [ ] Conector da Fase 3 agrega na origem e **não** traz PII para o staging.
