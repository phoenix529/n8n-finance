#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
embed.py — Pipeline de embeddings do Cockpit Financeiro Estratégico (Fase 2 RAG).

Conforme SPEC.md (fonte única de verdade). Schema: cockpit.

O que este script faz (idempotente):
  1. Conecta ao PostgreSQL (variáveis PG*; psycopg v3 ou psycopg2).
  2. Lê as views de consolidação/KPI e constrói UMA narrativa por
     (company, period, metric-group) — exatamente o shape de
     db/queries/rag_documents.sql.
  3. Faz upsert dessas narrativas em cockpit.kb_documents
     (chave lógica: doc_type + company_id + period_date).
  4. Gera embedding de cada documento via função plugável de embeddings
     (env EMBED_MODEL / EMBED_URL). Inclui fallback local determinístico
     (hash) de dimensão 1536, para rodar 100% offline em demo.
  5. Faz upsert em cockpit.kb_embeddings (embedding vector(1536), model).
  6. Só recalcula embeddings de documentos novos/alterados, salvo --force.

Uso:
    python embed.py                 # incremental (recomendado)
    python embed.py --force         # recalcula todos os embeddings
    python embed.py --only-docs     # só (re)constrói kb_documents, sem embeddar
    python embed.py --limit 50      # processa no máx. 50 documentos (debug)

Tudo com logging claro em pt-BR. Sai com código != 0 em erro fatal.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import logging
import os
import struct
import sys
import time
import urllib.error
import urllib.request
from typing import Any, Iterable, Sequence

# -----------------------------------------------------------------------------
# Configuração e constantes (conforme SPEC)
# -----------------------------------------------------------------------------
EMBED_DIM = 1536  # SPEC §6/§7: vector(1536)
DEFAULT_EMBED_MODEL = "text-embedding-3-small"
LOCAL_FALLBACK_MODEL = "local-hash-1536"  # marca embeddings determinísticos offline

LOG = logging.getLogger("cockpit.embed")


# -----------------------------------------------------------------------------
# .env opcional
# -----------------------------------------------------------------------------
def _load_dotenv() -> None:
    """Carrega .env do diretório do script, se python-dotenv estiver disponível."""
    try:
        from dotenv import load_dotenv  # type: ignore
    except Exception:
        return
    env_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env")
    if os.path.exists(env_path):
        load_dotenv(env_path)
        LOG.debug("Variáveis carregadas de %s", env_path)


# -----------------------------------------------------------------------------
# Conexão ao PostgreSQL (psycopg v3 preferido; psycopg2 como fallback)
# -----------------------------------------------------------------------------
def connect_db():
    """
    Abre conexão usando variáveis PGHOST/PGPORT/PGDATABASE/PGUSER/PGPASSWORD.
    Retorna (conn, driver) onde driver ∈ {"psycopg", "psycopg2"}.
    """
    params = {
        "host": os.getenv("PGHOST", "localhost"),
        "port": os.getenv("PGPORT", "5432"),
        "dbname": os.getenv("PGDATABASE", "cockpit"),
        "user": os.getenv("PGUSER", "postgres"),
        "password": os.getenv("PGPASSWORD", ""),
    }
    # Tenta psycopg v3
    try:
        import psycopg  # type: ignore

        conn = psycopg.connect(**params)
        LOG.info("Conectado ao PostgreSQL via psycopg (v3): %s/%s",
                 params["host"], params["dbname"])
        return conn, "psycopg"
    except ImportError:
        pass
    except Exception as exc:  # falha de conexão real
        LOG.error("Falha ao conectar via psycopg: %s", exc)
        raise

    # Fallback psycopg2
    try:
        import psycopg2  # type: ignore

        conn = psycopg2.connect(**params)
        LOG.info("Conectado ao PostgreSQL via psycopg2: %s/%s",
                 params["host"], params["dbname"])
        return conn, "psycopg2"
    except ImportError as exc:
        LOG.error("Nenhum driver PostgreSQL disponível. "
                  "Instale 'psycopg[binary]' ou 'psycopg2-binary'.")
        raise SystemExit(2) from exc


