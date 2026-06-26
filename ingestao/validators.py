#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
validators.py — validação de qualidade (Technical Blueprint §6.4).
  validar_dre(df)        -> lista de erros encontrados no DataFrame (antes da carga)
  run_quality_checks()   -> roda as 4 checagens de consistência pós-carga no banco
"""
ACCOUNTS_REQUIRED = {"RECEITA BRUTA", "RECEITA OPERACIONAL LIQUIDA",
                     "RESULTADO OPERACIONAL ANTES DOS IMPOSTOS (EBIT)", "RESULTADO LIQUIDO"}
COLS = ["company", "year", "month", "account_code", "account_description", "group", "value", "source"]


def validar_dre(df):
    erros = []
    if df is None or len(df) == 0:
        return ["DataFrame vazio"]
    faltando = [c for c in COLS if c not in df.columns]
    if faltando:
        return [f"colunas ausentes: {faltando}"]
    # meses válidos 1..12
    bad_m = df[(df["month"] < 1) | (df["month"] > 12)]
    if len(bad_m):
        erros.append(f"{len(bad_m)} linha(s) com mês fora de 1..12")
    # valores numéricos e não absurdos (> 500 milhões)
    import numbers
    nao_num = sum(1 for v in df["value"] if not isinstance(v, numbers.Number))
    if nao_num:
        erros.append(f"{nao_num} valor(es) não numéricos")
    absurdos = df[df["value"].abs() > 500_000_000]
    if len(absurdos):
        erros.append(f"{len(absurdos)} valor(es) absurdo(s) > R$ 500 mi")
    # contas-chave presentes
    presentes = set(df["account_description"].unique())
    falt = ACCOUNTS_REQUIRED - presentes
    if falt:
        erros.append(f"contas-chave ausentes: {sorted(falt)}")
    # receita bruta não pode ser totalmente zero (possível falha de leitura)
    rb = df[df["account_description"] == "RECEITA BRUTA"]["value"]
    if len(rb) and rb.abs().sum() == 0:
        erros.append("RECEITA BRUTA totalmente zero (possível falha de leitura)")
    return erros


# --- checagens pós-carga (blueprint §6.4) ------------------------------------
QUALITY_CHECKS = [
    # Mês corrente DINÂMICO: último ano carregado + mês de NOW() (blueprint §6.4 usa EXTRACT(MONTH FROM NOW()))
    ("Todas as 5 empresas carregadas no mês corrente (§6.4)",
     """SELECT COUNT(DISTINCT f.empresa_id) FROM fato_dre_mensal f JOIN dim_periodo p ON p.id=f.periodo_id
        WHERE p.ano = (SELECT MAX(d.ano) FROM dim_periodo d JOIN fato_dre_mensal x ON x.periodo_id=d.id)
          AND p.mes = EXTRACT(MONTH FROM NOW())::int""",
     lambda n: None if (n and n >= 5) else f"Apenas {n}/5 empresas com dados no mês corrente"),
    ("Receita bruta não-zero por empresa (mês corrente, §6.4)",
     """SELECT string_agg(e.codigo, ', ') FROM fato_dre_mensal f
        JOIN dim_conta c ON c.id=f.conta_id JOIN dim_empresa e ON e.id=f.empresa_id
        JOIN dim_periodo p ON p.id=f.periodo_id
        WHERE c.descricao='RECEITA BRUTA' AND f.valor=0
          AND p.ano = (SELECT MAX(d.ano) FROM dim_periodo d JOIN fato_dre_mensal x ON x.periodo_id=d.id)
          AND p.mes = EXTRACT(MONTH FROM NOW())::int""",
     lambda s: None if not s else f"Receita bruta ZERO no mês corrente: {s} (possível falha de leitura)"),
    ("Resultado líquido consistente com EBIT menos tributos (§6.4)",
     """SELECT string_agg(t.emp || ' (dif=' || t.diff || ')', ', ')
        FROM (SELECT e.codigo emp,
                round(SUM(f.valor) FILTER (WHERE c.descricao='RESULTADO OPERACIONAL ANTES DOS IMPOSTOS (EBIT)')
                    - SUM(f.valor) FILTER (WHERE c.descricao='TRIBUTOS FEDERAIS')
                    - SUM(f.valor) FILTER (WHERE c.descricao='RESULTADO LIQUIDO'), 2) diff,
                SUM(f.valor) FILTER (WHERE c.descricao='RESULTADO OPERACIONAL ANTES DOS IMPOSTOS (EBIT)') ebit,
                SUM(f.valor) FILTER (WHERE c.descricao='RESULTADO LIQUIDO') rl
              FROM fato_dre_mensal f JOIN dim_conta c ON c.id=f.conta_id
              JOIN dim_empresa e ON e.id=f.empresa_id JOIN dim_periodo p ON p.id=f.periodo_id
              WHERE p.ano=2026 GROUP BY e.codigo) t
        WHERE ABS(t.diff) > 0.01 AND NOT (t.ebit=0 AND t.rl=0)""",
     lambda s: None if not s else f"Divergência (EBIT - tributos) != resultado líquido: {s}"),
    ("Valores absurdos (> R$ 500 mi em uma linha)",
     "SELECT COUNT(*) FROM fato_dre_mensal WHERE ABS(valor) > 500000000",
     lambda n: None if not n else f"{n} valor(es) > R$ 500 mi (possível erro de formatação)"),
    ("Reprodutibilidade: Receita Bruta 2026 (12 meses) bate com a planilha",
     """SELECT round(SUM(f.valor),2) FROM fato_dre_mensal f
        JOIN dim_conta c ON c.id=f.conta_id JOIN dim_empresa e ON e.id=f.empresa_id
        JOIN dim_periodo p ON p.id=f.periodo_id
        WHERE c.descricao='RECEITA BRUTA' AND e.codigo='REF' AND p.ano=2026""",
     lambda v: None if (v is not None and abs(float(v) - 94215954.69) < 0.50)
               else f"Receita Bruta REF 2026 = {v} (esperado 94.215.954,69 da aba Resumo)"),
]


def run_quality_checks(conn=None):
    """Roda as checagens; retorna lista de alertas (vazia = tudo ok)."""
    close = False
    if conn is None:
        from db import get_conn
        conn = get_conn(); close = True
    alerts = []
    cur = conn.cursor()
    for nome, sql, judge in QUALITY_CHECKS:
        try:
            cur.execute(sql)
            val = cur.fetchone()[0]
            a = judge(val)
            if a:
                alerts.append(f"[{nome}] {a}")
        except Exception as e:
            alerts.append(f"[{nome}] erro ao checar: {e}")
    cur.close()
    if close:
        conn.close()
    return alerts


def run():
    """Roda as checagens IN-PROCESS; devolve {ok, output} (usado pelo runner HTTP)."""
    alerts = run_quality_checks()
    if alerts:
        return {"ok": False, "output": "ALERTAS DE QUALIDADE:\n" + "\n".join("  - " + a for a in alerts)}
    return {"ok": True, "output": "Qualidade OK — todas as checagens passaram."}


if __name__ == "__main__":
    import sys
    r = run()
    print(r["output"])
    if not r["ok"]:
        print(r["output"], file=sys.stderr)
        sys.exit(1)
