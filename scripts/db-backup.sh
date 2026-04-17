#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────
# Borzoi — nightly PostgreSQL backup
#
# Creates a gzipped pg_dump in BACKUP_DIR, removes files older than
# RETENTION_DAYS.  Intended to be called from cron (see setup.sh).
# ─────────────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
INSTALL_DIR="$(dirname "$SCRIPT_DIR")"
BACKUP_DIR="${INSTALL_DIR}/data/backups"
RETENTION_DAYS=30

mkdir -p "$BACKUP_DIR"

TIMESTAMP=$(date +%Y%m%d-%H%M%S)
FILENAME="borzoi-${TIMESTAMP}.sql.gz"

# Run pg_dump inside the postgres container and gzip on the host.
# --no-owner/--no-acl keep the dump portable across installs.
docker compose -f "${INSTALL_DIR}/docker-compose.yml" \
  exec -T postgres \
  pg_dump -U "$DB_USER" -d "$DB_NAME" --no-owner --no-acl \
  | gzip > "${BACKUP_DIR}/${FILENAME}"

# Sanity check — remove empty files (failed dump).
if [ ! -s "${BACKUP_DIR}/${FILENAME}" ]; then
  rm -f "${BACKUP_DIR}/${FILENAME}"
  echo "ERROR: backup file is empty, removed ${FILENAME}" >&2
  exit 1
fi

SIZE=$(du -h "${BACKUP_DIR}/${FILENAME}" | cut -f1)
echo "Backup complete: ${FILENAME} (${SIZE})"

# Prune backups older than RETENTION_DAYS.
DELETED=$(find "$BACKUP_DIR" -name "borzoi-*.sql.gz" -mtime +${RETENTION_DAYS} -print -delete)
if [ -n "$DELETED" ]; then
  echo "Pruned old backups:"
  echo "$DELETED"
fi