# -----------------------------------------------------------------------------
# Função de embeddings plugável + fallback local determinístico (dim 1536)
# -----------------------------------------------------------------------------
def _local_hash_embedding(text: str, dim: int = EMBED_DIM) -> list[float]:
    """
    Embedding local DETERMINÍSTICO (offline) baseado em hashing de tokens.

    Estratégia "hashing trick": cada token incrementa um bucket; o vetor é
    L2-normalizado. Não captura semântica como um modelo treinado, mas é
    estável, reproduzível e suficiente para uma demo de RAG totalmente offline.
    A mesma entrada sempre produz o mesmo vetor (idempotência garantida).
    """
    vec = [0.0] * dim
    # Tokenização simples por espaços/pontuação leve.
    tokens = (
        text.lower()
        .replace(".", " ")
        .replace(",", " ")
        .replace(";", " ")
        .replace(":", " ")
        .replace("(", " ")
        .replace(")", " ")
        .replace("%", " ")
        .replace("R$", " ")
        .split()
    )
    if not tokens:
        tokens = ["__vazio__"]

    for tok in tokens:
        # Hash estável (não usa hash() do Python, que é randomizado por processo).
        h = hashlib.sha256(tok.encode("utf-8")).digest()
        # Índice do bucket a partir dos 4 primeiros bytes.
        idx = struct.unpack_from(">I", h, 0)[0] % dim
        # Sinal a partir do 5º byte (distribui + e -).
        sign = 1.0 if (h[4] & 1) == 0 else -1.0
        vec[idx] += sign

    # Normalização L2 (vetor unitário) para cosseno estável.
    norm = sum(v * v for v in vec) ** 0.5
    if norm > 0:
        vec = [v / norm for v in vec]
    return vec


def _remote_embeddings(texts: Sequence[str], model: str, url: str,
                       api_key: str | None) -> list[list[float]]:
    """
    Chama um endpoint HTTP de embeddings no formato OpenAI-like.
    Espera resposta: {"data": [{"embedding": [...]}, ...]}.
    Levanta exceção em qualquer falha (o chamador decide se cai no fallback).
    """
    payload = json.dumps({"model": model, "input": list(texts)}).encode("utf-8")
    req = urllib.request.Request(url, data=payload, method="POST")
    req.add_header("Content-Type", "application/json")
    if api_key:
        req.add_header("Authorization", f"Bearer {api_key}")

    with urllib.request.urlopen(req, timeout=30) as resp:
        body = json.loads(resp.read().decode("utf-8"))

    data = body.get("data")
    if not isinstance(data, list) or len(data) != len(texts):
        raise ValueError("Resposta de embeddings em formato inesperado.")

    out: list[list[float]] = []
    for item in data:
        emb = item.get("embedding")
        if not isinstance(emb, list):
            raise ValueError("Item sem campo 'embedding'.")
        if len(emb) != EMBED_DIM:
            # Ajusta dimensão por truncamento/padding para conformar ao schema.
            if len(emb) > EMBED_DIM:
                emb = emb[:EMBED_DIM]
            else:
                emb = emb + [0.0] * (EMBED_DIM - len(emb))
        out.append([float(x) for x in emb])
    return out


def embed_texts(texts: Sequence[str]) -> tuple[list[list[float]], str]:
    """
    Camada PLUGÁVEL de embeddings.
    Retorna (lista_de_vetores, model_usado).

    - Se EMBED_URL estiver definido, tenta o serviço remoto (EMBED_MODEL).
    - Em qualquer falha, ou se EMBED_URL ausente, usa o fallback local
      determinístico (model = local-hash-1536), garantindo operação offline.
    """
    if not texts:
        return [], LOCAL_FALLBACK_MODEL

    model = os.getenv("EMBED_MODEL", DEFAULT_EMBED_MODEL)
    url = os.getenv("EMBED_URL", "").strip()
    api_key = os.getenv("EMBED_API_KEY") or None

    if url:
        try:
            vecs = _remote_embeddings(texts, model, url, api_key)
            return vecs, model
        except (urllib.error.URLError, ValueError, TimeoutError, OSError) as exc:
            LOG.warning("Serviço de embeddings remoto indisponível (%s). "
                        "Usando fallback local determinístico.", exc)

    # Fallback offline determinístico.
    vecs = [_local_hash_embedding(t) for t in texts]
    return vecs, LOCAL_FALLBACK_MODEL


