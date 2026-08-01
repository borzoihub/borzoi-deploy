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

# ---------- options ----------------------------------------------------------
#
#   --wait [--timeout N]   Wait for a NEW :latest to be published before pulling.
#
# For the "I just pushed, don't hand me the old image" case. CI takes a few
# minutes (test + build on two architectures + promote), so an update run
# started right after a push would otherwise pull the previous image and look
# like the change did nothing.
#
# It watches the REGISTRY, not GitHub Actions, for two reasons:
#
#   1. borzoi-backend is private, so reading the Actions API needs a token with
#      `actions:read` on every Pi. The Hub's registry token is `read:packages`
#      only, deliberately — putting a broader GitHub token on hardware in a
#      customer's house to answer "is a build running" is a bad trade.
#   2. A finished run is not the thing you care about. `:latest` only moves in
#      the `promote` job, which runs only if the tests passed. So a moved
#      :latest means "tested and published", which is strictly more than
#      "the workflow ended".
#
# Deliberately OPT-IN: with no flag this script behaves exactly as before. It
# cannot tell "the build has not finished" from "there is nothing to wait for",
# so a default wait would hang every routine update. Use it when you know you
# just pushed.
WAIT_FOR_NEW=0
WAIT_TIMEOUT=900   # 15 min — a full two-arch CI run with room to spare.

while [ $# -gt 0 ]; do
  case "$1" in
    --wait|-w)   WAIT_FOR_NEW=1; shift ;;
    --timeout)   WAIT_TIMEOUT="${2:?--timeout needs a value in seconds}"; shift 2 ;;
    -h|--help)
      echo "Usage: $0 [--wait] [--timeout SECONDS]"
      echo "  --wait      wait for a newly published :latest before pulling"
      echo "  --timeout   how long to wait, in seconds (default ${WAIT_TIMEOUT})"
      exit 0
      ;;
    *) err "Unknown option: $1 (try --help)"; exit 1 ;;
  esac
done

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

# GHCR needs an explicit `docker login`, with the shared read:packages PAT from
# .env. Logging in each run is cheap and idempotent, and keeps a host that was
# restored from backup (or whose ~/.docker was cleared) working without a manual
# step.
#
# This used to broker a short-lived per-Hub token through central. That was
# removed on 2026-07-31: GHCR does not accept any credential central can mint —
# not GitHub App installation tokens, not registry bearers — so the broker could
# only ever hand back this same PAT. See docs/connection-key.md.
info "Authenticating to ${REGISTRY%%/*}..."
if [ -z "${GHCR_TOKEN:-}" ]; then
  err "GHCR_TOKEN is not set in .env — cannot pull images. See docs/updating.md."
  exit 1
fi
if printf '%s' "$GHCR_TOKEN" | docker login "${REGISTRY%%/*}" -u "${GHCR_USER:-voltini-autobot}" --password-stdin >/dev/null 2>&1; then
  info "Registry credentials OK."
else
  err "docker login to ${REGISTRY%%/*} failed. Is GHCR_TOKEN valid?"
  exit 1
fi

# ---------- optionally wait for a new image ----------------------------------

# Fingerprint of what :latest points at right now. Hashing the manifest instead
# of parsing a digest out of it keeps this dependency-free — no jq, no python —
# and the manifest is byte-stable for a given image, so the hash changes if and
# only if the image does.
#
# `sha256sum` (coreutils) is the one guaranteed on a Raspberry Pi; `shasum`
# (perl) is what macOS has. Try both so this behaves the same on a Pi and on a
# developer's laptop — the Pi is the target that matters, and it was the one the
# first cut would have failed on.
_sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum
  else shasum -a 256
  fi
}
latest_fingerprint() {
  docker manifest inspect "$REGISTRY/borzoi-backend:latest" 2>/dev/null | _sha256 | cut -d' ' -f1
}

if [ "$WAIT_FOR_NEW" = "1" ]; then
  BEFORE="$(latest_fingerprint)"
  if [ -z "$BEFORE" ]; then
    err "Could not read the current :latest manifest — skipping the wait and pulling as usual."
  else
    info "Waiting for a new :latest (up to $((WAIT_TIMEOUT / 60)) min). Ctrl-C to pull whatever is there now."
    WAITED=0
    while [ "$WAITED" -lt "$WAIT_TIMEOUT" ]; do
      sleep 15
      WAITED=$((WAITED + 15))
      NOW="$(latest_fingerprint)"
      # An empty read is a transient registry blip, not "unchanged" — ignore it
      # rather than treating it as an answer.
      if [ -n "$NOW" ] && [ "$NOW" != "$BEFORE" ]; then
        info "New image published after ${WAITED}s — continuing."
        break
      fi
      # Progress every minute, so a long wait does not look like a hang.
      [ $((WAITED % 60)) -eq 0 ] && info "  ...still waiting (${WAITED}s)"
    done
    if [ "$WAITED" -ge "$WAIT_TIMEOUT" ]; then
      err ":latest did not change within $((WAIT_TIMEOUT / 60)) min."
      err "Either the build is still running, it failed, or it was already published before this run started."
      err "Check the Actions tab, then re-run without --wait to pull what is there."
      exit 1
    fi
  fi
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

# Same reasoning, and the one nobody notices: scripts/updater.sh is bind-mounted
# into the sidecar, so editing it changes neither the image nor the compose
# config and `up -d` leaves the old script running. Without this, a bundle sync
# that ships a new updater has no effect until someone restarts the container by
# hand — and since the OTA path deliberately excludes the updater from its own
# recreate (it must survive to write status.json), THIS is the only place an
# updated updater ever takes effect.
info "Restarting updater to pick up script changes..."
docker compose restart updater

# Clean up old images to prevent disk from filling up
info "Pruning unused Docker images..."
docker image prune -af

info "Update complete."
