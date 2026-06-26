-- =============================================================================
-- Cockpit Financeiro Estratégico — Biblioteca de Consultas: Consolidação
-- =============================================================================
-- Conforme SPEC.md. Schema: cockpit.
--
-- Perímetro de consolidação (SPEC §2): soma de todas as empresas marcadas como
-- is_consolidating. A empresa ELIM existe para eliminações intercompany
-- (arquitetura-ready; valores ~0 no demo).
--
-- Convenção de sinais (SPEC §3): receita positiva; custos/despesas negativos.
-- Consolidado = somar contas-folha primeiro, depois derivar (SPEC §4).
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1) DRE consolidada — último mês fechado + LTM + orçado do mês
--    Alimenta a seção "dre_consolidada" do dashboard_data.json (waterfall/tabela).
--    var_pct (por linha) = realizado / orcado - 1, em % (SPEC §4).
-- -----------------------------------------------------------------------------
WITH mes AS (
    SELECT DATE '2026-05-01' AS atual
),
-- P&L consolidado do mês (já derivado pela view)
mes_atual AS (
    SELECT p.*
    FROM cockpit.v_pnl_consolidado_month p, mes m
    WHERE p.period_date = m.atual
),
-- Acumulado LTM consolidado (12 meses até o fechamento)
ltm AS (
    SELECT
        SUM(receita_bruta)   AS receita_bruta,
        SUM(receita_liquida) AS receita_liquida,
        SUM(lucro_bruto)     AS lucro_bruto,
        SUM(ebitda)          AS ebitda,
        SUM(ebit)            AS ebit,
        SUM(lucro_liquido)   AS lucro_liquido
    FROM cockpit.v_pnl_consolidado_month
    WHERE period_date >  DATE '2026-05-01' - INTERVAL '12 months'
      AND period_date <= DATE '2026-05-01'
),
-- Orçado consolidado do mês, derivado das contas-folha orçadas
orc AS (
    SELECT
        SUM(CASE WHEN account_code = 'R_BRUTA'      THEN valor_orcado ELSE 0 END)
          + SUM(CASE WHEN account_code = 'DEDUCOES' THEN valor_orcado ELSE 0 END) AS receita_liquida_orc,
        SUM(CASE WHEN account_code = 'R_BRUTA'      THEN valor_orcado ELSE 0 END) AS receita_bruta_orc,
        SUM(CASE WHEN account_code IN ('R_BRUTA','DEDUCOES','CMV') THEN valor_orcado ELSE 0 END) AS lucro_bruto_orc,
        SUM(CASE WHEN account_code IN ('R_BRUTA','DEDUCOES','CMV','DESP_PESSOAL','DESP_VENDAS','DESP_ADM','DESP_OUTRAS')
                 THEN valor_orcado ELSE 0 END) AS ebitda_orc,
        SUM(CASE WHEN account_code IN ('R_BRUTA','DEDUCOES','CMV','DESP_PESSOAL','DESP_VENDAS','DESP_ADM','DESP_OUTRAS','DEPRECIACAO')
                 THEN valor_orcado ELSE 0 END) AS ebit_orc,
        SUM(valor_orcado) FILTER (WHERE account_code IN
                 ('R_BRUTA','DEDUCOES','CMV','DESP_PESSOAL','DESP_VENDAS','DESP_ADM','DESP_OUTRAS',
                  'DEPRECIACAO','RESULT_FIN','IRPJ_CSLL')) AS lucro_liquido_orc
    FROM cockpit.fact_financials f
    JOIN cockpit.dim_account a USING (account_code)
    JOIN cockpit.dim_company c USING (company_id), mes m
    WHERE f.period_date = m.atual
      AND a.account_kind = 'PNL'
      AND c.is_consolidating = TRUE
)
SELECT linha, code, mes_val AS mes, ltm_val AS ltm, orcado_mes,
       CASE WHEN orcado_mes <> 0 THEN (mes_val / orcado_mes - 1) * 100 ELSE NULL END AS var_pct
FROM (
    SELECT 'Receita Líquida'      AS linha, 'receita_liquida' AS code, ma.receita_liquida AS mes_val, l.receita_liquida AS ltm_val, o.receita_liquida_orc AS orcado_mes, 1 AS ord FROM mes_atual ma, ltm l, orc o
    UNION ALL
    SELECT 'Lucro Bruto', 'lucro_bruto', ma.lucro_bruto, l.lucro_bruto, o.lucro_bruto_orc, 2 FROM mes_atual ma, ltm l, orc o
    UNION ALL
    SELECT 'EBITDA', 'ebitda', ma.ebitda, l.ebitda, o.ebitda_orc, 3 FROM mes_atual ma, ltm l, orc o
    UNION ALL
    SELECT 'EBIT', 'ebit', ma.ebit, l.ebit, o.ebit_orc, 4 FROM mes_atual ma, ltm l, orc o
    UNION ALL
    SELECT 'Lucro Líquido', 'lucro_liquido', ma.lucro_liquido, l.lucro_liquido, o.lucro_liquido_orc, 5 FROM mes_atual ma, ltm l, orc o
) t
ORDER BY ord;


