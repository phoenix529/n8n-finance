#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
load_real_to_db.py — carrega os DADOS REAIS (5 planilhas DRE da Ref Comunicação)
no PostgreSQL, usando o adaptador adapter_dre.py.

Fluxo (honra a arquitetura Fase 1 — Postgres é a fonte da verdade):
  1. adapter_dre.build_all_facts()  -> fatos canônicos (Jan..Jun/2026, atuais)
  2. upsert das 5 unidades em dim_company e das linhas do DRE em dim_account
  3. substitui os fatos (remove os de demonstração) e insere os reais
  4. registra a execução em pipeline_runs (telemetria Fase 1)
  5. reconciliação impressa (Receita Bruta consolidada deve bater com o relatório)

Uso:
    python data/load_real_to_db.py
Env: PGHOST/PGPORT/PGDATABASE/PGUSER/PGPASSWORD (default 127.0.0.1:5432 cockpit/postgres)
"""
import os, sys, datetime as dt
import psycopg2
from psycopg2.extras import execute_values

sys.path.insert(0, os.path.dirname(__file__))
from adapter_dre import build_all_facts, UNITS, MAX_PERIOD

# ---- metadados das 5 unidades (consolidam por soma; cliente confirmou) -------
COMPANIES = [
    # company_id, name, sector, color, is_consolidating, sort
    ("REFMAIS", "REF+", "Agência full service / mídia", "#4F6BED", True, 1),
    ("BD",      "BD",   "Produtora de filmes",          "#10B981", True, 2),
    ("VIV",     "Viv",  "Eventos & mostruário",         "#F59E0B", True, 3),
    ("4PR",     "4PR",  "PR & assessoria",              "#6E86F2", True, 4),
    ("ZUP",     "Zup",  "Tecnologia / fees",            "#8B5CF6", True, 5),
]

# ---- plano de contas do DRE da agência (account_code = code do adaptador em MAIÚSCULA)
#  account_kind ∈ {'PNL','POSICAO'} (CHECK). Todas as linhas do DRE são PNL.
#  group_code é texto livre (usado para agrupar a DRE / gastos por categoria).
#  code, name, kind, group_code, sign, sort
ACCOUNTS = [
    ("RECEITA_BRUTA",     "Receita Bruta",                  "PNL", "RECEITA",   1,  10),
    ("DEDUCOES",          "Deduções e Impostos s/ Vendas",  "PNL", "RECEITA",  -1,  20),
    ("RECEITA_LIQUIDA",   "Receita Operacional Líquida",    "PNL", "RECEITA",   1,  30),
    ("CUSTOS",            "Custos dos Serviços Vendidos",   "PNL", "CUSTO",    -1,  40),
    ("RESULTADO_AGENCIA", "Resultado Operacional (Lucro Bruto)", "PNL", "RESULTADO", 1, 50),
    ("DESP_PESSOAL",      "Gastos com Pessoal",             "PNL", "OPEX",     -1,  60),
    ("DESP_INFRA",        "Infraestrutura",                 "PNL", "OPEX",     -1,  70),
    ("DESP_OUTRAS",       "Outras Despesas",                "PNL", "OPEX",     -1,  80),
    ("DESP_ADM",          "Despesas Administrativas",       "PNL", "OPEX",     -1,  90),
    ("TRIBUTOS",          "Tributos Federais (IRPJ+CSLL)",  "PNL", "IMPOSTO",  -1, 100),
    ("EBIT",              "Resultado Operacional (EBIT)",   "PNL", "RESULTADO", 1, 110),
    ("RESULTADO_LIQUIDO", "Resultado Líquido",              "PNL", "RESULTADO", 1, 120),
    ("GERACAO_CAIXA",     "Geração de Caixa",               "PNL", "CAIXA",     1, 130),
]


def connect():
    return psycopg2.connect(
        host=os.environ.get("PGHOST", "127.0.0.1"), port=int(os.environ.get("PGPORT", "5432")),
        dbname=os.environ.get("PGDATABASE", "cockpit"), user=os.environ.get("PGUSER", "postgres"),
        password=os.environ.get("PGPASSWORD", "postgres"), connect_timeout=8)


def main():
    facts = build_all_facts()
    if not facts:
        raise SystemExit("Nenhum fato extraído das planilhas (data/incoming).")
    started = dt.datetime.now(dt.timezone.utc)
    load_id = "real-dre-2026"

    con = connect(); con.autocommit = False
    cur = con.cursor()
    try:
        # 1) dim_company (upsert)
        execute_values(cur, """
            INSERT INTO cockpit.dim_company (company_id, name, sector, color, is_consolidating, sort)
            VALUES %s
            ON CONFLICT (company_id) DO UPDATE SET
              name=EXCLUDED.name, sector=EXCLUDED.sector, color=EXCLUDED.color,
              is_consolidating=EXCLUDED.is_consolidating, sort=EXCLUDED.sort
        """, COMPANIES)

        # 2) dim_account (upsert)
        execute_values(cur, """
            INSERT INTO cockpit.dim_account (account_code, account_name, account_kind, group_code, sign, sort)
            VALUES %s
            ON CONFLICT (account_code) DO UPDATE SET
              account_name=EXCLUDED.account_name, account_kind=EXCLUDED.account_kind,
              group_code=EXCLUDED.group_code, sign=EXCLUDED.sign, sort=EXCLUDED.sort
        """, ACCOUNTS)

        # 3) substitui os fatos (remove demo) e insere os reais
        # dados reais são SOMENTE ATUAIS (sem orçamento) -> orçado passa a aceitar NULL
        cur.execute("ALTER TABLE cockpit.fact_financials ALTER COLUMN valor_orcado DROP NOT NULL")
        cur.execute("DELETE FROM cockpit.fact_financials")
        rows = []
        for f in facts:
            rows.append((
                f["unidade"],                       # company_id
                f["periodo"] + "-01",               # period_date (1º dia do mês)
                f["code"].upper(),                  # account_code
                round(f["valor"], 2),               # valor_realizado
                None,                               # valor_orcado (somente atuais)
                f"{f['unidade_nome']} - DRE Acumulado 2026.xlsx",
                load_id,
            ))
        execute_values(cur, """
            INSERT INTO cockpit.fact_financials
              (company_id, period_date, account_code, valor_realizado, valor_orcado, source_file, load_id)
            VALUES %s
            ON CONFLICT (company_id, period_date, account_code) DO UPDATE SET
              valor_realizado=EXCLUDED.valor_realizado, valor_orcado=EXCLUDED.valor_orcado,
              source_file=EXCLUDED.source_file, load_id=EXCLUDED.load_id
        """, rows)

        # 4) telemetria pipeline_runs
        finished = dt.datetime.now(dt.timezone.utc)
        cur.execute("DELETE FROM cockpit.pipeline_runs WHERE load_id=%s", (load_id,))
        cur.execute("""
            INSERT INTO cockpit.pipeline_runs
              (load_id, workflow, source_file, status, rows_total, rows_ok, rows_quarantined,
               started_at, finished_at, retries, message)
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
        """, (load_id, "carga_real_dre", "5 planilhas DRE Acumulado 2026", "OK",
              len(rows), len(rows), 0, started, finished, 0,
              f"Carga real: 5 unidades, {MAX_PERIOD[-2:]} meses (atuais), projeções descartadas."))

        con.commit()
    except Exception:
        con.rollback(); raise

    # 5) reconciliação
    cur.execute("""
        SELECT a.account_code, SUM(f.valor_realizado)
        FROM cockpit.fact_financials f JOIN cockpit.dim_account a USING (account_code)
        WHERE a.account_code IN ('RECEITA_BRUTA','RECEITA_LIQUIDA','EBIT','RESULTADO_LIQUIDO','GERACAO_CAIXA')
        GROUP BY a.account_code""")
    agg = dict(cur.fetchall())
    cur.execute("SELECT count(*), count(distinct company_id), min(period_date), max(period_date) FROM cockpit.fact_financials")
    n, ncomp, pmin, pmax = cur.fetchone()
    cur.close(); con.close()

    print("=" * 70)
    print(f"CARGA REAL concluída → PostgreSQL/cockpit  (load_id={load_id})")
    print("=" * 70)
    print(f"  fatos inseridos : {n:>6}   unidades: {ncomp}   período: {pmin} … {pmax}")
    fmt = lambda v: f"R$ {float(v)/1e6:,.2f} mi" if v is not None else "—"
    print(f"  Receita Bruta   : {fmt(agg.get('RECEITA_BRUTA'))}   (esperado ~R$ 89,17 mi)")
    print(f"  Receita Líquida : {fmt(agg.get('RECEITA_LIQUIDA'))}")
    print(f"  EBIT            : {fmt(agg.get('EBIT'))}")
    print(f"  Resultado Líq.  : {fmt(agg.get('RESULTADO_LIQUIDO'))}")
    print(f"  Geração de Caixa: {fmt(agg.get('GERACAO_CAIXA'))}")


if __name__ == "__main__":
    main()
