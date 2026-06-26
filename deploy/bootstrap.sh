#!/usr/bin/env bash
# bootstrap.sh — preparação ÚNICA do VPS Ubuntu/Debian para o Cockpit REF.
# Rode UMA VEZ no servidor, como root (ou sudo). Idempotente: pode repetir sem dano.
#
#   ssh root@SEU_IP            # (depois TROQUE a senha de root: passwd)
#   bash bootstrap.sh
#
# O que faz: instala Docker + Compose, cria o usuário 'deploy' (dono do CI/CD),
# configura firewall (ufw) e prepara /opt/cockpit-ref. NÃO embute nenhum segredo.
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/phoenix529/n8n-finance.git}"
APP_DIR="/opt/cockpit-ref"
DEPLOY_USER="deploy"

echo "==> 1/6  Pacotes base"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y ca-certificates curl git ufw

echo "==> 2/6  Docker Engine + Compose plugin (script oficial)"
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sh
fi

echo "==> 3/6  Usuário '$DEPLOY_USER' (sem senha; só chave SSH)"
if ! id "$DEPLOY_USER" >/dev/null 2>&1; then
  useradd --create-home --shell /bin/bash "$DEPLOY_USER"
fi
usermod -aG docker "$DEPLOY_USER"
install -d -m 700 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "/home/$DEPLOY_USER/.ssh"
touch "/home/$DEPLOY_USER/.ssh/authorized_keys"
chown "$DEPLOY_USER:$DEPLOY_USER" "/home/$DEPLOY_USER/.ssh/authorized_keys"
chmod 600 "/home/$DEPLOY_USER/.ssh/authorized_keys"
echo "    -> cole a CHAVE PÚBLICA do CI em /home/$DEPLOY_USER/.ssh/authorized_keys"

echo "==> 4/6  Firewall (ufw): libera 22, 80, 443"
ufw allow OpenSSH        >/dev/null 2>&1 || ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
# n8n (operador): libere SÓ para o seu IP — descomente e ajuste:
# ufw allow from SEU.IP.AQUI to any port 5678 proto tcp
yes | ufw enable >/dev/null 2>&1 || true

echo "==> 5/6  Diretório da aplicação em $APP_DIR"
if [ ! -d "$APP_DIR/.git" ]; then
  git clone "$REPO_URL" "$APP_DIR"
fi
chown -R "$DEPLOY_USER:$DEPLOY_USER" "$APP_DIR"

echo "==> 6/6  Arquivo de segredos deploy/.env"
if [ ! -f "$APP_DIR/deploy/.env" ]; then
  cp "$APP_DIR/deploy/.env.example" "$APP_DIR/deploy/.env"
  chown "$DEPLOY_USER:$DEPLOY_USER" "$APP_DIR/deploy/.env"
  chmod 600 "$APP_DIR/deploy/.env"
  echo "    -> EDITE $APP_DIR/deploy/.env e preencha as senhas/chaves."
fi

cat <<EOF

================================================================================
 Bootstrap concluído. Próximos passos (você, manualmente):
   1) passwd                      # TROQUE a senha de root (a antiga vazou no chat)
   2) cole a chave pública do CI em /home/$DEPLOY_USER/.ssh/authorized_keys
   3) nano $APP_DIR/deploy/.env   # preencha DB_PASSWORD, ANTHROPIC_API_KEY, etc.
   4) suba as planilhas .xlsx do cliente para $APP_DIR/data/  (scp, fora do git)
   5) primeiro deploy:
        sudo -u $DEPLOY_USER bash $APP_DIR/deploy/deploy.sh
   Depois disso, cada 'git push' para main implanta sozinho (GitHub Actions).
================================================================================
EOF
