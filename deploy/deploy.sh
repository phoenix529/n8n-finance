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

echo "==> docker compose: build + up"
docker compose pull --quiet db n8n grafana caddy || true
docker compose up -d --build

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

echo "==> limpeza de imagens órfãs"
docker image prune -f >/dev/null 2>&1 || true
echo "==> deploy concluído."
