-- =============================================================================
-- Cockpit Financeiro Estratégico — Biblioteca de Consultas: KPIs
-- =============================================================================
-- Conforme SPEC.md (fonte única de verdade). Schema: cockpit.
--
-- Fórmulas canônicas (SPEC §4) — implementadas identicamente em SQL e JSON:
--   receita_liquida    = R_BRUTA + DEDUCOES        (DEDUCOES é negativo)
--   lucro_bruto        = receita_liquida + CMV
--   ebitda             = lucro_bruto + DESP_PESSOAL + DESP_VENDAS + DESP_ADM + DESP_OUTRAS
--   ebit               = ebitda + DEPRECIACAO
--   lucro_liquido      = ebit + RESULT_FIN + IRPJ_CSLL
--   margem_ebitda_pct  = ebitda / receita_liquida * 100
--   divida_liquida     = DIVIDA - CAIXA
--   divida_ebitda      = divida_liquida / ebitda_ltm
--   dso_dias           = AR / R_BRUTA * 30
--   capital_giro       = AR + ESTOQUE - AP
--
-- last_closed_period = 2026-05-01  (SPEC §5)
-- Estas queries leem as VIEWS de consolidação/KPI já definidas em db/schema.sql.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1) Snapshot de KPIs consolidados (LTM) — último mês fechado vs. mês anterior
--    Alimenta os tiles do topo do dashboard (kpis.* no dashboard_data.json).
--    Usa a view v_kpi_consolidado_ltm (snapshot LTM mais recente).
-- -----------------------------------------------------------------------------
SELECT
    k.last_closed_period,
    k.caixa,
    k.runway_meses,
    k.burn_mensal,
    k.receita_liquida_ltm,
    k.receita_yoy_pct,
    k.ebitda_ltm,
    k.margem_ebitda_pct,
    k.lucro_liquido_ltm,
    k.margem_liquida_pct,
    k.divida_liquida,
    k.divida_ebitda,
    k.dso_dias,
    k.capital_giro
FROM cockpit.v_kpi_consolidado_ltm AS k;


-- -----------------------------------------------------------------------------
-- 2) KPIs consolidados do último mês fechado vs. mês anterior (delta % por tile)
--    Calcula o par (value, prev, delta_pct) usado em cada tile de KPI.
--    Lê v_pnl_consolidado_month e v_position_company_month (agregada).
-- -----------------------------------------------------------------------------
WITH meses AS (
    SELECT DATE '2026-05-01' AS atual,
           DATE '2026-05-01' - INTERVAL '1 month' AS anterior
),
pnl AS (
    SELECT
        p.period_date,
        p.receita_liquida,
        p.ebitda,
        p.lucro_liquido,
        p.margem_ebitda_pct
    FROM cockpit.v_pnl_consolidado_month p, meses m
    WHERE p.period_date IN (m.atual, m.anterior)
),
pos AS (
    -- Posições consolidadas = soma das empresas (apenas leaf, sem ELIM materializa ~0)
    SELECT
        v.period_date,
        SUM(v.caixa)          AS caixa,
        SUM(v.divida_liquida) AS divida_liquida,
        SUM(v.capital_giro)   AS capital_giro,
        -- DSO consolidado: AR total / R_BRUTA total * 30 (recalcula, não soma DSOs)
        CASE WHEN SUM(v.r_bruta) <> 0
             THEN SUM(v.ar) / SUM(v.r_bruta) * 30 ELSE NULL END AS dso_dias
    FROM cockpit.v_position_company_month v, meses m
    WHERE v.period_date IN (m.atual, m.anterior)
    GROUP BY v.period_date
)
SELECT
    'receita_liquida' AS metrica,
    a.receita_liquida AS value,
    b.receita_liquida AS prev,
    CASE WHEN b.receita_liquida <> 0
         THEN (a.receita_liquida / b.receita_liquida - 1) * 100 ELSE NULL END AS delta_pct
FROM pnl a, pnl b, meses m WHERE a.period_date = m.atual AND b.period_date = m.anterior
UNION ALL
SELECT 'ebitda', a.ebitda, b.ebitda,
    CASE WHEN b.ebitda <> 0 THEN (a.ebitda / b.ebitda - 1) * 100 ELSE NULL END
FROM pnl a, pnl b, meses m WHERE a.period_date = m.atual AND b.period_date = m.anterior
UNION ALL
SELECT 'lucro_liquido', a.lucro_liquido, b.lucro_liquido,
    CASE WHEN b.lucro_liquido <> 0 THEN (a.lucro_liquido / b.lucro_liquido - 1) * 100 ELSE NULL END
FROM pnl a, pnl b, meses m WHERE a.period_date = m.atual AND b.period_date = m.anterior
UNION ALL
SELECT 'caixa', a.caixa, b.caixa,
    CASE WHEN b.caixa <> 0 THEN (a.caixa / b.caixa - 1) * 100 ELSE NULL END
FROM pos a, pos b, meses m WHERE a.period_date = m.atual AND b.period_date = m.anterior
UNION ALL
SELECT 'divida_liquida', a.divida_liquida, b.divida_liquida,
    CASE WHEN b.divida_liquida <> 0 THEN (a.divida_liquida / b.divida_liquida - 1) * 100 ELSE NULL END
FROM pos a, pos b, meses m WHERE a.period_date = m.atual AND b.period_date = m.anterior
UNION ALL
SELECT 'capital_giro', a.capital_giro, b.capital_giro,
    CASE WHEN b.capital_giro <> 0 THEN (a.capital_giro / b.capital_giro - 1) * 100 ELSE NULL END
