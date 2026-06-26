#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
ask.py — Consulta RAG do Cockpit Financeiro Estratégico (Fase 2).

Conforme SPEC.md (fonte única de verdade). Schema: cockpit.

Fluxo (responde em < 30s, ancorado ESTRITAMENTE nos fatos recuperados):
  1. Embeda a pergunta (mesma camada plugável de embed.py; fallback local 1536).
  2. Recupera os top-k documentos por similaridade de cosseno em
     cockpit.kb_embeddings (operador <=> do pgvector).
  3. Monta um prompt ancorado (grounded) com os fatos recuperados.
  4. Chama o Claude /v1/messages (modelo de env LLM_MODEL, default
     claude-opus-4-8) via SDK anthropic, ou HTTP cru (urllib) se o SDK ausente.
  5. Insere uma linha de auditoria em cockpit.ai_query_audit
     (question, retrieved_doc_ids, answer, model, tokens, latency_ms, user_role).
  6. Imprime a resposta + as fontes.

Uso (CLI):
    python ask.py "Qual o EBITDA consolidado do último mês?"
    python ask.py --role cockpit_executive --k 6 "Como está o runway?"
    python ask.py --json "Qual a margem EBITDA da Aurora Varejo em 2026-05?"

Uso (importável):
    from ask import ask
    resultado = ask("Qual o caixa consolidado?", role="cockpit_analyst")
    # -> {"answer": ..., "sources": [...], "doc_ids": [...], "model": ...,
    #     "prompt_tokens": ..., "completion_tokens": ..., "latency_ms": ...}
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys
import time
import urllib.error
import urllib.request
from typing import Any, Sequence

# Reutiliza a camada de embeddings e a conexão de embed.py (mesmo diretório).
try:
    from embed import connect_db, embed_texts, EMBED_DIM
except Exception:  # execução fora do diretório do módulo
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from embed import connect_db, embed_texts, EMBED_DIM  # type: ignore

LOG = logging.getLogger("cockpit.ask")

# Conforme claude-api skill: modelos vigentes. Default claude-opus-4-8.
DEFAULT_LLM_MODEL = "claude-opus-4-8"
ANTHROPIC_VERSION = "2023-06-01"
ANTHROPIC_URL = "https://api.anthropic.com/v1/messages"
MAX_TOKENS = 1024
REQUEST_TIMEOUT_S = 28  # mantém o SLA de < 30s
VALID_ROLES = {"cockpit_admin", "cockpit_analyst", "cockpit_executive", "cockpit_auditor"}


# -----------------------------------------------------------------------------
# .env opcional
# -----------------------------------------------------------------------------
def _load_dotenv() -> None:
    try:
        from dotenv import load_dotenv  # type: ignore
    except Exception:
        return
    env_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env")
    if os.path.exists(env_path):
        load_dotenv(env_path)


# -----------------------------------------------------------------------------
# Recuperação: top-k por cosseno em kb_embeddings (pgvector)
# -----------------------------------------------------------------------------
def _vector_literal(vec: Sequence[float]) -> str:
    return "[" + ",".join(f"{x:.8f}" for x in vec) + "]"


# Distância de cosseno do pgvector: operador <=>. Similaridade = 1 - distância.
RETRIEVE_SQL = r"""
SELECT
    d.id           AS doc_id,
    d.doc_type,
    d.company_id,
    d.period_date,
    d.title,
    d.content,
    1 - (e.embedding <=> %(qvec)s::vector) AS similaridade
FROM cockpit.kb_embeddings e
JOIN cockpit.kb_documents  d ON d.id = e.doc_id
ORDER BY e.embedding <=> %(qvec)s::vector
LIMIT %(k)s
"""


def retrieve_topk(conn, question_vec: Sequence[float], k: int) -> list[dict[str, Any]]:
    """Recupera os k documentos mais similares à pergunta."""
    out: list[dict[str, Any]] = []
    with conn.cursor() as cur:
        cur.execute(RETRIEVE_SQL, {"qvec": _vector_literal(question_vec), "k": k})
        cols = [c[0] for c in cur.description]
        for raw in cur.fetchall():
            out.append(dict(zip(cols, raw)))
    return out


