-- =============================================================================
-- Cockpit Financeiro Estratégico — Grupo Aurora
-- Dados de referência (dimensões): empresas + plano de contas
-- -----------------------------------------------------------------------------
-- Fonte canônica: SPEC.md (seção 2 — empresas; seção 3 — plano de contas).
-- Upserts idempotentes (ON CONFLICT DO UPDATE) — pode rodar várias vezes.
-- Pré-requisito: db/schema.sql aplicado (tabelas dim_company / dim_account existem).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Empresas (perímetro de consolidação) — SPEC seção 2
-- -----------------------------------------------------------------------------
-- is_consolidating: todas consolidam (somam no consolidado), inclusive ELIM
-- (que existe para eliminações intercompany; valores ~0 no demo, mas faz parte
-- da soma para deixar a arquitetura pronta). HLD é holding (corporate only).
INSERT INTO cockpit.dim_company (company_id, name, sector, color, is_consolidating, sort) VALUES
    ('AUR-VAR', 'Aurora Varejo S.A.',        'Varejo',     '#4F6BED', true, 1),
    ('AUR-IND', 'Aurora Indústria Ltda.',    'Indústria',  '#0EA5E9', true, 2),
    ('AUR-SVC', 'Aurora Serviços Ltda.',     'Serviços',   '#10B981', true, 3),
    ('AUR-LOG', 'Aurora Logística Ltda.',    'Logística',  '#F59E0B', true, 4),
    ('AUR-HLD', 'Aurora Participações S.A.', 'Holding',    '#6B7280', true, 5),
    ('ELIM',    'Eliminações Intercompany',  'Eliminação', '#94A3B8', true, 6)
ON CONFLICT (company_id) DO UPDATE SET
    name             = EXCLUDED.name,
    sector           = EXCLUDED.sector,
    color            = EXCLUDED.color,
    is_consolidating = EXCLUDED.is_consolidating,
    sort             = EXCLUDED.sort;

-- -----------------------------------------------------------------------------
-- 2. Plano de contas — contas-folha (subtotais são derivados nas views)
-- -----------------------------------------------------------------------------
-- 2.1 Contas de DRE (PNL) — SPEC seção 3.
-- Convenção de sinal: RECEITA bruta +; DEDUCOES, CMV, despesas, DEPRECIACAO,
-- IRPJ_CSLL armazenadas como NEGATIVAS; RESULT_FIN misto (sign = 0).
INSERT INTO cockpit.dim_account (account_code, account_name, account_kind, group_code, sign, sort) VALUES
    ('R_BRUTA',      'Receita Bruta de Vendas',            'PNL', 'RECEITA',  1,  1),
    ('DEDUCOES',     'Impostos e Deduções s/ Vendas',      'PNL', 'RECEITA', -1,  2),
    ('CMV',          'Custo dos Produtos/Serviços (CMV)',  'PNL', 'CUSTO',   -1,  3),
    ('DESP_PESSOAL', 'Despesas com Pessoal',               'PNL', 'OPEX',    -1,  4),
    ('DESP_VENDAS',  'Despesas Comerciais e Marketing',    'PNL', 'OPEX',    -1,  5),
    ('DESP_ADM',     'Despesas Administrativas',           'PNL', 'OPEX',    -1,  6),
    ('DESP_OUTRAS',  'Outras Despesas Operacionais',       'PNL', 'OPEX',    -1,  7),
    ('DEPRECIACAO',  'Depreciação e Amortização',          'PNL', 'DA',      -1,  8),
    ('RESULT_FIN',   'Resultado Financeiro Líquido',       'PNL', 'FINANC',   0,  9),
    ('IRPJ_CSLL',    'IR e CSLL',                          'PNL', 'IMPOSTO', -1, 10)
ON CONFLICT (account_code) DO UPDATE SET
    account_name = EXCLUDED.account_name,
    account_kind = EXCLUDED.account_kind,
    group_code   = EXCLUDED.group_code,
    sign         = EXCLUDED.sign,
    sort         = EXCLUDED.sort;

-- 2.2 Contas de POSIÇÃO (saldo de fim de mês) — SPEC seção 3. Todas positivas.
INSERT INTO cockpit.dim_account (account_code, account_name, account_kind, group_code, sign, sort) VALUES
    ('CAIXA',      'Caixa e Equivalentes',         'POSICAO', 'POSICAO', 1, 11),
    ('AR',         'Contas a Receber',             'POSICAO', 'POSICAO', 1, 12),
    ('AP',         'Contas a Pagar',               'POSICAO', 'POSICAO', 1, 13),
    ('ESTOQUE',    'Estoques',                     'POSICAO', 'POSICAO', 1, 14),
    ('DIVIDA',     'Dívida Bruta (Empréstimos)',   'POSICAO', 'POSICAO', 1, 15),
    ('PATRIMONIO', 'Patrimônio Líquido',           'POSICAO', 'POSICAO', 1, 16)
ON CONFLICT (account_code) DO UPDATE SET
    account_name = EXCLUDED.account_name,
    account_kind = EXCLUDED.account_kind,
    group_code   = EXCLUDED.group_code,
    sign         = EXCLUDED.sign,
    sort         = EXCLUDED.sort;

-- -----------------------------------------------------------------------------
-- 3. Verificação rápida (opcional) — descomente para conferir contagens
-- -----------------------------------------------------------------------------
-- SELECT 'empresas' AS dim, count(*) FROM cockpit.dim_company
-- UNION ALL
-- SELECT 'contas',     count(*) FROM cockpit.dim_account;
-- Esperado: 6 empresas, 16 contas (10 PNL + 6 POSICAO).

-- Fim de seed_reference.sql
