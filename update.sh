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

# ---------- ECR credential check ---------------------------------------------

# The docker credential helper (docker-credential-borzoi-ecr-login) handles
# ECR auth automatically on every pull. Verify it works before pulling.
info "Verifying ECR credentials..."
if echo "$ECR_REGISTRY" | docker-credential-borzoi-ecr-login get >/dev/null 2>&1; then
  info "ECR credentials OK."
else
  err "ECR credential helper failed. Check ~/.aws/credentials [borzoi-ecr] profile."
  exit 1
fi

# ---------- pull + restart ---------------------------------------------------

info "Pulling latest images..."
docker compose pull

info "Restarting stack..."
docker compose up -d

# Clean up old images to prevent disk from filling up
info "Pruning unused Docker images..."
docker image prune -af

info "Update complete."
