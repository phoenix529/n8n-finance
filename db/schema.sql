-- =============================================================================
-- Cockpit Financeiro Estratégico — Grupo Aurora
-- Camada de banco de dados: SCHEMA + tabelas + extensões + views (KPIs)
-- PostgreSQL 16 + pgvector
-- -----------------------------------------------------------------------------
-- Fonte canônica: SPEC.md (seções 2, 3, 4, 5, 6).
-- Convenções de sinal: RECEITA bruta é positiva; DEDUCOES, CMV, despesas (OPEX),
-- DEPRECIACAO e IRPJ_CSLL são armazenadas como números NEGATIVOS; RESULT_FIN pode
-- ser positivo ou negativo. Contas de POSICAO são sempre positivas.
-- Todos os valores monetários: numeric(18,2).
-- Idempotente: pode ser executado repetidamente sem erro (IF NOT EXISTS / DROP VIEW IF EXISTS).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 0. Schema + extensões
-- -----------------------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS cockpit;

-- pgvector para a camada RAG (embeddings de 1536 dimensões).
CREATE EXTENSION IF NOT EXISTS vector;

COMMENT ON SCHEMA cockpit IS
  'Cockpit Financeiro Estratégico do Grupo Aurora: dimensões, fatos, staging/quarentena, '
  'logs de pipeline, base de conhecimento RAG (pgvector) e auditoria de IA.';

-- =============================================================================
-- 1. DIMENSÕES
-- =============================================================================

-- 1.1 dim_company — perímetro de consolidação (SPEC seção 2)
CREATE TABLE IF NOT EXISTS cockpit.dim_company (
    company_id        text        PRIMARY KEY,
    name              text        NOT NULL,
    sector            text        NOT NULL,
    color             text        NOT NULL,
    is_consolidating  boolean     NOT NULL DEFAULT true,
    sort              integer     NOT NULL DEFAULT 0
);

COMMENT ON TABLE  cockpit.dim_company IS
  'Empresas do grupo (perímetro de consolidação). company_id é a chave estável usada em todo o sistema.';
COMMENT ON COLUMN cockpit.dim_company.company_id       IS 'Chave estável da empresa (ex.: AUR-VAR). Não reutilizar.';
COMMENT ON COLUMN cockpit.dim_company.is_consolidating IS 'Se TRUE, entra na soma consolidada. ELIM existe para eliminações intercompany.';
COMMENT ON COLUMN cockpit.dim_company.color            IS 'Cor hex de marca para o dashboard.';
COMMENT ON COLUMN cockpit.dim_company.sort             IS 'Ordem de exibição no dashboard.';

-- 1.2 dim_account — plano de contas (contas-folha; subtotais são DERIVADOS) (SPEC seção 3)
CREATE TABLE IF NOT EXISTS cockpit.dim_account (
    account_code  text     PRIMARY KEY,
    account_name  text     NOT NULL,
    account_kind  text     NOT NULL CHECK (account_kind IN ('PNL','POSICAO')),
    group_code    text     NOT NULL,
    sign          smallint NOT NULL CHECK (sign IN (-1, 0, 1)),
    sort          integer  NOT NULL DEFAULT 0
);

COMMENT ON TABLE  cockpit.dim_account IS
  'Plano de contas — apenas contas-folha. Subtotais (Receita Líquida, EBITDA etc.) são derivados nas views.';
COMMENT ON COLUMN cockpit.dim_account.account_kind IS 'PNL = conta de fluxo mensal (DRE); POSICAO = saldo de fim de mês (balanço).';
COMMENT ON COLUMN cockpit.dim_account.group_code   IS 'Agrupamento lógico (RECEITA, CUSTO, OPEX, DA, FINANC, IMPOSTO, POSICAO).';
COMMENT ON COLUMN cockpit.dim_account.sign         IS 'Convenção esperada do sinal: +1 positivo, -1 negativo, 0 misto (RESULT_FIN).';

-- =============================================================================
-- 2. FATO
-- =============================================================================

-- 2.1 fact_financials — fato financeiro mensal por empresa/conta (SPEC seção 6)
CREATE TABLE IF NOT EXISTS cockpit.fact_financials (
    id               bigint        GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    company_id       text          NOT NULL REFERENCES cockpit.dim_company(company_id),
    period_date      date          NOT NULL,
    account_code     text          NOT NULL REFERENCES cockpit.dim_account(account_code),
    valor_realizado  numeric(18,2) NOT NULL DEFAULT 0,
    valor_orcado     numeric(18,2) NOT NULL DEFAULT 0,
    source_file      text,
    load_id          text,
    created_at       timestamptz   NOT NULL DEFAULT now(),
    CONSTRAINT uq_fact_company_period_account UNIQUE (company_id, period_date, account_code)
);