-- -----------------------------------------------------------------------------
-- 2) Série mensal consolidada (ascendente por período "YYYY-MM")
--    Alimenta "series_mensal" do dashboard_data.json (todo o histórico).
--    Inclui caixa, dívida líquida e fluxo de caixa por mês.
-- -----------------------------------------------------------------------------
WITH pos AS (
    SELECT
        period_date,
        SUM(caixa)          AS caixa,
        SUM(divida_liquida) AS divida_liquida
    FROM cockpit.v_position_company_month
    GROUP BY period_date
),
orc AS (
    SELECT
        f.period_date,
        SUM(CASE WHEN a.account_code = 'R_BRUTA' THEN f.valor_orcado ELSE 0 END)
          + SUM(CASE WHEN a.account_code = 'DEDUCOES' THEN f.valor_orcado ELSE 0 END) AS receita_orcada,
        SUM(CASE WHEN a.account_code IN ('R_BRUTA','DEDUCOES','CMV','DESP_PESSOAL','DESP_VENDAS','DESP_ADM','DESP_OUTRAS')
                 THEN f.valor_orcado ELSE 0 END) AS ebitda_orcado
    FROM cockpit.fact_financials f
    JOIN cockpit.dim_account a USING (account_code)
    JOIN cockpit.dim_company c USING (company_id)
    WHERE a.account_kind = 'PNL' AND c.is_consolidating = TRUE
    GROUP BY f.period_date
)
SELECT
    to_char(p.period_date, 'YYYY-MM') AS period,
    p.receita_bruta,
    p.receita_liquida,
    p.lucro_bruto,
    p.ebitda,
    p.ebit,
    p.lucro_liquido,
    pos.caixa,
    pos.divida_liquida,
    pos.caixa - LAG(pos.caixa) OVER (ORDER BY p.period_date) AS fluxo_caixa,
    p.margem_ebitda_pct,
    orc.receita_orcada,
    orc.ebitda_orcado
FROM cockpit.v_pnl_consolidado_month p
LEFT JOIN pos ON pos.period_date = p.period_date
LEFT JOIN orc ON orc.period_date = p.period_date
ORDER BY p.period_date;


-- -----------------------------------------------------------------------------
-- 3) P&L derivado por empresa-mês (verificação das fórmulas canônicas)
--    Demonstra a derivação a partir das contas-folha (SPEC §4).
-- -----------------------------------------------------------------------------
SELECT
    c.company_id,
    c.name,
    p.period_date,
    p.receita_liquida,
    p.lucro_bruto,
    p.ebitda,
    p.ebit,
    p.lucro_liquido,
    p.margem_bruta_pct,
    p.margem_ebitda_pct,
    p.margem_liquida_pct
FROM cockpit.v_pnl_company_month p
JOIN cockpit.dim_company c USING (company_id)
WHERE c.is_consolidating = TRUE
  AND p.period_date = DATE '2026-05-01'
ORDER BY c.sort;


-- -----------------------------------------------------------------------------
-- 4) Budget vs Actual por empresa (último mês) — barras de variância
--    Alimenta "orcado_vs_realizado" do dashboard_data.json.
--    Usa a view v_budget_vs_actual; aqui agregamos por empresa (receita líquida).
--    variacao_orcado_pct = realizado / orcado - 1, em % (SPEC §4).
-- -----------------------------------------------------------------------------
SELECT
    c.company_id,
    c.name,
    -- Realizado / orçado de RECEITA LÍQUIDA (R_BRUTA + DEDUCOES) por empresa
    SUM(CASE WHEN v.account_code IN ('R_BRUTA','DEDUCOES') THEN v.realizado ELSE 0 END) AS realizado,
    SUM(CASE WHEN v.account_code IN ('R_BRUTA','DEDUCOES') THEN v.orcado    ELSE 0 END) AS orcado,
    CASE WHEN SUM(CASE WHEN v.account_code IN ('R_BRUTA','DEDUCOES') THEN v.orcado ELSE 0 END) <> 0
         THEN (
              SUM(CASE WHEN v.account_code IN ('R_BRUTA','DEDUCOES') THEN v.realizado ELSE 0 END)
            / SUM(CASE WHEN v.account_code IN ('R_BRUTA','DEDUCOES') THEN v.orcado    ELSE 0 END) - 1
         ) * 100
         ELSE NULL END AS var_pct
FROM cockpit.v_budget_vs_actual v
JOIN cockpit.dim_company c USING (company_id)
WHERE v.period_date = DATE '2026-05-01'
  AND c.is_consolidating = TRUE
GROUP BY c.company_id, c.name, c.sort
ORDER BY c.sort;


-- -----------------------------------------------------------------------------
-- 5) Gastos por categoria (donut) — quebra de OPEX + CMV, último mês, consolidado
--    Alimenta "gastos_por_categoria" do dashboard_data.json.
--    Valores apresentados em módulo (positivos) para o gráfico.
-- -----------------------------------------------------------------------------
WITH gastos AS (
    SELECT
        CASE f.account_code
            WHEN 'CMV'          THEN 'CMV'
            WHEN 'DESP_PESSOAL' THEN 'Pessoal'
            WHEN 'DESP_VENDAS'  THEN 'Comercial/Marketing'
            WHEN 'DESP_ADM'     THEN 'Administrativas'
            WHEN 'DESP_OUTRAS'  THEN 'Outras Operacionais'
        END AS categoria,
        SUM(ABS(f.valor_realizado)) AS valor
    FROM cockpit.fact_financials f
    JOIN cockpit.dim_account a USING (account_code)
    JOIN cockpit.dim_company c USING (company_id)
    WHERE f.period_date = DATE '2026-05-01'
      AND f.account_code IN ('CMV','DESP_PESSOAL','DESP_VENDAS','DESP_ADM','DESP_OUTRAS')
      AND c.is_consolidating = TRUE
    GROUP BY 1
),
total AS (SELECT SUM(valor) AS total FROM gastos)
SELECT
    g.categoria,
    g.valor,
    CASE WHEN t.total <> 0 THEN g.valor / t.total * 100 ELSE NULL END AS pct
FROM gastos g CROSS JOIN total t
ORDER BY g.valor DESC;
