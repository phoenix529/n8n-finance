#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
build_cockpit_real.py — gera dashboard_data.json a partir do PostgreSQL (dados REAIS).

Fonte da verdade = cockpit.fact_financials (carregado por data/load_real_to_db.py).
Reescreve o cockpit para a HISTÓRIA DE RESULTADO (P&L) da Ref Comunicação:
  Receita, Margens, Resultado Operacional (EBIT), Lucro Líquido, Geração de Caixa,
  gastos por categoria, comparativo por unidade — SEM caixa/dívida/AR-AP (não há
  dados de posição nas planilhas DRE). Atuais Jan..Jun/2026; orçamento ausente.

Uso:  python dashboard/build_cockpit_real.py   (escreve dashboard/dashboard_data.json)
"""
import os, json, datetime as dt
import psycopg2

OUT = os.path.join(os.path.dirname(__file__), "dashboard_data.json")
GEN_DATE = os.environ.get("GEN_DATE", "2026-06-25")   # passado via env (sem Date no harness)

PAL = ["#4F6BED", "#10B981", "#F59E0B", "#6E86F2", "#8B5CF6", "#EF4444", "#0EA5E9", "#14B8A6"]


def connect():
    return psycopg2.connect(
        host=os.environ.get("PGHOST", "127.0.0.1"), port=int(os.environ.get("PGPORT", "5432")),
        dbname=os.environ.get("PGDATABASE", "cockpit"), user=os.environ.get("PGUSER", "postgres"),
        password=os.environ.get("PGPASSWORD", "postgres"), connect_timeout=8)


def pctc(cur, num, den):
    return round(100.0 * num / den, 1) if den else None


def main():
    con = connect(); cur = con.cursor()

    # empresas (na ordem)
    cur.execute("""SELECT c.company_id, c.name, c.sector, c.color
                   FROM cockpit.dim_company c
                   WHERE c.company_id IN (SELECT DISTINCT company_id FROM cockpit.fact_financials)
                   ORDER BY c.sort""")
    companies = cur.fetchall()
    comp_ids = [r[0] for r in companies]

    # todos os fatos
    cur.execute("""SELECT company_id, to_char(period_date,'YYYY-MM'), account_code, valor_realizado
                   FROM cockpit.fact_financials""")
    rows = cur.fetchall()
    cur.close(); con.close()

    months = sorted({r[1] for r in rows})           # ['2026-01'...'2026-06']
    last = months[-1]
    # f[company][account][period] e cons[account][period]
    F, CONS = {}, {}
    for cid, per, acc, val in rows:
        val = float(val)
        F.setdefault(cid, {}).setdefault(acc, {})[per] = val
        CONS.setdefault(acc, {}); CONS[acc][per] = CONS[acc].get(per, 0.0) + val

    def cseries(acc):                # série consolidada mensal
        return [round(CONS.get(acc, {}).get(m, 0.0), 2) for m in months]

    def cytd(acc):                   # acumulado YTD consolidado
        return round(sum(CONS.get(acc, {}).get(m, 0.0) for m in months), 2)

    rl_ytd = cytd("RECEITA_LIQUIDA")

    # ---- KPIs (valor = último mês fechado; delta = MoM; spark = 6m; ytd; margem) ----
    def kpi(acc, margin_base=None):
        s = cseries(acc)
        value, prev = s[-1], (s[-2] if len(s) > 1 else 0.0)
        # headline = acumulado no ano; NÃO exibimos pílula de variação MoM (enganosa
        # com base ~zero, ex.: geração de caixa) — a tendência fica na sparkline.
        ytd = round(sum(s), 2)
        out = {"value": value, "prev": prev, "delta_pct": None, "spark": s, "ytd": ytd}
        if margin_base:
            base = cytd(margin_base)
            out["margem_pct"] = round(100.0 * ytd / base, 1) if base else None
        return out

    kpis = {
        "receita_bruta":     kpi("RECEITA_BRUTA"),
        "receita_liquida":   kpi("RECEITA_LIQUIDA"),
        "resultado_agencia": kpi("RESULTADO_AGENCIA", "RECEITA_LIQUIDA"),
        "ebit":              kpi("EBIT", "RECEITA_LIQUIDA"),
        "lucro_liquido":     kpi("RESULTADO_LIQUIDO", "RECEITA_LIQUIDA"),
        "geracao_caixa":     kpi("GERACAO_CAIXA"),
    }

    # ---- série mensal (campos consumidos pelos gráficos) ----
    series = []
    cum_ger = 0.0
    for i, m in enumerate(months):
        g = CONS.get("GERACAO_CAIXA", {}).get(m, 0.0)
        cum_ger += g
        rl = CONS.get("RECEITA_LIQUIDA", {}).get(m, 0.0)
        eb = CONS.get("EBIT", {}).get(m, 0.0)
        series.append({
            "period": m,
            "receita_bruta":     round(CONS.get("RECEITA_BRUTA", {}).get(m, 0.0), 2),
            "receita_liquida":   round(rl, 2),
            "lucro_bruto":       round(CONS.get("RESULTADO_AGENCIA", {}).get(m, 0.0), 2),
            "ebitda":            round(eb, 2),      # = EBIT (cockpit reaproveita o campo)
            "ebit":              round(eb, 2),
            "lucro_liquido":     round(CONS.get("RESULTADO_LIQUIDO", {}).get(m, 0.0), 2),
            "geracao_caixa":     round(g, 2),
            "margem_ebitda_pct": pctc(None, eb, rl) or 0,
            "caixa":             round(cum_ger, 2),  # geração de caixa ACUMULADA
            "fluxo_caixa":       round(g, 2),        # geração de caixa do mês
            "receita_orcada":    None,               # sem orçamento (atuais)
            "divida_liquida":    None,
        })

    # ---- por unidade (YTD) ----
    por_empresa = []
    for cid, name, sector, color in companies:
        racc = F.get(cid, {})
        rl_c = sum(racc.get("RECEITA_LIQUIDA", {}).get(m, 0.0) for m in months)
        eb_c = sum(racc.get("EBIT", {}).get(m, 0.0) for m in months) if "EBIT" in racc else None
        ll_c = sum(racc.get("RESULTADO_LIQUIDO", {}).get(m, 0.0) for m in months) if "RESULTADO_LIQUIDO" in racc else None
        por_empresa.append({
            "company_id": cid, "name": name, "sector": sector, "color": color,
            "receita_ltm": round(rl_c, 2),
            "ebitda_ltm": (round(eb_c, 2) if eb_c is not None else None),
            "margem_ebitda_pct": (round(100.0 * eb_c / rl_c, 1) if (eb_c is not None and rl_c) else None),
            "lucro_liquido_ltm": (round(ll_c, 2) if ll_c is not None else None),
            "share_receita_pct": (round(100.0 * rl_c / rl_ytd, 1) if rl_ytd else 0),
            "yoy_pct": None,   # histórico 2025 está nas abas Resumo; fora do escopo desta carga
            "incompleto": ("EBIT" not in racc),   # Zup: custos/resultado 2026 não lançados
            "serie_receita": [round(racc.get("RECEITA_LIQUIDA", {}).get(m, 0.0), 2) for m in months],
            "serie_ebitda":  [round(racc.get("EBIT", {}).get(m, 0.0), 2) for m in months],
        })

    # ---- DRE consolidada (mês fechado + acumulado YTD + % da receita líquida) ----
    def opex_period(m):
        return sum(CONS.get(a, {}).get(m, 0.0) for a in ("DESP_PESSOAL", "DESP_INFRA", "DESP_OUTRAS", "DESP_ADM"))
    opex_ytd = sum(opex_period(m) for m in months)
    dre_defs = [
        ("Receita Bruta",                "RECEITA_BRUTA",     cseries("RECEITA_BRUTA"),     cytd("RECEITA_BRUTA")),
        ("(–) Deduções e Impostos",      "DEDUCOES",          cseries("DEDUCOES"),          cytd("DEDUCOES")),
        ("Receita Operacional Líquida",  "receita_liquida",   cseries("RECEITA_LIQUIDA"),   rl_ytd),
        ("(–) Custos dos Serviços",      "CUSTOS",            cseries("CUSTOS"),            cytd("CUSTOS")),
        ("Resultado Operac. (Lucro Bruto)", "lucro_bruto",    cseries("RESULTADO_AGENCIA"), cytd("RESULTADO_AGENCIA")),
        ("(–) Despesas Operacionais",    "opex",              [round(opex_period(m),2) for m in months], round(opex_ytd,2)),
        ("Resultado Operacional (EBIT)", "ebit",              cseries("EBIT"),              cytd("EBIT")),
        ("(–) Tributos (IRPJ/CSLL)",     "TRIBUTOS",          cseries("TRIBUTOS"),          cytd("TRIBUTOS")),
        ("Resultado Líquido",            "lucro_liquido",     cseries("RESULTADO_LIQUIDO"), cytd("RESULTADO_LIQUIDO")),
        ("Geração de Caixa",             "geracao_caixa",     cseries("GERACAO_CAIXA"),     cytd("GERACAO_CAIXA")),
    ]
    dre = []
    for linha, code, s, ytd in dre_defs:
        dre.append({"linha": linha, "code": code, "mes": s[-1], "ltm": ytd,
                    "pct_rec": pctc(None, ytd, rl_ytd), "orcado_mes": None, "var_pct": None})

    # ---- gastos por categoria (acumulado YTD) ----
    cats_src = [
        ("Custos dos Serviços", cytd("CUSTOS")),
        ("Pessoal",             cytd("DESP_PESSOAL")),
        ("Tributos Federais",   cytd("TRIBUTOS")),
        ("Deduções s/ Vendas",  cytd("DEDUCOES")),
        ("Outras Despesas",     cytd("DESP_OUTRAS")),
        ("Infraestrutura",      cytd("DESP_INFRA")),
        ("Administrativas",     cytd("DESP_ADM")),
    ]
    cats_src = [(n, v) for n, v in cats_src if v and v > 0]
    tot_cat = sum(v for _, v in cats_src) or 1
    gastos = [{"categoria": n, "valor": round(v, 2), "pct": round(100.0 * v / tot_cat, 1),
               "color": PAL[i % len(PAL)]} for i, (n, v) in enumerate(cats_src)]

    # ---- "receita por unidade" (reaproveita o bloco orçado_vs_realizado) ----
    ovr = sorted(por_empresa, key=lambda c: c["receita_ltm"], reverse=True)
    orcado_vs_realizado = [{"name": c["name"], "realizado": c["receita_ltm"],
                            "orcado": None, "var_pct": c["share_receita_pct"]} for c in ovr]

    # ---- insights (calculados dos números reais) ----
    refmais = next((c for c in por_empresa if c["company_id"] == "REFMAIS"), None)
    zup = next((c for c in por_empresa if c["company_id"] == "ZUP"), None)
    ebit_ytd, ll_ytd, ger_ytd = cytd("EBIT"), cytd("RESULTADO_LIQUIDO"), cytd("GERACAO_CAIXA")
    mi = lambda v: f"R$ {v/1e6:,.1f} mi".replace(",", "X").replace(".", ",").replace("X", ".")
    insights = [
        {"severity": "info", "titulo": "Concentração de receita",
         "texto": f"REF+ responde por {refmais['share_receita_pct']:.0f}% da receita líquida do grupo "
                  f"({mi(refmais['receita_ltm'])} de {mi(rl_ytd)} acumulados jan–jun)."},
        {"severity": "positive" if ebit_ytd >= 0 else "warning", "titulo": "Resultado operacional",
         "texto": f"EBIT consolidado de {mi(ebit_ytd)} (margem {100.0*ebit_ytd/rl_ytd:.1f}% s/ receita líquida); "
                  f"resultado líquido de {mi(ll_ytd)} no acumulado de 2026."},
        {"severity": "warning", "titulo": "Geração de caixa",
         "texto": f"Geração de caixa consolidada de {mi(ger_ytd)} no período — pressionada por distribuições de "
                  f"lucro das unidades (sai do resultado, reduz o caixa gerado)."},
    ]
    if zup:
        insights.append({"severity": "warning", "titulo": "Zup — dados incompletos (2026)",
                         "texto": f"Zup entra na receita do grupo ({mi(zup['receita_ltm'])}), mas seus custos e resultado "
                                  f"de 2026 ainda não foram lançados na planilha — por isso o lucro bruto/EBIT consolidados "
                                  f"refletem 4 unidades (o DRE não fecha exatamente Receita − Custos)."})

    # ---- Q&A (fundamenta o fallback offline; o RAG ao vivo usa o mesmo banco) ----
    perguntas = [
        "Qual a receita líquida acumulada do grupo em 2026?",
        "Qual o resultado operacional (EBIT) consolidado?",
        "Qual unidade tem a maior receita?",
        "Por que a geração de caixa está negativa?",
    ]
    respostas = [
        {"q": perguntas[0], "fontes": ["fact_financials", "dim_account: RECEITA_LIQUIDA"],
         "a": f"A receita operacional líquida acumulada (jan–jun/2026) do grupo Ref Comunicação é de {mi(rl_ytd)}, "
              f"sobre receita bruta de {mi(cytd('RECEITA_BRUTA'))}."},
        {"q": perguntas[1], "fontes": ["fact_financials", "dim_account: EBIT"],
         "a": f"O resultado operacional (EBIT) consolidado é de {mi(ebit_ytd)} no acumulado de 2026, "
              f"margem de {100.0*ebit_ytd/rl_ytd:.1f}% sobre a receita líquida. O resultado líquido é {mi(ll_ytd)}."},
        {"q": perguntas[2], "fontes": ["fact_financials por company_id"],
         "a": f"REF+ é a maior unidade, com {mi(refmais['receita_ltm'])} de receita líquida "
              f"({refmais['share_receita_pct']:.0f}% do grupo), seguida por BD."},
        {"q": perguntas[3], "fontes": ["dim_account: GERACAO_CAIXA"],
         "a": f"A geração de caixa consolidada ({mi(ger_ytd)}) reflete distribuições de lucro feitas pelas unidades "
              f"no período — esses pagamentos reduzem o caixa gerado mesmo com resultado positivo."},
    ]

    data = {
        "meta": {
            "group_name": "Ref Comunicação", "currency": "BRL", "locale": "pt-BR",
            "generated_at": GEN_DATE, "period_start": months[0], "period_end": last,
            "last_closed_period": last, "companies": len(companies),
            "is_placeholder_brand": False, "fonte": "5 planilhas DRE Acumulado 2026 (atuais jan–jun)",
        },
        "kpis": kpis, "series_mensal": series, "por_empresa": por_empresa,
        "dre_consolidada": dre, "gastos_por_categoria": gastos,
        "orcado_vs_realizado": orcado_vs_realizado,
        "aging": {"receber": [], "pagar": []},   # sem dados de posição nas planilhas DRE
        "insights_ia": insights, "perguntas_sugeridas": perguntas, "respostas_demo": respostas,
    }
    with open(OUT, "w", encoding="utf-8") as fh:
        json.dump(data, fh, ensure_ascii=False, indent=2)

    print(f"OK -> {OUT}")
    print(f"  grupo={data['meta']['group_name']}  unidades={len(companies)}  meses={len(months)} ({months[0]}..{last})")
    print(f"  Receita Líq YTD={mi(rl_ytd)}  EBIT={mi(ebit_ytd)}  Result.Líq={mi(ll_ytd)}  Ger.Caixa={mi(ger_ytd)}")
    print(f"  KPIs={list(kpis)}  gastos_cats={len(gastos)}  insights={len(insights)}")


if __name__ == "__main__":
    main()
