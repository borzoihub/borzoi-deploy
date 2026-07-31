#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────
# Install (or rotate) this Hub's central credential.
#
#   ./scripts/set-hub-secret.sh                 # prompts, hidden input
#   ./scripts/set-hub-secret.sh --check         # report state, change nothing
#   VOLTINI_HUB_SECRET=vhs_… ./scripts/set-hub-secret.sh --from-env
#
# Issue (or rotate) the secret in the installer portal. It is displayed ONCE.
# Losing it costs nothing — stage another rotation.
#
# A rotation is a confirmed handover, not an overwrite: central keeps the Hub's
# current secret working until this script authenticates with the new one. If
# that never happens the staged secret just expires and the Hub is unaffected.
# So running this and failing is always safe.
#
# ── Why this script exists ───────────────────────────────────────────
# The secret cannot be delivered the way everything else on a Hub is. `git_sync`
# pulls the bundle, but .env is gitignored and per-Hub, so it can never carry a
# credential. Central cannot push it either — the whole point of the design is
# that central initiates nothing the Hub must be listening for. So delivery is
# out of band, and the honest goal is to make it a single paste rather than a
# hand-edit of .env followed by remembering which containers to restart.
#
# What this buys over editing .env yourself: it validates the format before
# writing, restarts exactly the services that read the value, and verifies the
# credential actually works against central — so you learn about a typo now
# rather than at 02:00 when the backup runs.
# ─────────────────────────────────────────────────────────────────────
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
INSTALL_DIR="$(dirname "$SCRIPT_DIR")"
ENV_FILE="${INSTALL_DIR}/.env"

err()  { echo "ERROR: $*" >&2; }
info() { echo "$*"; }

MODE="prompt"
case "${1:-}" in
  --check)    MODE="check" ;;
  --from-env) MODE="from-env" ;;
  -h|--help)  sed -n '2,24p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
  "")         ;;
  *)          err "unknown argument '$1' (try --help)"; exit 1 ;;
esac

[ -f "$ENV_FILE" ] || { err ".env not found — run setup.sh first."; exit 1; }

# shellcheck disable=SC1090
set -a; source "$ENV_FILE"; set +a
source "${SCRIPT_DIR}/broker.sh"

BROKER_URL="${VOLTINI_BROKER_URL:-https://api.voltini.energy/api/hub/credentials}"

# ── verify — does the credential actually work? ─────────────────────────────
verify_secret() {
  local secret="$1" response http
  response="$(curl -sS --max-time 15 -w $'\n%{http_code}' \
      -H "Authorization: Bearer ${secret}" \
      "${BROKER_URL%/}/registry-pull" 2>&1)" || {
    echo "unreachable: ${response}"
    return 2
  }
  http="${response##*$'\n'}"
  case "$http" in
    200) echo "ok"; return 0 ;;
    401) echo "rejected by central — the secret is wrong, or has been revoked"; return 1 ;;
    503) # Central accepted the credential; it just has no GitHub App wired yet.
         # That still proves the secret is valid, which is what we are checking.
         echo "ok (central accepted the secret; registry broker not configured yet)"; return 0 ;;
    *)   echo "unexpected HTTP ${http}"; return 1 ;;
  esac
}

if [ "$MODE" = "check" ]; then
  if [ -z "${VOLTINI_HUB_SECRET:-}" ]; then
    info "No central secret installed — this Hub uses the static GHCR_TOKEN and has no cloud backup."
    exit 0
  fi
  info "Secret installed: ${VOLTINI_HUB_SECRET:0:12}… (installation ${VOLTINI_INSTALLATION_ID:-unset})"
  info "Broker: ${BROKER_URL}"
  result="$(verify_secret "$VOLTINI_HUB_SECRET")"; rc=$?
  info "Verification: ${result}"
  exit $rc
fi

# ── obtain the new value ────────────────────────────────────────────────────
if [ "$MODE" = "from-env" ]; then
  NEW_SECRET="${VOLTINI_HUB_SECRET:-}"
  [ -n "$NEW_SECRET" ] || { err "VOLTINI_HUB_SECRET is not set in the environment."; exit 1; }
else
  echo "Paste the secret from the installer portal (input hidden):" >&2
  stty -echo 2>/dev/null; read -r NEW_SECRET; stty echo 2>/dev/null; echo "" >&2
