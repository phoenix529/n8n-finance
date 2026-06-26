-- =============================================================================
-- Cockpit Financeiro Estratégico — Biblioteca de Consultas: Documentos RAG
-- =============================================================================
-- Conforme SPEC.md. Schema: cockpit.
--
-- Estas queries CONSTROEM as narrativas de fatos (uma por company/period/metric-group)
-- que populam cockpit.kb_documents (SPEC §6, Fase 2). O script rag/embed.py executa
-- exatamente este shape, calcula embeddings (vector(1536)) e faz upsert em
-- cockpit.kb_embeddings.
--
-- Cada linha vira UM "chunk" de narrativa (doc_type, company_id, period_date,
-- title, content, metadata jsonb). Texto em PT-BR, valores em BRL.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1) Narrativas de P&L por empresa-mês (doc_type = 'pnl_empresa_mes')
--    Uma narrativa por (company_id, period_date) com os principais indicadores
--    de resultado já derivados. É a fonte mais granular do RAG.
-- -----------------------------------------------------------------------------
SELECT
    'pnl_empresa_mes'                       AS doc_type,
    p.company_id,
    p.period_date,
    format('P&L %s — %s', c.name, to_char(p.period_date, 'YYYY-MM')) AS title,
    format(
        'Resultado de %s (%s, setor %s) em %s: '
        || 'Receita Líquida R$ %s; Lucro Bruto R$ %s (margem bruta %s%%); '
        || 'EBITDA R$ %s (margem EBITDA %s%%); EBIT R$ %s; '
        || 'Lucro Líquido R$ %s (margem líquida %s%%).',
        c.name, p.company_id, c.sector, to_char(p.period_date, 'YYYY-MM'),
        to_char(p.receita_liquida, 'FM999G999G990D00'),
        to_char(p.lucro_bruto,     'FM999G999G990D00'),
        to_char(COALESCE(p.margem_bruta_pct, 0),  'FM990D0'),
        to_char(p.ebitda,          'FM999G999G990D00'),
        to_char(COALESCE(p.margem_ebitda_pct, 0), 'FM990D0'),
        to_char(p.ebit,            'FM999G999G990D00'),
        to_char(p.lucro_liquido,   'FM999G999G990D00'),
        to_char(COALESCE(p.margem_liquida_pct, 0), 'FM990D0')
    ) AS content,
    jsonb_build_object(
        'company_id', p.company_id,
        'company_name', c.name,
        'sector', c.sector,
        'period', to_char(p.period_date, 'YYYY-MM'),
        'receita_liquida', p.receita_liquida,
        'lucro_bruto', p.lucro_bruto,
        'ebitda', p.ebitda,
        'ebit', p.ebit,
        'lucro_liquido', p.lucro_liquido,
        'margem_ebitda_pct', p.margem_ebitda_pct,
        'grupo', 'pnl'
    ) AS metadata
FROM cockpit.v_pnl_company_month p
JOIN cockpit.dim_company c USING (company_id)
WHERE c.is_consolidating = TRUE
ORDER BY p.period_date, c.sort;


-- -----------------------------------------------------------------------------
-- 2) Narrativas de POSIÇÃO por empresa-mês (doc_type = 'posicao_empresa_mes')
--    Caixa, dívida líquida, capital de giro, DSO — métricas de balanço/liquidez.
-- -----------------------------------------------------------------------------
SELECT
    'posicao_empresa_mes'                   AS doc_type,
    v.company_id,
    v.period_date,
    format('Posição financeira %s — %s', c.name, to_char(v.period_date, 'YYYY-MM')) AS title,
    format(
        'Posição financeira de %s (%s) em %s: '
        || 'Caixa e Equivalentes R$ %s; Dívida Bruta R$ %s; Dívida Líquida R$ %s; '
        || 'Capital de Giro R$ %s; DSO %s dias '
        || '(Contas a Receber R$ %s, Contas a Pagar R$ %s, Estoques R$ %s).',
        c.name, v.company_id, to_char(v.period_date, 'YYYY-MM'),
        to_char(v.caixa,          'FM999G999G990D00'),
        to_char(v.divida,         'FM999G999G990D00'),
        to_char(v.divida_liquida, 'FM999G999G990D00'),
        to_char(v.capital_giro,   'FM999G999G990D00'),
        to_char(COALESCE(v.dso_dias, 0), 'FM990D0'),
        to_char(v.ar,             'FM999G999G990D00'),
        to_char(v.ap,             'FM999G999G990D00'),
        to_char(v.estoque,        'FM999G999G990D00')
    ) AS content,
    jsonb_build_object(
        'company_id', v.company_id,
        'company_name', c.name,
        'period', to_char(v.period_date, 'YYYY-MM'),
        'caixa', v.caixa,
        'divida_liquida', v.divida_liquida,
        'capital_giro', v.capital_giro,
        'dso_dias', v.dso_dias,
        'grupo', 'posicao'
    ) AS metadata
