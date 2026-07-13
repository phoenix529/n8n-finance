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
import tri_hist
import receita_tipo

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


def find_files(prefix):
    """TODOS os arquivos DRE da empresa (um por ano: '... DRE Acumulado 2026.xlsx',
    '... 2027.xlsx', ...). Multi-ano: cada um é processado com o ano do nome."""
    return sorted(glob.glob(str(INCOMING / f"{prefix}*DRE*.xlsx")))


def year_from_name(path, default=None):
    """Ano (20xx) extraído do nome do arquivo; default = ano-calendário atual."""
    import re, datetime
    m = re.search(r"(20\d{2})", os.path.basename(path))
    return int(m.group(1)) if m else (default or datetime.date.today().year)


def run():
    """Executa a ingestão IN-PROCESS e devolve {ok, total, output} (sem print/sys.exit).
    Usado tanto pela CLI quanto pelo runner HTTP do FastAPI (chamada in-process — não
    depende de spawnar subprocesso)."""
    out = [f"== Ingestão Cockpit REF == (planilhas em {INCOMING})"]
    had_error = False
    total = 0
    for empresa, (prefix, parser) in PARSERS.items():
        caminhos = find_files(prefix)
        if not caminhos:
            out.append(f"  [{empresa}] arquivo não encontrado (prefixo {prefix})")
            log_carga(empresa, f"{prefix}*", "erro", "arquivo não encontrado")
            had_error = True
            continue
        for caminho in caminhos:                 # multi-ano: um workbook por ano
            ano_arq = year_from_name(caminho)
            try:
                df = parser(caminho, ano_arq)    # DataFrame normalizado (ano do nome)
                erros = validar_dre(df)          # validação
                n = upsert_dre(empresa, df)      # INSERT/UPDATE
                total += n
                if erros:
                    log_carga(empresa, caminho, "parcial", erros)
                    out.append(f"  [{empresa}/{ano_arq}] PARCIAL: {n} linhas | alertas: {erros}")
                else:
                    log_carga(empresa, caminho, "sucesso", n)
                    out.append(f"  [{empresa}/{ano_arq}] OK: {n} linhas carregadas")
            except Exception as e:
                log_carga(empresa, caminho, "erro", str(e))
                out.append(f"  [{empresa}/{ano_arq}] ERRO: {e}")
                had_error = True

    for ref_file in find_files("REF+"):        # receita por cliente (REF), por ano
        try:
            dfc = parse_clientes_ref(ref_file, year_from_name(ref_file))
            nc = upsert_receita_cliente(dfc)
            out.append(f"  [REF/clientes/{year_from_name(ref_file)}] OK: {nc} linhas (receita por cliente)")
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

    # histórico trimestral 2024–2026 (aba 'Comparativo/Resumo tri') — hist[] do cockpit
    try:
        rt = tri_hist.run()
        out.append(rt["output"])
        had_error = had_error or (not rt["ok"])
    except Exception as e:
        out.append(f"  [tri_hist] ERRO: {e}")
        had_error = True

    # mix de receita bruta por tipo (Painel 02) — fato_receita_tipo_mensal + reconc.
    try:
        rrt = receita_tipo.run()
        out.append(rrt["output"])
        had_error = had_error or (not rrt["ok"])
    except Exception as e:
        out.append(f"  [receita_tipo] ERRO: {e}")
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
