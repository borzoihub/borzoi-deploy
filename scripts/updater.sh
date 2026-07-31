#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────
# Borzoi OTA updater — sidecar loop
#
# Runs inside the `updater` container (Docker socket + git + compose plugin). It is the execution half of the portal-triggered OTA upgrade:
#
#   borzoi-backend  → writes data/upgrade/request.json
#   THIS LOOP       → backup → git sync → registry login → pull → up -d → prune
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

# Credential-broker client — supplies `registry_credential`, used by
# registry_login() below. Sourced from the mounted project rather than baked
# into the updater image so a `git_sync` picks up changes without an image roll.
# shellcheck source=scripts/broker.sh
source "$INSTALL_DIR/scripts/broker.sh"

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

# .env carries REGISTRY + GHCR_TOKEN (+ DB_USER / DB_NAME for the backup script).
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

# Authenticate to the image registry. Runs on every upgrade because this
# container's filesystem is ephemeral — a login written here does not survive a
# recreate, unlike the host's ~/.docker/config.json.
#
# The credential comes from `registry_credential` (scripts/broker.sh): a
# short-lived token brokered through central when this Hub has its central
# secret, otherwise the static read:packages PAT from .env. This function is
# the swap point the credential-broker blueprint identified, and swapping it is
# all that changed — compose, the pull sequence and the OTA flow are untouched.
registry_login() {
  LOGIN_ERR=""
  if [ -z "${REGISTRY:-}" ]; then
    LOGIN_ERR="REGISTRY not set in .env"
    echo "updater: $LOGIN_ERR" >&2
    return 1
  fi

  # Not `$(registry_credential)` — that subshell would discard BROKER_ERR and
  # REGISTRY_CRED_SOURCE, so a failure would be reported with no reason and the
  # status file would say only "Registry login failed". See scripts/broker.sh.
  if ! registry_credential; then
    LOGIN_ERR="$BROKER_ERR"
    echo "updater: $LOGIN_ERR" >&2
    return 1
  fi

  # Registry host only — REGISTRY is "ghcr.io/borzoihub".
  local host out
  host="${REGISTRY%%/*}"
  if ! out="$(printf '%s' "$REGISTRY_CREDENTIAL" | docker login "$host" -u "${GHCR_USER:-voltini-autobot}" --password-stdin 2>&1)"; then
    LOGIN_ERR="docker login $host (${REGISTRY_CRED_SOURCE:-unknown} credential): $out"
    echo "updater: $LOGIN_ERR" >&2
    return 1
  fi
  echo "updater: registry login OK (${REGISTRY_CRED_SOURCE} credential)"
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

  # 2. Sync the bundle, then authenticate to the registry and pull the runtime images. We
  #    pull the configured services explicitly (NOT a bare `pull`) so compose
  #    never tries to pull the locally-built `updater` image.
  #
  #    The git sync reports under the existing `pull` step rather than a new one:
  #    `IHubUpgradeStep` in borzoi-common is a fixed
  #    `backup|pull|restart|verify` union, and adding a value would need a
  #    common release plus new Swedish copy in voltini-app for no user benefit.
  write_status running pull "" ""
  git_sync
  if ! registry_login; then
    write_status failed pull "" "Registry login failed: ${LOGIN_ERR:-unknown}"
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
    "$REGISTRY/borzoi-backend:latest" \
    -p "require('./package.json').version" 2>/dev/null || true)"
  if [ -n "$target" ]; then
    docker tag "$REGISTRY/borzoi-backend:latest" \
      "$REGISTRY/borzoi-backend:$target" 2>/dev/null || true
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
