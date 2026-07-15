#!/usr/bin/env bash
# deploy.sh — implantação idempotente do Cockpit REF. Chamado pelo GitHub Actions
# a cada push na main, e também executável à mão pelo usuário 'deploy'.
#
#   sudo -u deploy bash /opt/cockpit-ref/deploy/deploy.sh
#
# Puxa o código novo, (re)constrói as imagens e sobe o stack. Não toca em segredos
# (deploy/.env fica só no servidor) nem em dados (data/ fica só no servidor).
set -euo pipefail

APP_DIR="/opt/cockpit-ref"
cd "$APP_DIR"

# O repo pode pertencer a outro usuário (ex.: criado pelo 'deploy', mas o deploy roda
# como root) -> git aborta com "dubious ownership". Marca o diretório como confiável.
git config --global --add safe.directory "$APP_DIR" 2>/dev/null || true

echo "==> git: atualizando para origin/main"
git fetch --quiet origin main
git reset --hard origin/main          # estado = exatamente o que está no repositório

cd "$APP_DIR/deploy"
if [ ! -f .env ]; then
  echo "ERRO: $APP_DIR/deploy/.env ausente. Copie de .env.example e preencha." >&2
  exit 1
fi

# Validação do Caddyfile ANTES de aplicar: um Caddyfile inválido derruba o site
# inteiro (o restart do Caddy mais abaixo não subiria). O arquivo novo já está no
# disco (git reset) e é bind-montado no container Caddy que ainda roda a config
# ANTIGA — então validamos ali. Se falhar, abortamos e a config anterior continua
# servindo (zero downtime). Pulado no 1º deploy (Caddy ainda não está de pé).
if docker compose ps caddy 2>/dev/null | grep -qiE "up|running"; then
  echo "==> validando Caddyfile novo antes de aplicar"
  if ! docker compose exec -T caddy caddy validate --adapter caddyfile --config /etc/caddy/Caddyfile; then
    echo "ERRO: Caddyfile inválido — abortando deploy (config antiga preservada)." >&2
    exit 1
  fi
fi

echo "==> docker compose: build + up"
docker compose pull --quiet db n8n grafana caddy || true
docker compose up -d --build
# Caddy não recarrega o Caddyfile sozinho (bind-mount) — restart garante config nova
docker compose restart caddy >/dev/null

# O container 'ia' roda como uid 10001 (não-root). Garante que ele LÊ o segredo do
# Drive e ESCREVE os downloads em data/incoming, mesmo após upload/rotação como root.
echo "==> ajustando permissões dos volumes da IA (uid 10001)"
mkdir -p "$APP_DIR/data/incoming"
chown -R 10001:10001 "$APP_DIR/data" "$APP_DIR/deploy/secrets" 2>/dev/null || true

echo "==> aguardando saúde dos serviços"
sleep 8
docker compose ps

# Smoke test: a IA responde no /health (pela rede interna do compose)?
echo "==> smoke test IA /health"
docker compose exec -T ia python -c "import urllib.request,sys; \
sys.exit(0 if 'ok' in urllib.request.urlopen('http://127.0.0.1:8500/health',timeout=8).read().decode() else 1)" \
  && echo "    IA OK" || { echo "    IA FALHOU"; docker compose logs --tail=40 ia; exit 1; }

# Backup diário do banco (Blueprint §8) — agenda idempotente via /etc/cron.d.
# Dump roda dentro do container 'db'; retenção de 7 dias; falha alto (não poda em erro).
echo "==> agendando backup diário do banco (cron 03:00, retenção 7d)"
mkdir -p "$APP_DIR/backups"
cat > /etc/cron.d/cockpit-backup <<CRON
# Gerado por deploy.sh — backup diário do Postgres do Cockpit REF (§8). NÃO editar à mão.
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
0 3 * * * root APP_DIR=$APP_DIR BACKUP_DIR=$APP_DIR/backups bash $APP_DIR/backups/pg_backup.sh >> $APP_DIR/backups/backup.log 2>&1
CRON
chmod 0644 /etc/cron.d/cockpit-backup
# garante que o cron está ativo (imagem mínima pode não ter o serviço rodando)
service cron start 2>/dev/null || systemctl start cron 2>/dev/null || true

echo "==> limpeza de imagens órfãs"
docker image prune -f >/dev/null 2>&1 || true
echo "==> deploy concluído."