fi

NEW_SECRET="$(printf '%s' "$NEW_SECRET" | tr -d '[:space:]')"

# Format check before anything is written. The id is embedded in the secret, so
# a paste error is catchable here rather than becoming a 401 at 02:00.
if ! printf '%s' "$NEW_SECRET" | grep -Eq '^vhs_[0-9]+_[A-Za-z0-9_-]{20,}$'; then
  err "That does not look like a Hub secret (expected vhs_<installationId>_<random>)."
  exit 1
fi

SECRET_INSTALLATION_ID="$(printf '%s' "$NEW_SECRET" | cut -d_ -f2)"

# ── write, THEN verify, and roll back if verification fails ─────────────────
#
# The order matters and is the opposite of the obvious one. Central stages a
# rotation without retiring the current secret, and completes it only when this
# Hub successfully authenticates with the new one — so the verify call below is
# not a dry run, it IS the confirmation that commits the rotation.
#
# Verifying first would therefore commit the handover at central before this
# host had the new value on disk; if the write then failed, the Hub would be
# holding a retired secret with no way back. Writing first is safe precisely
# because both secrets work during the staging window: worst case the file has
# a value central has not yet promoted, and the first real use promotes it.
#
# The remaining risk is an operator pasting the wrong string, which is why a
# failed verification restores the backup rather than leaving it in place.
BACKUP="${ENV_FILE}.bak.$(date +%Y%m%d-%H%M%S)"
cp "$ENV_FILE" "$BACKUP"

set_var() {
  local key="$1" value="$2"
  if grep -q "^${key}=" "$ENV_FILE"; then
    # Use a non-/ delimiter — the secret is base64url and may contain '-' and
    # '_', but a URL value would contain '/'.
    awk -v k="$key" -v v="$value" \
      'BEGIN{FS=OFS="="} $1==k {print k "=" v; next} {print}' \
      "$ENV_FILE" > "${ENV_FILE}.tmp" && mv "${ENV_FILE}.tmp" "$ENV_FILE"
  else
    printf '%s=%s\n' "$key" "$value" >> "$ENV_FILE"
  fi
}

set_var VOLTINI_HUB_SECRET "$NEW_SECRET"
set_var VOLTINI_INSTALLATION_ID "$SECRET_INSTALLATION_ID"
set_var VOLTINI_BROKER_URL "$BROKER_URL"
chmod 600 "$ENV_FILE"

# This call is the handshake's third leg: authenticating with the new secret is
# how central learns the Hub really has it, and only then does it retire the old
# one. Until this succeeds the previous secret is still valid at central.
info "Confirming the new secret with ${BROKER_URL}..."
result="$(verify_secret "$NEW_SECRET")"; rc=$?
if [ $rc -ne 0 ]; then
  err "Confirmation failed: ${result}"
  cp "$BACKUP" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  err "Restored the previous .env — this Hub still has its working secret."
  err "Nothing was retired at central; the staged rotation simply expires."
  exit 1
fi
info "Confirmed: ${result}"
info "Installed for installation ${SECRET_INSTALLATION_ID}."

# ── restart what reads it ───────────────────────────────────────────────────
# Only the deploy/infra layer consumes this credential, so only those services
# restart. The backend, the optimizer and the database are deliberately NOT
# touched: the control loop must not be interrupted by a credential change, and
# it never reads this value in the first place.
cd "$INSTALL_DIR" || exit 1
if docker compose ps --services 2>/dev/null | grep -q '^db-backup$'; then
  info "Restarting db-backup (picks up the new broker token)..."
  docker compose up -d db-backup >/dev/null 2>&1 \
    || err "could not restart db-backup — do it manually."
fi
info "The updater re-reads .env on its next loop; no restart needed."

cat <<EOF

Done. Next:

  - Confirm the portal shows a recent "last used" for installation
    ${SECRET_INSTALLATION_ID} — that is how you know this Hub has really adopted
    the credential.
  - Once it has, blank GHCR_TOKEN in .env to retire the shared static PAT for
    this Hub.
  - To enable cloud backups, set BACKUP_S3_BUCKET and add 'cloud-backup' to
    COMPOSE_PROFILES, then: docker compose up -d db-backup
EOF
