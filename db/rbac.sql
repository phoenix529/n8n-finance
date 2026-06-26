-- =============================================================================
-- Cockpit Financeiro Estratégico — Grupo Aurora
-- RBAC + Row-Level Security (PostgreSQL 16)
-- -----------------------------------------------------------------------------
-- Fonte canônica: SPEC.md (seção 6 — RBAC; seção 9 — file layout).
-- Cria os quatro papéis, concede privilégios, define cockpit.user_company_access
-- e aplica RLS em cockpit.fact_financials limitando executivos às suas empresas.
-- Idempotente: usa DO-blocks com IF NOT EXISTS e CREATE POLICY guardado.
-- Pré-requisito: db/schema.sql já aplicado (schema cockpit + tabelas existem).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 0. Papéis (roles)
-- -----------------------------------------------------------------------------
-- cockpit_admin     : DBA da aplicação. Acesso total ao schema cockpit (DDL/DML),
--                     gerencia cargas, RBAC e RLS. NOINHERIT explícito não usado:
--                     herda para facilitar operação. BYPASSRLS para administração.
-- cockpit_analyst   : Analista de FP&A. Lê tudo (todas as empresas), escreve em
--                     staging/quarentena/logs e nas tabelas de fato/RAG. Não altera
--                     estrutura nem RBAC. NÃO sofre RLS (precisa do panorama completo).
-- cockpit_executive : Executivo. SOMENTE leitura, e RESTRITO às empresas concedidas
--                     em user_company_access via RLS em fact_financials.
-- cockpit_auditor   : Auditoria/compliance. SOMENTE leitura de TUDO, incluindo as
--                     tabelas de auditoria/log (ai_query_audit, ingestion_log,
--                     pipeline_runs, quarantine_rows). Não sofre RLS (visão integral
--                     para auditar), mas não pode escrever nada.
-- -----------------------------------------------------------------------------
-- Observação: estes são "group roles" (NOLOGIN). Usuários reais (LOGIN) recebem
-- estes papéis com GRANT <role> TO <usuario>;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cockpit_admin') THEN
        CREATE ROLE cockpit_admin NOLOGIN BYPASSRLS;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cockpit_analyst') THEN
        CREATE ROLE cockpit_analyst NOLOGIN;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cockpit_executive') THEN
        CREATE ROLE cockpit_executive NOLOGIN;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cockpit_auditor') THEN
        CREATE ROLE cockpit_auditor NOLOGIN;
    END IF;
END
$$;

COMMENT ON ROLE cockpit_admin     IS 'DBA da aplicação: DDL/DML completos no schema cockpit, gerencia cargas e RBAC. BYPASSRLS.';
COMMENT ON ROLE cockpit_analyst   IS 'FP&A: leitura total + escrita em fato/staging/RAG/logs. Sem RLS (panorama completo). Sem DDL.';
COMMENT ON ROLE cockpit_executive IS 'Executivo: somente leitura, restrito às empresas concedidas em user_company_access (via RLS).';
COMMENT ON ROLE cockpit_auditor   IS 'Auditoria: somente leitura de tudo, inclusive trilhas de auditoria/log. Sem RLS, sem escrita.';

-- -----------------------------------------------------------------------------
-- 1. Tabela de escopo por empresa (usada pela RLS)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cockpit.user_company_access (
    role_name   text    NOT NULL,
    company_id  text    NOT NULL REFERENCES cockpit.dim_company(company_id),
    created_at  timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT pk_user_company_access PRIMARY KEY (role_name, company_id)
);

COMMENT ON TABLE  cockpit.user_company_access IS
  'Escopo de empresas por papel/usuário (role_name). Usada pela RLS de fact_financials para limitar executivos.';
COMMENT ON COLUMN cockpit.user_company_access.role_name  IS 'Nome do papel/usuário do Postgres (current_user) com acesso à empresa.';
COMMENT ON COLUMN cockpit.user_company_access.company_id IS 'Empresa que o papel/usuário pode visualizar.';

-- -----------------------------------------------------------------------------
-- 2. Privilégios de schema e USAGE
-- -----------------------------------------------------------------------------
GRANT USAGE ON SCHEMA cockpit TO cockpit_admin, cockpit_analyst, cockpit_executive, cockpit_auditor;

-- 2.1 cockpit_admin — controle total do schema cockpit.
GRANT ALL PRIVILEGES ON ALL TABLES    IN SCHEMA cockpit TO cockpit_admin;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA cockpit TO cockpit_admin;
GRANT CREATE ON SCHEMA cockpit TO cockpit_admin;

-- 2.2 cockpit_analyst — leitura total + escrita (sem DDL).
GRANT SELECT ON ALL TABLES IN SCHEMA cockpit TO cockpit_analyst;
GRANT INSERT, UPDATE, DELETE ON
    cockpit.fact_financials,
    cockpit.stg_financials,
    cockpit.quarantine_rows,
    cockpit.pipeline_runs,
    cockpit.ingestion_log,
    cockpit.kb_documents,
    cockpit.kb_embeddings,
    cockpit.ai_query_audit
TO cockpit_analyst;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA cockpit TO cockpit_analyst;

-- 2.3 cockpit_executive — somente leitura (RLS restringe linhas de fato).
GRANT SELECT ON ALL TABLES IN SCHEMA cockpit TO cockpit_executive;
-- O executivo pode registrar perguntas de IA (insert na auditoria), nada mais.
GRANT INSERT ON cockpit.ai_query_audit TO cockpit_executive;
GRANT USAGE  ON SEQUENCE cockpit.ai_query_audit_id_seq TO cockpit_executive;

