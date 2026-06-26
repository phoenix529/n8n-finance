#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
build_dashboard.py — gera o dashboard executivo do Grafana (Technical Blueprint §7.3)
como código (provisionado). 6 painéis obrigatórios + status de última atualização,
todos consultando o PostgreSQL cockpit_ref. Negativos em vermelho; filtros por
empresa/ano. Saída: grafana/dashboards/cockpit_ref.json
"""
import json, os

DS = {"type": "postgres", "uid": "cockpit_ref_pg"}
BRL = "currencyBRL"
_id = [0]
def nid():
    _id[0] += 1
    return _id[0]


def target(sql, fmt="table"):
    return {"refId": "A", "datasource": DS, "format": fmt, "rawSql": sql}


def thresholds_redneg():
    return {"mode": "absolute", "steps": [{"color": "red", "value": None}, {"color": "green", "value": 0}]}


def stat(title, sql, x, y, w=6, h=4, unit=BRL):
    return {
        "id": nid(), "type": "stat", "title": title, "datasource": DS,
        "gridPos": {"h": h, "w": w, "x": x, "y": y},
        "targets": [target(sql)],
        "fieldConfig": {"defaults": {"unit": unit, "decimals": 0, "thresholds": thresholds_redneg(),
                                     "color": {"mode": "thresholds"}}, "overrides": []},
        "options": {"reduceOptions": {"calcs": ["lastNotNull"], "fields": "", "values": False},
                    "textMode": "value", "colorMode": "value", "graphMode": "area", "justifyMode": "auto"},
    }


def timeseries(title, sql, x, y, w=24, h=9):
    return {
        "id": nid(), "type": "timeseries", "title": title, "datasource": DS,
        "gridPos": {"h": h, "w": w, "x": x, "y": y},
        "targets": [target(sql, "table")],
        "fieldConfig": {"defaults": {"unit": BRL, "custom": {"drawStyle": "line", "lineWidth": 2,
                        "fillOpacity": 8, "showPoints": "always", "pointSize": 6}}, "overrides": []},
        "options": {"legend": {"displayMode": "list", "placement": "bottom", "showLegend": True},
                    "tooltip": {"mode": "multi"}},
    }


def barchart(title, sql, x, y, w=12, h=9, stacked=False):
    return {
        "id": nid(), "type": "barchart", "title": title, "datasource": DS,
        "gridPos": {"h": h, "w": w, "x": x, "y": y},
        "targets": [target(sql, "table")],
        "fieldConfig": {"defaults": {"unit": BRL, "custom": {"fillOpacity": 85,
                        "stacking": {"mode": "normal" if stacked else "none"}}}, "overrides": []},
        "options": {"orientation": "horizontal", "showValue": "auto", "xTickLabelRotation": 0,
                    "legend": {"displayMode": "list", "placement": "bottom", "showLegend": stacked},
                    "tooltip": {"mode": "multi"}},
    }


def table(title, sql, x, y, w=12, h=10, money_cols=None):
    overrides = []
    for col in (money_cols or []):
        overrides.append({"matcher": {"id": "byName", "options": col},
                          "properties": [{"id": "unit", "value": BRL},
                                         {"id": "custom.cellOptions", "value": {"type": "color-text"}},
                                         {"id": "thresholds", "value": thresholds_redneg()},
                                         {"id": "color", "value": {"mode": "thresholds"}}]})
    return {
        "id": nid(), "type": "table", "title": title, "datasource": DS,
        "gridPos": {"h": h, "w": w, "x": x, "y": y},
        "targets": [target(sql, "table")],
        "fieldConfig": {"defaults": {"custom": {"align": "auto"}}, "overrides": overrides},
        "options": {"showHeader": True, "cellHeight": "sm"},
    }


def text(title, content, x, y, w=12, h=6):
    return {"id": nid(), "type": "text", "title": title,
            "gridPos": {"h": h, "w": w, "x": x, "y": y},
            "options": {"mode": "markdown", "content": content}}


# ---- SQL dos painéis --------------------------------------------------------
def grp_sum(desc):
    return (f"SELECT SUM(f.valor) FROM fato_dre_mensal f "
            f"JOIN dim_conta c ON c.id=f.conta_id JOIN dim_periodo p ON p.id=f.periodo_id "
            f"WHERE c.descricao='{desc}' AND p.ano=$ano")

# Por MÊS (blueprint §7.3): make_date(ano,mes,1) — 2026 mostra os 12 meses; anos
# anteriores (só dezembro) colapsam em 1 ponto naturalmente. Filtro empresa/consolidado.
SQL_EVOL = """SELECT make_date(p.ano,p.mes,1) AS "time",
  SUM(f.valor) FILTER (WHERE c.descricao='RECEITA BRUTA') AS "Receita Bruta",
  SUM(f.valor) FILTER (WHERE c.descricao='RESULTADO OPERACIONAL ANTES DOS IMPOSTOS (EBIT)') AS "EBIT"
