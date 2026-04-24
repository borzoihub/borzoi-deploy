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

# After pulling, resolve the actual semver tag for each image so that
# "docker ps" shows the real version instead of ":latest".
resolve_version_tag() {
  local image=$1
  # The latest image shares a digest with a semver-tagged image.
  # Find that tag by matching digests among locally available tags.
  local digest
  digest=$(docker inspect --format '{{index .RepoDigests 0}}' "$image:latest" 2>/dev/null | cut -d@ -f2)
  [ -z "$digest" ] && return
  docker images "$image" --digests --format '{{.Tag}} {{.Digest}}' \
    | grep -E '^[0-9]+\.[0-9]+\.[0-9]+ ' \
    | grep "$digest" \
    | awk '{print $1}' \
    | sort -V \
    | tail -1
}

# Pull with latest first, then try to find the versioned tag.
# If we can resolve it, re-export so compose uses the versioned tag.
BACKEND_VER=$(resolve_version_tag "$ECR_REGISTRY/borzoi-backend")
FRONTEND_VER=$(resolve_version_tag "$ECR_REGISTRY/borzoi-frontend")

if [ -n "$BACKEND_VER" ]; then
  export BACKEND_TAG="$BACKEND_VER"
  info "Backend version: $BACKEND_VER"
else
  info "Backend version: latest (could not resolve semver tag)"
fi
if [ -n "$FRONTEND_VER" ]; then
  export FRONTEND_TAG="$FRONTEND_VER"
  info "Frontend version: $FRONTEND_VER"
else
  info "Frontend version: latest (could not resolve semver tag)"
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
