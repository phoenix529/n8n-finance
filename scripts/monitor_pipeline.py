#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
monitor_pipeline.py — heartbeat / alerta de saúde do pipeline de ingestão (Fase 1).

Verifica `cockpit.pipeline_runs` / `cockpit.quarantine_rows` e reporta a saúde
operacional para suportar o critério de sucesso da Fase 1 (pipeline rodando 10 dias
sem intervenção). Pensado para rodar agendado (ex.: de hora em hora) e alimentar
alertas: o código de saída sinaliza o nível mais grave encontrado.

    exit 0 = OK | exit 1 = WARN | exit 2 = ALERT

Checagens:
  1. Runs presas em RUNNING há mais de --stuck-min minutos          -> ALERT
  2. Sem run concluído (OK/PARTIAL) nas últimas --silent-h horas    -> ALERT (pipeline silencioso)
  3. Runs com status ERROR nas últimas 24h                          -> WARN
  4. Taxa de quarentena do último run acima de --quar-pct %         -> WARN
  5. Heartbeat: nº de runs concluídos nos últimos 10 dias + último run

Config via env PG* (igual aos demais scripts).
"""
import os, sys, argparse

try:
    import psycopg2
except ImportError:
    sys.exit("psycopg2 não instalado (pip install psycopg2-binary).")


def connect():
    return psycopg2.connect(
        host=os.environ.get("PGHOST", "127.0.0.1"),
        port=int(os.environ.get("PGPORT", "5432")),
        dbname=os.environ.get("PGDATABASE", "cockpit"),
        user=os.environ.get("PGUSER", "postgres"),
        password=os.environ.get("PGPASSWORD", "postgres"),
    )


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--stuck-min", type=int, default=30)
    ap.add_argument("--silent-h", type=int, default=26)   # > 1 dia (run diário)
    ap.add_argument("--quar-pct", type=float, default=20.0)
    args = ap.parse_args()

    conn = connect(); conn.autocommit = True
    cur = conn.cursor()
    level = 0
    print("=" * 60)
    print("Monitor do pipeline de ingestão — Cockpit Financeiro")
    print("=" * 60)

    # 1. Runs presas em RUNNING
    cur.execute("""SELECT count(*) FROM cockpit.pipeline_runs
                   WHERE status='RUNNING'
                     AND started_at < now() - (%s || ' minutes')::interval""", (args.stuck_min,))
    stuck = cur.fetchone()[0]
    if stuck:
        level = max(level, 2); print(f"[ALERT] {stuck} run(s) presa(s) em RUNNING há > {args.stuck_min} min")
    else:
        print(f"[OK]    nenhuma run presa em RUNNING (> {args.stuck_min} min)")

    # 2. Silêncio: último run concluído
    cur.execute("""SELECT max(finished_at) FROM cockpit.pipeline_runs
                   WHERE status IN ('OK','PARTIAL')""")
    last_ok = cur.fetchone()[0]
    if last_ok is None:
        level = max(level, 2); print("[ALERT] nenhum run concluído (OK/PARTIAL) registrado")
    else:
        cur.execute("SELECT (now() - %s) < (%s || ' hours')::interval", (last_ok, args.silent_h))
        recent = cur.fetchone()[0]
        if recent:
            print(f"[OK]    último run concluído em {last_ok:%Y-%m-%d %H:%M} (< {args.silent_h}h)")
        else:
            level = max(level, 2); print(f"[ALERT] sem run concluído há > {args.silent_h}h (último: {last_ok})")

    # 3. Runs com ERROR nas últimas 24h
    cur.execute("""SELECT count(*) FROM cockpit.pipeline_runs
                   WHERE status='ERROR' AND started_at > now() - interval '24 hours'""")
    errs = cur.fetchone()[0]
    if errs:
        level = max(level, 1); print(f"[WARN]  {errs} run(s) com status ERROR nas últimas 24h")
    else:
        print("[OK]    nenhuma run com ERROR nas últimas 24h")

    # 4. Taxa de quarentena do último run
    cur.execute("""SELECT load_id, rows_total, rows_quarantined
                   FROM cockpit.pipeline_runs
                   WHERE status IN ('OK','PARTIAL') ORDER BY finished_at DESC NULLS LAST LIMIT 1""")
    row = cur.fetchone()
    if row and row[1]:
        pct = 100.0 * (row[2] or 0) / row[1]
        if pct > args.quar_pct:
            level = max(level, 1); print(f"[WARN]  taxa de quarentena do último run = {pct:.1f}% (> {args.quar_pct}%) [{row[0]}]")
        else:
            print(f"[OK]    taxa de quarentena do último run = {pct:.1f}% (<= {args.quar_pct}%)")

    # 5. Heartbeat — runs nos últimos 10 dias
    cur.execute("""SELECT count(*) FROM cockpit.pipeline_runs
                   WHERE status IN ('OK','PARTIAL') AND started_at > now() - interval '10 days'""")
    n10 = cur.fetchone()[0]
    print(f"[INFO]  runs concluídos nos últimos 10 dias: {n10}")

    cur.close(); conn.close()
    print("-" * 60)
    verdict = {0: "OK", 1: "WARN", 2: "ALERT"}[level]
    print(f"VEREDITO: {verdict}")
    return level


if __name__ == "__main__":
    sys.exit(main())