# -----------------------------------------------------------------------------
# SQL: construção das narrativas (espelha db/queries/rag_documents.sql)
# -----------------------------------------------------------------------------
# Combina os 5 grupos de narrativa num único resultset:
#   (doc_type, company_id, period_date, title, content, metadata)
NARRATIVE_SQL = r"""
WITH
-- (1) P&L por empresa-mês
pnl_emp AS (
    SELECT
        'pnl_empresa_mes' AS doc_type,
        p.company_id,
        p.period_date,
        format('P&L %s — %s', c.name, to_char(p.period_date, 'YYYY-MM')) AS title,
        format(
            'Resultado de %s (%s, setor %s) em %s: '
            || 'Receita Líquida R$ %s; Lucro Bruto R$ %s (margem bruta %s%%); '
            || 'EBITDA R$ %s (margem EBITDA %s%%); EBIT R$ %s; '
            || 'Lucro Líquido R$ %s (margem líquida %s%%).',
            c.name, p.company_id, c.sector, to_char(p.period_date, 'YYYY-MM'),
            to_char(p.receita_liquida, 'FM999G999G990D00'),
            to_char(p.lucro_bruto,     'FM999G999G990D00'),
            to_char(COALESCE(p.margem_bruta_pct, 0),  'FM990D0'),
            to_char(p.ebitda,          'FM999G999G990D00'),
            to_char(COALESCE(p.margem_ebitda_pct, 0), 'FM990D0'),
            to_char(p.ebit,            'FM999G999G990D00'),
            to_char(p.lucro_liquido,   'FM999G999G990D00'),
            to_char(COALESCE(p.margem_liquida_pct, 0), 'FM990D0')
        ) AS content,
        jsonb_build_object(
            'company_id', p.company_id, 'company_name', c.name, 'sector', c.sector,
            'period', to_char(p.period_date, 'YYYY-MM'),
            'receita_liquida', p.receita_liquida, 'lucro_bruto', p.lucro_bruto,
            'ebitda', p.ebitda, 'ebit', p.ebit, 'lucro_liquido', p.lucro_liquido,
            'margem_ebitda_pct', p.margem_ebitda_pct, 'grupo', 'pnl'
        ) AS metadata
    FROM cockpit.v_pnl_company_month p
    JOIN cockpit.dim_company c USING (company_id)
    WHERE c.is_consolidating = TRUE
),
-- (2) Posição por empresa-mês
pos_emp AS (
    SELECT
        'posicao_empresa_mes' AS doc_type,
        v.company_id,
        v.period_date,
        format('Posição financeira %s — %s', c.name, to_char(v.period_date, 'YYYY-MM')) AS title,
        format(
            'Posição financeira de %s (%s) em %s: '
            || 'Caixa e Equivalentes R$ %s; Dívida Bruta R$ %s; Dívida Líquida R$ %s; '
            || 'Capital de Giro R$ %s; DSO %s dias '
            || '(Contas a Receber R$ %s, Contas a Pagar R$ %s, Estoques R$ %s).',
            c.name, v.company_id, to_char(v.period_date, 'YYYY-MM'),
            to_char(v.caixa,          'FM999G999G990D00'),
            to_char(v.divida,         'FM999G999G990D00'),
            to_char(v.divida_liquida, 'FM999G999G990D00'),
            to_char(v.capital_giro,   'FM999G999G990D00'),
            to_char(COALESCE(v.dso_dias, 0), 'FM990D0'),
            to_char(v.ar,             'FM999G999G990D00'),
            to_char(v.ap,             'FM999G999G990D00'),
            to_char(v.estoque,        'FM999G999G990D00')
        ) AS content,
        jsonb_build_object(
            'company_id', v.company_id, 'company_name', c.name,
            'period', to_char(v.period_date, 'YYYY-MM'),
            'caixa', v.caixa, 'divida_liquida', v.divida_liquida,
            'capital_giro', v.capital_giro, 'dso_dias', v.dso_dias, 'grupo', 'posicao'
        ) AS metadata
    FROM cockpit.v_position_company_month v
    JOIN cockpit.dim_company c USING (company_id)
    WHERE c.is_consolidating = TRUE
),
-- (3) Consolidado por mês (company_id = NULL)
pos_cons AS (
    SELECT period_date,
           SUM(caixa) AS caixa, SUM(divida_liquida) AS divida_liquida,
           SUM(capital_giro) AS capital_giro
    FROM cockpit.v_position_company_month
    GROUP BY period_date
),
cons_mes AS (
    SELECT
        'consolidado_mes' AS doc_type,
        NULL::text AS company_id,
        p.period_date,
        format('Consolidado Grupo Aurora — %s', to_char(p.period_date, 'YYYY-MM')) AS title,
        format(
            'Resultado consolidado do Grupo Aurora em %s: '
            || 'Receita Líquida R$ %s; EBITDA R$ %s (margem EBITDA %s%%); '
            || 'Lucro Líquido R$ %s; Caixa consolidado R$ %s; '
            || 'Dívida Líquida R$ %s; Capital de Giro R$ %s.',
            to_char(p.period_date, 'YYYY-MM'),
            to_char(p.receita_liquida, 'FM999G999G990D00'),
            to_char(p.ebitda,          'FM999G999G990D00'),
            to_char(COALESCE(p.margem_ebitda_pct, 0), 'FM990D0'),
            to_char(p.lucro_liquido,   'FM999G999G990D00'),
            to_char(COALESCE(pc.caixa, 0),          'FM999G999G990D00'),
            to_char(COALESCE(pc.divida_liquida, 0), 'FM999G999G990D00'),
            to_char(COALESCE(pc.capital_giro, 0),   'FM999G999G990D00')
        ) AS content,
        jsonb_build_object(
            'period', to_char(p.period_date, 'YYYY-MM'),
            'receita_liquida', p.receita_liquida, 'ebitda', p.ebitda,
            'lucro_liquido', p.lucro_liquido, 'margem_ebitda_pct', p.margem_ebitda_pct,
            'caixa', pc.caixa, 'divida_liquida', pc.divida_liquida, 'grupo', 'consolidado'
        ) AS metadata
    FROM cockpit.v_pnl_consolidado_month p
    LEFT JOIN pos_cons pc ON pc.period_date = p.period_date
),
-- (4) Orçado vs Realizado por empresa-mês (receita líquida)
bva AS (
    SELECT
        c.company_id, c.name, c.sort, v.period_date,
        SUM(CASE WHEN v.account_code IN ('R_BRUTA','DEDUCOES') THEN v.realizado ELSE 0 END) AS realizado,
        SUM(CASE WHEN v.account_code IN ('R_BRUTA','DEDUCOES') THEN v.orcado    ELSE 0 END) AS orcado
    FROM cockpit.v_budget_vs_actual v
    JOIN cockpit.dim_company c USING (company_id)
    WHERE c.is_consolidating = TRUE
    GROUP BY c.company_id, c.name, c.sort, v.period_date
),
orc_real AS (
    SELECT
        'orcado_vs_real_mes' AS doc_type,
        b.company_id,
        b.period_date,
        format('Orçado vs Realizado %s — %s', b.name, to_char(b.period_date, 'YYYY-MM')) AS title,
        format(
            'Orçado vs Realizado de %s em %s (receita líquida): '
            || 'Realizado R$ %s; Orçado R$ %s; Variação %s%% (%s a meta).',
            b.name, to_char(b.period_date, 'YYYY-MM'),
            to_char(b.realizado, 'FM999G999G990D00'),
            to_char(b.orcado,    'FM999G999G990D00'),
            to_char(CASE WHEN b.orcado <> 0 THEN (b.realizado / b.orcado - 1) * 100 ELSE 0 END, 'FM990D0'),
            CASE WHEN b.orcado <> 0 AND b.realizado >= b.orcado THEN 'acima ou em linha com'
                 ELSE 'abaixo d' END
        ) AS content,
        jsonb_build_object(
            'company_id', b.company_id, 'company_name', b.name,
            'period', to_char(b.period_date, 'YYYY-MM'),
            'realizado', b.realizado, 'orcado', b.orcado,
            'var_pct', CASE WHEN b.orcado <> 0 THEN (b.realizado / b.orcado - 1) * 100 ELSE NULL END,
            'grupo', 'orcado_vs_real'
        ) AS metadata
    FROM bva b
),
-- (5) Snapshot KPIs LTM consolidado (1 documento de estado atual)
kpi_ltm AS (
    SELECT
        'kpi_ltm' AS doc_type,
        NULL::text AS company_id,
        k.last_closed_period AS period_date,
        format('Snapshot KPIs LTM — %s', to_char(k.last_closed_period, 'YYYY-MM')) AS title,
        format(
            'Indicadores-chave (LTM, 12 meses até %s) do Grupo Aurora: '
            || 'Receita Líquida LTM R$ %s (YoY %s%%); EBITDA LTM R$ %s (margem %s%%); '
            || 'Lucro Líquido LTM R$ %s; Caixa R$ %s; Dívida Líquida R$ %s '
            || '(Dívida/EBITDA %sx); DSO %s dias; Capital de Giro R$ %s; '
            || 'Burn mensal R$ %s; Runway %s.',
            to_char(k.last_closed_period, 'YYYY-MM'),
            to_char(k.receita_liquida_ltm, 'FM999G999G990D00'),
            to_char(COALESCE(k.receita_yoy_pct, 0),    'FM990D0'),
            to_char(k.ebitda_ltm,          'FM999G999G990D00'),
            to_char(COALESCE(k.margem_ebitda_pct, 0),  'FM990D0'),
            to_char(k.lucro_liquido_ltm,   'FM999G999G990D00'),
            to_char(k.caixa,               'FM999G999G990D00'),
            to_char(k.divida_liquida,      'FM999G999G990D00'),
            to_char(COALESCE(k.divida_ebitda, 0),      'FM990D0'),
            to_char(COALESCE(k.dso_dias, 0),           'FM990D0'),
            to_char(k.capital_giro,        'FM999G999G990D00'),
            to_char(COALESCE(k.burn_mensal, 0),        'FM999G999G990D00'),
            COALESCE(to_char(k.runway_meses, 'FM990D0') || ' meses', 'n/a (fluxo positivo)')
        ) AS content,
        jsonb_build_object(
            'period', to_char(k.last_closed_period, 'YYYY-MM'),
            'receita_liquida_ltm', k.receita_liquida_ltm, 'ebitda_ltm', k.ebitda_ltm,
            'lucro_liquido_ltm', k.lucro_liquido_ltm, 'caixa', k.caixa,
            'divida_liquida', k.divida_liquida, 'divida_ebitda', k.divida_ebitda,
            'runway_meses', k.runway_meses, 'grupo', 'kpi_ltm'
        ) AS metadata
    FROM cockpit.v_kpi_consolidado_ltm k
)
SELECT doc_type, company_id, period_date, title, content, metadata FROM pnl_emp
UNION ALL SELECT doc_type, company_id, period_date, title, content, metadata FROM pos_emp
UNION ALL SELECT doc_type, company_id, period_date, title, content, metadata FROM cons_mes
UNION ALL SELECT doc_type, company_id, period_date, title, content, metadata FROM orc_real
UNION ALL SELECT doc_type, company_id, period_date, title, content, metadata FROM kpi_ltm
ORDER BY doc_type, company_id NULLS FIRST, period_date;
"""


