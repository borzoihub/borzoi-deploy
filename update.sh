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

# ---------- sync this bundle from git ----------------------------------------

# Images come from the registry; docker-compose.yml, the nginx templates and any
# mounted config.json do not — they are files in this checkout. Pull them here so
# a manual update applies infrastructure changes too, not just new images.
# Deliberately non-fatal: --ff-only refuses on a diverged or hand-edited tree,
# and that must not block a backend upgrade. Kept in step with git_sync() in
# scripts/updater.sh (the OTA path).
if [ -d .git ]; then
  info "Syncing bundle from git..."
  if git pull --ff-only; then
    info "Bundle synced."
  else
    err "git pull --ff-only failed (diverged or dirty tree?) — continuing with on-disk files."
  fi
else
  info "Not a git checkout — skipping bundle sync."
fi

# ---------- registry credential ----------------------------------------------

# GHCR needs an explicit `docker login`. Unlike the old ECR credential helper
# there is no token exchange — GHCR_TOKEN is a read:packages PAT read from
# .env. Logging in each run is cheap and idempotent, and keeps a host that was
# restored from backup (or whose ~/.docker was cleared) working without a
# manual step.
info "Authenticating to ${REGISTRY%%/*}..."
if [ -z "${GHCR_TOKEN:-}" ]; then
  err "GHCR_TOKEN is not set in .env — cannot pull images. See docs/updating.md."
  exit 1
fi
if printf '%s' "$GHCR_TOKEN" | docker login "${REGISTRY%%/*}" -u "${GHCR_USER:-voltini-autobot}" --password-stdin >/dev/null 2>&1; then
  info "Registry credentials OK."
else
  err "docker login to ${REGISTRY%%/*} failed. Check GHCR_USER/GHCR_TOKEN in .env."
  exit 1
fi

# ---------- pull + resolve versions ------------------------------------------

info "Pulling latest images..."
# Pull the runtime services explicitly — the `updater` sidecar is built
# locally (pull_policy: build), so a bare `docker compose pull` would fail
# trying to fetch borzoi-updater from a registry.
docker compose pull postgres backend frontend nginx

# Read the version from inside the pulled image and re-tag locally so that
# "docker ps" shows the real version instead of ":latest".
BACKEND_VER=$(docker run --rm --entrypoint node "$REGISTRY/borzoi-backend:latest" -p "require('./package.json').version" 2>/dev/null)

if [ -n "$BACKEND_VER" ]; then
  docker tag "$REGISTRY/borzoi-backend:latest" "$REGISTRY/borzoi-backend:$BACKEND_VER"
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