-- 2.4 cockpit_auditor — somente leitura de tudo (inclui trilhas de auditoria).
GRANT SELECT ON ALL TABLES IN SCHEMA cockpit TO cockpit_auditor;

-- -----------------------------------------------------------------------------
-- 3. Privilégios padrão para objetos FUTUROS (views/tabelas criadas depois)
-- -----------------------------------------------------------------------------
-- Garante que novas tabelas/views herdem os GRANTs corretos sem reexecução manual.
ALTER DEFAULT PRIVILEGES IN SCHEMA cockpit
    GRANT SELECT ON TABLES TO cockpit_analyst, cockpit_executive, cockpit_auditor;
ALTER DEFAULT PRIVILEGES IN SCHEMA cockpit
    GRANT ALL ON TABLES TO cockpit_admin;
ALTER DEFAULT PRIVILEGES IN SCHEMA cockpit
    GRANT ALL ON SEQUENCES TO cockpit_admin;

-- -----------------------------------------------------------------------------
-- 4. Row-Level Security em cockpit.fact_financials
-- -----------------------------------------------------------------------------
-- Liga RLS. FORCE garante que a política também se aplique ao DONO da tabela
-- (exceto papéis com BYPASSRLS, como cockpit_admin).
ALTER TABLE cockpit.fact_financials ENABLE ROW LEVEL SECURITY;
ALTER TABLE cockpit.fact_financials FORCE ROW LEVEL SECURITY;

-- 4.1 Política para EXECUTIVOS: só veem linhas das empresas concedidas.
-- A checagem casa current_user contra user_company_access.role_name.
DROP POLICY IF EXISTS rls_exec_company_scope ON cockpit.fact_financials;
CREATE POLICY rls_exec_company_scope
    ON cockpit.fact_financials
    FOR SELECT
    TO cockpit_executive
    USING (
        EXISTS (
            SELECT 1
            FROM cockpit.user_company_access uca
            WHERE uca.role_name  = current_user
              AND uca.company_id = cockpit.fact_financials.company_id
        )
    );

COMMENT ON POLICY rls_exec_company_scope ON cockpit.fact_financials IS
  'Executivos só leem fatos das empresas listadas em user_company_access para o seu usuário (current_user).';

-- 4.2 Política para ANALISTAS: leitura de todas as empresas (panorama completo).
DROP POLICY IF EXISTS rls_analyst_all ON cockpit.fact_financials;
CREATE POLICY rls_analyst_all
    ON cockpit.fact_financials
    FOR SELECT
    TO cockpit_analyst
    USING (true);

COMMENT ON POLICY rls_analyst_all ON cockpit.fact_financials IS
  'Analistas (FP&A) leem todas as empresas — necessário para consolidação.';

-- 4.3 Política de ESCRITA para ANALISTAS (INSERT/UPDATE/DELETE em todas as empresas).
DROP POLICY IF EXISTS rls_analyst_write ON cockpit.fact_financials;
CREATE POLICY rls_analyst_write
    ON cockpit.fact_financials
    FOR ALL
    TO cockpit_analyst
    USING (true)
    WITH CHECK (true);

COMMENT ON POLICY rls_analyst_write ON cockpit.fact_financials IS
  'Analistas podem inserir/atualizar/excluir fatos de qualquer empresa (carga e correções).';

-- 4.4 Política para AUDITORES: leitura integral (auditoria precisa ver tudo).
DROP POLICY IF EXISTS rls_auditor_all ON cockpit.fact_financials;
CREATE POLICY rls_auditor_all
    ON cockpit.fact_financials
    FOR SELECT
    TO cockpit_auditor
    USING (true);

COMMENT ON POLICY rls_auditor_all ON cockpit.fact_financials IS
  'Auditores leem todas as empresas (visão integral para compliance), sem direito de escrita.';

-- Nota: cockpit_admin possui BYPASSRLS, portanto não é afetado pelas políticas acima.

-- -----------------------------------------------------------------------------
-- 5. Exemplos de provisionamento de usuários reais (comentado — ajustar em produção)
-- -----------------------------------------------------------------------------
-- Criação de um executivo restrito a Varejo + Indústria:
--
--   CREATE ROLE maria_exec LOGIN PASSWORD 'TROCAR_ME';
--   GRANT cockpit_executive TO maria_exec;
--   INSERT INTO cockpit.user_company_access (role_name, company_id)
--   VALUES ('maria_exec','AUR-VAR'), ('maria_exec','AUR-IND')
--   ON CONFLICT (role_name, company_id) DO NOTHING;
--
-- Como a política casa contra current_user, o escopo é por USUÁRIO. Para conceder
-- a TODOS os executivos um conjunto fixo de empresas, use role_name = 'cockpit_executive'
-- E ajuste a política para também considerar pg_has_role; mantemos o modelo por
-- usuário por ser mais seguro (menor privilégio).
--
-- Analista, auditor e admin de exemplo:
--   CREATE ROLE joao_fpa  LOGIN PASSWORD 'TROCAR_ME'; GRANT cockpit_analyst   TO joao_fpa;
--   CREATE ROLE ana_audit LOGIN PASSWORD 'TROCAR_ME'; GRANT cockpit_auditor   TO ana_audit;
--   CREATE ROLE dba_cockpit LOGIN PASSWORD 'TROCAR_ME'; GRANT cockpit_admin   TO dba_cockpit;

-- Fim de rbac.sql
