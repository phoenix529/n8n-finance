-- =============================================================================
-- schema_ref.sql — Modelo de dados PostgreSQL do Cockpit REF (Technical Blueprint §5)
-- Banco: cockpit_ref | Owner: cockpit_user
-- Star schema: dimensões + fatos + views analíticas + tabela de controle de carga.
-- Segue exatamente o blueprint; nomes em português conforme especificado.
-- =============================================================================

-- ----------------------------------------------------------------------------
-- 5.1 Dimensões
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS dim_empresa (
    id          SERIAL PRIMARY KEY,
    codigo      VARCHAR(20) UNIQUE NOT NULL,    -- REF, BD, 4PR, VIV, ZUP
    nome        VARCHAR(100) NOT NULL,
    tipo        VARCHAR(50),                    -- agency, production company, tech
    ativo       BOOLEAN DEFAULT TRUE,
    criado_em   TIMESTAMP DEFAULT NOW()
);

-- Plano de contas UNIFICADO (canônico) entre as empresas. As variações de
-- nomenclatura por empresa são mapeadas para uma única conta canônica pelos parsers.
CREATE TABLE IF NOT EXISTS dim_conta (
    id              SERIAL PRIMARY KEY,
    codigo_conta    VARCHAR(30),                -- ex.: 3.1.07.01 (pode ser NULL)
    descricao       VARCHAR(200) NOT NULL,
    grupo           VARCHAR(100),               -- REVENUE, DIRECT_COST, PERSONNEL, ADMIN...
    subgrupo        VARCHAR(100),
    tipo            VARCHAR(20),                -- revenue, cost, expense, result, tax
    empresa_id      INT REFERENCES dim_empresa(id),  -- NULL = conta unificada (grupo)
    criado_em       TIMESTAMP DEFAULT NOW(),
    UNIQUE (descricao)
);

CREATE TABLE IF NOT EXISTS dim_periodo (
    id          SERIAL PRIMARY KEY,
    data        DATE UNIQUE NOT NULL,
    ano         INT NOT NULL,
    mes         INT NOT NULL,
    trimestre   INT NOT NULL,
    semestre    INT NOT NULL,
    nome_mes    VARCHAR(20)
);

CREATE TABLE IF NOT EXISTS dim_cliente (
    id          SERIAL PRIMARY KEY,
    nome        VARCHAR(200) NOT NULL,
    empresa_id  INT REFERENCES dim_empresa(id),
    ativo       BOOLEAN DEFAULT TRUE,
    UNIQUE (nome, empresa_id)
);

-- ----------------------------------------------------------------------------
-- 5.2 Fatos
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS fato_dre_mensal (
    id              SERIAL PRIMARY KEY,
    empresa_id      INT NOT NULL REFERENCES dim_empresa(id),
    conta_id        INT NOT NULL REFERENCES dim_conta(id),
    periodo_id      INT NOT NULL REFERENCES dim_periodo(id),
    valor           NUMERIC(18,4),              -- 4 casas: reproduz o TOTAL da planilha (R$ 0,01)
    fonte           VARCHAR(50),                -- nome do arquivo de origem
    carregado_em    TIMESTAMP DEFAULT NOW(),
    UNIQUE (empresa_id, conta_id, periodo_id)
);
CREATE INDEX IF NOT EXISTS ix_dre_emp_per ON fato_dre_mensal(empresa_id, periodo_id);

CREATE TABLE IF NOT EXISTS fato_receita_cliente_mensal (
    id              SERIAL PRIMARY KEY,
    empresa_id      INT NOT NULL REFERENCES dim_empresa(id),
    cliente_id      INT NOT NULL REFERENCES dim_cliente(id),
    periodo_id      INT NOT NULL REFERENCES dim_periodo(id),
    tipo_receita    VARCHAR(100),               -- FEE, MIDIA_OFF, MIDIA_ON, PRODUCAO...
    valor           NUMERIC(18,2),
    carregado_em    TIMESTAMP DEFAULT NOW(),
    UNIQUE (empresa_id, cliente_id, periodo_id, tipo_receita)
);
CREATE INDEX IF NOT EXISTS ix_rec_cli_per ON fato_receita_cliente_mensal(cliente_id, periodo_id);

