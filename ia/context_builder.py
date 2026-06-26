#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
context_builder.py — coração da camada de IA (Technical Blueprint §7.4).
Consulta o PostgreSQL (cockpit_ref) e constrói um resumo textual estruturado
(~2000 tokens) para fundamentar a resposta do Claude. NÃO inventa nada.

build_context(empresa, periodo) ->
  1. DRE consolidada/da empresa do período
  2. variação vs período anterior
  3. top 3 contas/grupos com maior variação
  4. receita por cliente (se empresa == REF ou grupo)
  5. texto estruturado
"""
import os, re, pathlib
import psycopg2

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

KEY_LINES = ["RECEITA BRUTA", "RECEITA OPERACIONAL LIQUIDA",
             "RESULTADO OPERACIONAL DA AGENCIA",
             "RESULTADO OPERACIONAL ANTES DOS IMPOSTOS (EBIT)", "RESULTADO LIQUIDO"]
GRUPO_PT = {"REVENUE": "Receita", "DIRECT_COST": "Custo direto", "PERSONNEL": "Pessoal",
            "ADMIN": "Administrativo", "FACILITIES": "Infraestrutura", "FINANCIAL": "Financeiro",
            "TAXES": "Impostos", "RESULT": "Resultado"}


def _conn():
    return psycopg2.connect(connect_timeout=6, **DB)


def _brl(v):
    if v is None:
        return "n/d"
    v = float(v)
    s = f"R$ {abs(v):,.0f}".replace(",", ".")
    return ("-" + s) if v < 0 else s


def parse_periodo(periodo):
    """Retorna (label, where_sql, params, prev_label, prev_where, prev_params, comparable).
    `comparable`=False quando o período anterior cairia em anos com SÓ total anual
    (histórico < 2026 é anual, gravado em dez): mês/trimestre de 2026 não é comparável
    a 2025. Comparações ANO×ANO e dentro de 2026 (T2-T4, meses 02-12) são comparáveis."""
    periodo = (periodo or "").strip().upper()
    m = re.match(r"^(\d{4})-Q([1-4])$", periodo)
    if m:
        y, q = int(m.group(1)), int(m.group(2))
        meses = [(q - 1) * 3 + 1, (q - 1) * 3 + 2, (q - 1) * 3 + 3]
        pq = q - 1 or 4; py = y if q > 1 else y - 1
        pmeses = [(pq - 1) * 3 + 1, (pq - 1) * 3 + 2, (pq - 1) * 3 + 3]
        return (f"{y}-T{q}", "p.ano=%s AND p.mes = ANY(%s)", [y, meses],
                f"{py}-T{pq}", "p.ano=%s AND p.mes = ANY(%s)", [py, pmeses], py >= 2026)
    m = re.match(r"^(\d{4})-(\d{2})$", periodo)
    if m:
        y, mo = int(m.group(1)), int(m.group(2))
        pmo = mo - 1 or 12; py = y if mo > 1 else y - 1
        return (f"{y}-{mo:02d}", "p.ano=%s AND p.mes=%s", [y, mo],
                f"{py}-{pmo:02d}", "p.ano=%s AND p.mes=%s", [py, pmo], py >= 2026)
    m = re.match(r"^(\d{4})$", periodo)
    y = int(m.group(1)) if m else 2026
    return (f"{y}", "p.ano=%s", [y], f"{y-1}", "p.ano=%s", [y - 1], True)


def _empresa_filter(empresa):
    if empresa and empresa.strip().upper() not in ("", "GRUPO", "TODAS", "ALL"):
        return " AND e.codigo=%s", [empresa.strip().upper()]
    return "", []


def build_context(empresa=None, periodo=None) -> str:
    label, w, p, plabel, pw, pp, comp = parse_periodo(periodo)
    ef, ep = _empresa_filter(empresa)
    escopo = (empresa.strip().upper() if ef else "GRUPO (5 empresas)")
    con = _conn(); cur = con.cursor()
    lines = [f"Escopo: {escopo} | Período: {label}"]

    # 1+2. DRE do período + período anterior (linhas-chave)
    def dre(where, params):
        cur.execute(f"""SELECT c.descricao, SUM(f.valor)
            FROM fato_dre_mensal f JOIN dim_conta c ON c.id=f.conta_id
            JOIN dim_empresa e ON e.id=f.empresa_id JOIN dim_periodo p ON p.id=f.periodo_id
            WHERE {where}{ef} GROUP BY c.descricao""", params + ep)
        return {d: float(v) for d, v in cur.fetchall() if v is not None}
    cur_dre = dre(w, p)
    prev_dre = dre(pw, pp) if comp else {}
    hdr = f" e variação vs {plabel}" if comp else " (sem comparação: 2025 só tem totais anuais)"
    lines.append(f"\nDRE — linhas-chave ({label}){hdr}:")
    for ln in KEY_LINES:
        v = cur_dre.get(ln); pv = prev_dre.get(ln)
        var = (f" (vs {plabel}: {_brl(pv)}; "
               f"{'+' if (v or 0) >= (pv or 0) else ''}{((v-pv)/abs(pv)*100):.1f}%)" if (comp and pv) else "")
        lines.append(f"  - {ln}: {_brl(v)}{var}")

    # 3. top 3 CONTAS (todas, não só as linhas-chave) com maior variação absoluta.
    #    Quando comp=False (comparação cruzando para 2025, anual), prev_dre={} e a lista
    #    fica vazia — então não há risco de comparar detalhe 2026 com histórico anual.
    var_lines = []
    for ln, v in cur_dre.items():
        pv = prev_dre.get(ln)
        if v is not None and pv is not None and pv != 0:
            var_lines.append((ln, v - pv))
    var_lines.sort(key=lambda x: -abs(x[1]))
    if var_lines:
        lines.append(f"\nContas com maior variação vs {plabel}:")
        for ln, d in var_lines[:3]:
            lines.append(f"  - {ln}: {'+' if d >= 0 else ''}{_brl(d)}")

    # 4. receita por cliente (REF) — ESCOPADA ao ano do período (e à empresa)
    if not ef or empresa.strip().upper() == "REF":
        ano = p[0]   # parse_periodo sempre coloca o ano como 1º parâmetro
        cur.execute(f"""SELECT cl.nome, SUM(r.valor)
            FROM fato_receita_cliente_mensal r JOIN dim_cliente cl ON cl.id=r.cliente_id
            JOIN dim_empresa e ON e.id=r.empresa_id JOIN dim_periodo per ON per.id=r.periodo_id
            WHERE per.ano=%s{ef} GROUP BY cl.nome ORDER BY SUM(r.valor) DESC LIMIT 5""", [ano] + ep)
        cli = cur.fetchall()
        if cli:
            lines.append(f"\nTop clientes (REF, receita faturada — ano {ano}):")
            for nome, v in cli:
                lines.append(f"  - {nome}: {_brl(v)}")

    cur.close(); con.close()
    return "\n".join(lines)


if __name__ == "__main__":
    import sys
    emp = sys.argv[1] if len(sys.argv) > 1 else None
    per = sys.argv[2] if len(sys.argv) > 2 else "2026"
    print(build_context(emp, per))
