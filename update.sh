#!/usr/bin/env bash
set -euo pipefail

# ============================================================================
# Borzoi update — pull latest images, apply infrastructure changes, restart.
#
# Safe to run on a live installation with data. Postgres data lives on a
# host bind mount (data/postgres) and is never touched by container updates.
# ============================================================================

cd "$(dirname "$0")"

err() { echo "ERROR: $*" >&2; }
info() { echo "$*"; }

if [ ! -f .env ]; then
  err ".env not found — run setup.sh first for initial installation."
  exit 1
fi

# Source .env for DB_USER / DB_NAME (needed by backup cron).
set -a
source .env
set +a

# ---------- pre-update backup ------------------------------------------------

info "Taking pre-update database backup..."
mkdir -p data/backups
if ./scripts/db-backup.sh; then
  info "Pre-update backup complete."
else
  err "Pre-update backup failed. Aborting update."
  exit 1
fi

# ---------- pull + restart ---------------------------------------------------

info "Pulling latest images..."
docker compose pull

info "Restarting stack..."
docker compose up -d

# ---------- ensure nightly backup cron ---------------------------------------

BACKUP_SCRIPT="$(pwd)/scripts/db-backup.sh"
CRON_SCHEDULE="0 2 * * *"
CRON_LINE="$CRON_SCHEDULE cd $(pwd) && . .env && $BACKUP_SCRIPT >> data/backups/backup.log 2>&1"

if crontab -l 2>/dev/null | grep -q "db-backup.sh"; then
  info "Nightly backup cron already installed."
else
  ( crontab -l 2>/dev/null || true
    echo "$CRON_LINE"
  ) | crontab -
  info "Nightly backup cron installed (02:00)."
fi

info "Update complete."
