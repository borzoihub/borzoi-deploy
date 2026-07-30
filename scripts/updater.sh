#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────
# Borzoi OTA updater — sidecar loop
#
# Runs inside the `updater` container (Docker socket + aws-cli + compose
# plugin). It is the execution half of the portal-triggered OTA upgrade:
#
#   borzoi-backend  → writes data/upgrade/request.json
#   THIS LOOP       → backup → ECR login → pull → up -d → prune
#                     writing progress to data/upgrade/status.json
#   borzoi-backend  → reads status.json back (survives its own restart)
#
# Two facts make the sidecar necessary:
#   1. `docker compose up -d` recreates the backend container — it can't
#      run its own upgrade.
#   2. The backend container can't reach the Docker socket / host.
#
# The presence (and freshness) of data/upgrade/capable — touched every
# loop here — is how the backend knows this Hub is OTA-capable at all.
#
# The actual pull/up sequence is intentionally kept in step with update.sh
# (the manual, host-run path). Keep the two in sync.
# ─────────────────────────────────────────────────────────────────────
set -uo pipefail

# Project must be mounted at its real host path (see docker-compose.yml)
# so compose's relative bind mounts resolve identically inside and out.
INSTALL_DIR="${INSTALL_DIR:-$(pwd)}"
cd "$INSTALL_DIR" || { echo "updater: cannot cd to $INSTALL_DIR" >&2; exit 1; }

UPGRADE_DIR="$INSTALL_DIR/data/upgrade"
CAPABLE="$UPGRADE_DIR/capable"
REQUEST="$UPGRADE_DIR/request.json"
STATUS="$UPGRADE_DIR/status.json"
POLL_SECONDS="${UPDATER_POLL_SECONDS:-10}"

# Which compose services this updater pulls + recreates, and whether it takes a
# pre-update DB backup. Defaults reproduce the full-Hub behavior exactly; the
# sim-node compose overrides them (OTA_SERVICES=sim, OTA_BACKUP=0) since a sim
# node has no database and only the one `sim` service. The updater service
# itself is always excluded from the recreate (`--no-deps` + explicit list) so
# it never recreates itself mid-run.
OTA_SERVICES="${OTA_SERVICES:-postgres backend frontend nginx}"
OTA_BACKUP="${OTA_BACKUP:-1}"

mkdir -p "$UPGRADE_DIR"

# .env carries ECR_REGISTRY (+ DB_USER / DB_NAME for the backup script).
set -a
[ -f "$INSTALL_DIR/.env" ] && . "$INSTALL_DIR/.env"
set +a

STARTED_AT=""
LOGIN_ERR=""

# Emit a JSON string literal, or `null` for an empty value (with escaping).
json_str() {
  if [ -z "${1:-}" ]; then
    printf 'null'
  else
    printf '"%s"' "$(printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g')"
  fi
}

now_iso() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# write_status <state> <step> <targetVersion> <error>
# currentVersion + otaSupported are overlaid by the backend on read.
write_status() {
  local state="$1" step="${2:-}" target="${3:-}" err="${4:-}" finished=""
  case "$state" in success|failed) finished="$(now_iso)" ;; esac
  {
    printf '{'
    printf '"state":"%s",' "$state"
    printf '"step":%s,' "$(json_str "$step")"
    printf '"targetVersion":%s,' "$(json_str "$target")"
    printf '"startedAt":%s,' "$(json_str "$STARTED_AT")"
    printf '"finishedAt":%s,' "$(json_str "$finished")"
    printf '"error":%s' "$(json_str "$err")"
    printf '}'
  } > "$STATUS.tmp"
  mv "$STATUS.tmp" "$STATUS"
}

ecr_login() {
  LOGIN_ERR=""
  if [ -z "${ECR_REGISTRY:-}" ]; then
    LOGIN_ERR="ECR_REGISTRY not set in .env"
    echo "updater: $LOGIN_ERR" >&2
    return 1
  fi
  # ECR registry host is <account>.dkr.ecr.<region>.amazonaws.com
  local region pw out
  region="$(printf '%s' "$ECR_REGISTRY" | cut -d. -f4)"

  # Capture the real reason (creds not found, TLS/cert, IAM, …) so it lands
  # in status.json + these logs instead of a generic "login failed".
  if ! pw="$(aws ecr get-login-password --profile borzoi-ecr --region "$region" 2>&1)"; then
    LOGIN_ERR="aws get-login-password: $pw"
    echo "updater: $LOGIN_ERR" >&2
    return 1
  fi
  if ! out="$(printf '%s' "$pw" | docker login --username AWS --password-stdin "$ECR_REGISTRY" 2>&1)"; then
    LOGIN_ERR="docker login: $out"
    echo "updater: $LOGIN_ERR" >&2
    return 1
  fi
}