FROM cockpit.v_position_company_month v
JOIN cockpit.dim_company c USING (company_id)
WHERE c.is_consolidating = TRUE
ORDER BY v.period_date, c.sort;


-- -----------------------------------------------------------------------------
-- 3) Narrativas CONSOLIDADAS por mês (doc_type = 'consolidado_mes')
--    company_id = NULL (visão grupo). Resultado consolidado do mês.
-- -----------------------------------------------------------------------------
WITH pos AS (
    SELECT
        period_date,
        SUM(caixa)          AS caixa,
        SUM(divida_liquida) AS divida_liquida,
        SUM(capital_giro)   AS capital_giro
    FROM cockpit.v_position_company_month
    GROUP BY period_date
)
SELECT
    'consolidado_mes'                       AS doc_type,
    NULL::text                              AS company_id,
    p.period_date,
    format('Consolidado Grupo Aurora — %s', to_char(p.period_date, 'YYYY-MM')) AS title,
    format(
        'Resultado consolidado do Grupo Aurora em %s: '
        || 'Receita Líquida R$ %s; EBITDA R$ %s (margem EBITDA %s%%); '
        || 'Lucro Líquido R$ %s; Caixa consolidado R$ %s; '
        || 'Dívida Líquida R$ %s; Capital de Giro R$ %s.',
        to_char(p.period_date, 'YYYY-MM'),
        to_char(p.receita_liquida, 'FM999G999G990D00'),
        to_char(p.ebitda,          'FM999G999G990D00'),
        to_char(COALESCE(p.margem_ebitda_pct, 0), 'FM990D0'),
        to_char(p.lucro_liquido,   'FM999G999G990D00'),
        to_char(COALESCE(pos.caixa, 0),          'FM999G999G990D00'),
        to_char(COALESCE(pos.divida_liquida, 0), 'FM999G999G990D00'),
        to_char(COALESCE(pos.capital_giro, 0),   'FM999G999G990D00')
    ) AS content,
    jsonb_build_object(
        'period', to_char(p.period_date, 'YYYY-MM'),
        'receita_liquida', p.receita_liquida,
        'ebitda', p.ebitda,
        'lucro_liquido', p.lucro_liquido,
        'margem_ebitda_pct', p.margem_ebitda_pct,
        'caixa', pos.caixa,
        'divida_liquida', pos.divida_liquida,
        'grupo', 'consolidado'
    ) AS metadata
FROM cockpit.v_pnl_consolidado_month p
LEFT JOIN pos ON pos.period_date = p.period_date
ORDER BY p.period_date;


-- -----------------------------------------------------------------------------
-- 4) Narrativas de ORÇADO vs REALIZADO por empresa (doc_type = 'orcado_vs_real_mes')
--    Foco em variância de receita líquida no mês, em PT-BR.
-- -----------------------------------------------------------------------------
WITH bva AS (
    SELECT
        c.company_id,
        c.name,
        c.sort,
        v.period_date,
        SUM(CASE WHEN v.account_code IN ('R_BRUTA','DEDUCOES') THEN v.realizado ELSE 0 END) AS realizado,
        SUM(CASE WHEN v.account_code IN ('R_BRUTA','DEDUCOES') THEN v.orcado    ELSE 0 END) AS orcado
    FROM cockpit.v_budget_vs_actual v
    JOIN cockpit.dim_company c USING (company_id)
    WHERE c.is_consolidating = TRUE
    GROUP BY c.company_id, c.name, c.sort, v.period_date
)
SELECT
    'orcado_vs_real_mes'                    AS doc_type,
    b.company_id,
    b.period_date,
    format('Orçado vs Realizado %s — %s', b.name, to_char(b.period_date, 'YYYY-MM')) AS title,
    format(
        'Orçado vs Realizado de %s em %s (receita líquida): '
        || 'Realizado R$ %s; Orçado R$ %s; Variação %s%% '
        || '(%s a meta).',
        b.name, to_char(b.period_date, 'YYYY-MM'),
        to_char(b.realizado, 'FM999G999G990D00'),
        to_char(b.orcado,    'FM999G999G990D00'),
        to_char(CASE WHEN b.orcado <> 0 THEN (b.realizado / b.orcado - 1) * 100 ELSE 0 END, 'FM990D0'),
        CASE WHEN b.orcado <> 0 AND b.realizado >= b.orcado THEN 'acima ou em linha com'
             ELSE 'abaixo d' END
    ) AS content,
    jsonb_build_object(
        'company_id', b.company_id,
        'company_name', b.name,
        'period', to_char(b.period_date, 'YYYY-MM'),
        'realizado', b.realizado,
        'orcado', b.orcado,
        'var_pct', CASE WHEN b.orcado <> 0 THEN (b.realizado / b.orcado - 1) * 100 ELSE NULL END,
        'grupo', 'orcado_vs_real'
    ) AS metadata
