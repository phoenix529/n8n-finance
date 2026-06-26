-- =============================================================================
-- Cockpit Financeiro Estratégico — Biblioteca de Consultas: Qualidade de Dados
-- =============================================================================
-- Conforme SPEC.md. Schema: cockpit.
--
-- Objetos de confiabilidade de ingestão (SPEC §6, Fase 1):
--   cockpit.stg_financials   — staging bruto (tudo texto)
--   cockpit.quarantine_rows  — linhas rejeitadas (raw_payload jsonb, error_code, ...)
--   cockpit.pipeline_runs    — execuções (status, rows_total/ok/quarantined, retries)
--   cockpit.ingestion_log    — log estruturado por etapa (level, step, message, payload)
--
-- Estas queries dão observabilidade operacional ao runbook (docs/02-runbook-...).
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1) Resumo das execuções de pipeline (mais recentes primeiro)
--    Taxa de quarentena e duração por execução — visão de saúde da ingestão.
-- -----------------------------------------------------------------------------
SELECT
    pr.load_id,
    pr.workflow,
    pr.source_file,
    pr.status,
    pr.rows_total,
    pr.rows_ok,
    pr.rows_quarantined,
    CASE WHEN pr.rows_total > 0
         THEN round(pr.rows_quarantined::numeric / pr.rows_total * 100, 2)
         ELSE 0 END AS pct_quarentena,
    pr.retries,
    pr.started_at,
    pr.finished_at,
    EXTRACT(EPOCH FROM (pr.finished_at - pr.started_at)) AS duracao_seg,
    pr.message
FROM cockpit.pipeline_runs pr
ORDER BY pr.started_at DESC NULLS LAST
LIMIT 50;


-- -----------------------------------------------------------------------------
-- 2) Execuções com falha ou com quarentena (alertas operacionais)
--    Critério: status de falha OU presença de linhas em quarentena.
-- -----------------------------------------------------------------------------
SELECT
    pr.load_id,
    pr.workflow,
    pr.source_file,
    pr.status,
    pr.rows_quarantined,
    pr.retries,
    pr.started_at,
    pr.message
FROM cockpit.pipeline_runs pr
WHERE pr.status IN ('failed', 'error', 'partial')
   OR pr.rows_quarantined > 0
ORDER BY pr.started_at DESC NULLS LAST;


-- -----------------------------------------------------------------------------
-- 3) Linhas em quarentena agregadas por código de erro (Pareto de problemas)
--    Mostra os tipos de erro mais frequentes para priorização de correções.
-- -----------------------------------------------------------------------------
SELECT
    q.error_code,
    count(*)                          AS qtd,
    count(DISTINCT q.load_id)         AS execucoes_afetadas,
    count(DISTINCT q.source_file)     AS arquivos_afetados,
    min(q.created_at)                 AS primeira_ocorrencia,
    max(q.created_at)                 AS ultima_ocorrencia
FROM cockpit.quarantine_rows q
GROUP BY q.error_code
ORDER BY qtd DESC;


-- -----------------------------------------------------------------------------
-- 4) Detalhe das linhas em quarentena de uma execução específica
--    Substitua :load_id pelo load_id de interesse (parâmetro do runbook).
--    Expõe o payload bruto (jsonb) para diagnóstico linha a linha.
-- -----------------------------------------------------------------------------
SELECT
    q.id,
    q.load_id,
    q.source_file,
    q.row_num,
    q.error_code,
    q.error_detail,
    q.raw_payload,
    q.created_at
FROM cockpit.quarantine_rows q
WHERE q.load_id = :load_id
ORDER BY q.row_num;


-- -----------------------------------------------------------------------------
-- 5) Log de ingestão por execução, com filtro de severidade
--    Níveis típicos: 'info', 'warn', 'error'. Útil para trilha de auditoria.
-- -----------------------------------------------------------------------------
SELECT
    il.id,
    il.load_id,
    il.level,
    il.step,
    il.message,
    il.payload,
    il.created_at
FROM cockpit.ingestion_log il
WHERE il.load_id = :load_id
  AND (il.level = 'error' OR il.level = 'warn' OR il.level = 'info')
ORDER BY il.created_at;


-- -----------------------------------------------------------------------------
-- 6) Cobertura de fatos: empresas x períodos x contas esperadas vs. presentes
--    Detecta lacunas (meses/contas faltantes) que comprometeriam a consolidação.
--    Esperado por empresa consolidante = (#contas PNL+POSICAO) x (#períodos fechados).
-- -----------------------------------------------------------------------------
WITH periodos AS (
    SELECT generate_series(DATE '2025-01-01', DATE '2026-05-01', INTERVAL '1 month')::date AS period_date
),
esperado AS (
    SELECT
        c.company_id,
        (SELECT count(*) FROM cockpit.dim_account) * (SELECT count(*) FROM periodos) AS fatos_esperados
    FROM cockpit.dim_company c
    WHERE c.is_consolidating = TRUE
),
presente AS (
    SELECT
        f.company_id,
        count(*) AS fatos_presentes
    FROM cockpit.fact_financials f
    JOIN cockpit.dim_company c USING (company_id)
    WHERE c.is_consolidating = TRUE
      AND f.period_date BETWEEN DATE '2025-01-01' AND DATE '2026-05-01'
    GROUP BY f.company_id
)
SELECT
    c.company_id,
    c.name,
    e.fatos_esperados,
    COALESCE(p.fatos_presentes, 0)                       AS fatos_presentes,
    e.fatos_esperados - COALESCE(p.fatos_presentes, 0)   AS lacunas,
    round(COALESCE(p.fatos_presentes, 0)::numeric / NULLIF(e.fatos_esperados, 0) * 100, 1) AS cobertura_pct
FROM cockpit.dim_company c
JOIN esperado e ON e.company_id = c.company_id
LEFT JOIN presente p ON p.company_id = c.company_id
WHERE c.is_consolidating = TRUE
ORDER BY c.sort;


-- -----------------------------------------------------------------------------
-- 7) Consistência de sinais (SPEC §3): receita positiva, custos/despesas negativos
--    Aponta valores realizados com sinal incoerente com o sign da conta.
--    sign '+' deve ser >= 0; sign '-' deve ser <= 0; '+/-' (RESULT_FIN) é livre.
-- -----------------------------------------------------------------------------
SELECT
    f.company_id,
    f.period_date,
    f.account_code,
    a.account_name,
    a.sign        AS sinal_esperado,
    f.valor_realizado,
    f.source_file,
    f.load_id
FROM cockpit.fact_financials f
JOIN cockpit.dim_account a USING (account_code)
WHERE (a.sign = '+' AND f.valor_realizado < 0)
   OR (a.sign = '-' AND f.valor_realizado > 0)
ORDER BY f.period_date DESC, f.company_id, f.account_code;


-- -----------------------------------------------------------------------------
-- 8) Duplicidade lógica de fatos (a UNIQUE deveria impedir, mas valida o staging)
--    Detecta múltiplas linhas para a mesma (empresa, período, conta).
-- -----------------------------------------------------------------------------
SELECT
    f.company_id,
    f.period_date,
    f.account_code,
    count(*) AS ocorrencias
FROM cockpit.fact_financials f
GROUP BY f.company_id, f.period_date, f.account_code
HAVING count(*) > 1
ORDER BY ocorrencias DESC, f.company_id, f.period_date;
