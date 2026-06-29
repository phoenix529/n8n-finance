#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
drive_sync.py — baixa as planilhas DRE mais recentes do Google Drive (Shared Drive)
para data/incoming/, de onde o main.py faz a ingestão.

Acesso por SERVICE ACCOUNT, SOMENTE LEITURA (scope drive.readonly). A credencial
(JSON) é apontada por GOOGLE_APPLICATION_CREDENTIALS e fica só no servidor (montada
read-only) — NUNCA versionada. A pasta é compartilhada (Viewer) com o e-mail da SA.

Env:
  GDRIVE_FOLDER_ID                id da pasta / Shared Drive com as planilhas
  GOOGLE_APPLICATION_CREDENTIALS  caminho do JSON da service account (montado :ro)
  INCOMING                        destino (default ../data/incoming)

Expõe run() -> {ok, output} para o runner HTTP do FastAPI (POST /run/sync) e CLI.
"""
import os, io, pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
INCOMING = pathlib.Path(os.environ.get("INCOMING", ROOT / "data" / "incoming"))
FOLDER_ID = os.environ.get("GDRIVE_FOLDER_ID", "").strip()
SCOPES = ["https://www.googleapis.com/auth/drive.readonly"]
XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"


def _service():
    from google.oauth2 import service_account
    from googleapiclient.discovery import build
    keyfile = os.environ.get("GOOGLE_APPLICATION_CREDENTIALS", "")
    if not keyfile or not os.path.exists(keyfile):
        raise RuntimeError(
            f"credencial da service account ausente (GOOGLE_APPLICATION_CREDENTIALS={keyfile!r})")
    creds = service_account.Credentials.from_service_account_file(keyfile, scopes=SCOPES)
    return build("drive", "v3", credentials=creds, cache_discovery=False)


def run():
    out = [f"== Sync Google Drive -> {INCOMING} =="]
    if not FOLDER_ID:
        return {"ok": False, "output": "GDRIVE_FOLDER_ID não definido (defina no deploy/.env)"}
    try:
        from googleapiclient.http import MediaIoBaseDownload
        svc = _service()
    except Exception as e:
        return {"ok": False, "output": f"falha ao iniciar cliente Google Drive: {e}"}

    INCOMING.mkdir(parents=True, exist_ok=True)
    # Só planilhas Excel cujo nome contém DRE (ignora o Google Doc do blueprint etc.).
    q = (f"'{FOLDER_ID}' in parents and trashed = false "
         f"and name contains 'DRE' and mimeType = '{XLSX_MIME}'")
    try:
        resp = svc.files().list(
            q=q, fields="files(id,name,modifiedTime)", orderBy="name",
            supportsAllDrives=True, includeItemsFromAllDrives=True, corpora="allDrives",
        ).execute()
        files = resp.get("files", [])
    except Exception as e:
        return {"ok": False, "output": f"falha ao listar arquivos na pasta {FOLDER_ID}: {e}"}

    if not files:
        return {"ok": False,
                "output": f"nenhum .xlsx '*DRE*' encontrado em {FOLDER_ID} "
                          f"(a pasta foi compartilhada com a service account?)"}

    baixados, erros = 0, []
    for f in files:
        dest = INCOMING / f["name"]
        try:
            req = svc.files().get_media(fileId=f["id"], supportsAllDrives=True)
            with io.FileIO(str(dest), "wb") as buf:
                dl = MediaIoBaseDownload(buf, req)
                done = False
                while not done:
                    _, done = dl.next_chunk()
            baixados += 1
            out.append(f"  OK   {f['name']}  (mod {f.get('modifiedTime', '?')})")
        except Exception as e:
            erros.append(f["name"])
            out.append(f"  ERRO {f['name']}: {e}")

    out.append(f"-- {baixados} arquivo(s) baixado(s); {len(erros)} erro(s) --")
    return {"ok": len(erros) == 0 and baixados > 0, "output": "\n".join(out)}


def main():
    import sys
    r = run()
    print(r["output"])
    sys.exit(0 if r["ok"] else 1)


if __name__ == "__main__":
    main()