# -----------------------------------------------------------------------------
# Upsert de kb_documents (idempotente por doc_type + company_id + period_date)
# -----------------------------------------------------------------------------
UPSERT_DOC_SQL = r"""
INSERT INTO cockpit.kb_documents
    (doc_type, company_id, period_date, title, content, metadata, created_at)
VALUES (%(doc_type)s, %(company_id)s, %(period_date)s, %(title)s, %(content)s,
        %(metadata)s::jsonb, now())
ON CONFLICT (doc_type, company_id, period_date)
DO UPDATE SET
    title    = EXCLUDED.title,
    content  = EXCLUDED.content,
    metadata = EXCLUDED.metadata
RETURNING id, content;
"""

# Fallback de upsert quando NÃO há índice único nessas colunas: emula manualmente.
SELECT_DOC_ID_SQL = r"""
SELECT id, content FROM cockpit.kb_documents
WHERE doc_type = %(doc_type)s
  AND company_id IS NOT DISTINCT FROM %(company_id)s
  AND period_date IS NOT DISTINCT FROM %(period_date)s
"""
UPDATE_DOC_SQL = r"""
UPDATE cockpit.kb_documents
SET title = %(title)s, content = %(content)s, metadata = %(metadata)s::jsonb
WHERE id = %(id)s
"""
INSERT_DOC_SQL = r"""
INSERT INTO cockpit.kb_documents
    (doc_type, company_id, period_date, title, content, metadata, created_at)
VALUES (%(doc_type)s, %(company_id)s, %(period_date)s, %(title)s, %(content)s,
        %(metadata)s::jsonb, now())
RETURNING id
"""