# -----------------------------------------------------------------------------
# Montagem do prompt ancorado (grounded) em PT-BR
# -----------------------------------------------------------------------------
SYSTEM_PROMPT = (
    "Você é o assistente financeiro do Cockpit Estratégico do Grupo Aurora, um "
    "grupo empresarial brasileiro multi-companhia. Responda SEMPRE em português "
    "do Brasil, de forma objetiva e executiva, com valores em reais (R$).\n\n"
    "REGRA DE OURO — ancoragem estrita: use EXCLUSIVAMENTE os FATOS RECUPERADOS "
    "fornecidos abaixo. NUNCA invente números, datas, empresas ou métricas que "
    "não estejam explicitamente nos fatos. Se a informação necessária não estiver "
    "presente, diga claramente que não há dados suficientes no contexto recuperado "
    "(ex.: 'Não encontrei esse dado nos fatos disponíveis.'). Não estime, não "
    "extrapole e não use conhecimento externo para preencher lacunas numéricas.\n\n"
    "Ao citar um número, mantenha a unidade e o período exatamente como nos fatos. "
    "Quando útil, mencione a empresa e o período de referência. Seja conciso."
)


def build_user_prompt(question: str, docs: list[dict[str, Any]]) -> str:
    """Monta o turno do usuário com os fatos recuperados + a pergunta."""
    linhas = ["FATOS RECUPERADOS (base de conhecimento do cockpit):", ""]
    if not docs:
        linhas.append("(nenhum fato recuperado)")
    for i, d in enumerate(docs, start=1):
        periodo = d.get("period_date")
        periodo_str = ""
        if periodo is not None:
            # period_date pode ser date ou str dependendo do driver.
            periodo_str = str(periodo)[:7]
        cabecalho = f"[{i}] {d.get('title', '(sem título)')}"
        if periodo_str:
            cabecalho += f" (ref. {periodo_str})"
        linhas.append(cabecalho)
        linhas.append(d.get("content", "").strip())
        linhas.append("")
    linhas.append("PERGUNTA DO USUÁRIO:")
    linhas.append(question.strip())
    linhas.append("")
    linhas.append(
        "Responda usando apenas os fatos acima. Se faltar dado, diga que não "
        "há informação suficiente no contexto recuperado."
    )
    return "\n".join(linhas)


# -----------------------------------------------------------------------------
# Chamada ao Claude — SDK anthropic se disponível, senão HTTP cru (urllib)
# -----------------------------------------------------------------------------
def _call_claude_sdk(model: str, system: str, user_prompt: str,
                     api_key: str) -> tuple[str, int, int]:
    """Usa o SDK anthropic. Retorna (texto, prompt_tokens, completion_tokens)."""
    import anthropic  # type: ignore

    client = anthropic.Anthropic(api_key=api_key)
    resp = client.messages.create(
        model=model,
        max_tokens=MAX_TOKENS,
        system=system,
        # Pensamento adaptativo (recomendado para 4.x); não afeta o SLA aqui.
        thinking={"type": "adaptive"},
        messages=[{"role": "user", "content": user_prompt}],
    )
    texto = "".join(
        block.text for block in resp.content if getattr(block, "type", None) == "text"
    ).strip()
    usage = getattr(resp, "usage", None)
    pt = int(getattr(usage, "input_tokens", 0) or 0)
    ct = int(getattr(usage, "output_tokens", 0) or 0)
    return texto, pt, ct