COMMENT ON TABLE  cockpit.fact_financials IS
  'Fato financeiro: um valor realizado e um valor orçado por empresa, mês (primeiro dia) e conta-folha.';
COMMENT ON COLUMN cockpit.fact_financials.period_date     IS 'Primeiro dia do mês (grão mensal). Ex.: 2026-05-01.';
COMMENT ON COLUMN cockpit.fact_financials.valor_realizado IS 'Valor realizado, com convenção de sinal de dim_account. numeric(18,2).';
COMMENT ON COLUMN cockpit.fact_financials.valor_orcado    IS 'Valor orçado (mesma convenção de sinal), para Orçado vs Realizado.';
COMMENT ON COLUMN cockpit.fact_financials.load_id         IS 'Correlaciona com pipeline_runs.load_id (rastreabilidade de carga).';

CREATE INDEX IF NOT EXISTS ix_fact_period           ON cockpit.fact_financials (period_date);
CREATE INDEX IF NOT EXISTS ix_fact_company_period   ON cockpit.fact_financials (company_id, period_date);
CREATE INDEX IF NOT EXISTS ix_fact_account_period   ON cockpit.fact_financials (account_code, period_date);
CREATE INDEX IF NOT EXISTS ix_fact_load_id          ON cockpit.fact_financials (load_id);

-- =============================================================================
-- 3. INGESTÃO / CONFIABILIDADE (Fase 1)
-- =============================================================================

