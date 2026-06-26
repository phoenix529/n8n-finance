#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
db.py — conexão e funções de carga no PostgreSQL (Technical Blueprint §6.2).
Lê credenciais do .env (DB_HOST/DB_PORT/DB_NAME/DB_USER/DB_PASSWORD).
Expõe: get_conn, upsert_dre(empresa, df), upsert_receita_cliente(df), log_carga(...).
"""
import os, pathlib
import psycopg2
from psycopg2.extras import execute_values

# carrega .env do diretório do projeto (sem sobrescrever variáveis já definidas)
ROOT = pathlib.Path(__file__).resolve().parent.parent
_envp = ROOT / ".env"
if _envp.exists():
    for line in _envp.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip())

DB = dict(host=os.environ.get("DB_HOST", "127.0.0.1"), port=int(os.environ.get("DB_PORT", "5432")),
          dbname=os.environ.get("DB_NAME", "cockpit_ref"), user=os.environ.get("DB_USER", "cockpit_user"),
          password=os.environ.get("DB_PASSWORD"))   # nunca hardcoded — vem do .env (§8)

# metadados das empresas (codigo -> nome, tipo)
EMPRESAS = {
    "REF": ("REF Comunicação", "agency"),
    "BD":  ("BD", "production company"),
    "4PR": ("4PR", "agency"),
    "VIV": ("Viv", "agency"),
    "ZUP": ("Zup", "tech"),
}


def get_conn():
    return psycopg2.connect(connect_timeout=8, **DB)


# ---- caches de dimensão (por conexão) ---------------------------------------
def _empresa_id(cur, codigo, cache):
    if codigo in cache:
        return cache[codigo]
    nome, tipo = EMPRESAS.get(codigo, (codigo, None))
    cur.execute("""INSERT INTO dim_empresa (codigo, nome, tipo) VALUES (%s,%s,%s)
                   ON CONFLICT (codigo) DO UPDATE SET nome=EXCLUDED.nome, tipo=EXCLUDED.tipo
                   RETURNING id""", (codigo, nome, tipo))
    cache[codigo] = cur.fetchone()[0]
    return cache[codigo]


def _conta_id(cur, descricao, grupo, tipo, cache, codigo_conta=None):
    if descricao in cache:
        return cache[descricao]
    cur.execute("""INSERT INTO dim_conta (codigo_conta, descricao, grupo, tipo) VALUES (%s,%s,%s,%s)
                   ON CONFLICT (descricao) DO UPDATE SET grupo=EXCLUDED.grupo, tipo=EXCLUDED.tipo
                   RETURNING id""", (codigo_conta, descricao, grupo, tipo))
    cache[descricao] = cur.fetchone()[0]
    return cache[descricao]


def _periodo_id(cur, year, month, cache):
    key = (year, month)
    if key in cache:
        return cache[key]
    import datetime as dt
    data = dt.date(year, month, 1)
    tri = (month - 1) // 3 + 1
    sem = 1 if month <= 6 else 2
    nome = ["JAN", "FEV", "MAR", "ABR", "MAI", "JUN", "JUL", "AGO", "SET", "OUT", "NOV", "DEZ"][month - 1]
    cur.execute("""INSERT INTO dim_periodo (data, ano, mes, trimestre, semestre, nome_mes)
                   VALUES (%s,%s,%s,%s,%s,%s)
                   ON CONFLICT (data) DO UPDATE SET ano=EXCLUDED.ano RETURNING id""",
                (data, year, month, tri, sem, nome))
    cache[key] = cur.fetchone()[0]
    return cache[key]


def _cliente_id(cur, nome, empresa_id, cache):
    key = (nome, empresa_id)
    if key in cache:
        return cache[key]
    cur.execute("""INSERT INTO dim_cliente (nome, empresa_id) VALUES (%s,%s)
                   ON CONFLICT (nome, empresa_id) DO UPDATE SET ativo=TRUE RETURNING id""",
                (nome, empresa_id))
    cache[key] = cur.fetchone()[0]
    return cache[key]


# ---- cargas -----------------------------------------------------------------
def upsert_dre(empresa, df):
    """Insere/atualiza fato_dre_mensal a partir do DataFrame normalizado. Retorna nº de linhas."""
    if df is None or len(df) == 0:
        return 0
    con = get_conn(); con.autocommit = False
    try:
        cur = con.cursor()
        ec, cc, pc = {}, {}, {}
        emp_id = _empresa_id(cur, empresa, ec)
        # mapa descricao->grupo/tipo (do próprio df)
        meta = {r["account_description"]: (r["group"], r.get("tipo")) for _, r in df.iterrows()}
        # garante contas e períodos
        from parsers.base import CANON
        tipos = {d: t for d, g, t, _ in CANON}
        valores = []
        for _, r in df.iterrows():
            cid = _conta_id(cur, r["account_description"], r["group"], tipos.get(r["account_description"]), cc, r.get("account_code"))
            pid = _periodo_id(cur, int(r["year"]), int(r["month"]), pc)
            valores.append((emp_id, cid, pid, float(r["value"]), r["source"]))
        execute_values(cur, """
            INSERT INTO fato_dre_mensal (empresa_id, conta_id, periodo_id, valor, fonte)
            VALUES %s
            ON CONFLICT (empresa_id, conta_id, periodo_id)
            DO UPDATE SET valor=EXCLUDED.valor, fonte=EXCLUDED.fonte, carregado_em=NOW()
        """, valores)
        con.commit()
        return len(valores)
    except Exception:
        con.rollback(); raise
    finally:
        con.close()


def upsert_receita_cliente(df):
    """Insere/atualiza fato_receita_cliente_mensal. Retorna nº de linhas."""
    if df is None or len(df) == 0:
        return 0
    con = get_conn(); con.autocommit = False
    try:
        cur = con.cursor()
        ec, pc, clc = {}, {}, {}
        valores = []
        for _, r in df.iterrows():
            emp_id = _empresa_id(cur, r["company"], ec)
            cli_id = _cliente_id(cur, r["cliente"], emp_id, clc)
            pid = _periodo_id(cur, int(r["year"]), int(r["month"]), pc)
            valores.append((emp_id, cli_id, pid, r["tipo_receita"], float(r["value"])))
        execute_values(cur, """
            INSERT INTO fato_receita_cliente_mensal (empresa_id, cliente_id, periodo_id, tipo_receita, valor)
            VALUES %s
            ON CONFLICT (empresa_id, cliente_id, periodo_id, tipo_receita)
            DO UPDATE SET valor=EXCLUDED.valor, carregado_em=NOW()
        """, valores)
        con.commit()
        return len(valores)
    except Exception:
        con.rollback(); raise
    finally:
        con.close()


def log_carga(empresa, arquivo, status, info):
    """Registra a execução em log_carga. `info` = nº de linhas (sucesso) ou mensagem/erros."""
    linhas = info if isinstance(info, int) else None
    msg = None if isinstance(info, int) else (info if isinstance(info, str) else "; ".join(map(str, info)))
    con = get_conn(); con.autocommit = True
    try:
        cur = con.cursor()
        cur.execute("SELECT id FROM dim_empresa WHERE codigo=%s", (empresa,))
        row = cur.fetchone()
        emp_id = row[0] if row else None
        cur.execute("""INSERT INTO log_carga (empresa_id, arquivo, status, linhas_carregadas, mensagem_erro)
                       VALUES (%s,%s,%s,%s,%s)""",
                    (emp_id, os.path.basename(arquivo), status, linhas, msg))
    finally:
        con.close()
