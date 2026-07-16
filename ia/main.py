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
import api_cockpit                                  # API do Cockpit (API_CONTRACT.md)

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

# --- Cockpit: API REST (/api/*) + frontend estático (/app) -------------------
app.include_router(api_cockpit.router)
_APP_DIR = ROOT / "cockpit-app"
if _APP_DIR.is_dir():                               # guarda: só monta se existir
    from fastapi.staticfiles import StaticFiles

    import re as _re
    from fastapi.responses import HTMLResponse

    def _app_asset_ver():
        """Versão do frontend = maior mtime dos .js/.css locais (hex). Muda quando
        um deploy altera qualquer arquivo do app; estável entre restarts."""
        mt = 0
        for p in _APP_DIR.rglob("*"):
            if p.suffix in (".js", ".css"):
                try:
                    mt = max(mt, int(p.stat().st_mtime))
                except OSError:
                    pass
        return format(mt, "x")

    _ASSET_VER = _app_asset_ver()

    class _NoCacheStatic(StaticFiles):
        """Anti-cache-velho em duas camadas (o Cloudflare do cliente reescreve
        Cache-Control p/ max-age=14400 em asset cacheado — Browser Cache TTL do
        zone, fora do nosso controle — então só `no-cache` não basta):
        1. index.html sai com no-cache E com os src/href locais carimbados com
           ?v=<versão do deploy> — URL nova a cada deploy ⇒ cache antigo (edge OU
           navegador) nunca é consultado.
        2. Demais arquivos saem com no-cache (revalidação ETag → 304 barato) para
           quem acessa o origin direto, sem CDN na frente."""
        async def get_response(self, path, scope):
            if path in ("", ".", "index.html"):
                html = (_APP_DIR / "index.html").read_text(encoding="utf-8")
                html = _re.sub(r'((?:src|href)="(?:js|css)/[^"?]+)"',
                               r'\1?v=' + _ASSET_VER + '"', html)
                return HTMLResponse(html, headers={"Cache-Control": "no-cache"})
            resp = await super().get_response(path, scope)
            resp.headers["Cache-Control"] = "no-cache"
            return resp

    app.mount("/app", _NoCacheStatic(directory=str(_APP_DIR), html=True), name="cockpit-app")


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
import sys as _sys, importlib.util, traceback
_ING = str(ROOT / "ingestao")
if _ING not in _sys.path:
    _sys.path.insert(0, _ING)
RUNNERS = {"sync": "drive_sync", "ingestao": "main", "qualidade": "validators", "cor": "cor_loader"}


def _load_runner(modname):
    """Carrega ingestao/<modname>.py SEMPRE pelo caminho do arquivo, com chave
    única no sys.modules. Corrige colisão real: o uvicorn já registra ESTE
    arquivo (ia/main.py) como módulo 'main'; import_module('main') devolvia o
    módulo errado (sem run()) em vez de ingestao/main.py."""
    key = "ingestao_" + modname
    if key in _sys.modules:
        return _sys.modules[key]
    spec = importlib.util.spec_from_file_location(key, os.path.join(_ING, modname + ".py"))
    mod = importlib.util.module_from_spec(spec)
    _sys.modules[key] = mod
    spec.loader.exec_module(mod)
    return mod


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
        m = _load_runner(RUNNERS[script])
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
