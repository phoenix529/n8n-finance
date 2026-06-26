#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
upload_server.py — serve o dashboard (estático) E recebe upload de planilhas do cliente.

  GET  /                -> dashboard/index.html (e demais arquivos estáticos)
  GET  /upload.html     -> página de upload (cliente escolhe o .xlsx)
  POST /upload          -> recebe multipart, salva em data/raw/, roda a ingestão
                           VERIFICADA (run_ingestion.py) e devolve o resultado:
                           {ok, file, status, rows_ok, rows_quarantined, reasons[], message}

Segurança (upload exposto): só aceita .xlsx/.csv, limite de tamanho, nome higienizado
(sem path traversal), grava apenas em data/raw/. Token opcional via env UPLOAD_TOKEN
(enviado no campo 'token' do form) — se definido, é exigido.

Rode na mesma porta do dashboard (8088) para reaproveitar o túnel existente:
    python scripts/upload_server.py            # porta 8088
"""
import os, re, sys, json, html, subprocess, mimetypes, pathlib, datetime as dt
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = pathlib.Path(__file__).resolve().parent.parent
DASH = ROOT / "dashboard"
RAW = ROOT / "data" / "raw"
RAW.mkdir(parents=True, exist_ok=True)

PORT = int(os.environ.get("DASH_PORT", "8088"))
MAX_BYTES = int(os.environ.get("UPLOAD_MAX_BYTES", str(15 * 1024 * 1024)))   # 15 MB
ALLOWED_EXT = {".xlsx", ".csv"}
UPLOAD_TOKEN = os.environ.get("UPLOAD_TOKEN", "")   # vazio = aberto (demo)
PGENV = {**os.environ, "PGHOST": os.environ.get("PGHOST", "127.0.0.1"),
         "PGPORT": os.environ.get("PGPORT", "5432"), "PGDATABASE": os.environ.get("PGDATABASE", "cockpit"),
         "PGUSER": os.environ.get("PGUSER", "postgres"), "PGPASSWORD": os.environ.get("PGPASSWORD", "postgres")}

try:
    import psycopg2
except ImportError:
    psycopg2 = None


def safe_name(filename):
    base = os.path.basename(filename or "planilha.xlsx")
    base = re.sub(r"[^A-Za-z0-9._-]+", "_", base).strip("._") or "planilha.xlsx"
    stamp = dt.datetime.utcnow().strftime("%Y%m%d_%H%M%S")
    stem, ext = os.path.splitext(base)
    return f"upload_{stem}_{stamp}{ext.lower()}"


def parse_multipart(body, content_type):
    m = re.search(r"boundary=(.*)", content_type or "")
    if not m:
        return {}
    delim = b"--" + m.group(1).strip().strip('"').encode()
    out = {}
    for part in body.split(delim):
        part = part.strip(b"\r\n")
        if not part or part == b"--" or b"\r\n\r\n" not in part:
            continue
        head, data = part.split(b"\r\n\r\n", 1)
        h = head.decode("utf-8", "replace")
        nm = re.search(r'name="([^"]*)"', h)
        fn = re.search(r'filename="([^"]*)"', h)
        if not nm:
            continue
        if data.endswith(b"\r\n"):
            data = data[:-2]
        out[nm.group(1)] = (fn.group(1) if fn else None, data)
    return out


def run_ingestion(path):
    """Roda a ingestão verificada sobre o arquivo e retorna o resultado do pipeline_runs."""
    load_id = "cli-" + os.path.splitext(os.path.basename(path))[0]
    p = subprocess.run([sys.executable, str(ROOT / "scripts" / "run_ingestion.py"), path],
                       cwd=str(ROOT), env=PGENV, capture_output=True, text=True, timeout=120)
    res = {"status": None, "rows_ok": None, "rows_quarantined": None, "reasons": [],
           "stdout": (p.stdout or "")[-400:]}
    if psycopg2 is not None:
        try:
            con = psycopg2.connect(connect_timeout=5, host=PGENV["PGHOST"], port=int(PGENV["PGPORT"]),
                                   dbname=PGENV["PGDATABASE"], user=PGENV["PGUSER"], password=PGENV["PGPASSWORD"])
            con.autocommit = True
            cur = con.cursor()
            cur.execute("""SELECT status, rows_total, rows_ok, rows_quarantined
                           FROM cockpit.pipeline_runs WHERE load_id=%s""", (load_id,))
            r = cur.fetchone()
            if r:
                res.update(status=r[0], rows_total=r[1], rows_ok=r[2], rows_quarantined=r[3])
            cur.execute("""SELECT error_code, error_detail FROM cockpit.quarantine_rows
                           WHERE load_id=%s ORDER BY id LIMIT 20""", (load_id,))
            res["reasons"] = [f"{c}: {d}" for (c, d) in cur.fetchall()]
            cur.close(); con.close()
        except Exception as e:
            res["db_warn"] = str(e)
    res["returncode"] = p.returncode
    return res


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, body, ctype="application/json; charset=utf-8"):
        if isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path in ("/", ""):
            path = "/index.html"
        target = (DASH / path.lstrip("/")).resolve()
        if not str(target).startswith(str(DASH.resolve())) or not target.is_file():
            return self._send(404, "not found", "text/plain")
        ctype = mimetypes.guess_type(str(target))[0] or "application/octet-stream"
        self._send(200, target.read_bytes(), ctype)

    def do_POST(self):
        if self.path.split("?", 1)[0] != "/upload":
            return self._send(404, json.dumps({"ok": False, "error": "rota inválida"}))
        try:
            n = int(self.headers.get("Content-Length", 0))
        except ValueError:
            n = 0
        if n <= 0 or n > MAX_BYTES:
            return self._send(413, json.dumps({"ok": False,
                              "error": f"arquivo ausente ou maior que {MAX_BYTES//(1024*1024)} MB"}))
        body = self.rfile.read(n)
        fields = parse_multipart(body, self.headers.get("Content-Type", ""))

        if UPLOAD_TOKEN:
            tok = (fields.get("token", (None, b""))[1] or b"").decode("utf-8", "replace").strip()
            if tok != UPLOAD_TOKEN:
                return self._send(401, json.dumps({"ok": False, "error": "token inválido"}))

        if "file" not in fields or not fields["file"][0]:
            return self._send(400, json.dumps({"ok": False, "error": "campo 'file' ausente"}))
        filename, data = fields["file"]
        ext = os.path.splitext(filename)[1].lower()
        if ext not in ALLOWED_EXT:
            return self._send(400, json.dumps({"ok": False,
                              "error": f"extensão {ext or '(nenhuma)'} não permitida (use .xlsx ou .csv)"}))
        if not data:
            return self._send(400, json.dumps({"ok": False, "error": "arquivo vazio"}))

        saved = RAW / safe_name(filename)
        saved.write_bytes(data)
        try:
            r = run_ingestion(str(saved))
        except subprocess.TimeoutExpired:
            return self._send(504, json.dumps({"ok": False, "error": "ingestão excedeu o tempo limite"}))
        ok = r.get("returncode") == 0 and r.get("status") in ("OK", "PARTIAL")
        msg = (f"{r.get('rows_ok')} linha(s) carregada(s), {r.get('rows_quarantined')} em quarentena."
               if ok else "Falha na ingestão — verifique o arquivo.")
        print(f"[upload] {filename} -> {saved.name} | status={r.get('status')} "
              f"ok={r.get('rows_ok')} quar={r.get('rows_quarantined')} rc={r.get('returncode')}")
        self._send(200, json.dumps({
            "ok": ok, "file": filename, "saved_as": saved.name,
            "status": r.get("status"), "rows_total": r.get("rows_total"),
            "rows_ok": r.get("rows_ok"), "rows_quarantined": r.get("rows_quarantined"),
            "reasons": r.get("reasons", []), "message": msg,
        }, ensure_ascii=False))

    def log_message(self, *a):
        pass


def main():
    print(f"upload_server: dashboard + /upload em http://127.0.0.1:{PORT}  (raw -> {RAW})")
    print(f"  token de upload: {'EXIGIDO' if UPLOAD_TOKEN else 'aberto (demo)'} | psycopg2: {'ok' if psycopg2 else 'ausente'}")
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
