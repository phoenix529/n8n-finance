#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
drive_sync.py — baixa as planilhas DRE mais recentes do Google Drive (Shared Drive)
para data/incoming/, de onde o main.py faz a ingestão.

Acesso por SERVICE ACCOUNT, SOMENTE LEITURA (scope drive.readonly). A credencial
(JSON) é apontada por GOOGLE_APPLICATION_CREDENTIALS e fica só no servidor (montada
read-only) — NUNCA versionada. A pasta é compartilhada (Viewer) com o e-mail da SA.

LAYOUT MULTI-ANO (Iteração 5): varre a pasta raiz E subpastas cujo nome é um ano
(ex.: '2026', '2027'). Assim o cliente pode organizar por ano ou manter tudo plano —
o ANO é sempre lido do NOME do arquivo ('... DRE Acumulado <ANO>.xlsx'), não da pasta.
Arquivos com o mesmo nome em locais diferentes: fica o de modificação mais recente.

Env:
  GDRIVE_FOLDER_ID                id da pasta / Shared Drive com as planilhas
  GOOGLE_APPLICATION_CREDENTIALS  caminho do JSON da service account (montado :ro)
  INCOMING                        destino (default ../data/incoming)

Expõe run() -> {ok, output} para o runner HTTP do FastAPI (POST /run/sync) e CLI.
"""
import os, io, re, pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
INCOMING = pathlib.Path(os.environ.get("INCOMING", ROOT / "data" / "incoming"))
FOLDER_ID = os.environ.get("GDRIVE_FOLDER_ID", "").strip()
SCOPES = ["https://www.googleapis.com/auth/drive.readonly"]
XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
FOLDER_MIME = "application/vnd.google-apps.folder"
YEAR_RE = re.compile(r"^20\d{2}$")           # subpasta de ano: 2018..2099
EXPECTED = ("REF+", "BD", "4PR", "Viv", "Zup")


def _service():
    from google.oauth2 import service_account
    from googleapiclient.discovery import build
    keyfile = os.environ.get("GOOGLE_APPLICATION_CREDENTIALS", "")
    if not keyfile or not os.path.exists(keyfile):
        raise RuntimeError(
            f"credencial da service account ausente (GOOGLE_APPLICATION_CREDENTIALS={keyfile!r})")
    creds = service_account.Credentials.from_service_account_file(keyfile, scopes=SCOPES)
    return build("drive", "v3", credentials=creds, cache_discovery=False)


def _list(svc, q, fields):
    """Lista com paginação, atravessando Shared Drives."""
    itens, token = [], None
    while True:
        resp = svc.files().list(
            q=q, fields=f"nextPageToken,{fields}", orderBy="name", pageToken=token,
            supportsAllDrives=True, includeItemsFromAllDrives=True, corpora="allDrives",
        ).execute()
        itens += resp.get("files", [])
        token = resp.get("nextPageToken")
        if not token:
            return itens


def _year_subfolders(svc, folder_id):
    """Subpastas cujo nome é um ano (ex.: 2026). Lista [(id, nome)]."""
    q = f"'{folder_id}' in parents and trashed = false and mimeType = '{FOLDER_MIME}'"
    return [(f["id"], f["name"].strip())
            for f in _list(svc, q, "files(id,name)")
            if YEAR_RE.match(f["name"].strip())]


def _dre_files_in(svc, folder_id):
    """Planilhas Excel cujo nome contém DRE dentro de UMA pasta."""
    q = (f"'{folder_id}' in parents and trashed = false "
         f"and name contains 'DRE' and mimeType = '{XLSX_MIME}'")
    return _list(svc, q, "files(id,name,modifiedTime)")


def collect_files(svc, folder_id):
    """Junta as planilhas DRE da raiz + de cada subpasta-ano. Deduplica por NOME
    (fica o modifiedTime mais recente). Retorna (lista_final, log_de_origem)."""
    origem = []                              # linhas p/ o output (onde achou o quê)
    por_nome = {}                            # nome -> (file, pasta_label)
    escopos = [(folder_id, "raiz")] + [(fid, ano) for fid, ano in _year_subfolders(svc, folder_id)]
    for fid, label in escopos:
        achados = _dre_files_in(svc, fid)
        if achados or label != "raiz":
            origem.append(f"  [{label}] {len(achados)} arquivo(s) DRE")
        for f in achados:
            nome = f["name"]
            ant = por_nome.get(nome)
            if ant is None or (f.get("modifiedTime", "") > ant[0].get("modifiedTime", "")):
                por_nome[nome] = (f, label)
    return list(por_nome.values()), origem


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
    try:
        selecionados, origem = collect_files(svc, FOLDER_ID)
    except Exception as e:
        return {"ok": False, "output": f"falha ao listar arquivos na pasta {FOLDER_ID}: {e}"}
    out += origem

    if not selecionados:
        return {"ok": False,
                "output": "\n".join(out) + f"\nnenhum .xlsx '*DRE*' encontrado em {FOLDER_ID} "
                          "(raiz ou subpastas-ano) — a pasta foi compartilhada com a service account?"}

    baixados, erros = 0, []
    for f, label in selecionados:
        dest = INCOMING / f["name"]
        try:
            req = svc.files().get_media(fileId=f["id"], supportsAllDrives=True)
            with io.FileIO(str(dest), "wb") as buf:
                dl = MediaIoBaseDownload(buf, req)
                done = False
                while not done:
                    _, done = dl.next_chunk()
            baixados += 1
            out.append(f"  OK   {f['name']}  [{label}]  (mod {f.get('modifiedTime', '?')})")
        except Exception as e:
            erros.append(f["name"])
            out.append(f"  ERRO {f['name']}: {e}")

    # Completude: cada uma das 5 empresas deve ter ao menos UMA planilha DRE
    # (em qualquer ano/pasta). Com multi-ano, não exigimos todas no mesmo lugar.
    nomes = [f["name"] for f, _ in selecionados]
    faltando = [p for p in EXPECTED if not any(n.startswith(p) for n in nomes)]
    if faltando:
        out.append(f"  AVISO: empresa(s) sem NENHUMA planilha DRE no Drive: {', '.join(faltando)}")
    anos = sorted({m.group(0) for n in nomes for m in [re.search(r'20\d{2}', n)] if m})
    out.append(f"-- {baixados} arquivo(s); {len(erros)} erro(s); "
               f"anos presentes: {', '.join(anos) or '—'}; faltando {len(faltando)} empresa(s) --")
    return {"ok": len(erros) == 0 and baixados > 0 and not faltando, "output": "\n".join(out)}


def main():
    import sys
    r = run()
    print(r["output"])
    sys.exit(0 if r["ok"] else 1)


if __name__ == "__main__":
    main()
