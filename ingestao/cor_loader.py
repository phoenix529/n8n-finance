#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
cor_loader.py — integração com o COR (projectcor.com) — Technical Blueprint §7.1/§7.2.

Extrai /users, /projects e /hours da API REST do COR e carrega dim_colaborador,
dim_projeto e fato_cor_horas. A margem real por projeto sai da view vw_margem_projeto.

AUTENTICAÇÃO (verificada 2026-07): OAuth2 client-credentials —
  POST {BASE}/oauth/token?grant_type=client_credentials
  header  Authorization: Basic base64(COR_API_KEY:COR_CLIENT_SECRET), corpo vazio
  → {access_token (JWT ~1h), type:"bearer"} → usar  Authorization: Bearer <token>.
Paginação: ?page=N&perPage=... (resp: total, perPage, page, lastPage, data).
/hours usa filtro em JSON url-encoded: ?filters={"dateStart":"YYYY-MM-DD","dateDeadline":"..."}.

CUSTO/HORA: o COR guarda `salary` e `monthly_hours` por colaborador (endpoint de
detalhe /users/{id}); derivamos custo_hora = salary / monthly_hours e gravamos em
dim_custo_hora_colaborador (vigência aberta) — assim a margem funciona sem planilha
extra. O campo `cost` das horas do COR ainda vem majoritariamente zerado (config.
incompleta), por isso NÃO o usamos como fonte de custo.

EMPRESA POR PROJETO (pendência do cliente): o COR é UMA empresa só ('Grupo REF',
company_id 13305); as 5 empresas do grupo aparecem como clientes/brands, sem um
campo único que diga qual das 5 executou o projeto. Enquanto o cliente não define a
regra, `_empresa_do_projeto` faz best-effort por nome do cliente COR e, sem match,
deixa empresa_id NULL (a hora é carregada mesmo assim; a margem por-empresa fica
pendente do vínculo). Preencha COR_CLIENTE_EMPRESA quando a regra for definida.

