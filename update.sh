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

# ---------- resolve latest versions -----------------------------------------

resolve_latest_tag() {
  local repo=$1
  # List image tags from ECR, pick the highest semver tag (ignore "latest").
  aws ecr describe-images \
    --profile borzoi-ecr \
    --repository-name "$repo" \
    --query 'imageDetails[*].imageTags[]' \
    --output text \
  | tr '\t' '\n' \
  | grep -E '^[0-9]+\.[0-9]+\.[0-9]+$' \
  | sort -V \
  | tail -1
}

info "Resolving latest image versions from ECR..."

BACKEND_TAG=$(resolve_latest_tag borzoi-backend)
FRONTEND_TAG=$(resolve_latest_tag borzoi-frontend)

if [ -z "$BACKEND_TAG" ] || [ -z "$FRONTEND_TAG" ]; then
  err "Could not resolve latest version tags from ECR."
  [ -z "$BACKEND_TAG" ] && err "  borzoi-backend: no semver tags found"
  [ -z "$FRONTEND_TAG" ] && err "  borzoi-frontend: no semver tags found"
  exit 1
fi

export BACKEND_TAG FRONTEND_TAG
info "Backend: $BACKEND_TAG, Frontend: $FRONTEND_TAG"

# ---------- pull + restart ---------------------------------------------------

info "Pulling images..."
docker compose pull

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
