#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
run_ingestion.py — Ingestao de planilhas (Fase 1) via CLI, espelhando 1:1 a logica do
workflow n8n `01_ingestao_planilhas.json` (no `Code` node "Validacao de Schema").

Para cada arquivo data/raw/upload_*.xlsx:
  1. abre uma execucao em cockpit.pipeline_runs (status RUNNING);
  2. grava cada linha crua em cockpit.stg_financials;
  3. valida o schema da linha:
        - colunas obrigatorias presentes
        - empresa (nome) existe em dim_company        -> EMPRESA_DESCONHECIDA
        - periodo 'YYYY-MM' parseavel                  -> PERIODO_INVALIDO
        - conta_codigo existe em dim_account           -> CONTA_DESCONHECIDA
        - valor_realizado / valor_orcado numericos     -> VALOR_NAO_NUMERICO
  4. linha VALIDA  -> UPSERT idempotente em cockpit.fact_financials
     linha INVALIDA-> cockpit.quarantine_rows (com error_code/detail + raw_payload jsonb)
  5. registra cockpit.ingestion_log e fecha pipeline_runs (success) com contagens.

Uso:
    python scripts/run_ingestion.py                 # ingere data/raw/upload_*.xlsx
    python scripts/run_ingestion.py <glob...>       # ingere arquivos especificos

Config via env (default = instancia local de demo):
    PGHOST=127.0.0.1 PGPORT=5432 PGDATABASE=cockpit PGUSER=postgres PGPASSWORD=postgres