FROM bva b
ORDER BY b.period_date, b.sort;


-- -----------------------------------------------------------------------------
-- 5) Narrativa do snapshot LTM consolidado (doc_type = 'kpi_ltm')
--    Único documento de "estado atual" — KPIs LTM no último mês fechado.
-- -----------------------------------------------------------------------------
SELECT
    'kpi_ltm'                               AS doc_type,
    NULL::text                              AS company_id,
    k.last_closed_period                    AS period_date,
    format('Snapshot KPIs LTM — %s', to_char(k.last_closed_period, 'YYYY-MM')) AS title,
    format(
        'Indicadores-chave (LTM, 12 meses até %s) do Grupo Aurora: '
        || 'Receita Líquida LTM R$ %s (YoY %s%%); EBITDA LTM R$ %s (margem %s%%); '
        || 'Lucro Líquido LTM R$ %s; Caixa R$ %s; Dívida Líquida R$ %s '
        || '(Dívida/EBITDA %sx); DSO %s dias; Capital de Giro R$ %s; '
        || 'Burn mensal R$ %s; Runway %s.',
        to_char(k.last_closed_period, 'YYYY-MM'),
        to_char(k.receita_liquida_ltm, 'FM999G999G990D00'),
        to_char(COALESCE(k.receita_yoy_pct, 0),    'FM990D0'),
        to_char(k.ebitda_ltm,          'FM999G999G990D00'),
        to_char(COALESCE(k.margem_ebitda_pct, 0),  'FM990D0'),
        to_char(k.lucro_liquido_ltm,   'FM999G999G990D00'),
        to_char(k.caixa,               'FM999G999G990D00'),
        to_char(k.divida_liquida,      'FM999G999G990D00'),
        to_char(COALESCE(k.divida_ebitda, 0),      'FM990D0'),
        to_char(COALESCE(k.dso_dias, 0),           'FM990D0'),
        to_char(k.capital_giro,        'FM999G999G990D00'),
        to_char(COALESCE(k.burn_mensal, 0),        'FM999G999G990D00'),
        COALESCE(to_char(k.runway_meses, 'FM990D0') || ' meses', 'n/a (fluxo positivo)')
    ) AS content,
    jsonb_build_object(
        'period', to_char(k.last_closed_period, 'YYYY-MM'),
        'receita_liquida_ltm', k.receita_liquida_ltm,
        'ebitda_ltm', k.ebitda_ltm,
        'lucro_liquido_ltm', k.lucro_liquido_ltm,
        'caixa', k.caixa,
        'divida_liquida', k.divida_liquida,
        'divida_ebitda', k.divida_ebitda,
        'runway_meses', k.runway_meses,
        'grupo', 'kpi_ltm'
    ) AS metadata
FROM cockpit.v_kpi_consolidado_ltm k;


-- -----------------------------------------------------------------------------
-- 6) UNION de seleção usado pelo rag/embed.py para popular kb_documents
--    O embed.py executa este SELECT combinado e insere cada linha como um
--    documento (idempotente por (doc_type, company_id, period_date)).
--    Mantido como bloco final para servir de "contrato" do conteúdo do RAG.
-- -----------------------------------------------------------------------------
-- NOTA: este bloco é executado pelo embed.py via psycopg; aqui é a referência.
--   Ele combina (1) pnl_empresa_mes, (2) posicao_empresa_mes, (3) consolidado_mes,
--   (4) orcado_vs_real_mes e (5) kpi_ltm em um único resultset com colunas:
--   (doc_type, company_id, period_date, title, content, metadata).