FROM fato_dre_mensal f JOIN dim_conta c ON c.id=f.conta_id
JOIN dim_periodo p ON p.id=f.periodo_id JOIN dim_empresa e ON e.id=f.empresa_id
WHERE ('$empresa'='GRUPO' OR e.codigo='$empresa')
GROUP BY p.ano, p.mes ORDER BY p.ano, p.mes"""

# ordem lógica da DRE (independe de c.id, que varia conforme a empresa que criou a conta)
_DRE_ORDER = ["RECEITA BRUTA", "DEDUCOES IMPOSTOS", "RECEITA OPERACIONAL LIQUIDA",
              "CUSTOS DOS SERVICOS", "RESULTADO OPERACIONAL DA AGENCIA", "GASTOS COM PESSOAL",
              "INFRAESTRUTURA", "OUTRAS DESPESAS", "DESPESAS ADMINISTRATIVAS", "TRIBUTOS FEDERAIS",
              "RESULTADO OPERACIONAL ANTES DOS IMPOSTOS (EBIT)", "RESULTADO LIQUIDO", "GERACAO DE CAIXA"]
_DRE_CASE = "CASE c.descricao " + " ".join(f"WHEN '{d}' THEN {i}" for i, d in enumerate(_DRE_ORDER)) + " ELSE 99 END"
SQL_DRE_EMP = f"""SELECT c.descricao AS "Linha", c.grupo AS "Grupo", SUM(f.valor) AS "Valor (R$)"
FROM fato_dre_mensal f JOIN dim_conta c ON c.id=f.conta_id
JOIN dim_empresa e ON e.id=f.empresa_id JOIN dim_periodo p ON p.id=f.periodo_id
WHERE ('$empresa'='GRUPO' OR e.codigo='$empresa') AND p.ano=$ano
GROUP BY c.descricao, c.grupo ORDER BY {_DRE_CASE}"""

# pivotado: cada categoria vira uma COLUNA numérica -> barra ÚNICA empilhada (blueprint §7.3)
SQL_CUSTOS = """SELECT 'Custos e Despesas' AS "Categoria",
  COALESCE(SUM(f.valor) FILTER (WHERE c.grupo='DIRECT_COST'),0) AS "Custo Direto",
  COALESCE(SUM(f.valor) FILTER (WHERE c.grupo='PERSONNEL'),0)   AS "Pessoal",
  COALESCE(SUM(f.valor) FILTER (WHERE c.grupo='ADMIN'),0)       AS "Administrativo",
  COALESCE(SUM(f.valor) FILTER (WHERE c.grupo='FACILITIES'),0)  AS "Infraestrutura",
  COALESCE(SUM(f.valor) FILTER (WHERE c.grupo='FINANCIAL'),0)   AS "Financeiro"
FROM fato_dre_mensal f JOIN dim_conta c ON c.id=f.conta_id
JOIN dim_empresa e ON e.id=f.empresa_id JOIN dim_periodo p ON p.id=f.periodo_id
WHERE ('$empresa'='GRUPO' OR e.codigo='$empresa') AND p.ano=$ano
  AND c.grupo IN ('DIRECT_COST','PERSONNEL','ADMIN','FACILITIES','FINANCIAL')"""

SQL_CLIENTES = """SELECT cl.nome AS "Cliente",
  COALESCE(SUM(r.valor) FILTER (WHERE r.tipo_receita='FEE'),0) AS "FEE",
  COALESCE(SUM(r.valor) FILTER (WHERE r.tipo_receita='VARIAVEL'),0) AS "Variável"