def _vector_literal(vec: Sequence[float]) -> str:
    """Formata uma lista de floats como literal de pgvector: '[v1,v2,...]'."""
    return "[" + ",".join(f"{x:.8f}" for x in vec) + "]"


def upsert_document(cur, row: dict[str, Any]) -> tuple[int, str]:
    """
    Faz upsert de um documento e retorna (doc_id, content_persistido).
    Tenta ON CONFLICT (índice único esperado); cai para emulação manual.
    """
    try:
        cur.execute(UPSERT_DOC_SQL, row)
        rec = cur.fetchone()
        return int(rec[0]), str(rec[1])
    except Exception:
        # Sem constraint única — emula upsert (rollback do erro acima).
        cur.connection.rollback()
        cur.execute(SELECT_DOC_ID_SQL, row)
        existing = cur.fetchone()
        if existing:
            doc_id = int(existing[0])
            cur.execute(UPDATE_DOC_SQL, {**row, "id": doc_id})
            return doc_id, row["content"]
        cur.execute(INSERT_DOC_SQL, row)
        return int(cur.fetchone()[0]), row["content"]


# -----------------------------------------------------------------------------
# Upsert de kb_embeddings (idempotente por doc_id)
# -----------------------------------------------------------------------------
SELECT_EMB_SQL = r"""
SELECT id, model FROM cockpit.kb_embeddings WHERE doc_id = %(doc_id)s
"""
INSERT_EMB_SQL = r"""
INSERT INTO cockpit.kb_embeddings (doc_id, embedding, model, created_at)
VALUES (%(doc_id)s, %(embedding)s::vector, %(model)s, now())
"""
UPDATE_EMB_SQL = r"""
UPDATE cockpit.kb_embeddings
SET embedding = %(embedding)s::vector, model = %(model)s, created_at = now()
WHERE doc_id = %(doc_id)s
"""