# Sync THIS bundle from git before deploying.
#
# Why: images arrive from the registry, but docker-compose.yml, the nginx
# templates and any mounted config.json do NOT — they are plain files in the
# /opt/borzoi checkout. Without this, a Hub runs whatever bundle it was
# installed with, forever, and every compose change needs a visit to every Pi.
#
# Three details that are easy to get wrong:
#
#   * Run git as the CHECKOUT'S OWNER, not root. The container is root while
#     the host repo belongs to the install user, so plain `git pull` would trip
#     git's dubious-ownership guard — and if waved through with safe.directory,
#     it would leave root-owned objects in .git that later break a host-side
#     `./update.sh` run by that user. `setpriv --reuid` avoids both.
#   * HOME is /root here and is not readable by that uid, so point git at /tmp
#     for its config lookup.
#   * NEVER fail the upgrade on a failed pull. A hand-edited tracked file on one
#     Pi makes --ff-only refuse; that must not block a backend upgrade. Warn and
#     continue with the on-disk files.
#
# Self-update caveat: bash has already read this script into memory, so a change
# to updater.sh itself takes effect on the NEXT run. Compose/config changes
# apply to this one.
git_sync() {
  [ -d "$INSTALL_DIR/.git" ] || { echo "updater: $INSTALL_DIR is not a git checkout — skipping sync."; return 0; }

  local uid gid
  uid="$(stat -c '%u' "$INSTALL_DIR")"
  gid="$(stat -c '%g' "$INSTALL_DIR")"

  if setpriv --reuid="$uid" --regid="$gid" --clear-groups \
       env HOME=/tmp git -C "$INSTALL_DIR" pull --ff-only; then
    echo "updater: bundle synced from git."
  else
    echo "updater: git pull --ff-only failed (diverged or dirty tree?) — continuing with on-disk files." >&2
  fi
}

run_upgrade() {
  STARTED_AT="$(now_iso)"

  # 1. Pre-update backup (same script the nightly cron uses). Skipped when
  #    OTA_BACKUP=0 (e.g. a sim node, which has no database to dump).
  if [ "$OTA_BACKUP" != "0" ]; then
    write_status running backup "" ""
    if ! bash "$INSTALL_DIR/scripts/db-backup.sh"; then
      write_status failed backup "" "Pre-update backup failed"
      return
    fi
  fi

  # 2. Sync the bundle, then authenticate to ECR and pull the runtime images. We
  #    pull the configured services explicitly (NOT a bare `pull`) so compose
  #    never tries to pull the locally-built `updater` image.
  #
  #    The git sync reports under the existing `pull` step rather than a new one:
  #    `IHubUpgradeStep` in borzoi-common is a fixed
  #    `backup|pull|restart|verify` union, and adding a value would need a
  #    common release plus new Swedish copy in voltini-app for no user benefit.
  write_status running pull "" ""
  git_sync
  if ! ecr_login; then
    write_status failed pull "" "ECR login failed: ${LOGIN_ERR:-unknown}"
    return
  fi
  # Always resolve `latest` fresh. This function runs in the updater's
  # long-lived loop process, so the `export BACKEND_TAG="$target"` below would
  # otherwise leak the previously-resolved version into the next run's pull —
  # pinning it to a stale tag instead of `latest` (so a node would re-pull the
  # version it already runs and never see a newer publish).
  export BACKEND_TAG=latest
  if ! docker compose pull $OTA_SERVICES; then
    write_status failed pull "" "docker compose pull failed"
    return
  fi

  # Resolve the pulled backend version (for reporting + a real ps tag).
  local target
  target="$(docker run --rm --entrypoint node \
    "$ECR_REGISTRY/borzoi-backend:latest" \
    -p "require('./package.json').version" 2>/dev/null || true)"
  if [ -n "$target" ]; then
    docker tag "$ECR_REGISTRY/borzoi-backend:latest" \
      "$ECR_REGISTRY/borzoi-backend:$target" 2>/dev/null || true
    export BACKEND_TAG="$target"
  fi

  # 3. Recreate the runtime services — explicitly EXCLUDING the updater
  #    itself (`--no-deps` + an explicit service list), so this container is
  #    never recreated mid-run and can finish writing status.
  write_status running restart "$target" ""
  if ! docker compose up -d --no-deps $OTA_SERVICES; then
    write_status failed restart "$target" "docker compose up failed"
    return
  fi
  # nginx only re-reads its templates on container start (Hub only; a sim
  # node's OTA_SERVICES has no nginx, so this no-ops there).
  case " $OTA_SERVICES " in
    *" nginx "*) docker compose restart nginx >/dev/null 2>&1 || true ;;
  esac

  # 4. Reclaim disk from the superseded images.
  docker image prune -af >/dev/null 2>&1 || true

  write_status success "" "$target" ""
}

echo "updater: watching $REQUEST (poll ${POLL_SECONDS}s, install dir $INSTALL_DIR)"
while true; do
  # Heartbeat the capability marker so the backend reports otaSupported.
  touch "$CAPABLE" 2>/dev/null || true

  if [ -f "$REQUEST" ]; then
    # Claim the request atomically so a duplicate write can't double-run it.
    if mv "$REQUEST" "$REQUEST.processing" 2>/dev/null; then
      write_status pending "" "" ""
      run_upgrade
      rm -f "$REQUEST.processing"
    fi
  fi

  sleep "$POLL_SECONDS"
done
