# Deploy & CI/CD — Cockpit Financeiro Estratégico REF

Pipeline: **`git push` → GitHub Actions → SSH (chave) → VPS → `docker compose up`**.
Stack em containers: PostgreSQL+pgvector · FastAPI (IA) · n8n · Grafana · Caddy (proxy/TLS).

> **Eu (assistente) não insiro segredos.** Os passos que envolvem senhas/chaves
> (rotacionar a senha de root, criar a chave SSH, preencher Secrets no GitHub e o
> `deploy/.env` no servidor) são feitos **por você** — estão marcados com 🔑.

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

### 3. 🔑 Chave SSH do CI (no SEU computador)
```bash
ssh-keygen -t ed25519 -f cockpit_deploy -C "github-actions-deploy" -N ""
# -> cole o conteúdo de cockpit_deploy.pub no servidor:
#    /home/deploy/.ssh/authorized_keys
# -> guarde cockpit_deploy (privada) para o passo 4
```

### 4. 🔑 Secrets e variável no GitHub
`Settings → Secrets and variables → Actions`:

| Tipo | Nome | Valor |
|---|---|---|
| Secret | `DEPLOY_HOST` | `76.13.172.100` |
| Secret | `DEPLOY_USER` | `deploy` |
| Secret | `DEPLOY_SSH_KEY` | conteúdo de `cockpit_deploy` (chave **privada**) |
| Secret | `DEPLOY_PORT` | `22` (opcional) |
| **Variable** | `DEPLOY_ENABLED` | `true`  ← destrava o job de deploy |

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
- **Segredos** vivem só em dois lugares, nunca no git: *GitHub Secrets* (chave SSH)
  e `deploy/.env` *no servidor*. Os `.xlsx` do cliente ficam só em `data/` no servidor.

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