def _call_claude_http(model: str, system: str, user_prompt: str,
                      api_key: str) -> tuple[str, int, int]:
    """Fallback HTTP cru (urllib) para /v1/messages. Mesmo retorno do SDK."""
    payload = json.dumps({
        "model": model,
        "max_tokens": MAX_TOKENS,
        "system": system,
        "thinking": {"type": "adaptive"},
        "messages": [{"role": "user", "content": user_prompt}],
    }).encode("utf-8")

    req = urllib.request.Request(ANTHROPIC_URL, data=payload, method="POST")
    req.add_header("Content-Type", "application/json")
    req.add_header("x-api-key", api_key)
    req.add_header("anthropic-version", ANTHROPIC_VERSION)

    with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT_S) as resp:
        body = json.loads(resp.read().decode("utf-8"))

    blocks = body.get("content", [])
    texto = "".join(
        b.get("text", "") for b in blocks if b.get("type") == "text"
    ).strip()
    usage = body.get("usage", {}) or {}
    pt = int(usage.get("input_tokens", 0) or 0)
    ct = int(usage.get("output_tokens", 0) or 0)
    return texto, pt, ct


def call_claude(model: str, system: str, user_prompt: str) -> tuple[str, int, int]:
    """
    Chama o Claude usando o SDK se disponível, senão HTTP cru.
    Levanta RuntimeError se ANTHROPIC_API_KEY não estiver definido.
    """
    api_key = os.getenv("ANTHROPIC_API_KEY", "").strip()
    if not api_key:
        raise RuntimeError(
            "ANTHROPIC_API_KEY não definido — impossível chamar o Claude.")

    try:
        import anthropic  # noqa: F401  (apenas verifica disponibilidade)
        return _call_claude_sdk(model, system, user_prompt, api_key)
    except ImportError:
        LOG.info("SDK anthropic ausente — usando HTTP cru (urllib).")
        return _call_claude_http(model, system, user_prompt, api_key)


# -----------------------------------------------------------------------------
# Auditoria — insere em cockpit.ai_query_audit
# -----------------------------------------------------------------------------
AUDIT_SQL = r"""
INSERT INTO cockpit.ai_query_audit
    (user_role, question, retrieved_doc_ids, answer, model,
     prompt_tokens, completion_tokens, latency_ms, created_at)
VALUES
    (%(user_role)s, %(question)s, %(retrieved_doc_ids)s, %(answer)s, %(model)s,
     %(prompt_tokens)s, %(completion_tokens)s, %(latency_ms)s, now())
RETURNING id
"""


def write_audit(conn, *, user_role: str, question: str, doc_ids: list[int],
                answer: str, model: str, prompt_tokens: int,
                completion_tokens: int, latency_ms: int) -> int | None:
    """Grava a linha de auditoria. Retorna o id, ou None em falha (não fatal)."""
    try:
        with conn.cursor() as cur:
            cur.execute(AUDIT_SQL, {
                "user_role": user_role,
                "question": question,
                # retrieved_doc_ids é int[] no schema — psycopg aceita lista Python.
                "retrieved_doc_ids": doc_ids,
                "answer": answer,
                "model": model,
                "prompt_tokens": prompt_tokens,
                "completion_tokens": completion_tokens,
                "latency_ms": latency_ms,
            })
            audit_id = int(cur.fetchone()[0])
        conn.commit()
        return audit_id
    except Exception as exc:
        conn.rollback()
        LOG.warning("Falha ao gravar auditoria (não fatal): %s", exc)
        return None