def upsert_embedding(cur, doc_id: int, vec: Sequence[float], model: str) -> str:
    """
    Faz upsert do embedding de um documento. Retorna 'inserido' ou 'atualizado'.
    """
    params = {
        "doc_id": doc_id,
        "embedding": _vector_literal(vec),
        "model": model,
    }
    cur.execute(SELECT_EMB_SQL, {"doc_id": doc_id})
    if cur.fetchone():
        cur.execute(UPDATE_EMB_SQL, params)
        return "atualizado"
    cur.execute(INSERT_EMB_SQL, params)
    return "inserido"


def embedding_is_current(cur, doc_id: int, model_atual: str) -> bool:
    """
    Heurística de idempotência incremental: considera o embedding atual quando
    já existe um registro para o doc_id com o mesmo modelo. Em modo --force o
    chamador ignora esta checagem.
    """
    cur.execute(SELECT_EMB_SQL, {"doc_id": doc_id})
    row = cur.fetchone()
    return bool(row) and row[1] == model_atual


# -----------------------------------------------------------------------------
# Pipeline principal
# -----------------------------------------------------------------------------
def build_documents(conn) -> list[dict[str, Any]]:
    """Executa NARRATIVE_SQL e faz upsert em kb_documents. Retorna docs persistidos."""
    docs: list[dict[str, Any]] = []
    with conn.cursor() as cur:
        cur.execute(NARRATIVE_SQL)
        cols = [d[0] for d in cur.description]
        rows = cur.fetchall()
        LOG.info("Narrativas geradas pelas views: %d", len(rows))

        inseridos = 0
        for raw in rows:
            rec = dict(zip(cols, raw))
            # metadata pode vir como dict (psycopg) ou str (psycopg2) — normaliza p/ str JSON.
            meta = rec.get("metadata")
            if isinstance(meta, (dict, list)):
                meta_str = json.dumps(meta, ensure_ascii=False, default=str)
            elif meta is None:
                meta_str = "{}"
            else:
                meta_str = str(meta)
            row = {
                "doc_type": rec["doc_type"],
                "company_id": rec["company_id"],
                "period_date": rec["period_date"],
                "title": rec["title"],
                "content": rec["content"],
                "metadata": meta_str,
            }
            doc_id, content = upsert_document(cur, row)
            docs.append({"id": doc_id, "content": content,
                         "doc_type": row["doc_type"]})
            inseridos += 1
        conn.commit()
        LOG.info("kb_documents atualizada (upsert) — %d documentos.", inseridos)
    return docs


