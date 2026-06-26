#!/usr/bin/env bash
# pg_backup.sh — backup diário do PostgreSQL com retenção de 7 dias (Blueprint §8).
# Agende no cron:  0 3 * * * /opt/cockpit-ref/backups/pg_backup.sh
set -euo pipefail
DIR="${BACKUP_DIR:-/opt/cockpit-ref/backups}"; mkdir -p "$DIR"
DB="${DB_NAME:-cockpit_ref}"; USR="${DB_USER:-cockpit_user}"; HST="${DB_HOST:-127.0.0.1}"
STAMP="$(date +%Y%m%d_%H%M%S)"
PGPASSWORD="${DB_PASSWORD}" pg_dump -U "$USR" -h "$HST" "$DB" | gzip > "$DIR/${DB}_${STAMP}.sql.gz"
find "$DIR" -name "${DB}_*.sql.gz" -mtime +7 -delete
echo "backup ok: ${DB}_${STAMP}.sql.gz"
