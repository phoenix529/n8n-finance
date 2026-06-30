# Deploy & CI/CD — Cockpit Financeiro Estratégico REF

Pipeline: **`git push` → GitHub Actions → SSH (senha, DEPLOY_PASSWORD) → VPS → `docker compose up`**.
Stack em containers: PostgreSQL+pgvector · FastAPI (IA) · n8n · Grafana · Caddy (proxy/TLS).

> **Eu (assistente) não insiro segredos.** Os passos que envolvem senhas
> (rotacionar a senha de root, definir a senha do usuário `deploy`, preencher Secrets
> no GitHub e o `deploy/.env` no servidor) são feitos **por você** — marcados com 🔑.

---

## URLs ao vivo (depois do deploy)

| Recurso | URL (por IP) | Com domínio (recomendado) |
|---|---|---|
| **Dashboard do cliente** (Grafana via Caddy) | `http://76.13.172.100/` | `https://cockpit.seu-dominio.com/` |
| n8n (operador, basic-auth) | `http://76.13.172.100:5678/` | idem + restrinja no firewall |
| Postgres / IA | — | nunca expostos (rede interna) |

> Por IP é **HTTP em texto puro**. Para HTTPS, aponte um domínio para `76.13.172.100`
> e troque no `deploy/.env`: `SITE_ADDRESS=cockpit.seu-dominio.com` — o Caddy emite o
> certificado sozinho.

---

## Passo a passo (uma vez)

### 1. 🔑 No servidor — segurança primeiro
```bash
ssh root@76.13.172.100
passwd                      # TROQUE a senha de root: a anterior foi exposta no chat
```

### 2. Bootstrap do servidor
```bash
# ainda como root, baixe e rode o preparo (instala Docker, cria usuário 'deploy', firewall):
curl -fsSL https://raw.githubusercontent.com/phoenix529/n8n-finance/main/deploy/bootstrap.sh -o bootstrap.sh
bash bootstrap.sh
```
> Se o repositório for **privado**, em vez do `curl` faça `git clone` autenticado ou
> suba o `deploy/` via `scp`, depois rode `bash /opt/cockpit-ref/deploy/bootstrap.sh`.

### 3. 🔑 Senha do usuário de deploy (no servidor)
```bash
passwd deploy        # defina uma senha FORTE e única (não a senha de root)
```
> Auth por senha (escolha do projeto). Mitigações já aplicadas pelo bootstrap:
> `fail2ban` (bane IPs após tentativas falhas) + `ufw`. Recomendado ainda: restringir
> a porta 22 ao seu IP (`ufw allow from SEU.IP to any port 22 proto tcp`).

### 4. 🔑 Secrets e variável no GitHub
`Settings → Secrets and variables → Actions`:

| Tab | Nome | Valor |
|---|---|---|
| **Secrets** | `DEPLOY_HOST` | `76.13.172.100` |
| **Secrets** | `DEPLOY_USER` | `deploy` |
| **Secrets** | `DEPLOY_PASSWORD` | a senha que você definiu no passo 3 |
| **Secrets** | `DEPLOY_PORT` | `22` (opcional) |
| **Variables** | `DEPLOY_ENABLED` | `true`  ← destrava o job de deploy |

### 5. 🔑 Segredos do servidor + dados do cliente
```bash
sudo -u deploy nano /opt/cockpit-ref/deploy/.env     # preencha DB_PASSWORD, ANTHROPIC_API_KEY, etc.
# suba as 5 planilhas .xlsx (confidenciais, fora do git):
scp *.xlsx deploy@76.13.172.100:/opt/cockpit-ref/data/
```

### 6. Primeiro deploy
```bash
sudo -u deploy bash /opt/cockpit-ref/deploy/deploy.sh
```
Depois disso, **todo `git push` na `main`** implanta sozinho. Acompanhe na aba
**Actions** do GitHub. Disparo manual: Actions → *Deploy* → *Run workflow*.

---

## Como funciona

- **`.github/workflows/ci.yml`** — em todo push/PR: compila o Python, valida o
  `docker-compose` e builda a imagem da IA. Sem segredos.
- **`.github/workflows/deploy.yml`** — após o CI, conecta por SSH e roda
  `deploy.sh` (que faz `git reset --hard origin/main` + `docker compose up -d --build`
  + smoke test no `/health` da IA).
- **Segredos** vivem só em dois lugares, nunca no git: *GitHub Secrets* (senha do
  deploy) e `deploy/.env` *no servidor*. Os `.xlsx` do cliente ficam só em `data/`
  no servidor.

## Operação
```bash
cd /opt/cockpit-ref/deploy
docker compose ps                 # estado dos serviços
docker compose logs -f ia         # logs da IA
docker compose restart grafana    # reiniciar um serviço
# rodar a ingestão manualmente (idempotente):
docker compose exec ia python /opt/cockpit-ref/ingestao/main.py
```

## Rollback
```bash
cd /opt/cockpit-ref && git log --oneline -5
git reset --hard <commit-bom> && bash deploy/deploy.sh
```

## Sincronização automática do Google Drive (sem upload manual)

As planilhas ficam num Shared Drive; um service account (somente leitura) baixa as
5 mais recentes para `data/incoming/` e a ingestão roda em seguida. `drive_sync.py`
faz o download (`POST /run/sync`); o workflow n8n **20 — Sync Drive + Ingestão**
agenda tudo (diário 07:00). Os segredos nunca entram no git.

**Configuração (uma vez):**
1. **Google Cloud** → projeto → habilite a **Google Drive API**.
2. **IAM → Service Accounts** → crie uma SA → **Keys → Add key → JSON** (baixe o arquivo).
3. No servidor, coloque a chave em `deploy/secrets/gdrive_sa.json` (a pasta é gitignored):
   ```bash
   mkdir -p /opt/cockpit-ref/deploy/secrets
   # envie o JSON para /opt/cockpit-ref/deploy/secrets/gdrive_sa.json (scp), depois:
   chmod 600 /opt/cockpit-ref/deploy/secrets/gdrive_sa.json
   chown 10001:10001 /opt/cockpit-ref/deploy/secrets/gdrive_sa.json  # uid do container 'ia'
   ```
   > `deploy.sh` reaplica esse `chown` (em `data/` e `secrets/`) a cada deploy, então
   > após uma rotação de chave basta rodar o deploy — não precisa ajustar à mão.
4. **Compartilhe o Shared Drive/pasta** com o e-mail da SA (`…@…iam.gserviceaccount.com`)
   como **Leitor** (no Shared Drive: adicione a SA como *membro* — Viewer).
5. Em `deploy/.env`, defina `GDRIVE_FOLDER_ID=<id-da-pasta>` (o id que aparece na URL
   do Drive: `drive.google.com/drive/folders/<ID>`).
6. Recarregue o stack: `cd /opt/cockpit-ref/deploy && docker compose up -d`.

**Testar o download isolado:**
```bash
docker compose exec ia curl -s -X POST http://127.0.0.1:8500/run/sync
# espera {"ok":true,...}; os .xlsx aparecem em /opt/cockpit-ref/data/incoming/
```

**Ligar a automação:** no n8n (`:5678`), importe `n8n/workflows/20_ref_sync_drive.json`,
e ative o workflow (toggle **Active**). Ele roda 07:00: baixa do Drive → ingere →
ramifica em sucesso/erro. Disparo manual: botão **Execute workflow**.

> Lembrete operacional: as abas ligadas ao ERP só trazem números novos depois de
> **atualizar + salvar** o Excel no Drive. Rotina: atualizar → revisar → salvar →
> o n8n pega a versão salva.
