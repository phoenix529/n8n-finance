#!/usr/bin/env bash
# pg_backup.sh — backup diário do Postgres de PRODUÇÃO com retenção de 7 dias (Blueprint §8).
#
# O Postgres de produção roda DENTRO do container 'db' (não escuta no 127.0.0.1 do host),
# então o dump é feito via `docker compose exec db pg_dump`. Agendado automaticamente por
# deploy/deploy.sh em /etc/cron.d/cockpit-backup (diário, 03:00). Também roda à mão:
#   BACKUP_DIR=/opt/cockpit-ref/backups bash /opt/cockpit-ref/backups/pg_backup.sh
#
# Falha ALTO: se o pg_dump falhar ou o arquivo sair vazio, aborta e NÃO executa a
# retenção — assim uma falha (ex.: banco fora do ar) nunca apaga o último bom backup.
set -uo pipefail

APP_DIR="${APP_DIR:-/opt/cockpit-ref}"
DIR="${BACKUP_DIR:-$APP_DIR/backups}"; mkdir -p "$DIR"
DB="${DB_NAME:-cockpit_ref}"; USR="${DB_USER:-cockpit_user}"
STAMP="$(date +%Y%m%d_%H%M%S)"
OUT="$DIR/${DB}_${STAMP}.sql.gz"

# Senha vem do deploy/.env do servidor (NUNCA commitada — §8).
if [ -z "${DB_PASSWORD:-}" ] && [ -f "$APP_DIR/deploy/.env" ]; then
  DB_PASSWORD="$(grep -E '^DB_PASSWORD=' "$APP_DIR/deploy/.env" | cut -d= -f2- | tr -d '\r')"
fi

cd "$APP_DIR/deploy" || { echo "ERRO: $APP_DIR/deploy inexistente" >&2; exit 1; }

# Dump dentro do container; pipefail propaga falha do pg_dump através do gzip.
if ! docker compose exec -T -e PGPASSWORD="${DB_PASSWORD:-}" db \
       pg_dump -U "$USR" "$DB" | gzip > "$OUT"; then
  rm -f "$OUT"
  echo "ERRO: pg_dump FALHOU — backup abortado; retencao NAO executada" >&2
  exit 1
fi

# gzip de dump vazio tem ~20 bytes; um dump real tem dezenas/centenas de KB.
if [ ! -s "$OUT" ] || [ "$(stat -c%s "$OUT")" -lt 200 ]; then
  rm -f "$OUT"
  echo "ERRO: dump vazio/invalido — backup abortado; retencao NAO executada" >&2
  exit 1
fi

# Retenção 7 dias — só depois de confirmar um backup válido.
find "$DIR" -name "${DB}_*.sql.gz" -mtime +7 -delete
echo "backup ok: ${DB}_${STAMP}.sql.gz ($(stat -c%s "$OUT") bytes)"
