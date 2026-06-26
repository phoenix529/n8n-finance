#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
rag_server.py — endpoint RAG AO VIVO para a caixa "Pergunte aos seus dados (IA)"
do dashboard. Recupera os números do fechamento das views cockpit.* no PostgreSQL
(retrieval) e gera a resposta com Claude, fundamentada APENAS nesses números.

    POST /ask   (ou /webhook/cockpit-ask)
        body : {"question": "...", "locale": "pt-BR"}
        resp : {"answer": "...", "fontes": [...], "model": "...", "latency_ms": N}

Config via rag/.env (carregado automaticamente; variáveis de ambiente têm prioridade):
    ANTHROPIC_API_KEY   (obrigatória — você a coloca no .env; este script nunca a imprime)
    LLM_MODEL           (default claude-opus-4-8)
    PGHOST/PGPORT/PGDATABASE/PGUSER/PGPASSWORD
    RAG_PORT            (default 5680)

Cada consulta é auditada em cockpit.ai_query_audit (pergunta, resposta, modelo,
tokens, latência) — critério de sucesso da Fase 2: resposta executiva < 30s.
"""
import os, json, time, pathlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ENV_PATH = pathlib.Path(__file__).with_name(".env")


def load_env():
    if not ENV_PATH.exists():
        return
    for line in ENV_PATH.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        k, v = k.strip(), v.strip().strip('"').strip("'")
        if k and k not in os.environ:          # variável de ambiente vence o .env
            os.environ[k] = v


load_env()

LLM_MODEL = os.environ.get("LLM_MODEL", "claude-opus-4-8")
PORT = int(os.environ.get("RAG_PORT", "5680"))
PG = dict(
    host=os.environ.get("PGHOST", "127.0.0.1"),
    port=int(os.environ.get("PGPORT", "5432")),
    dbname=os.environ.get("PGDATABASE", "cockpit"),
    user=os.environ.get("PGUSER", "postgres"),
    password=os.environ.get("PGPASSWORD", "postgres"),
)

try:
    import psycopg2
except ImportError:
    psycopg2 = None
try:
    import anthropic
except ImportError:
    anthropic = None


# --------------------------------------------------------------------------------------
# Retrieval — busca os números do fechamento nas views cockpit.* (PostgreSQL)
# --------------------------------------------------------------------------------------
def fmt_brl(v):
    if v is None:
        return "n/d"
    v = float(v)
    if abs(v) >= 1e6:
        return f"R$ {v/1e6:.1f} mi".replace(".", ",")
    if abs(v) >= 1e3:
        return f"R$ {v/1e3:.0f} mil"
    return f"R$ {v:.0f}"


def retrieve_context():
    """Retorna (texto_de_contexto, lista_de_fontes), fundamentado nos dados REAIS
    (cockpit.fact_financials — DRE da Ref Comunicação, atuais jan–jun/2026).
    Faz fallback para dashboard_data.json se o banco não estiver acessível."""
    if psycopg2 is not None:
        try:
            conn = psycopg2.connect(connect_timeout=4, **PG)
            conn.autocommit = True
            cur = conn.cursor()
            lines, fontes = [], []

            # acumulado YTD consolidado, por conta
            cur.execute("""SELECT account_code, SUM(valor_realizado)
                           FROM cockpit.fact_financials GROUP BY account_code""")
            agg = {a: float(v) for a, v in cur.fetchall()}
            # último mês fechado
            cur.execute("SELECT max(period_date) FROM cockpit.fact_financials")
            last = cur.fetchone()[0]
            cur.execute("""SELECT account_code, SUM(valor_realizado) FROM cockpit.fact_financials
                           WHERE period_date = %s GROUP BY account_code""", (last,))
            lm = {a: float(v) for a, v in cur.fetchall()}

            rl = agg.get("RECEITA_LIQUIDA", 0.0)
            mg = lambda c: (f" (margem {agg.get(c,0)/rl*100:.1f}%)" if rl else "")
            g = lambda c: fmt_brl(agg.get(c))
            lines.append(
                "Acumulado jan–jun/2026 (consolidado das 5 unidades): "
                f"Receita Bruta {g('RECEITA_BRUTA')}; Receita Líquida {g('RECEITA_LIQUIDA')}; "
                f"Lucro Bruto/Resultado Operacional {g('RESULTADO_AGENCIA')}; "
                f"EBIT {g('EBIT')}{mg('EBIT')}; Resultado Líquido {g('RESULTADO_LIQUIDO')}{mg('RESULTADO_LIQUIDO')}; "
                f"Geração de Caixa {g('GERACAO_CAIXA')}; Custos dos Serviços {g('CUSTOS')}; "
                f"Gastos com Pessoal {g('DESP_PESSOAL')}; Tributos {g('TRIBUTOS')}.")
            fontes.append("cockpit.fact_financials (acumulado jan–jun/2026)")

            lines.append(
                f"Último mês fechado ({last.strftime('%Y-%m')}): "
                f"Receita Líquida {fmt_brl(lm.get('RECEITA_LIQUIDA'))}; EBIT {fmt_brl(lm.get('EBIT'))}; "
                f"Resultado Líquido {fmt_brl(lm.get('RESULTADO_LIQUIDO'))}.")
            fontes.append(f"cockpit.fact_financials ({last.strftime('%Y-%m')})")

            cur.execute("""
                SELECT c.name,
                       SUM(f.valor_realizado) FILTER (WHERE f.account_code='RECEITA_LIQUIDA') rl,
                       SUM(f.valor_realizado) FILTER (WHERE f.account_code='EBIT') eb
                FROM cockpit.fact_financials f JOIN cockpit.dim_company c USING (company_id)
                GROUP BY c.name ORDER BY rl DESC NULLS LAST""")
            rows = cur.fetchall()
            if rows:
                porc = "; ".join(
                    f"{n}: receita líq. {fmt_brl(rl_)}" +
                    (f", EBIT {fmt_brl(eb_)}" if eb_ is not None else ", resultado de 2026 ainda não lançado")
                    for (n, rl_, eb_) in rows if rl_)
                lines.append("Por unidade (jan–jun/2026): " + porc + ".")
                fontes.append("cockpit.fact_financials por unidade")

            cur.close(); conn.close()
            if lines:
                return "\n".join(lines), fontes
        except Exception as e:                 # banco indisponível → fallback no JSON
            print(f"[rag] PostgreSQL indisponível ({e}); usando dashboard_data.json")

    # fallback: dashboard_data.json (mesmo schema P&L)
    try:
        p = pathlib.Path(__file__).resolve().parent.parent / "dashboard" / "dashboard_data.json"
        d = json.load(open(p, encoding="utf-8"))
        k = d["kpis"]
        gv = lambda key: fmt_brl(k.get(key, {}).get("ytd"))
        ctx = (f"Acumulado jan–{d['meta']['last_closed_period'][-2:]}/2026 (consolidado): "
               f"Receita Bruta {gv('receita_bruta')}; Receita Líquida {gv('receita_liquida')}; "
               f"Lucro Bruto {gv('resultado_agencia')}; EBIT {gv('ebit')}; "
               f"Lucro Líquido {gv('lucro_liquido')}; Geração de Caixa {gv('geracao_caixa')}.")
        return ctx, ["dashboard_data.json (fallback)"]
    except Exception as e:
        return f"(contexto indisponível: {e})", []


# --------------------------------------------------------------------------------------
# Geração — Claude, fundamentado SOMENTE no contexto recuperado
# --------------------------------------------------------------------------------------
SYSTEM = (
    "Você é o assistente analítico do Cockpit Financeiro da Ref Comunicação, um grupo de "
    "comunicação/publicidade brasileiro com 5 unidades (REF+, BD, Viv, 4PR e Zup; valores em BRL). "
    "Os dados são de RESULTADO (DRE/P&L) — atuais de jan a jun/2026; NÃO há dados de posição "
    "(caixa em banco, dívida, contas a receber/pagar). Responda em português do Brasil, de forma "
    "objetiva e executiva (2-4 frases). Use SOMENTE os números do CONTEXTO fornecido; nunca invente "
    "ou estime valores. Se a informação pedida não estiver no contexto (ex.: saldo de caixa, dívida), "
    "diga que ela não está disponível nas planilhas de DRE. Formate valores como R$ X,X mi / R$ X mil. "
    "Responda apenas com a resposta final, sem expor raciocínio."
)


def ask_claude(question, context):
    client = anthropic.Anthropic()            # lê ANTHROPIC_API_KEY do ambiente
    msg = client.messages.create(
        model=LLM_MODEL,
        max_tokens=600,
        system=SYSTEM,
        messages=[{"role": "user", "content":
                   f"CONTEXTO (fonte: cockpit.fact_financials no PostgreSQL; DRE real, atuais jan–jun/2026):\n"
                   f"{context}\n\nPERGUNTA DO EXECUTIVO: {question}"}],
    )
    answer = "".join(b.text for b in msg.content if b.type == "text").strip()
    return answer, msg.usage.input_tokens, msg.usage.output_tokens


def audit(question, answer, prompt_tokens, completion_tokens, latency_ms):
    if psycopg2 is None:
        return
    try:
        conn = psycopg2.connect(connect_timeout=4, **PG); conn.autocommit = True
        cur = conn.cursor()
        cur.execute("""
            INSERT INTO cockpit.ai_query_audit
              (user_role, question, retrieved_doc_ids, answer, model,
               prompt_tokens, completion_tokens, latency_ms)
            VALUES ('cockpit_executive', %s, NULL, %s, %s, %s, %s, %s)""",
            (question, answer, LLM_MODEL, prompt_tokens, completion_tokens, latency_ms))
        cur.close(); conn.close()
    except Exception as e:
        print(f"[rag] aviso: falha ao gravar ai_query_audit: {e}")


# --------------------------------------------------------------------------------------
# HTTP
# --------------------------------------------------------------------------------------
class Handler(BaseHTTPRequestHandler):
    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def _json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code); self._cors()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers(); self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204); self._cors(); self.end_headers()

    def do_GET(self):
        # health check
        self._json(200, {"status": "ok", "model": LLM_MODEL,
                         "key_set": bool(os.environ.get("ANTHROPIC_API_KEY", "").startswith("sk-ant"))})

    def do_POST(self):
        try:
            n = int(self.headers.get("Content-Length", 0))
            payload = json.loads(self.rfile.read(n) or b"{}")
        except Exception:
            return self._json(400, {"error": "json inválido"})
        question = (payload.get("question") or payload.get("q") or "").strip()
        if not question:
            return self._json(400, {"error": "campo 'question' ausente"})

        if anthropic is None:
            return self._json(503, {"error": "pacote 'anthropic' não instalado"})
        if not os.environ.get("ANTHROPIC_API_KEY", "").startswith("sk-ant"):
            # sem chave → 503: o dashboard cai graciosamente nas respostas_demo offline
            return self._json(503, {"error": "ANTHROPIC_API_KEY não configurada em rag/.env"})

        t0 = time.time()
        context, fontes = retrieve_context()
        try:
            answer, pin, pout = ask_claude(question, context)
        except Exception as e:
            return self._json(502, {"error": f"falha na geração: {e}"})
        ms = int((time.time() - t0) * 1000)
        audit(question, answer, pin, pout, ms)
        print(f"[rag] {ms} ms | {pin}+{pout} tok | {question[:60]!r}")
        self._json(200, {"answer": answer, "fontes": fontes, "model": LLM_MODEL, "latency_ms": ms})

    def log_message(self, *a):   # silencia o log padrão (evita poluir stdout)
        pass


def main():
    print("=" * 64)
    print(f"RAG server (Cockpit) — modelo {LLM_MODEL} — porta {PORT}")
    print(f"  Postgres : {PG['user']}@{PG['host']}:{PG['port']}/{PG['dbname']}  "
          f"({'psycopg2 ok' if psycopg2 else 'psycopg2 AUSENTE'})")
    print(f"  Anthropic: {'sdk ok' if anthropic else 'pacote AUSENTE (pip install anthropic)'} | "
          f"chave {'definida' if os.environ.get('ANTHROPIC_API_KEY','').startswith('sk-ant') else 'NÃO definida (rag/.env)'}")
    print(f"  Endpoint : POST http://127.0.0.1:{PORT}/ask")
    print("=" * 64)
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