# -----------------------------------------------------------------------------
# Função principal importável: ask(question, role)
# -----------------------------------------------------------------------------
def ask(question: str, role: str = "cockpit_analyst", *, k: int = 5,
        conn: Any = None) -> dict[str, Any]:
    """
    Responde a uma pergunta em linguagem natural ancorada nos fatos do cockpit.

    Parâmetros:
        question : pergunta em PT-BR.
        role     : papel RBAC do solicitante (registrado na auditoria).
        k        : número de documentos a recuperar (top-k).
        conn     : conexão psycopg opcional (reuso por chamadores, ex.: n8n).
                   Se None, abre e fecha uma conexão própria.

    Retorna dict com: answer, sources, doc_ids, model, prompt_tokens,
                      completion_tokens, latency_ms.
    """
    if role not in VALID_ROLES:
        LOG.warning("Papel '%s' não reconhecido; registrando assim mesmo.", role)

    model = os.getenv("LLM_MODEL", DEFAULT_LLM_MODEL).strip() or DEFAULT_LLM_MODEL
    t0 = time.time()

    own_conn = conn is None
    if own_conn:
        conn, _driver = connect_db()

    try:
        # 1) Embeda a pergunta.
        qvecs, emb_model = embed_texts([question])
        qvec = qvecs[0] if qvecs else [0.0] * EMBED_DIM
        LOG.info("Pergunta embeddada com modelo '%s'.", emb_model)

        # 2) Recupera top-k.
        docs = retrieve_topk(conn, qvec, k)
        doc_ids = [int(d["doc_id"]) for d in docs]
        LOG.info("Recuperados %d documentos (top-%d).", len(docs), k)

        # 3) Monta prompt ancorado.
        user_prompt = build_user_prompt(question, docs)

        # 4) Chama o Claude.
        answer, prompt_tokens, completion_tokens = call_claude(
            model, SYSTEM_PROMPT, user_prompt)

        latency_ms = int((time.time() - t0) * 1000)
        LOG.info("Resposta gerada em %d ms (%d/%d tokens entrada/saída).",
                 latency_ms, prompt_tokens, completion_tokens)

        # 5) Auditoria.
        write_audit(conn, user_role=role, question=question, doc_ids=doc_ids,
                    answer=answer, model=model, prompt_tokens=prompt_tokens,
                    completion_tokens=completion_tokens, latency_ms=latency_ms)

        # Fontes legíveis para exibição.
        sources = []
        for d in docs:
            periodo = d.get("period_date")
            ref = str(periodo)[:7] if periodo is not None else ""
            sim = d.get("similaridade")
            sources.append({
                "doc_id": int(d["doc_id"]),
                "title": d.get("title", ""),
                "doc_type": d.get("doc_type", ""),
                "company_id": d.get("company_id"),
                "period": ref,
                "similaridade": round(float(sim), 4) if sim is not None else None,
            })

        return {
            "answer": answer,
            "sources": sources,
            "doc_ids": doc_ids,
            "model": model,
            "prompt_tokens": prompt_tokens,
            "completion_tokens": completion_tokens,
            "latency_ms": latency_ms,
        }
    finally:
        if own_conn and conn is not None:
            conn.close()


# -----------------------------------------------------------------------------
# CLI
# -----------------------------------------------------------------------------
def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Consulta RAG ancorada do Cockpit Financeiro (Claude).")
    parser.add_argument("question", nargs="+", help="Pergunta em linguagem natural.")
    parser.add_argument("--role", default="cockpit_analyst",
                        help="Papel RBAC do solicitante (default: cockpit_analyst).")
    parser.add_argument("--k", type=int, default=5,
                        help="Número de documentos recuperados (top-k, default 5).")
    parser.add_argument("--json", action="store_true",
                        help="Imprime o resultado completo em JSON.")
    parser.add_argument("--verbose", "-v", action="store_true",
                        help="Logging em nível DEBUG.")
    args = parser.parse_args(argv)

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
        datefmt="%H:%M:%S",
    )

    _load_dotenv()
    question = " ".join(args.question).strip()

    try:
        result = ask(question, role=args.role, k=args.k)
    except RuntimeError as exc:
        LOG.error("%s", exc)
        return 2
    except Exception as exc:
        LOG.exception("Erro ao processar a pergunta: %s", exc)
        return 1

    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2, default=str))
        return 0

    # Saída legível.
    print("\n" + "=" * 70)
    print("PERGUNTA:", question)
    print("=" * 70)
    print(result["answer"])
    print("-" * 70)
    print("FONTES:")
    if not result["sources"]:
        print("  (nenhuma fonte recuperada)")
    for s in result["sources"]:
        sim = f"{s['similaridade']:.3f}" if s.get("similaridade") is not None else "n/a"
        ref = f" — {s['period']}" if s.get("period") else ""
        print(f"  [{s['doc_id']}] {s['title']}{ref}  (sim {sim})")
    print("-" * 70)
    print(f"Modelo: {result['model']} | "
          f"tokens entrada/saída: {result['prompt_tokens']}/{result['completion_tokens']} | "
          f"latência: {result['latency_ms']} ms")
    print("=" * 70 + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
