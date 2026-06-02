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

mkdir -p "$UPGRADE_DIR"

# .env carries ECR_REGISTRY (+ DB_USER / DB_NAME for the backup script).
set -a
[ -f "$INSTALL_DIR/.env" ] && . "$INSTALL_DIR/.env"
set +a

STARTED_AT=""

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
  [ -n "${ECR_REGISTRY:-}" ] || { echo "updater: ECR_REGISTRY not set" >&2; return 1; }
  # ECR registry host is <account>.dkr.ecr.<region>.amazonaws.com
  local region
  region="$(printf '%s' "$ECR_REGISTRY" | cut -d. -f4)"
  aws ecr get-login-password --profile borzoi-ecr --region "$region" \
    | docker login --username AWS --password-stdin "$ECR_REGISTRY"
}

run_upgrade() {
  STARTED_AT="$(now_iso)"

  # 1. Pre-update backup (same script the nightly cron uses).
  write_status running backup "" ""
  if ! bash "$INSTALL_DIR/scripts/db-backup.sh"; then
    write_status failed backup "" "Pre-update backup failed"
    return
  fi

  # 2. Authenticate to ECR and pull the runtime images. We pull the runtime
  #    services explicitly (NOT a bare `pull`) so compose never tries to pull
  #    the locally-built `updater` image.
  write_status running pull "" ""
  if ! ecr_login; then
    write_status failed pull "" "ECR login failed"
    return
  fi
  if ! docker compose pull postgres backend frontend nginx; then
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
  if ! docker compose up -d --no-deps postgres backend frontend nginx; then
    write_status failed restart "$target" "docker compose up failed"
    return
  fi
  # nginx only re-reads its templates on container start.
  docker compose restart nginx >/dev/null 2>&1 || true

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