-- 3.1 stg_financials — espelho cru das linhas de planilha (tudo texto)
CREATE TABLE IF NOT EXISTS cockpit.stg_financials (
    id               bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    load_id          text,
    source_file      text,
    row_num          integer,
    company_id       text,
    period_date      text,
    account_code     text,
    valor_realizado  text,
    valor_orcado     text,
    raw_payload      jsonb,
    created_at       timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE cockpit.stg_financials IS
  'Staging cru: espelho fiel das linhas recebidas da planilha (todos os campos como texto) antes de validação/cast.';

CREATE INDEX IF NOT EXISTS ix_stg_load_id ON cockpit.stg_financials (load_id);

-- 3.2 quarantine_rows — linhas rejeitadas com motivo
CREATE TABLE IF NOT EXISTS cockpit.quarantine_rows (
    id            bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    load_id       text,
    source_file   text,
    row_num       integer,
    raw_payload   jsonb,
    error_code    text,
    error_detail  text,
    created_at    timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE  cockpit.quarantine_rows IS
  'Linhas que falharam na validação durante a ingestão, com payload original e código/detalhe do erro.';
COMMENT ON COLUMN cockpit.quarantine_rows.error_code IS 'Código curto do erro (ex.: BAD_COMPANY, BAD_ACCOUNT, BAD_NUMBER, DUP_KEY).';

CREATE INDEX IF NOT EXISTS ix_quarantine_load_id ON cockpit.quarantine_rows (load_id);

-- 3.3 pipeline_runs — uma linha por execução de carga
CREATE TABLE IF NOT EXISTS cockpit.pipeline_runs (
    load_id           text        PRIMARY KEY,
    workflow          text        NOT NULL,
    source_file       text,
    status            text        NOT NULL DEFAULT 'RUNNING'
                                  CHECK (status IN ('RUNNING','OK','PARTIAL','ERROR')),
    rows_total        integer     NOT NULL DEFAULT 0,
    rows_ok           integer     NOT NULL DEFAULT 0,
    rows_quarantined  integer     NOT NULL DEFAULT 0,
    started_at        timestamptz NOT NULL DEFAULT now(),
    finished_at       timestamptz,
    retries           integer     NOT NULL DEFAULT 0,
    message           text
);

COMMENT ON TABLE  cockpit.pipeline_runs IS
  'Cabeçalho de cada execução de pipeline de ingestão (load_id), com contagens e status final.';
COMMENT ON COLUMN cockpit.pipeline_runs.status IS 'RUNNING | OK (tudo carregado) | PARTIAL (com quarentena) | ERROR.';

-- 3.4 ingestion_log — log estruturado por passo
CREATE TABLE IF NOT EXISTS cockpit.ingestion_log (
    id          bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    load_id     text,
    level       text        NOT NULL DEFAULT 'INFO'
                            CHECK (level IN ('DEBUG','INFO','WARN','ERROR')),
    step        text,
    message     text,
    payload     jsonb,
    created_at  timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE cockpit.ingestion_log IS
  'Log estruturado dos passos da ingestão (correlacionado por load_id) para observabilidade e troubleshooting.';

CREATE INDEX IF NOT EXISTS ix_ingestion_log_load_id ON cockpit.ingestion_log (load_id);

-- =============================================================================
-- 4. RAG / pgvector (Fase 2)
-- =============================================================================

-- 4.1 kb_documents — chunks narrativos ("fatos" em PT-BR) para recuperação
CREATE TABLE IF NOT EXISTS cockpit.kb_documents (
    id          bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    doc_type    text        NOT NULL,
    company_id  text        REFERENCES cockpit.dim_company(company_id),
    period_date date,
    title       text,
    content     text        NOT NULL,
    metadata    jsonb       NOT NULL DEFAULT '{}'::jsonb,
    created_at  timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE  cockpit.kb_documents IS
  'Base de conhecimento RAG: uma linha por narrativa de fato (ex.: "EBITDA da Aurora Varejo em 2026-05 foi R$ ...").';
COMMENT ON COLUMN cockpit.kb_documents.doc_type IS 'Tipo do chunk (ex.: dre_empresa, kpi_consolidado, posicao, orcado_vs_realizado).';
COMMENT ON COLUMN cockpit.kb_documents.content  IS 'Texto narrativo em PT-BR que será embeddado e usado como contexto.';

CREATE INDEX IF NOT EXISTS ix_kb_documents_company_period ON cockpit.kb_documents (company_id, period_date);
CREATE INDEX IF NOT EXISTS ix_kb_documents_doc_type       ON cockpit.kb_documents (doc_type);

-- 4.2 kb_embeddings — vetor 1536-dim por documento + índice ivfflat (cosine)
CREATE TABLE IF NOT EXISTS cockpit.kb_embeddings (
    id          bigint        GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    doc_id      bigint        NOT NULL REFERENCES cockpit.kb_documents(id) ON DELETE CASCADE,
    embedding   vector(1536)  NOT NULL,
    model       text          NOT NULL,
    created_at  timestamptz   NOT NULL DEFAULT now()
);

COMMENT ON TABLE  cockpit.kb_embeddings IS
  'Embeddings (vector 1536) dos documentos da base de conhecimento. Recuperação por similaridade de cosseno.';
COMMENT ON COLUMN cockpit.kb_embeddings.model IS 'Identificador do modelo de embedding usado (EMBED_MODEL).';

-- Índice IVFFlat para busca por similaridade de cosseno (vector_cosine_ops).
-- Observação: IVFFlat exige dados para "treinar" as listas; após carga inicial,
-- rode "ANALYZE cockpit.kb_embeddings;" e, se necessário, recrie o índice.
CREATE INDEX IF NOT EXISTS ix_kb_embeddings_cosine
    ON cockpit.kb_embeddings
    USING ivfflat (embedding vector_cosine_ops)
    WITH (lists = 100);

CREATE INDEX IF NOT EXISTS ix_kb_embeddings_doc_id ON cockpit.kb_embeddings (doc_id);

-- 4.3 ai_query_audit — auditoria de cada consulta de IA
CREATE TABLE IF NOT EXISTS cockpit.ai_query_audit (
    id                 bigint       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_role          text,
    question           text         NOT NULL,
    retrieved_doc_ids  integer[],
    answer             text,
    model              text,
    prompt_tokens      integer,
    completion_tokens  integer,
    latency_ms         integer,
    created_at         timestamptz  NOT NULL DEFAULT now()
);

COMMENT ON TABLE  cockpit.ai_query_audit IS
  'Trilha de auditoria das perguntas em linguagem natural ao cockpit: papel, pergunta, docs recuperados, resposta, tokens e latência.';
COMMENT ON COLUMN cockpit.ai_query_audit.retrieved_doc_ids IS 'IDs de kb_documents usados como contexto (grounding).';

-- =============================================================================
-- 5. VIEWS DE CONSOLIDAÇÃO / KPI (SPEC seção 6, fórmulas da seção 4)
-- -----------------------------------------------------------------------------
-- Convenção: as contas-folha já carregam o sinal correto (despesas negativas),
-- então as fórmulas usam SOMA simples. LTM = 12 meses terminando no
-- last_closed_period (2026-05-01).
-- =============================================================================

DROP VIEW IF EXISTS cockpit.v_budget_vs_actual       CASCADE;
DROP VIEW IF EXISTS cockpit.v_kpi_consolidado_ltm     CASCADE;
DROP VIEW IF EXISTS cockpit.v_position_company_month   CASCADE;
DROP VIEW IF EXISTS cockpit.v_pnl_consolidado_month    CASCADE;
DROP VIEW IF EXISTS cockpit.v_pnl_company_month        CASCADE;

-- -----------------------------------------------------------------------------
-- 5.1 v_pnl_company_month — DRE derivada por empresa-mês
-- -----------------------------------------------------------------------------
CREATE VIEW cockpit.v_pnl_company_month AS
WITH base AS (
    SELECT
        f.company_id,
        f.period_date,
        SUM(f.valor_realizado) FILTER (WHERE f.account_code = 'R_BRUTA')      AS r_bruta,
        SUM(f.valor_realizado) FILTER (WHERE f.account_code = 'DEDUCOES')     AS deducoes,
        SUM(f.valor_realizado) FILTER (WHERE f.account_code = 'CMV')          AS cmv,
        SUM(f.valor_realizado) FILTER (WHERE f.account_code = 'DESP_PESSOAL') AS desp_pessoal,
        SUM(f.valor_realizado) FILTER (WHERE f.account_code = 'DESP_VENDAS')  AS desp_vendas,
        SUM(f.valor_realizado) FILTER (WHERE f.account_code = 'DESP_ADM')     AS desp_adm,
        SUM(f.valor_realizado) FILTER (WHERE f.account_code = 'DESP_OUTRAS')  AS desp_outras,
        SUM(f.valor_realizado) FILTER (WHERE f.account_code = 'DEPRECIACAO')  AS depreciacao,
        SUM(f.valor_realizado) FILTER (WHERE f.account_code = 'RESULT_FIN')   AS result_fin,
        SUM(f.valor_realizado) FILTER (WHERE f.account_code = 'IRPJ_CSLL')    AS irpj_csll
    FROM cockpit.fact_financials f
    JOIN cockpit.dim_account a ON a.account_code = f.account_code
    WHERE a.account_kind = 'PNL'
    GROUP BY f.company_id, f.period_date
),
calc AS (
    SELECT
        b.company_id,
        b.period_date,
        COALESCE(b.r_bruta,0)                                       AS receita_bruta,
        COALESCE(b.deducoes,0)                                      AS deducoes,
        COALESCE(b.cmv,0)                                           AS cmv,
        COALESCE(b.desp_pessoal,0)                                  AS desp_pessoal,
        COALESCE(b.desp_vendas,0)                                   AS desp_vendas,
        COALESCE(b.desp_adm,0)                                      AS desp_adm,
        COALESCE(b.desp_outras,0)                                   AS desp_outras,
        COALESCE(b.depreciacao,0)                                   AS depreciacao,
        COALESCE(b.result_fin,0)                                    AS result_fin,
        COALESCE(b.irpj_csll,0)                                     AS irpj_csll,
        -- receita_liquida = R_BRUTA + DEDUCOES  (DEDUCOES é negativa)
        (COALESCE(b.r_bruta,0) + COALESCE(b.deducoes,0))            AS receita_liquida
    FROM base b
)
SELECT
    c.company_id,
    c.period_date,
    c.receita_bruta,
    c.receita_liquida,
    -- lucro_bruto = receita_liquida + CMV
    (c.receita_liquida + c.cmv)                                                          AS lucro_bruto,
    -- ebitda = lucro_bruto + DESP_PESSOAL + DESP_VENDAS + DESP_ADM + DESP_OUTRAS
    (c.receita_liquida + c.cmv
        + c.desp_pessoal + c.desp_vendas + c.desp_adm + c.desp_outras)                   AS ebitda,
    -- ebit = ebitda + DEPRECIACAO
    (c.receita_liquida + c.cmv
        + c.desp_pessoal + c.desp_vendas + c.desp_adm + c.desp_outras
        + c.depreciacao)                                                                 AS ebit,
    -- lucro_liquido = ebit + RESULT_FIN + IRPJ_CSLL
    (c.receita_liquida + c.cmv
        + c.desp_pessoal + c.desp_vendas + c.desp_adm + c.desp_outras
        + c.depreciacao + c.result_fin + c.irpj_csll)                                    AS lucro_liquido,
    -- margens (proteção contra divisão por zero)
    CASE WHEN c.receita_liquida <> 0
         THEN ROUND((c.receita_liquida + c.cmv) / c.receita_liquida * 100, 2) END        AS margem_bruta_pct,
    CASE WHEN c.receita_liquida <> 0
         THEN ROUND((c.receita_liquida + c.cmv
                + c.desp_pessoal + c.desp_vendas + c.desp_adm + c.desp_outras)
                / c.receita_liquida * 100, 2) END                                        AS margem_ebitda_pct,
    CASE WHEN c.receita_liquida <> 0
         THEN ROUND((c.receita_liquida + c.cmv
                + c.desp_pessoal + c.desp_vendas + c.desp_adm + c.desp_outras
                + c.depreciacao + c.result_fin + c.irpj_csll)
                / c.receita_liquida * 100, 2) END                                        AS margem_liquida_pct
FROM calc c;

COMMENT ON VIEW cockpit.v_pnl_company_month IS
  'DRE derivada por empresa-mês: receita líquida, lucro bruto, EBITDA, EBIT, lucro líquido e margens (SPEC seção 4).';

-- -----------------------------------------------------------------------------
-- 5.2 v_pnl_consolidado_month — consolidado (soma das empresas) por mês
-- -----------------------------------------------------------------------------
-- Consolida somando as contas-folha primeiro (das empresas que consolidam) e
-- então derivando — garante margens corretas no consolidado.
CREATE VIEW cockpit.v_pnl_consolidado_month AS
WITH base AS (
    SELECT
        f.period_date,
        SUM(f.valor_realizado) FILTER (WHERE f.account_code = 'R_BRUTA')      AS r_bruta,
        SUM(f.valor_realizado) FILTER (WHERE f.account_code = 'DEDUCOES')     AS deducoes,
        SUM(f.valor_realizado) FILTER (WHERE f.account_code = 'CMV')          AS cmv,
        SUM(f.valor_realizado) FILTER (WHERE f.account_code = 'DESP_PESSOAL') AS desp_pessoal,
        SUM(f.valor_realizado) FILTER (WHERE f.account_code = 'DESP_VENDAS')  AS desp_vendas,
        SUM(f.valor_realizado) FILTER (WHERE f.account_code = 'DESP_ADM')     AS desp_adm,
        SUM(f.valor_realizado) FILTER (WHERE f.account_code = 'DESP_OUTRAS')  AS desp_outras,
        SUM(f.valor_realizado) FILTER (WHERE f.account_code = 'DEPRECIACAO')  AS depreciacao,
        SUM(f.valor_realizado) FILTER (WHERE f.account_code = 'RESULT_FIN')   AS result_fin,
        SUM(f.valor_realizado) FILTER (WHERE f.account_code = 'IRPJ_CSLL')    AS irpj_csll,
        -- agrega também o orçado para as séries do dashboard
        SUM(f.valor_orcado)    FILTER (WHERE f.account_code = 'R_BRUTA')      AS r_bruta_orc,
        SUM(f.valor_orcado)    FILTER (WHERE f.account_code = 'DEDUCOES')     AS deducoes_orc,
        SUM(f.valor_orcado)    FILTER (WHERE f.account_code = 'CMV')          AS cmv_orc,
        SUM(f.valor_orcado)    FILTER (WHERE f.account_code = 'DESP_PESSOAL') AS desp_pessoal_orc,
        SUM(f.valor_orcado)    FILTER (WHERE f.account_code = 'DESP_VENDAS')  AS desp_vendas_orc,
        SUM(f.valor_orcado)    FILTER (WHERE f.account_code = 'DESP_ADM')     AS desp_adm_orc,
        SUM(f.valor_orcado)    FILTER (WHERE f.account_code = 'DESP_OUTRAS')  AS desp_outras_orc
    FROM cockpit.fact_financials f
    JOIN cockpit.dim_account a ON a.account_code = f.account_code
    JOIN cockpit.dim_company c ON c.company_id   = f.company_id
    WHERE a.account_kind = 'PNL'
      AND c.is_consolidating = true
    GROUP BY f.period_date
),
calc AS (
    SELECT
        b.period_date,
        COALESCE(b.r_bruta,0)                                AS receita_bruta,
        (COALESCE(b.r_bruta,0) + COALESCE(b.deducoes,0))     AS receita_liquida,
        COALESCE(b.cmv,0)                                    AS cmv,
        COALESCE(b.desp_pessoal,0)                           AS desp_pessoal,
        COALESCE(b.desp_vendas,0)                            AS desp_vendas,
        COALESCE(b.desp_adm,0)                               AS desp_adm,
        COALESCE(b.desp_outras,0)                            AS desp_outras,
        COALESCE(b.depreciacao,0)                            AS depreciacao,
        COALESCE(b.result_fin,0)                             AS result_fin,
        COALESCE(b.irpj_csll,0)                              AS irpj_csll,
        -- receita orçada líquida e EBITDA orçado (para as séries)
        (COALESCE(b.r_bruta_orc,0) + COALESCE(b.deducoes_orc,0)) AS receita_orcada,
        (COALESCE(b.r_bruta_orc,0) + COALESCE(b.deducoes_orc,0)
            + COALESCE(b.cmv_orc,0)
            + COALESCE(b.desp_pessoal_orc,0) + COALESCE(b.desp_vendas_orc,0)
            + COALESCE(b.desp_adm_orc,0) + COALESCE(b.desp_outras_orc,0)) AS ebitda_orcado
    FROM base b
)
SELECT
    c.period_date,
    c.receita_bruta,
    c.receita_liquida,
    (c.receita_liquida + c.cmv)                                                          AS lucro_bruto,
    (c.receita_liquida + c.cmv
        + c.desp_pessoal + c.desp_vendas + c.desp_adm + c.desp_outras)                   AS ebitda,
    (c.receita_liquida + c.cmv
        + c.desp_pessoal + c.desp_vendas + c.desp_adm + c.desp_outras
        + c.depreciacao)                                                                 AS ebit,
    (c.receita_liquida + c.cmv
        + c.desp_pessoal + c.desp_vendas + c.desp_adm + c.desp_outras
        + c.depreciacao + c.result_fin + c.irpj_csll)                                    AS lucro_liquido,
    CASE WHEN c.receita_liquida <> 0
         THEN ROUND((c.receita_liquida + c.cmv) / c.receita_liquida * 100, 2) END        AS margem_bruta_pct,
    CASE WHEN c.receita_liquida <> 0
         THEN ROUND((c.receita_liquida + c.cmv
                + c.desp_pessoal + c.desp_vendas + c.desp_adm + c.desp_outras)
                / c.receita_liquida * 100, 2) END                                        AS margem_ebitda_pct,
    CASE WHEN c.receita_liquida <> 0
         THEN ROUND((c.receita_liquida + c.cmv
                + c.desp_pessoal + c.desp_vendas + c.desp_adm + c.desp_outras
                + c.depreciacao + c.result_fin + c.irpj_csll)
                / c.receita_liquida * 100, 2) END                                        AS margem_liquida_pct,
    c.receita_orcada,
    c.ebitda_orcado
FROM calc c;

COMMENT ON VIEW cockpit.v_pnl_consolidado_month IS
  'DRE consolidada por mês (soma das empresas que consolidam, contas-folha primeiro, depois derivada). Inclui receita_orcada e ebitda_orcado.';

-- -----------------------------------------------------------------------------
-- 5.3 v_position_company_month — contas de posição + KPIs de balanço
-- -----------------------------------------------------------------------------
CREATE VIEW cockpit.v_position_company_month AS
WITH base AS (
    SELECT
        f.company_id,
        f.period_date,
        SUM(f.valor_realizado) FILTER (WHERE f.account_code = 'CAIXA')      AS caixa,
        SUM(f.valor_realizado) FILTER (WHERE f.account_code = 'AR')         AS ar,
        SUM(f.valor_realizado) FILTER (WHERE f.account_code = 'AP')         AS ap,
        SUM(f.valor_realizado) FILTER (WHERE f.account_code = 'ESTOQUE')    AS estoque,
        SUM(f.valor_realizado) FILTER (WHERE f.account_code = 'DIVIDA')     AS divida,
        SUM(f.valor_realizado) FILTER (WHERE f.account_code = 'PATRIMONIO') AS patrimonio
    FROM cockpit.fact_financials f
    JOIN cockpit.dim_account a ON a.account_code = f.account_code
    WHERE a.account_kind = 'POSICAO'
    GROUP BY f.company_id, f.period_date
),
pos AS (
    SELECT
        b.company_id,
        b.period_date,
        COALESCE(b.caixa,0)      AS caixa,
        COALESCE(b.ar,0)         AS ar,
        COALESCE(b.ap,0)         AS ap,
        COALESCE(b.estoque,0)    AS estoque,
        COALESCE(b.divida,0)     AS divida,
        COALESCE(b.patrimonio,0) AS patrimonio
    FROM base b
),
-- receita bruta mensal por empresa (para DSO)
rb AS (
    SELECT f.company_id, f.period_date,
           SUM(f.valor_realizado) AS r_bruta
    FROM cockpit.fact_financials f
    WHERE f.account_code = 'R_BRUTA'
    GROUP BY f.company_id, f.period_date
)
SELECT
    p.company_id,
    p.period_date,
    p.caixa,
    p.ar,
    p.ap,
    p.estoque,
    p.divida,
    p.patrimonio,
    -- divida_liquida = DIVIDA - CAIXA
    (p.divida - p.caixa)                                                       AS divida_liquida,
    -- capital_giro = AR + ESTOQUE - AP
    (p.ar + p.estoque - p.ap)                                                  AS capital_giro,
    -- dso_dias = AR / R_BRUTA * 30
    CASE WHEN COALESCE(rb.r_bruta,0) <> 0
         THEN ROUND(p.ar / rb.r_bruta * 30, 1) END                            AS dso_dias,
    -- fluxo_caixa_mes = CAIXA(m) - CAIXA(m-1) (proxy de variação de caixa)
    (p.caixa - LAG(p.caixa) OVER (PARTITION BY p.company_id ORDER BY p.period_date))
                                                                              AS fluxo_caixa_mes
FROM pos p
LEFT JOIN rb ON rb.company_id = p.company_id AND rb.period_date = p.period_date;

COMMENT ON VIEW cockpit.v_position_company_month IS
  'Contas de posição por empresa-mês + dívida líquida, capital de giro, DSO e fluxo de caixa do mês (variação de caixa).';

-- -----------------------------------------------------------------------------
-- 5.4 v_kpi_consolidado_ltm — snapshot LTM consolidado mais recente
-- -----------------------------------------------------------------------------
-- LTM = 12 meses terminando no last_closed_period (2026-05-01).
-- Definimos o período de fechamento como o maior period_date que NÃO é o mês
-- parcial corrente (2026-06-01). Conforme SPEC seção 5, last_closed_period = 2026-05-01.
CREATE VIEW cockpit.v_kpi_consolidado_ltm AS
WITH params AS (
    -- last_closed_period = maior mês com pelo menos uma empresa, excluindo o mês corrente parcial.
    SELECT DATE '2026-05-01' AS last_closed_period
),
-- janela LTM: 12 meses terminando (inclusive) em last_closed_period
ltm_pnl AS (
    SELECT
        SUM(v.receita_liquida) AS receita_liquida_ltm,
        SUM(v.lucro_bruto)     AS lucro_bruto_ltm,
        SUM(v.ebitda)          AS ebitda_ltm,
        SUM(v.ebit)            AS ebit_ltm,
        SUM(v.lucro_liquido)   AS lucro_liquido_ltm
    FROM cockpit.v_pnl_consolidado_month v, params p
    WHERE v.period_date >  (p.last_closed_period - INTERVAL '12 months')
      AND v.period_date <= p.last_closed_period
),
-- P&L do mês de fechamento (consolidado)
mes_pnl AS (
    SELECT v.*
    FROM cockpit.v_pnl_consolidado_month v, params p
    WHERE v.period_date = p.last_closed_period
),
-- posição consolidada no mês de fechamento (soma das empresas que consolidam)
pos_cons AS (
    SELECT
        SUM(vp.caixa)          AS caixa,
        SUM(vp.ar)             AS ar,
        SUM(vp.ap)             AS ap,
        SUM(vp.estoque)        AS estoque,
        SUM(vp.divida)         AS divida,
        SUM(vp.divida_liquida) AS divida_liquida,
        SUM(vp.capital_giro)   AS capital_giro
    FROM cockpit.v_position_company_month vp
    JOIN cockpit.dim_company c ON c.company_id = vp.company_id
    CROSS JOIN params p
    WHERE vp.period_date = p.last_closed_period
      AND c.is_consolidating = true
),
-- receita bruta consolidada do mês de fechamento (para DSO consolidado)
rb_cons AS (
    SELECT SUM(f.valor_realizado) AS r_bruta
    FROM cockpit.fact_financials f
    JOIN cockpit.dim_company c ON c.company_id = f.company_id
    CROSS JOIN params p
    WHERE f.account_code = 'R_BRUTA'
      AND f.period_date  = p.last_closed_period
      AND c.is_consolidating = true
),
-- fluxo de caixa dos últimos 3 meses (consolidado) para burn/runway
caixa_mensal AS (
    SELECT
        vp.period_date,
        SUM(vp.caixa) AS caixa_cons
    FROM cockpit.v_position_company_month vp
    JOIN cockpit.dim_company c ON c.company_id = vp.company_id
    WHERE c.is_consolidating = true
    GROUP BY vp.period_date
),
fluxo_cons AS (
    SELECT
        cm.period_date,
        cm.caixa_cons - LAG(cm.caixa_cons) OVER (ORDER BY cm.period_date) AS fluxo
    FROM caixa_mensal cm
),
burn AS (
    -- burn_mensal = média( -fluxo ) dos últimos 3 meses até o fechamento, quando negativo
    SELECT
        AVG(-fc.fluxo) AS burn_mensal
    FROM fluxo_cons fc, params p
    WHERE fc.period_date >  (p.last_closed_period - INTERVAL '3 months')
      AND fc.period_date <= p.last_closed_period
)
SELECT
    p.last_closed_period,
    -- KPIs LTM de resultado
    lp.receita_liquida_ltm,
    lp.lucro_bruto_ltm,
    lp.ebitda_ltm,
    lp.ebit_ltm,
    lp.lucro_liquido_ltm,
    CASE WHEN lp.receita_liquida_ltm <> 0
         THEN ROUND(lp.ebitda_ltm / lp.receita_liquida_ltm * 100, 2) END        AS margem_ebitda_ltm_pct,
    CASE WHEN lp.receita_liquida_ltm <> 0
         THEN ROUND(lp.lucro_liquido_ltm / lp.receita_liquida_ltm * 100, 2) END AS margem_liquida_ltm_pct,
    -- posição no mês de fechamento
    pc.caixa,
    pc.divida,
    pc.divida_liquida,
    pc.capital_giro,
    -- divida_ebitda = divida_liquida / ebitda_ltm
    CASE WHEN lp.ebitda_ltm <> 0
         THEN ROUND(pc.divida_liquida / lp.ebitda_ltm, 2) END                   AS divida_ebitda,
    -- dso consolidado no mês de fechamento
    CASE WHEN COALESCE(rb.r_bruta,0) <> 0
         THEN ROUND(pc.ar / rb.r_bruta * 30, 1) END                             AS dso_dias,
    -- burn e runway
    CASE WHEN b.burn_mensal > 0 THEN ROUND(b.burn_mensal, 2) END                AS burn_mensal,
    CASE WHEN b.burn_mensal > 0 THEN ROUND(pc.caixa / b.burn_mensal, 1) END     AS runway_meses,
    -- EBITDA do mês de fechamento (referência)
    mp.ebitda                                                                   AS ebitda_mes,
    mp.lucro_liquido                                                            AS lucro_liquido_mes,
    mp.receita_liquida                                                          AS receita_liquida_mes
FROM params p
CROSS JOIN ltm_pnl lp
CROSS JOIN pos_cons pc
CROSS JOIN rb_cons  rb
CROSS JOIN burn     b
LEFT  JOIN mes_pnl  mp ON true;

COMMENT ON VIEW cockpit.v_kpi_consolidado_ltm IS
  'Snapshot de KPIs consolidados LTM (12 meses terminando em 2026-05-01): EBITDA LTM, margens, dívida líquida/EBITDA, DSO, burn e runway.';

-- -----------------------------------------------------------------------------
-- 5.5 v_budget_vs_actual — realizado vs orçado por empresa/conta/mês + variância
-- -----------------------------------------------------------------------------
CREATE VIEW cockpit.v_budget_vs_actual AS
SELECT
    f.company_id,
    f.period_date,
    f.account_code,
    a.account_name,
    a.group_code,
    a.account_kind,
    SUM(f.valor_realizado) AS realizado,
    SUM(f.valor_orcado)    AS orcado,
    (SUM(f.valor_realizado) - SUM(f.valor_orcado)) AS variacao_abs,
    -- variacao_orcado_pct = realizado / orcado - 1, em %
    CASE WHEN SUM(f.valor_orcado) <> 0
         THEN ROUND((SUM(f.valor_realizado) / SUM(f.valor_orcado) - 1) * 100, 2) END AS variacao_orcado_pct
FROM cockpit.fact_financials f
JOIN cockpit.dim_account a ON a.account_code = f.account_code
GROUP BY f.company_id, f.period_date, f.account_code, a.account_name, a.group_code, a.account_kind;

COMMENT ON VIEW cockpit.v_budget_vs_actual IS
  'Orçado vs Realizado por empresa/conta/mês com variância absoluta e percentual (realizado/orcado - 1).';

-- =============================================================================
-- 6. CARGA DE DADOS — nota COPY
-- -----------------------------------------------------------------------------
-- O gerador de dados (data/generate_data.py) escreve data/out/fact_financials.csv
-- com cabeçalho:
--   company_id,period_date,account_code,valor_realizado,valor_orcado,source_file,load_id
--
-- Carregue diretamente em fact_financials. Como a tabela tem coluna identidade (id)
-- e created_at com DEFAULT, liste apenas as colunas presentes no CSV.
--
-- Exemplo com \copy (cliente psql; caminho relativo ao diretório de onde o psql roda):
--
--   \copy cockpit.fact_financials (company_id, period_date, account_code, valor_realizado, valor_orcado, source_file, load_id) FROM 'data/out/fact_financials.csv' WITH (FORMAT csv, HEADER true)
--
-- No Windows, com caminho absoluto:
--
--   \copy cockpit.fact_financials (company_id, period_date, account_code, valor_realizado, valor_orcado, source_file, load_id) FROM 'C:/Users/Administrator/Documents/n8n/data/out/fact_financials.csv' WITH (FORMAT csv, HEADER true)
--
-- Para recarga limpa (idempotente), trunque antes:
--   TRUNCATE cockpit.fact_financials RESTART IDENTITY;
--
-- Após carregar embeddings, atualize estatísticas do índice IVFFlat:
--   ANALYZE cockpit.kb_embeddings;
-- =============================================================================

-- Fim de schema.sql
