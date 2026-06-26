#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
cor_loader.py — integração com o COR (Technical Blueprint §7.1) — ESQUELETO Fase 2.

Extrai /projects, /users e /time-entries do COR (REST, Bearer token) e carrega
dim_projeto, dim_colaborador e fato_cor_horas. A margem real é calculada pela view
vw_margem_projeto (já criada). BLOQUEADO até o cliente fornecer:
  - COR_API_TOKEN          (token da API do COR)
  - custo/hora por colaborador (dim_custo_hora_colaborador)

Env:  COR_BASE_URL, COR_API_TOKEN, DB_* (via .env)
Uso:  cd ingestao && python cor_loader.py
"""
import os, sys, json, datetime as dt, urllib.request, urllib.error
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from db import get_conn   # reutiliza conexão/.env

COR_BASE_URL = os.environ.get("COR_BASE_URL", "https://api.cor.live")  # ajustar conforme doc do COR
COR_API_TOKEN = os.environ.get("COR_API_TOKEN", "")


def _get(path, params=None):
    url = COR_BASE_URL.rstrip("/") + path
    if params:
        import urllib.parse
        url += "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {COR_API_TOKEN}",
                                               "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode("utf-8"))


def upsert_projetos(rows):
    con = get_conn(); cur = con.cursor()
    for p in rows:
        cur.execute("""INSERT INTO dim_projeto (cor_id, nome, status, data_inicio, data_fim)
                       VALUES (%s,%s,%s,%s,%s) ON CONFLICT (cor_id) DO UPDATE
                       SET nome=EXCLUDED.nome, status=EXCLUDED.status""",
                    (str(p.get("id")), p.get("name", "?"), p.get("status"),
                     p.get("start_date"), p.get("end_date")))
    con.commit(); con.close()


def upsert_colaboradores(rows):
    con = get_conn(); cur = con.cursor()
    for u in rows:
        cur.execute("""INSERT INTO dim_colaborador (cor_id, nome, papel)
                       VALUES (%s,%s,%s) ON CONFLICT (cor_id) DO UPDATE SET nome=EXCLUDED.nome""",
                    (str(u.get("id")), u.get("name", "?"), u.get("role")))
    con.commit(); con.close()


def load_time_entries(rows):
    """fato_cor_horas: usa custo/hora vigente de dim_custo_hora_colaborador."""
    con = get_conn(); cur = con.cursor()
    for t in rows:
        d = t.get("date")
        per = dt.date.fromisoformat(d) if d else None
        cur.execute("SELECT id FROM dim_projeto WHERE cor_id=%s", (str(t.get("project")),))
        pj = cur.fetchone()
        cur.execute("SELECT id FROM dim_colaborador WHERE cor_id=%s", (str(t.get("user")),))
        co = cur.fetchone()
        if not (pj and co and per):
            continue
        cur.execute("""SELECT custo_hora FROM dim_custo_hora_colaborador
                       WHERE colaborador_id=%s AND vigencia_inicio<=%s
                       AND (vigencia_fim IS NULL OR vigencia_fim>=%s) ORDER BY vigencia_inicio DESC LIMIT 1""",
                    (co[0], per, per))
        ch = cur.fetchone()
        custo_hora = float(ch[0]) if ch else None
        if custo_hora is None:
            continue   # blueprint §10: não estimar; aguardar custo/hora
        cur.execute("""INSERT INTO dim_periodo (data, ano, mes, trimestre, semestre, nome_mes)
                       VALUES (make_date(%s,%s,1),%s,%s,%s,%s,%s)
                       ON CONFLICT (data) DO UPDATE SET ano=EXCLUDED.ano RETURNING id""",
                    (per.year, per.month, per.year, per.month, (per.month-1)//3+1,
                     1 if per.month <= 6 else 2, per.strftime("%b").upper()))
        pid = cur.fetchone()[0]
        cur.execute("""INSERT INTO fato_cor_horas (projeto_id, colaborador_id, periodo_id, horas_apontadas, custo_hora)
                       VALUES (%s,%s,%s,%s,%s)
                       ON CONFLICT (projeto_id, colaborador_id, periodo_id)
                       DO UPDATE SET horas_apontadas=EXCLUDED.horas_apontadas,
                                     custo_hora=EXCLUDED.custo_hora, carregado_em=NOW()""",
                    (pj[0], co[0], pid, t.get("hours", 0), custo_hora))
    con.commit(); con.close()


def run():
    """Executa a carga COR IN-PROCESS; devolve {ok, output}. BLOQUEADO sem COR_API_TOKEN."""
    if not COR_API_TOKEN:
        return {"ok": False, "output": "BLOQUEADO: defina COR_API_TOKEN no .env e popule "
                                       "dim_custo_hora_colaborador (custo/hora por colaborador)."}
    try:
        upsert_colaboradores(_get("/users"))
        upsert_projetos(_get("/projects"))
        hoje = dt.date.today()
        inicio = (hoje.replace(day=1) - dt.timedelta(days=30)).isoformat()
        load_time_entries(_get("/time-entries", {"from": inicio, "to": hoje.isoformat()}))
        return {"ok": True, "output": "COR carregado. Margem real disponível em vw_margem_projeto."}
    except Exception as e:
        return {"ok": False, "output": f"ERRO COR: {e}"}


def main():
    r = run()
    print(r["output"])
    sys.exit(0 if r["ok"] else 2)


if __name__ == "__main__":
    main()