"""
import os, sys, glob, json, datetime as dt

try:
    import openpyxl
except ImportError:
    sys.exit("ERRO: openpyxl nao instalado (pip install openpyxl).")
try:
    import psycopg2
    import psycopg2.extras
except ImportError:
    sys.exit("ERRO: psycopg2 nao instalado (pip install psycopg2-binary).")

REQUIRED_COLS = ["empresa", "periodo", "conta_codigo", "conta_nome",
                 "valor_realizado", "valor_orcado"]


def connect():
    return psycopg2.connect(
        host=os.environ.get("PGHOST", "127.0.0.1"),
        port=int(os.environ.get("PGPORT", "5432")),
        dbname=os.environ.get("PGDATABASE", "cockpit"),
        user=os.environ.get("PGUSER", "postgres"),
        password=os.environ.get("PGPASSWORD", "postgres"),
    )


def with_retry(fn, tries=3, base=0.5, exc=Exception, label=""):
    """Executa fn() com ate `tries` tentativas e backoff exponencial. Confiabilidade
    da Fase 1: resiliencia a falhas transitorias do banco (espelha o retryOnFail dos
    nos Postgres do n8n)."""
    import time
    last = None
    for i in range(tries):
        try:
            return fn()
        except exc as e:
            last = e
            wait = base * (2 ** i)
            print(f"[retry] {label} falhou (tentativa {i+1}/{tries}): {e} -> aguardando {wait:.1f}s")
            time.sleep(wait)
    raise last


def connect_with_retry(tries=5):
    return with_retry(connect, tries=tries, base=0.5,
                      exc=psycopg2.OperationalError, label="conexao Postgres")


def selftest_retry():
    """Prova que o retry com backoff funciona: a chamada falha 2x e sucede na 3a."""
    print("Autoteste de retry (falha transitoria simulada 2x, sucesso na 3a):")
    state = {"n": 0}

    def flaky():
        state["n"] += 1
        if state["n"] < 3:
            raise psycopg2.OperationalError(f"falha transitoria simulada #{state['n']}")
        return "conexao estabelecida"

    res = with_retry(flaky, tries=3, base=0.2,
                     exc=psycopg2.OperationalError, label="conexao")
    print(f"-> {res} apos {state['n']} tentativas. OK: retry/backoff funcionando.")
    return 0


def parse_period(s):
    """'YYYY-MM' -> date(first day). Levanta ValueError em mes invalido (ex.: 2026-13)."""
    return dt.datetime.strptime(str(s).strip() + "-01", "%Y-%m-%d").date()


def parse_money(v):
    """Numero -> float. Aceita string numerica simples. Caso contrario, ValueError."""
    if isinstance(v, (int, float)):
        return float(v)
    return float(str(v).strip())  # 'R$ doze mil' -> ValueError


def validate(row, valid_companies, valid_accounts):
    """Retorna (company_id, period_date, vr, vo) se valido; senao levanta (code, detail)."""
    for c in REQUIRED_COLS:
        if row.get(c) in (None, ""):
            raise ValueError(("COLUNA_AUSENTE", f"coluna obrigatoria ausente/vazia: {c}"))
    empresa = str(row["empresa"]).strip()
    company_id = valid_companies.get(empresa)
    if company_id is None:
        raise ValueError(("EMPRESA_DESCONHECIDA", f"empresa fora do perimetro: {empresa!r}"))
    try:
        period_date = parse_period(row["periodo"])
    except ValueError:
        raise ValueError(("PERIODO_INVALIDO", f"periodo nao parseavel: {row['periodo']!r}"))
    code = str(row["conta_codigo"]).strip()
    if code not in valid_accounts:
        raise ValueError(("CONTA_DESCONHECIDA", f"conta_codigo fora do plano: {code!r}"))
    try:
        vr = parse_money(row["valor_realizado"])
        vo = parse_money(row["valor_orcado"])
    except ValueError:
        raise ValueError(("VALOR_NAO_NUMERICO",
                          f"valor nao numerico: realizado={row['valor_realizado']!r} "
                          f"orcado={row['valor_orcado']!r}"))
    return company_id, period_date, code, vr, vo


def ingest_file(cur, path, valid_companies, valid_accounts):
    src = os.path.basename(path)
    load_id = f"cli-{os.path.splitext(src)[0]}"
    cur.execute(
        """INSERT INTO cockpit.pipeline_runs
             (load_id, workflow, source_file, status, started_at)
           VALUES (%s, 'run_ingestion.py', %s, 'RUNNING', now())
           ON CONFLICT (load_id) DO UPDATE
             SET status='RUNNING', started_at=now(),
                 rows_total=0, rows_ok=0, rows_quarantined=0, retries=0, message=NULL""",
        (load_id, src))

    wb = openpyxl.load_workbook(path, data_only=True)
    ws = wb.active
    rows = list(ws.iter_rows(values_only=True))
    header = [str(h).strip() if h is not None else "" for h in rows[0]]
    total = ok = quar = 0

    for i, raw in enumerate(rows[1:], start=2):
        total += 1
        row = {header[j]: raw[j] if j < len(raw) else None for j in range(len(header))}
        payload = {k: (None if v is None else str(v)) for k, v in row.items()}
        # 1) staging cru (todos os campos como texto)
        cur.execute(
            """INSERT INTO cockpit.stg_financials
                 (load_id, source_file, row_num, company_id, period_date,
                  account_code, valor_realizado, valor_orcado, raw_payload)
               VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
            (load_id, src, i, payload.get("empresa"), payload.get("periodo"),
             payload.get("conta_codigo"), payload.get("valor_realizado"),
             payload.get("valor_orcado"), json.dumps(payload, ensure_ascii=False)))
        # 2) validacao -> fact ou quarentena
        try:
            company_id, period_date, code, vr, vo = validate(row, valid_companies, valid_accounts)
        except ValueError as e:
            code, detail = e.args[0]
            quar += 1
            cur.execute(
                """INSERT INTO cockpit.quarantine_rows
                     (load_id, source_file, row_num, raw_payload, error_code, error_detail)
                   VALUES (%s,%s,%s,%s,%s,%s)""",
                (load_id, src, i, json.dumps(payload, ensure_ascii=False), code, detail))
            continue
        ok += 1
        cur.execute(
            """INSERT INTO cockpit.fact_financials
                 (company_id, period_date, account_code, valor_realizado, valor_orcado,
                  source_file, load_id)
               VALUES (%s,%s,%s,%s,%s,%s,%s)
               ON CONFLICT (company_id, period_date, account_code) DO UPDATE
                 SET valor_realizado=EXCLUDED.valor_realizado,
                     valor_orcado=EXCLUDED.valor_orcado,
                     source_file=EXCLUDED.source_file, load_id=EXCLUDED.load_id""",
            (company_id, period_date, code, vr, vo, src, load_id))

    cur.execute(
        """INSERT INTO cockpit.ingestion_log (load_id, level, step, message, payload)
           VALUES (%s,'INFO','validacao',%s,%s)""",
        (load_id, f"{src}: {ok} ok, {quar} em quarentena de {total} linhas",
         json.dumps({"rows_total": total, "rows_ok": ok, "rows_quarantined": quar})))
    run_status = "OK" if quar == 0 else "PARTIAL"   # ERROR fica para excecoes de pipeline
    cur.execute(
        """UPDATE cockpit.pipeline_runs
             SET status=%s, finished_at=now(),
                 rows_total=%s, rows_ok=%s, rows_quarantined=%s,
                 message=%s
           WHERE load_id=%s""",
        (run_status, total, ok, quar,
         f"{ok}/{total} carregadas, {quar} em quarentena", load_id))
    return src, total, ok, quar


def main():
    if "--selftest-retry" in sys.argv:
        return selftest_retry()
    patterns = [a for a in sys.argv[1:] if not a.startswith("-")] or [
        os.path.join(os.path.dirname(__file__), "..", "data", "raw", "upload_*.xlsx")]
    files = sorted({f for p in patterns for f in glob.glob(p)})
    if not files:
        sys.exit("Nenhum arquivo encontrado para: " + ", ".join(patterns))

    conn = connect_with_retry()        # resiliência: reconecta em falha transitória
    conn.autocommit = False
    cur = conn.cursor()
    # lookups de validacao a partir das dimensoes
    cur.execute("SELECT name, company_id FROM cockpit.dim_company")
    valid_companies = {n: cid for (n, cid) in cur.fetchall()}
    cur.execute("SELECT account_code FROM cockpit.dim_account")
    valid_accounts = {r[0] for r in cur.fetchall()}

    print("=" * 64)
    print("Ingestao de planilhas (Fase 1) — run_ingestion.py")
    print("=" * 64)
    results = []
    for f in files:
        results.append(ingest_file(cur, f, valid_companies, valid_accounts))
    conn.commit()

    for src, total, ok, quar in results:
        print(f"  {src:<40} total={total:>3}  ok={ok:>3}  quarentena={quar:>3}")
    cur.close()
    conn.close()
    print("-" * 64)
    print("OK — ingestao concluida (commit).")


if __name__ == "__main__":
    main()
