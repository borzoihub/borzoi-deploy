#!/usr/bin/env bash
set -euo pipefail

# ============================================================================
# Borzoi sim-node update — pull latest borzoi-backend image, recreate the sim
# container. The host-run counterpart to the OTA updater sidecar
# (scripts/updater.sh) and the sim-node analogue of update.sh.
#
# A sim node holds no database, no frontend, no nginx — just one
# borzoi-backend container in BORZOI_MODE=sim (docker-compose.sim.yml). So this
# is a slim version of update.sh: no DB backup, only the `sim` service.
#
# It runs the SAME pull -> retag -> up -d sequence the updater sidecar runs, so
# the result is identical to clicking "Update" in the portal — including the
# no-op case: if ECR's `latest` is the same image the node already runs, the
# container is NOT recreated and the script reports that and exits 0.
#
# Usage:
#   ./update-sim.sh            pull + recreate only if the image actually changed
#   ./update-sim.sh --force    recreate the sim container even if unchanged
#                              (use to unstick a node parked on an OTA upgrade)
# ============================================================================

cd "$(dirname "$0")"

err()  { echo "ERROR: $*" >&2; }
info() { echo "$*"; }

FORCE=0
case "${1:-}" in
  --force|-f) FORCE=1 ;;
  "") ;;
  *) err "unknown argument: $1 (use --force or no argument)"; exit 2 ;;
esac

COMPOSE_FILE_SIM="docker-compose.sim.yml"

if [ ! -f .env ]; then
  err ".env not found — run install-sim.sh first for initial installation."
  exit 1
fi
if [ ! -f "$COMPOSE_FILE_SIM" ]; then
  err "$COMPOSE_FILE_SIM not found next to this script — run from the borzoi-deploy clone."
  exit 1
fi

# .env carries ECR_REGISTRY (+ the pinned COMPOSE_FILE / project). Explicit -f
# below means we don't rely on COMPOSE_FILE, but the sourced values are still
# needed for the registry host.
set -a
# shellcheck disable=SC1091
source .env
set +a

if [ -z "${ECR_REGISTRY:-}" ]; then
  err "ECR_REGISTRY not set in .env."
  exit 1
fi

dc() { docker compose -f "$COMPOSE_FILE_SIM" "$@"; }

# ---------- ECR credential check --------------------------------------------
# install-sim.sh configures the docker credential helper, so a plain pull
# authenticates automatically. Verify it before pulling so a creds problem
# surfaces clearly instead of as a generic pull failure.

info "Verifying ECR credentials..."
if echo "$ECR_REGISTRY" | docker-credential-borzoi-ecr-login get >/dev/null 2>&1; then
  info "ECR credentials OK."
else
  err "ECR credential helper failed. Check ~/.aws/credentials [borzoi-ecr] profile."
  exit 1
fi

# ---------- record what's running, then pull --------------------------------
# Capture the running sim container's image id so we can tell a real upgrade
# from a no-op pull (same digest -> compose won't recreate).

RUNNING_CID="$(dc ps -q sim 2>/dev/null || true)"
RUNNING_IMG=""
if [ -n "$RUNNING_CID" ]; then
  RUNNING_IMG="$(docker inspect "$RUNNING_CID" --format '{{.Image}}' 2>/dev/null || true)"
fi

info "Pulling sim image from ECR..."
# Only the `sim` service — the `updater` sidecar is built locally
# (pull_policy: build), so a bare `docker compose pull` would fail on it.
dc pull sim

LATEST_IMG="$(docker image inspect "$ECR_REGISTRY/borzoi-backend:latest" --format '{{.Id}}' 2>/dev/null || true)"

# Read the version from inside the pulled image and re-tag locally so that
# `docker ps` shows the real version instead of ":latest" (mirrors update.sh /
# updater.sh). Best-effort.
BACKEND_VER="$(docker run --rm --entrypoint node "$ECR_REGISTRY/borzoi-backend:latest" \
  -p "require('./package.json').version" 2>/dev/null || true)"
if [ -n "$BACKEND_VER" ]; then
  docker tag "$ECR_REGISTRY/borzoi-backend:latest" \
    "$ECR_REGISTRY/borzoi-backend:$BACKEND_VER" 2>/dev/null || true
  export BACKEND_TAG="$BACKEND_VER"
  info "Latest published version: $BACKEND_VER"
else
  info "Latest published version: unknown (using :latest)"
fi

# ---------- ensure the OTA updater sidecar exists ---------------------------
# install-sim.sh brings up BOTH sim + updater; this script only touches `sim`.
# A node first started via update-sim.sh (or one whose updater was removed)
# would otherwise have no `borzoi-sim-updater` container — OTA `update` jobs
# drain but nothing acts on data/upgrade/request.json, so OTA silently dies.
# Run this in EVERY path (incl. the no-op short-circuit below). pull_policy is
# `build`, so this builds borzoi-updater:local if missing and is a no-op if the
# sidecar is already up. Bare `up -d updater` won't recreate the running `sim`.

info "Ensuring OTA updater sidecar is up..."
dc up -d updater

# ---------- no-op short-circuit ---------------------------------------------
# If the running container is already on the pulled image, recreating it would
# only restart the same version. Skip unless --force was given.

if [ "$FORCE" -ne 1 ] && [ -n "$RUNNING_IMG" ] && [ -n "$LATEST_IMG" ] \
   && [ "$RUNNING_IMG" = "$LATEST_IMG" ]; then
  info "Sim node already running the latest image (${BACKEND_VER:-latest}) — nothing to update."
  info "Pass --force to recreate the container anyway (e.g. to unstick a parked OTA upgrade)."
  exit 0
fi

# ---------- recreate the sim container --------------------------------------

if [ "$FORCE" -eq 1 ]; then
  info "Recreating the sim container (--force)..."
  dc up -d --no-deps --force-recreate sim
else
  info "Recreating the sim container with the new image..."
  dc up -d --no-deps sim
fi

# Reclaim disk from superseded images.
info "Pruning unused Docker images..."
docker image prune -af >/dev/null 2>&1 || true

info "Sim update complete (now on ${BACKEND_VER:-latest})."