FROM fato_receita_cliente_mensal r JOIN dim_cliente cl ON cl.id=r.cliente_id
JOIN dim_periodo p ON p.id=r.periodo_id
WHERE p.ano=$ano
GROUP BY cl.nome ORDER BY SUM(r.valor) DESC LIMIT 12"""

SQL_MARGEM = """SELECT projeto AS "Projeto", empresa AS "Empresa",
  custo_real_entrega AS "Custo Real (R$)", receita_projeto AS "Receita (R$)",
  margem_bruta AS "Margem (R$)", round(pct_margem*100,1) AS "% Margem"
FROM vw_margem_projeto ORDER BY 1 LIMIT 50"""

SQL_UPDATE = "SELECT ultima_carga FROM vw_ultima_atualizacao"


def build():
    panels = []
    # Linha 0 — status + título consolidado
    panels.append(stat("Receita Bruta (grupo)", grp_sum("RECEITA BRUTA"), 0, 0))
    panels.append(stat("Receita Líquida (grupo)", grp_sum("RECEITA OPERACIONAL LIQUIDA"), 6, 0))
    panels.append(stat("EBIT (grupo)", grp_sum("RESULTADO OPERACIONAL ANTES DOS IMPOSTOS (EBIT)"), 12, 0))
    panels.append(stat("Resultado Líquido (grupo)", grp_sum("RESULTADO LIQUIDO"), 18, 0))
    # Linha 1 — evolução histórica
    panels.append(timeseries("Evolução histórica — Receita Bruta e EBIT por mês ($empresa · 2018→)", SQL_EVOL, 0, 4))
    # Linha 2 — DRE por empresa + composição de custos
    panels.append(table("DRE por Empresa ($empresa · $ano)", SQL_DRE_EMP, 0, 13, w=12, h=11, money_cols=["Valor (R$)"]))
    panels.append(barchart("Composição de Custos e Despesas ($empresa · $ano)", SQL_CUSTOS, 12, 13, w=12, h=11, stacked=True))
    # Linha 3 — receita por cliente + margem real (Fase 2)
    panels.append(barchart("Receita por Cliente — REF ($ano · FEE × Variável)", SQL_CLIENTES, 0, 24, w=12, h=11, stacked=True))
    panels.append(table("Margem Real por Projeto (Fase 2 — COR)", SQL_MARGEM, 12, 24, w=12, h=11,
                        money_cols=["Custo Real (R$)", "Receita (R$)", "Margem (R$)"]))
    # Linha 4 — última atualização
    panels.append({"id": nid(), "type": "stat", "title": "Última atualização da carga", "datasource": DS,
                   "gridPos": {"h": 4, "w": 8, "x": 0, "y": 35},
                   "targets": [target(SQL_UPDATE)],
                   "fieldConfig": {"defaults": {"unit": "dateTimeAsIso"}, "overrides": []},
                   "options": {"reduceOptions": {"calcs": ["lastNotNull"]}, "textMode": "value", "colorMode": "none"}})
    panels.append(text("", "**Cockpit Financeiro REF Group** · dados reais (DRE 2018→2026) · "
                       "valores negativos em vermelho · Fase 2 (COR / margem real) aguarda token + custo/hora.",
                       8, 35, w=16, h=4))

    dash = {
        "uid": "cockpit-ref", "title": "Cockpit Financeiro — REF Group",
        "tags": ["cockpit", "ref", "financeiro"], "timezone": "browser",
        "schemaVersion": 39, "version": 1, "refresh": "30m",
        "time": {"from": "now-8y", "to": "now"},
        "templating": {"list": [
            {"name": "empresa", "type": "query", "datasource": DS, "label": "Empresa",
             "query": "SELECT codigo FROM (SELECT 'GRUPO' codigo, 0 o UNION ALL SELECT codigo, 1 o FROM dim_empresa) t ORDER BY o, codigo",
             "current": {"text": "GRUPO", "value": "GRUPO"},
             "refresh": 1, "includeAll": False, "multi": False, "sort": 0},
            {"name": "ano", "type": "query", "datasource": DS, "label": "Ano",
             "query": "SELECT DISTINCT ano FROM dim_periodo ORDER BY ano DESC",
             "current": {"text": "2026", "value": "2026"}, "refresh": 1, "includeAll": False, "multi": False},
        ]},
        "panels": panels,
    }
    out = os.path.join(os.path.dirname(__file__), "dashboards", "cockpit_ref.json")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "w", encoding="utf-8") as fh:
        json.dump(dash, fh, ensure_ascii=False, indent=2)
    print(f"OK -> {out}  ({len(panels)} painéis)")


if __name__ == "__main__":
    build()