-- Mix da RECEITA BRUTA por tipo canônico (Painel 02 — "Distribuição da receita bruta
-- por tipo"). Origem: linhas de tipo logo abaixo de 'RECEITA BRUTA' na aba DRE-Base;
-- a SOMA dos tipos por mês == RECEITA BRUTA do mês. Tipos canônicos (rollup DEFAULT):
-- Fee Mensal, Mídia Off, Mídia On, Criação, Filmes/Spot, BVS, Outras.
CREATE TABLE IF NOT EXISTS fato_receita_tipo_mensal (
    id              SERIAL PRIMARY KEY,
    empresa_id      INT NOT NULL REFERENCES dim_empresa(id),
    periodo_id      INT NOT NULL REFERENCES dim_periodo(id),
    tipo            VARCHAR(40) NOT NULL,       -- categoria canônica (ordem fixa no contrato)
    valor           NUMERIC(16,2),
    UNIQUE (empresa_id, periodo_id, tipo)
);
CREATE INDEX IF NOT EXISTS ix_rec_tipo_emp_per ON fato_receita_tipo_mensal(empresa_id, periodo_id);

-- Folha de pagamento mensal por colaborador (abas 'Folha <Mês>').
--   total     = SALÁRIO BRUTO recebido (col H "TOTAL" = salário+extra);
--   total_mes = CUSTO TOTAL p/ a empresa (col T "TOTAL MÊS" = bruto+VT+VR+FGTS+INSS).
-- LGPD: o salário exato NUNCA é exposto pela API — apenas faixa (banda).
CREATE TABLE IF NOT EXISTS fato_folha_mensal (
    id           SERIAL PRIMARY KEY,
    empresa_id   INT REFERENCES dim_empresa(id),
    periodo_id   INT REFERENCES dim_periodo(id),
    nome         VARCHAR(160),
    departamento VARCHAR(120),
    cargo        VARCHAR(120),
    tipo         VARCHAR(40),
    salario      NUMERIC(14,2),
    extra        NUMERIC(14,2),
    total        NUMERIC(14,2),               -- bruto recebido (col H)
    total_mes    NUMERIC(14,2),               -- custo total empresa (col T)
    cor_id       INTEGER,                     -- id do usuário no COR (col AC "COR ID")
    cliente_dedicado VARCHAR(60),             -- cliente atendido pela pessoa (col AD)
    UNIQUE (empresa_id, periodo_id, nome, departamento, cargo)
);
-- Migração idempotente p/ DBs criados antes da coluna de custo total.
ALTER TABLE fato_folha_mensal ADD COLUMN IF NOT EXISTS total_mes NUMERIC(14,2);
-- Junção folha↔COR + cliente dedicado por pessoa (colunas novas do cliente, Jul→Dez/26).
ALTER TABLE fato_folha_mensal ADD COLUMN IF NOT EXISTS cor_id INTEGER;
ALTER TABLE fato_folha_mensal ADD COLUMN IF NOT EXISTS cliente_dedicado VARCHAR(60);

-- ----------------------------------------------------------------------------
-- 5.4 Controle de carga
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS log_carga (
    id                SERIAL PRIMARY KEY,
    empresa_id        INT REFERENCES dim_empresa(id),
    arquivo           VARCHAR(300),
    status            VARCHAR(20),              -- sucesso, erro, parcial
    linhas_carregadas INT,
    mensagem_erro     TEXT,
    executado_em      TIMESTAMP DEFAULT NOW()
);

-- ----------------------------------------------------------------------------
-- 7.x Fase 2 — COR / margem real (estrutura pronta; populada na Fase 2)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS dim_projeto (
    id          SERIAL PRIMARY KEY,
    cor_id      VARCHAR(50),
    nome        VARCHAR(200) NOT NULL,
    cliente_id  INT REFERENCES dim_cliente(id),
    empresa_id  INT REFERENCES dim_empresa(id),
    status      VARCHAR(50),
    data_inicio DATE,
    data_fim    DATE,
    criado_em   TIMESTAMP DEFAULT NOW(),
    UNIQUE (cor_id)
);

CREATE TABLE IF NOT EXISTS dim_colaborador (
    id          SERIAL PRIMARY KEY,
    cor_id      VARCHAR(50),
    nome        VARCHAR(200) NOT NULL,
    papel       VARCHAR(100),
    empresa_id  INT REFERENCES dim_empresa(id),
    ativo       BOOLEAN DEFAULT TRUE,
    UNIQUE (cor_id)
);

CREATE TABLE IF NOT EXISTS dim_custo_hora_colaborador (
    id                  SERIAL PRIMARY KEY,
    colaborador_id      INT REFERENCES dim_colaborador(id),
    custo_hora          NUMERIC(10,2) NOT NULL,
    vigencia_inicio     DATE NOT NULL,
    vigencia_fim        DATE,
    criado_em           TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS fato_cor_horas (
    id                  SERIAL PRIMARY KEY,
    empresa_id          INT REFERENCES dim_empresa(id),
    projeto_id          INT REFERENCES dim_projeto(id),
    colaborador_id      INT REFERENCES dim_colaborador(id),
    periodo_id          INT REFERENCES dim_periodo(id),
    horas_apontadas     NUMERIC(10,2),
    custo_hora          NUMERIC(10,2),
    custo_total         NUMERIC(18,2) GENERATED ALWAYS AS (horas_apontadas * custo_hora) STORED,
    carregado_em        TIMESTAMP DEFAULT NOW(),
    UNIQUE (projeto_id, colaborador_id, periodo_id)   -- evita dupla contagem em re-execução
);

-- ----------------------------------------------------------------------------
-- 5.3 Views analíticas (DRE consolidada / por empresa) + extras p/ dashboards
-- ----------------------------------------------------------------------------
CREATE OR REPLACE VIEW vw_dre_grupo_mensal AS
SELECT p.ano, p.mes, p.nome_mes, p.data, c.grupo, c.descricao,
       SUM(f.valor) AS valor_total
FROM fato_dre_mensal f
JOIN dim_conta c   ON c.id = f.conta_id
JOIN dim_periodo p ON p.id = f.periodo_id
GROUP BY p.ano, p.mes, p.nome_mes, p.data, c.grupo, c.descricao;

CREATE OR REPLACE VIEW vw_dre_empresa_mensal AS
SELECT e.codigo AS empresa, e.nome AS empresa_nome,
       p.ano, p.mes, p.nome_mes, p.data, c.grupo, c.descricao, f.valor
FROM fato_dre_mensal f
JOIN dim_empresa e ON e.id = f.empresa_id
JOIN dim_conta c   ON c.id = f.conta_id
JOIN dim_periodo p ON p.id = f.periodo_id;

-- Linhas-chave da DRE pivotadas por empresa/mês (facilita os painéis do Grafana).
-- % EBIT é RECALCULADO aqui (blueprint: não armazenar linhas de %).
CREATE OR REPLACE VIEW vw_dre_kpis_mensal AS
SELECT e.codigo AS empresa, e.nome AS empresa_nome, p.ano, p.mes, p.data,
       MAX(f.valor) FILTER (WHERE c.descricao='RECEITA BRUTA')                AS receita_bruta,
       MAX(f.valor) FILTER (WHERE c.descricao='RECEITA OPERACIONAL LIQUIDA')  AS receita_liquida,
       MAX(f.valor) FILTER (WHERE c.descricao='RESULTADO OPERACIONAL DA AGENCIA') AS resultado_agencia,
       MAX(f.valor) FILTER (WHERE c.descricao='RESULTADO OPERACIONAL ANTES DOS IMPOSTOS (EBIT)') AS ebit,
       MAX(f.valor) FILTER (WHERE c.descricao='RESULTADO LIQUIDO')            AS resultado_liquido,
       MAX(f.valor) FILTER (WHERE c.descricao='GERACAO DE CAIXA')             AS geracao_caixa
FROM fato_dre_mensal f
JOIN dim_empresa e ON e.id = f.empresa_id
JOIN dim_conta c   ON c.id = f.conta_id
JOIN dim_periodo p ON p.id = f.periodo_id
GROUP BY e.codigo, e.nome, p.ano, p.mes, p.data;

-- Margem real por projeto (Fase 2 — retorna vazio até COR ser carregado)
CREATE OR REPLACE VIEW vw_margem_projeto AS
SELECT p.nome AS projeto, e.codigo AS empresa, per.ano, per.mes,
       SUM(h.horas_apontadas) AS total_horas,
       SUM(h.custo_total)     AS custo_real_entrega,
       r.valor                AS receita_projeto,
       (r.valor - SUM(h.custo_total)) AS margem_bruta,
       CASE WHEN r.valor > 0 THEN (r.valor - SUM(h.custo_total)) / r.valor ELSE NULL END AS pct_margem
FROM fato_cor_horas h
JOIN dim_projeto p   ON p.id = h.projeto_id
JOIN dim_empresa e   ON e.id = h.empresa_id
JOIN dim_periodo per ON per.id = h.periodo_id
LEFT JOIN fato_receita_cliente_mensal r
       ON r.cliente_id = p.cliente_id AND r.periodo_id = h.periodo_id AND r.empresa_id = h.empresa_id
GROUP BY p.nome, e.codigo, per.ano, per.mes, r.valor;

-- "Última atualização" para o painel de status do dashboard
CREATE OR REPLACE VIEW vw_ultima_atualizacao AS
SELECT MAX(carregado_em) AS ultima_carga,
       (SELECT MAX(executado_em) FROM log_carga WHERE status='sucesso') AS ultimo_sucesso
FROM fato_dre_mensal;