FROM pos a, pos b, meses m WHERE a.period_date = m.atual AND b.period_date = m.anterior
UNION ALL
SELECT 'dso_dias', a.dso_dias, b.dso_dias,
    CASE WHEN b.dso_dias <> 0 THEN (a.dso_dias / b.dso_dias - 1) * 100 ELSE NULL END
FROM pos a, pos b, meses m WHERE a.period_date = m.atual AND b.period_date = m.anterior;


-- -----------------------------------------------------------------------------
-- 3) Sparkline: série mensal consolidada (12 últimos meses até o fechamento)
--    Alimenta os arrays "spark" dos tiles (receita_liquida, ebitda, lucro, caixa).
-- -----------------------------------------------------------------------------
SELECT
    to_char(p.period_date, 'YYYY-MM') AS period,
    p.receita_liquida,
    p.ebitda,
    p.lucro_liquido,
    pos.caixa
FROM cockpit.v_pnl_consolidado_month p
LEFT JOIN (
    SELECT period_date, SUM(caixa) AS caixa
    FROM cockpit.v_position_company_month
    GROUP BY period_date
) pos ON pos.period_date = p.period_date
WHERE p.period_date >  DATE '2026-05-01' - INTERVAL '12 months'
  AND p.period_date <= DATE '2026-05-01'
ORDER BY p.period_date;


-- -----------------------------------------------------------------------------
-- 4) KPIs por empresa (agregados LTM + margem + share de receita)
--    Alimenta a seção "por_empresa" do dashboard_data.json.
--    LTM = 12 meses terminando em last_closed_period (2026-05-01).
-- -----------------------------------------------------------------------------
WITH ltm AS (
    SELECT
        p.company_id,
        SUM(p.receita_liquida) AS receita_ltm,
        SUM(p.ebitda)          AS ebitda_ltm,
        SUM(p.lucro_liquido)   AS lucro_liquido_ltm
    FROM cockpit.v_pnl_company_month p
    WHERE p.period_date >  DATE '2026-05-01' - INTERVAL '12 months'
      AND p.period_date <= DATE '2026-05-01'
    GROUP BY p.company_id
),
total AS (
    SELECT SUM(receita_ltm) AS receita_total FROM ltm
)
SELECT
    c.company_id,
    c.name,
    c.sector,
    c.color,
    l.receita_ltm,
    l.ebitda_ltm,
    CASE WHEN l.receita_ltm <> 0 THEN l.ebitda_ltm / l.receita_ltm * 100 ELSE NULL END AS margem_ebitda_pct,
    l.lucro_liquido_ltm,
    CASE WHEN t.receita_total <> 0 THEN l.receita_ltm / t.receita_total * 100 ELSE NULL END AS share_receita_pct
FROM cockpit.dim_company c
JOIN ltm   l ON l.company_id = c.company_id
CROSS JOIN total t
WHERE c.is_consolidating = TRUE
ORDER BY c.sort;


-- -----------------------------------------------------------------------------
-- 5) Receita YoY consolidada (último mês vs. mesmo mês do ano anterior)
--    receita_yoy_pct = receita_liquida(m) / receita_liquida(m-12) - 1, em %
-- -----------------------------------------------------------------------------
SELECT
    to_char(atual.period_date, 'YYYY-MM') AS period,
    atual.receita_liquida                 AS receita_liquida_atual,
    ano_ant.receita_liquida               AS receita_liquida_ano_anterior,
    CASE WHEN ano_ant.receita_liquida <> 0
         THEN (atual.receita_liquida / ano_ant.receita_liquida - 1) * 100
         ELSE NULL END                    AS receita_yoy_pct
FROM cockpit.v_pnl_consolidado_month atual
JOIN cockpit.v_pnl_consolidado_month ano_ant
  ON ano_ant.period_date = atual.period_date - INTERVAL '12 months'
WHERE atual.period_date = DATE '2026-05-01';


-- -----------------------------------------------------------------------------
-- 6) Burn & Runway (proxy de variação de caixa, média dos últimos 3 meses)
--    fluxo_caixa_mes = CAIXA(m) - CAIXA(m-1)
--    burn_mensal     = média( -fluxo_caixa_mes ) dos últimos 3 meses, quando negativo
--    runway_meses    = CAIXA / burn_mensal (se burn>0; senão fluxo positivo)
-- -----------------------------------------------------------------------------
WITH caixa_mensal AS (
    SELECT
        period_date,
        SUM(caixa) AS caixa
    FROM cockpit.v_position_company_month
    GROUP BY period_date
),
fluxo AS (
    SELECT
        period_date,
        caixa,
        caixa - LAG(caixa) OVER (ORDER BY period_date) AS fluxo_caixa_mes
    FROM caixa_mensal
),
ult3 AS (
    SELECT *
    FROM fluxo
    WHERE period_date >  DATE '2026-05-01' - INTERVAL '3 months'
      AND period_date <= DATE '2026-05-01'
),
agg AS (
    SELECT
        AVG(-fluxo_caixa_mes) AS burn_mensal,        -- positivo quando há queima
        (SELECT caixa FROM caixa_mensal WHERE period_date = DATE '2026-05-01') AS caixa_atual
    FROM ult3
)
SELECT
    caixa_atual,
    GREATEST(burn_mensal, 0) AS burn_mensal,
    CASE WHEN burn_mensal > 0
         THEN caixa_atual / burn_mensal
         ELSE NULL END AS runway_meses          -- NULL = fluxo positivo / n.a.
FROM agg;