Env:  COR_API_KEY, COR_CLIENT_SECRET, COR_BASE_URL (default abaixo), DB_* (via .env)
Uso:  cd ingestao && python cor_loader.py
"""
import os, sys, json, time, base64, datetime as dt
import urllib.request, urllib.error, urllib.parse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from db import get_conn                      # reutiliza conexão/.env
try:
    from db import log_carga                 # log opcional (mesma tabela da ingestão)
except Exception:                            # pragma: no cover
    def log_carga(*a, **k): pass

COR_BASE_URL = os.environ.get("COR_BASE_URL", "https://api.projectcor.com/v1")
COR_API_KEY = os.environ.get("COR_API_KEY", "").strip()
COR_CLIENT_SECRET = os.environ.get("COR_CLIENT_SECRET", "").strip()
PER_PAGE = 100                               # menos páginas por recurso

# Empresa do COLABORADOR pela LABEL do COR (mecanismo escolhido pelo cliente):
# cada pessoa recebe uma label da sua empresa. nome da label (upper) → codigo dim_empresa.
# O custo de cada hora é atribuído à empresa de QUEM apontou — atribuição exata.
COR_LABEL_EMPRESA = {
    "REF": "REF", "REF+": "REF", "REF +": "REF",
    "BD": "BD", "BLACKDOOR": "BD", "BLACK DOOR": "BD",
    "4IN": "4PR", "4INFLUENCE": "4PR",
    "VIV": "VIV", "VIV EXPERIENCE": "VIV",
    "ZUP": "ZUP", "ZUPTECH": "ZUP",
}
# Fallback (projeto): best-effort por nome do cliente COR, usado só quando o
# colaborador não tem label de empresa.
COR_CLIENTE_EMPRESA = {
    "REF +": "REF", "REF+": "REF", "GRUPO REF": "REF",
    "BLACKDOOR": "BD", "BLDO": "BD",
    "4INFLUENCE": "4PR", "4IN": "4PR",
    "VIV": "VIV", "ZUP": "ZUP", "ZUPTECH": "ZUP",
}


# =============================================================================
# HTTP + auth
# =============================================================================
_TOKEN = {"val": None, "exp": 0}


def _token():
    """JWT do COR com cache até ~1 min antes de expirar."""
    now = time.time()
    if _TOKEN["val"] and now < _TOKEN["exp"] - 60:
        return _TOKEN["val"]
    if not (COR_API_KEY and COR_CLIENT_SECRET):
        raise RuntimeError("COR_API_KEY / COR_CLIENT_SECRET ausentes no .env")
    basic = base64.b64encode(f"{COR_API_KEY}:{COR_CLIENT_SECRET}".encode()).decode()
    req = urllib.request.Request(
        COR_BASE_URL.rstrip("/") + "/oauth/token?grant_type=client_credentials",
        data=b"", method="POST",
        headers={"Authorization": "Basic " + basic, "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as r:
        d = json.loads(r.read().decode("utf-8"))
    _TOKEN["val"] = d["access_token"]
    _TOKEN["exp"] = now + 3300                # ~55 min de folga (token dura ~1h)
    return _TOKEN["val"]


def _get(path):
    """GET autenticado com retry/backoff em 429; devolve JSON decodificado."""
    url = COR_BASE_URL.rstrip("/") + path
    for tent in range(5):
        req = urllib.request.Request(url, headers={"Authorization": "Bearer " + _token(),
                                                   "Accept": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=45) as r:
                return json.loads(r.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            if e.code == 429:                 # rate limit → espera crescente
                time.sleep(2 * (tent + 1)); continue
            if e.code == 401:                 # token venceu → força renovação
                _TOKEN["val"] = None; time.sleep(1); continue
            raise
    raise RuntimeError(f"COR GET {path}: falhou após retries")


def _paginate(path_base):
    """Itera todas as páginas de um recurso paginado (page/perPage)."""
    page = 1
    while True:
        sep = "&" if "?" in path_base else "?"
        r = _get(f"{path_base}{sep}page={page}&perPage={PER_PAGE}")
        data = r.get("data", []) if isinstance(r, dict) else []
        for row in data:
            yield row
        last = int(r.get("lastPage", 1) or 1) if isinstance(r, dict) else 1
        if page >= last or not data:
            break
        page += 1


# =============================================================================
# Mapeamentos auxiliares
# =============================================================================
def _empresa_id_por_codigo(cur):
    cur.execute("SELECT codigo, id FROM dim_empresa")
    return {c: i for c, i in cur.fetchall()}


def _empresa_do_colaborador(user, emp_por_cod):
    """empresa_id (das 5) pela LABEL de empresa do colaborador no COR; None se sem label."""
    for l in (user.get("labels") or []):
        nome = (l.get("name") if isinstance(l, dict) else str(l)).upper().strip()
        cod = COR_LABEL_EMPRESA.get(nome)
        if cod:
            return emp_por_cod.get(cod)
    return None                              # colaborador ainda sem label de empresa


def _empresa_do_projeto(proj, emp_por_cod):
    """empresa_id (das 5) por best-effort no nome do cliente COR; None se sem match."""
    cli = proj.get("client")
    nome = (cli.get("name") if isinstance(cli, dict) else None) or ""
    up = nome.upper()
    for chave, cod in COR_CLIENTE_EMPRESA.items():
        if chave in up:
            return emp_por_cod.get(cod)
    return None                              # pendente: regra do cliente


def _periodo_id(cur, ano, mes):
    cur.execute("SELECT id FROM dim_periodo WHERE ano=%s AND mes=%s", (ano, mes))
    r = cur.fetchone()
    if r:
        return r[0]
    tri = (mes - 1) // 3 + 1
    sem = 1 if mes <= 6 else 2
    nome = ["JAN", "FEV", "MAR", "ABR", "MAI", "JUN",
            "JUL", "AGO", "SET", "OUT", "NOV", "DEZ"][mes - 1]
    cur.execute("""INSERT INTO dim_periodo (data, ano, mes, trimestre, semestre, nome_mes)
                   VALUES (make_date(%s,%s,1),%s,%s,%s,%s,%s) RETURNING id""",
                (ano, mes, ano, mes, tri, sem, nome))
    return cur.fetchone()[0]


# =============================================================================
# Cargas
# =============================================================================
def upsert_colaboradores(cur, emp_por_cod):
    """/users → dim_colaborador (+ custo/hora derivado do salário do COR).
    Retorna (n_colab, n_custo_novos, n_sem_salario)."""
    n = ncusto = nsem = nsem_emp = 0
    hoje = dt.date.today()
    for u in _paginate("/users"):
        cor_id = str(u.get("id"))
        nome = f"{(u.get('first_name') or '').strip()} {(u.get('last_name') or '').strip()}".strip() or "?"
        up = u.get("userPosition")
        papel = up.get("name") if isinstance(up, dict) else None
        emp_id = _empresa_do_colaborador(u, emp_por_cod)     # empresa pela label COR
        if emp_id is None:
            nsem_emp += 1
        cur.execute("""INSERT INTO dim_colaborador (cor_id, nome, papel, empresa_id, ativo)
                       VALUES (%s,%s,%s,%s,TRUE)
                       ON CONFLICT (cor_id) DO UPDATE
                       SET nome=EXCLUDED.nome, papel=EXCLUDED.papel,
                           empresa_id=EXCLUDED.empresa_id
                       RETURNING id""", (cor_id, nome, papel, emp_id))
        colab_id = cur.fetchone()[0]
        n += 1
        # custo/hora: só busca detalhe se ainda não há vigência aberta p/ o colaborador
        cur.execute("""SELECT 1 FROM dim_custo_hora_colaborador
                       WHERE colaborador_id=%s AND vigencia_fim IS NULL LIMIT 1""", (colab_id,))
        if cur.fetchone():
            continue
        det = _get(f"/users/{cor_id}")
        d = det.get("data", det) if isinstance(det, dict) else {}
        sal = d.get("salary")
        mh = d.get("monthly_hours") or u.get("monthly_hours") or 160
        if isinstance(sal, (int, float)) and sal and mh:
            custo_h = round(float(sal) / float(mh), 2)
            cur.execute("""INSERT INTO dim_custo_hora_colaborador
                           (colaborador_id, custo_hora, vigencia_inicio) VALUES (%s,%s,%s)""",
                        (colab_id, custo_h, hoje))
            ncusto += 1
        else:
            nsem += 1
    return n, ncusto, nsem


def upsert_projetos(cur, emp_por_cod):
    """/projects → dim_projeto. Retorna (n_proj, n_sem_empresa)."""
    n = nsem = 0
    for p in _paginate("/projects"):
        emp_id = _empresa_do_projeto(p, emp_por_cod)
        if emp_id is None:
            nsem += 1
        def _d(v):                            # datas COR podem vir '' ou 'YYYY-MM-DD ...'
            v = (v or "")[:10]
            return v if len(v) == 10 else None
        cur.execute("""INSERT INTO dim_projeto (cor_id, nome, empresa_id, status, data_inicio, data_fim)
                       VALUES (%s,%s,%s,%s,%s,%s)
                       ON CONFLICT (cor_id) DO UPDATE
                       SET nome=EXCLUDED.nome, empresa_id=EXCLUDED.empresa_id,
                           status=EXCLUDED.status""",
                    (str(p.get("id")), (p.get("name") or "?")[:200], emp_id,
                     str(p.get("status")) if p.get("status") is not None else None,
                     _d(p.get("start")), _d(p.get("end"))))
        n += 1
    return n, nsem


def load_horas(cur, ini, fim):
    """/hours (janela ini..fim) → fato_cor_horas agregado por (projeto, colab, mês).
    Só carrega entries COM projeto E colaborador conhecidos E custo/hora vigente.
    Retorna dict de contadores."""
    # índices cor_id → id local
    cur.execute("SELECT cor_id, id FROM dim_projeto"); proj = dict(cur.fetchall())
    cur.execute("SELECT cor_id, id, empresa_id FROM dim_projeto")
    proj_emp = {c: e for c, _, e in cur.fetchall()}
    cur.execute("SELECT cor_id, id FROM dim_colaborador"); colab = dict(cur.fetchall())

    filt = urllib.parse.quote(json.dumps({"dateStart": ini, "dateDeadline": fim}))
    agg = {}                                  # (proj_id, colab_id, ano, mes) -> horas
    tot = sem_proj = sem_colab = 0
    for e in _paginate(f"/hours?filters={filt}"):
        tot += 1
        pid_cor = e.get("project_id"); uid_cor = e.get("user_id")
        if not pid_cor:
            sem_proj += 1; continue
        pj = proj.get(str(pid_cor)); co = colab.get(str(uid_cor))
        if not pj or not co:
            sem_colab += 1; continue
        try:
            horas = float(e.get("duration") or 0)
        except (TypeError, ValueError):
            horas = 0.0
        d = (e.get("start") or "")[:10]
        if len(d) != 10:
            continue
        ano, mes = int(d[:4]), int(d[5:7])
        k = (pj, co, ano, mes)
        agg[k] = agg.get(k, 0.0) + horas

    # limpa o intervalo recarregado (idempotência) e regrava
    carregados = sem_custo = 0
    periodos = {}
    for (pj, co, ano, mes), horas in agg.items():
        # custo/hora vigente do colaborador
        primeiro = dt.date(ano, mes, 1)
        cur.execute("""SELECT custo_hora FROM dim_custo_hora_colaborador
                       WHERE colaborador_id=%s AND vigencia_inicio<=%s
                       AND (vigencia_fim IS NULL OR vigencia_fim>=%s)
                       ORDER BY vigencia_inicio DESC LIMIT 1""", (co, primeiro, primeiro))
        r = cur.fetchone()
        if not r:
            sem_custo += 1; continue          # blueprint §10: não estimar sem custo
        custo_h = float(r[0])
        per_id = periodos.get((ano, mes)) or _periodo_id(cur, ano, mes)
        periodos[(ano, mes)] = per_id
        # empresa da hora = empresa do COLABORADOR (label COR) — atribuição de custo
        # exata; fallback = empresa best-effort do projeto.
        cur.execute("SELECT empresa_id FROM dim_colaborador WHERE id=%s", (co,))
        rc = cur.fetchone()
        emp_id = rc[0] if rc and rc[0] is not None else None
        if emp_id is None:
            cur.execute("SELECT empresa_id FROM dim_projeto WHERE id=%s", (pj,))
            rr = cur.fetchone()
            emp_id = rr[0] if rr else None
        cur.execute("""INSERT INTO fato_cor_horas
                         (empresa_id, projeto_id, colaborador_id, periodo_id, horas_apontadas, custo_hora)
                       VALUES (%s,%s,%s,%s,%s,%s)
                       ON CONFLICT (projeto_id, colaborador_id, periodo_id) DO UPDATE
                       SET horas_apontadas=EXCLUDED.horas_apontadas,
                           custo_hora=EXCLUDED.custo_hora,
                           empresa_id=EXCLUDED.empresa_id, carregado_em=NOW()""",
                    (emp_id, pj, co, per_id, round(horas, 2), custo_h))
        carregados += 1
    return {"entries": tot, "sem_projeto": sem_proj, "sem_colab": sem_colab,
            "pares_carregados": carregados, "sem_custo": sem_custo}


# =============================================================================
# Orquestração
# =============================================================================
def run():
    """Carga COR IN-PROCESS → {ok, output}. Fecha (ok=False) só em ERRO real;
    dados imaturos (horas sem projeto) são REPORTADOS, não tratados como falha."""
    if not (COR_API_KEY and COR_CLIENT_SECRET):
        return {"ok": False, "output": "BLOQUEADO: defina COR_API_KEY e COR_CLIENT_SECRET no .env."}
    out = ["== Integração COR =="]
    con = get_conn(); cur = con.cursor()
    try:
        emp = _empresa_id_por_codigo(cur)
        nc, ncusto, nsem_sal = upsert_colaboradores(cur, emp)
        out.append(f"  colaboradores: {nc} (custo/hora novo p/ {ncusto}; {nsem_sal} sem salário no COR)")
        npj, nsem_emp = upsert_projetos(cur, emp)
        out.append(f"  projetos: {npj} ({nsem_emp} sem empresa mapeada — regra do cliente pendente)")
        con.commit()

        hoje = dt.date.today()
        ini = (hoje.replace(day=1) - dt.timedelta(days=35)).isoformat()
        st = load_horas(cur, ini, hoje.isoformat())
        con.commit()
        out.append(f"  horas {ini}..{hoje}: {st['entries']} apontamentos | "
                   f"carregados {st['pares_carregados']} pares (proj×colab×mês)")
        avisos = []
        if st["sem_projeto"]:
            pct = 100 * st["sem_projeto"] // max(st["entries"], 1)
            avisos.append(f"{st['sem_projeto']} horas SEM projeto vinculado ({pct}%) — "
                          f"não entram na margem por projeto")
        if st["sem_custo"]:
            avisos.append(f"{st['sem_custo']} pares sem custo/hora — colaborador sem salário no COR")
        if nsem_emp:
            avisos.append("margem por-EMPRESA aguarda a regra de qual das 5 empresas executa cada projeto")
        for a in avisos:
            out.append(f"  ⚠ {a}")
        out.append("  margem real por projeto: vw_margem_projeto "
                   + ("(populando)" if st["pares_carregados"] else "(vazia até haver horas com projeto+custo)"))
        log_carga("COR", "api", "sucesso", st["pares_carregados"])
        return {"ok": True, "output": "\n".join(out)}
    except Exception as e:
        con.rollback()
        log_carga("COR", "api", "erro", str(e))
        return {"ok": False, "output": "\n".join(out) + f"\n  ERRO COR: {e}"}
    finally:
        con.close()


def main():
    r = run()
    print(r["output"])
    sys.exit(0 if r["ok"] else 2)


if __name__ == "__main__":
    main()
