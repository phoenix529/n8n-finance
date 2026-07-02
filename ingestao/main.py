#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
main.py — orquestrador de ingestão (Technical Blueprint §6.2).
Lê as 5 planilhas, normaliza (um parser por empresa), valida, e carrega no PostgreSQL.
Registra cada execução em log_carga. Sai com código 0 (sucesso) ou 1 (algum erro),
para que o n8n possa ramificar (IF) e notificar.

Uso:  cd ingestao && python main.py
Env:  INCOMING (pasta das planilhas; default ../data/incoming)
"""
import os, sys, glob, pathlib

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from parsers.ref import parse_ref
from parsers.bd import parse_bd
from parsers.quatro_pr import parse_4pr
from parsers.viv import parse_viv
from parsers.zup import parse_zup
from parsers.clientes import parse_clientes_ref
from db import upsert_dre, upsert_receita_cliente, log_carga
from validators import validar_dre, run_quality_checks
import folha_fees
import history

ROOT = pathlib.Path(__file__).resolve().parent.parent
INCOMING = pathlib.Path(os.environ.get("INCOMING", ROOT / "data" / "incoming"))

# empresa -> (prefixo do arquivo, parser)
PARSERS = {
    "REF": ("REF+", parse_ref),
    "BD":  ("BD",   parse_bd),
    "4PR": ("4PR",  parse_4pr),
    "VIV": ("Viv",  parse_viv),
    "ZUP": ("Zup",  parse_zup),
}


def find_file(prefix):
    hits = sorted(glob.glob(str(INCOMING / f"{prefix}*DRE*.xlsx")))
    return hits[0] if hits else None


def run():
    """Executa a ingestão IN-PROCESS e devolve {ok, total, output} (sem print/sys.exit).
    Usado tanto pela CLI quanto pelo runner HTTP do FastAPI (chamada in-process — não
    depende de spawnar subprocesso)."""
    out = [f"== Ingestão Cockpit REF == (planilhas em {INCOMING})"]
    had_error = False
    total = 0
    for empresa, (prefix, parser) in PARSERS.items():
        caminho = find_file(prefix)
        if not caminho:
            out.append(f"  [{empresa}] arquivo não encontrado (prefixo {prefix})")
            log_carga(empresa, f"{prefix}*", "erro", "arquivo não encontrado")
            had_error = True
            continue
        try:
            df = parser(caminho)                 # DataFrame normalizado
            erros = validar_dre(df)              # validação
            n = upsert_dre(empresa, df)          # INSERT/UPDATE
            total += n
            if erros:
                log_carga(empresa, caminho, "parcial", erros)
                out.append(f"  [{empresa}] PARCIAL: {n} linhas | alertas: {erros}")
            else:
                log_carga(empresa, caminho, "sucesso", n)
                out.append(f"  [{empresa}] OK: {n} linhas carregadas")
        except Exception as e:
            log_carga(empresa, caminho, "erro", str(e))
            out.append(f"  [{empresa}] ERRO: {e}")
            had_error = True

    ref_file = find_file("REF+")               # receita por cliente (REF)
    if ref_file:
        try:
            dfc = parse_clientes_ref(ref_file)
            nc = upsert_receita_cliente(dfc)
            out.append(f"  [REF/clientes] OK: {nc} linhas (receita por cliente)")
        except Exception as e:
            out.append(f"  [REF/clientes] ERRO: {e}")
            had_error = True

    out.append(f"-- total fato_dre_mensal: {total} linhas --")

    # histórico anual 2018–2025 (ponto em dez) — evolução completa no cockpit
    try:
        rh = history.run()
        out.append(rh["output"])
        had_error = had_error or (not rh["ok"])
    except Exception as e:
        out.append(f"  [histórico] ERRO: {e}")
        had_error = True

    # folha + fees (API_CONTRACT.md §Novas tabelas) — cockpit 100% data-driven
    try:
        rf = folha_fees.run()
        out.append(rf["output"])
        had_error = had_error or (not rf["ok"])
    except Exception as e:
        out.append(f"  [folha/fees] ERRO: {e}")
        had_error = True

    alerts = run_quality_checks()              # checagens de qualidade pós-carga
    if alerts:
        out.append("ALERTAS DE QUALIDADE:")
        out += [f"  - {a}" for a in alerts]
    else:
        out.append("Qualidade OK.")
    # exit/ok reflete ERROS de carga E falhas de qualidade (§6.4) — assim o n8n
    # ramifica (IF) e alerta também quando a reprodutibilidade/consistência falha.
    return {"ok": (not had_error) and (not alerts), "total": total, "output": "\n".join(out)}


def main():
    r = run()
    print(r["output"])
    sys.exit(0 if r["ok"] else 1)


if __name__ == "__main__":
    main()
