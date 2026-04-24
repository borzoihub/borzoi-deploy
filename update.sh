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

# ---------- pull + resolve versions ------------------------------------------

info "Pulling latest images..."
docker compose pull

# Read the version from inside the pulled image and re-tag locally so that
# "docker ps" shows the real version instead of ":latest".
BACKEND_VER=$(docker run --rm "$ECR_REGISTRY/borzoi-backend:latest" node -p "require('./package.json').version" 2>/dev/null)

if [ -n "$BACKEND_VER" ]; then
  docker tag "$ECR_REGISTRY/borzoi-backend:latest" "$ECR_REGISTRY/borzoi-backend:$BACKEND_VER"
  export BACKEND_TAG="$BACKEND_VER"
  info "Backend version: $BACKEND_VER"
else
  info "Backend version: unknown (falling back to latest)"
fi

# ---------- restart with resolved tags --------------------------------------

info "Restarting stack..."
docker compose up -d

# Nginx reads templates only at container start. docker-compose up -d won't
# restart nginx when only bind-mounted template files changed (the image and
# compose config are unchanged). Force a restart so it picks up any updated
# nginx templates from git.
info "Restarting nginx to pick up template changes..."
docker compose restart nginx

# Clean up old images to prevent disk from filling up
info "Pruning unused Docker images..."
docker image prune -af

info "Update complete."