def embed_documents(conn, docs: list[dict[str, Any]], *, force: bool,
                    batch_size: int = 32) -> None:
    """Gera/atualiza embeddings em kb_embeddings, em lotes, de forma idempotente."""
    if not docs:
        LOG.warning("Nenhum documento para embeddar.")
        return

    # Pré-detecta o modelo de embeddings que será usado (1 sondagem barata).
    _, model = embed_texts([docs[0]["content"]])
    LOG.info("Modelo de embeddings ativo: %s (dim %d)", model, EMBED_DIM)

    pendentes: list[dict[str, Any]] = []
    with conn.cursor() as cur:
        for d in docs:
            if force or not embedding_is_current(cur, d["id"], model):
                pendentes.append(d)
    conn.commit()

    if not pendentes:
        LOG.info("Todos os embeddings já estão atualizados (modo incremental).")
        return

    LOG.info("Documentos a (re)embeddar: %d de %d", len(pendentes), len(docs))

    total_ins = total_upd = 0
    with conn.cursor() as cur:
        for i in range(0, len(pendentes), batch_size):
            chunk = pendentes[i:i + batch_size]
            textos = [c["content"] for c in chunk]
            vecs, used_model = embed_texts(textos)
            for d, vec in zip(chunk, vecs):
                acao = upsert_embedding(cur, d["id"], vec, used_model)
                if acao == "inserido":
                    total_ins += 1
                else:
                    total_upd += 1
            conn.commit()
            LOG.info("Lote %d-%d embeddado (%d docs).",
                     i, i + len(chunk) - 1, len(chunk))

    LOG.info("kb_embeddings atualizada — %d inseridos, %d atualizados.",
             total_ins, total_upd)


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Constrói kb_documents e kb_embeddings do Cockpit (RAG).")
    parser.add_argument("--force", action="store_true",
                        help="Recalcula todos os embeddings, mesmo já existentes.")
    parser.add_argument("--only-docs", action="store_true",
                        help="Apenas (re)constrói kb_documents, sem embeddar.")
    parser.add_argument("--limit", type=int, default=0,
                        help="Limita o número de documentos processados (debug).")
    parser.add_argument("--verbose", "-v", action="store_true",
                        help="Logging em nível DEBUG.")
    args = parser.parse_args(argv)

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
        datefmt="%H:%M:%S",
    )

    _load_dotenv()
    t0 = time.time()
    LOG.info("=== Pipeline de embeddings do Cockpit — início ===")

    try:
        conn, _driver = connect_db()
    except Exception as exc:
        LOG.error("Não foi possível conectar ao banco: %s", exc)
        return 2

    try:
        docs = build_documents(conn)
        if args.limit and args.limit > 0:
            docs = docs[: args.limit]
            LOG.info("Aplicado --limit: processando %d documentos.", len(docs))

        if args.only_docs:
            LOG.info("Modo --only-docs: pulando geração de embeddings.")
        else:
            embed_documents(conn, docs, force=args.force)

        LOG.info("=== Concluído em %.2fs ===", time.time() - t0)
        return 0
    except Exception as exc:  # erro fatal de pipeline
        conn.rollback()
        LOG.exception("Erro fatal no pipeline: %s", exc)
        return 1
    finally:
        conn.close()


if __name__ == "__main__":
    raise SystemExit(main())
