#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
ia/main.py — serviço de IA consultiva (Technical Blueprint §7.4).
FastAPI expõe POST /perguntar: recebe pergunta em linguagem natural, monta o
contexto a partir do PostgreSQL (context_builder) e responde com Claude,
fundamentado SOMENTE nos números. Autenticação por API key (§8).

Rodar:  cd ia && uvicorn main:app --host 127.0.0.1 --port 8500
        (ou: python main.py)
"""
import os, time, pathlib
from fastapi import FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import anthropic

import sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from context_builder import build_context

ROOT = pathlib.Path(__file__).resolve().parent.parent
_envp = ROOT / ".env"
if _envp.exists():
    for line in _envp.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip())

LLM_MODEL = os.environ.get("LLM_MODEL", "claude-opus-4-8")   # blueprint: claude-opus-4-5 -> latest
IA_API_KEY = os.environ.get("IA_API_KEY", "")               # se vazio, auth desativada (dev)

SYSTEM_PROMPT = """
You are a senior financial analyst at REF Group, a Brazilian communication group.
You have access to the consolidated financial data of the group and its 5 companies.
Always answer in Portuguese, in an objective and executive manner.
When identifying relevant variations, explain the probable cause based on the data.
Do not invent data. If the information is not in the provided context, say that you do not have this information available.
Format monetary values in R$ with a thousands separator.
""".strip()

app = FastAPI(title="Cockpit REF — IA Consultiva", version="1.0")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])
_client = anthropic.Anthropic()   # lê ANTHROPIC_API_KEY do ambiente


class Pergunta(BaseModel):
    texto: str
    empresa: str | None = None      # filtro opcional: REF, BD, 4PR, VIV, ZUP
    periodo: str | None = None      # ex.: "2026", "2026-Q1", "2026-06"


def _check_key(x_api_key):
    if IA_API_KEY and x_api_key != IA_API_KEY:
        raise HTTPException(status_code=401, detail="API key inválida (cabeçalho X-API-Key)")


@app.get("/health")
def health():
    return {"status": "ok", "model": LLM_MODEL,
            "key_set": os.environ.get("ANTHROPIC_API_KEY", "").startswith("sk-ant")}


@app.post("/perguntar")
def perguntar(p: Pergunta, x_api_key: str = Header(default="")):
    _check_key(x_api_key)
    t0 = time.time()
    contexto = build_context(p.empresa, p.periodo)
    try:
        resposta = _client.messages.create(
            model=LLM_MODEL, max_tokens=1024, system=SYSTEM_PROMPT,
            messages=[{"role": "user", "content": f"Context:\n{contexto}\n\nQuestion: {p.texto}"}],
        )
        texto = "".join(b.text for b in resposta.content if b.type == "text").strip()
        return {"resposta": texto, "fontes": ["cockpit_ref.fato_dre_mensal", "fato_receita_cliente_mensal"],
                "modelo": LLM_MODEL, "latency_ms": int((time.time() - t0) * 1000)}
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Falha na geração: {e}")


# ---------------------------------------------------------------------------
# Runner HTTP (Blueprint §3.1: "n8n executa o script Python via shell OU HTTP").
# Usado pelos workflows do n8n via nó HTTP Request (sempre disponível), evitando
# o nó Execute Command (desabilitado por segurança nesta instância n8n).
# ---------------------------------------------------------------------------
import sys as _sys, importlib, traceback
_ING = str(ROOT / "ingestao")
if _ING not in _sys.path:
    _sys.path.insert(0, _ING)
RUNNERS = {"sync": "drive_sync", "ingestao": "main", "qualidade": "validators", "cor": "cor_loader"}


@app.post("/run/{script}")
def run_script(script: str):
    # Endpoint INTERNO: o uvicorn escuta só em 127.0.0.1 (isolamento de rede) e os scripts
    # são FIXOS por allow-list (sem entrada do usuário -> sem injeção); por isso não exige
    # API key — nenhum segredo vai para o JSON do workflow (§8). Roda IN-PROCESS (importa o
    # módulo e chama run()) — não depende de spawnar subprocesso.
    if script not in RUNNERS:
        raise HTTPException(status_code=404, detail=f"script desconhecido (use {list(RUNNERS)})")
    t0 = time.time()
    try:
        m = importlib.import_module(RUNNERS[script])
        r = m.run()
        ok = bool(r.get("ok"))
        return {"ok": ok, "script": script, "returncode": 0 if ok else 1,
                "stdout": (r.get("output") or "")[-3000:],
                "stderr": "" if ok else (r.get("output") or "")[-1500:],
                "latency_ms": int((time.time() - t0) * 1000)}
    except Exception:
        return {"ok": False, "script": script, "returncode": 1, "stdout": "",
                "stderr": traceback.format_exc()[-1500:], "latency_ms": int((time.time() - t0) * 1000)}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=int(os.environ.get("IA_PORT", "8500")))
