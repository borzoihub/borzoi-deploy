#!/usr/bin/env bash
set -euo pipefail

# ============================================================================
# Borzoi SIM-node installer — turn any Docker host into a simulation worker.
#
# Flow (a fresh machine with Docker already installed):
#   git clone https://github.com/borzoihub/borzoi-deploy.git
#   cd borzoi-deploy
#   ./install-sim.sh      # paste the sim bundle JSON when prompted → done
#
# A "sim node" is the borzoi-backend image run in BORZOI_MODE=sim — a pure
# outbound job-queue worker (see borzoi-backend/src/sim-server.ts). It pulls
# the prebuilt multi-arch image from ECR (no local build), reaches the central
# coordinator (voltini.energy-backend) over outbound HTTPS only, and updates
# itself OTA via the same updater sidecar the full Hub uses — triggered by an
# `update` job on the queue rather than an inbound call (no tunnel needed).
#
# Unlike the full Hub setup.sh this installs NO postgres/frontend/nginx, no
# DB-backup cron, and no Cloudflare tunnel. It only:
#   - parses the pasted sim bundle (ECR creds + coordinator URL + worker token)
#   - writes .env (mode 0600) pinned to docker-compose.sim.yml
#   - installs + configures the amazon-ecr-credential-helper wrapper
#   - pulls the sim image and brings the sim + updater containers up
# ============================================================================

COMPOSE_FILE_SIM="docker-compose.sim.yml"

# ---------- helpers ---------------------------------------------------------

err() { echo "ERROR: $*" >&2; }
info() { echo "$*"; }

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    err "required command not found: $1"
    exit 1
  fi
}

# ask "prompt" "default" — returns value on stdout.
ask() {
  local prompt="$1"
  local default="${2:-}"
  local reply
  if [ -n "$default" ]; then
    read -rp "$prompt [$default]: " reply >&2 || true
    reply="${reply:-$default}"
  else
    while :; do
      read -rp "$prompt: " reply >&2 || true
      if [ -n "$reply" ]; then break; fi
      echo "  (required)" >&2
    done
  fi
  echo "$reply"
}

# ask_secret "prompt" — silent read, returns value on stdout.
ask_secret() {
  local prompt="$1"
  local reply
  while :; do
    read -rsp "$prompt: " reply >&2 || true
    echo >&2
    if [ -n "$reply" ]; then break; fi
    echo "  (required)" >&2
  done
  echo "$reply"
}

# Minimal JSON field extractor — avoids a hard dependency on jq. Handles the
# simple flat structure the sim bundle emits (no nesting, no arrays). Same
# extractor setup.sh uses for the Hub installer credentials.
extract_json_field() {
  local field="$1" input="$2"
  printf '%s' "$input" | awk -v f="$field" '
    BEGIN { FS="\"" }
    {
      for (i = 1; i < NF; i++) {
        if ($i == f) {
          for (j = i+1; j <= NF; j++) if ($j ~ /[^ :[:space:]]/) { print $j; exit }
        }
      }
    }'
}

# ---------- preflight -------------------------------------------------------
# Docker + the compose v2 plugin must already be present (same contract as the
# Hub setup.sh — we do not auto-install Docker).

require_cmd docker
if ! docker compose version >/dev/null 2>&1; then
  err "docker compose v2 not available (need the 'docker compose' plugin, not docker-compose v1)."
  err "Install Docker Engine + the compose plugin, then re-run ./install-sim.sh"
  err "  https://docs.docker.com/engine/install/"
  exit 1
fi

HAS_AWS_CLI=0
if command -v aws >/dev/null 2>&1; then
  HAS_AWS_CLI=1
fi

# Run from the repo regardless of the caller's CWD.
cd "$(dirname "$0")"

if [ ! -f "$COMPOSE_FILE_SIM" ]; then
  err "$COMPOSE_FILE_SIM not found next to this script — are you in the borzoi-deploy clone?"
  exit 1
fi

# ---------- existing .env handling ------------------------------------------

if [ -f .env ]; then
  echo "A .env file already exists." >&2
  overwrite=$(ask "Overwrite? Type 'yes' to confirm, anything else aborts" "no")
  if [ "$overwrite" != "yes" ]; then
    info "Aborted. Existing .env left untouched."
    exit 0
  fi
  backup=".env.backup.$(date +%s)"
  cp .env "$backup"
  chmod 600 "$backup"
  info "Backed up existing .env → $backup"
fi

# ---------- obtain the sim bundle -------------------------------------------
# Source order (first hit wins), so fleet rollout needs no interaction:
#   1. a file path argument:   ./install-sim.sh sim-bundle.json
#   2. $SIM_BUNDLE_FILE        (path to a bundle file)
#   3. $SIM_BUNDLE_JSON        (the bundle JSON inline)
#   4. interactive paste       (fallback)
# Build the bundle once with ./make-sim-bundle.sh (reuses installer-creds.json).

BUNDLE_FILE="${1:-${SIM_BUNDLE_FILE:-}}"
BUNDLE_NONINTERACTIVE=0
if [ -n "$BUNDLE_FILE" ]; then
  [ -r "$BUNDLE_FILE" ] || { err "sim bundle file not readable: $BUNDLE_FILE"; exit 1; }
  BUNDLE_JSON=$(cat "$BUNDLE_FILE")
  BUNDLE_NONINTERACTIVE=1
  info "Using sim bundle from $BUNDLE_FILE"
elif [ -n "${SIM_BUNDLE_JSON:-}" ]; then
  BUNDLE_JSON="$SIM_BUNDLE_JSON"
  BUNDLE_NONINTERACTIVE=1
  info "Using sim bundle from \$SIM_BUNDLE_JSON"
else
  echo "" >&2
  echo "Borzoi sim-node setup." >&2
  echo "" >&2
  echo "Paste the SIM BUNDLE JSON (build it with ./make-sim-bundle.sh on the" >&2
  echo "operator machine). End the paste with Ctrl-D on a blank line." >&2
  echo "" >&2
  echo "Shape expected (values will differ):" >&2
  echo "  {" >&2
  echo "    \"ecr_region\":        \"eu-north-1\"," >&2
  echo "    \"ecr_registry\":      \"<account>.dkr.ecr.<region>.amazonaws.com\"," >&2
  echo "    \"access_key_id\":     \"AKIA...\"," >&2
  echo "    \"secret_access_key\": \"...\"," >&2
  echo "    \"coordinator_url\":   \"https://api.voltini.energy\"," >&2
  echo "    \"worker_token\":      \"<long-lived WorkerService JWT>\"" >&2
  echo "  }" >&2
  echo "" >&2
  echo "(Paste now, then Ctrl-D):" >&2
  BUNDLE_JSON=$(cat)
fi

if [ -z "$BUNDLE_JSON" ]; then
  err "Empty sim bundle. Provide a bundle file/env or paste the JSON."
  exit 1
fi

ECR_REGION=$(extract_json_field "ecr_region" "$BUNDLE_JSON")
ECR_REGISTRY=$(extract_json_field "ecr_registry" "$BUNDLE_JSON")
ECR_AWS_ACCESS_KEY_ID=$(extract_json_field "access_key_id" "$BUNDLE_JSON")
ECR_AWS_SECRET_ACCESS_KEY=$(extract_json_field "secret_access_key" "$BUNDLE_JSON")
COORDINATOR_URL=$(extract_json_field "coordinator_url" "$BUNDLE_JSON")
JOB_AUTH_TOKEN=$(extract_json_field "worker_token" "$BUNDLE_JSON")

MISSING=""
[ -z "$ECR_REGION" ]                && MISSING="$MISSING ecr_region"
[ -z "$ECR_REGISTRY" ]              && MISSING="$MISSING ecr_registry"
[ -z "$ECR_AWS_ACCESS_KEY_ID" ]     && MISSING="$MISSING access_key_id"
[ -z "$ECR_AWS_SECRET_ACCESS_KEY" ] && MISSING="$MISSING secret_access_key"
[ -z "$COORDINATOR_URL" ]           && MISSING="$MISSING coordinator_url"
[ -z "$JOB_AUTH_TOKEN" ]            && MISSING="$MISSING worker_token"
if [ -n "$MISSING" ]; then
  err "Pasted JSON is missing:$MISSING"
  exit 1
fi

info "Parsed sim bundle for region $ECR_REGION, registry $ECR_REGISTRY."
info "Coordinator: $COORDINATOR_URL"

# Node identity + parallelism. Default the node id to the hostname (the same
# default the sim server itself uses) so it's stable and human-recognisable on
# the Background jobs page. Leave max-concurrent blank to let the node pick
# cores-1 automatically.
DEFAULT_NODE_ID="$(hostname 2>/dev/null || echo sim-node)"
if [ "$BUNDLE_NONINTERACTIVE" = "1" ]; then
  # Scripted rollout: no prompts. Honor env overrides, else sane defaults.
  JOB_NODE_ID="${JOB_NODE_ID:-$DEFAULT_NODE_ID}"
  JOB_MAX_CONCURRENT="${JOB_MAX_CONCURRENT:-}"
  info "Node id: $JOB_NODE_ID (non-interactive)"
else
  JOB_NODE_ID=$(ask "Node id (shown on the Background jobs page)" "$DEFAULT_NODE_ID")
  # Optional: a positive integer, or BLANK for auto (cores-1). Read directly so
  # an empty answer is accepted — `ask` with an empty default treats blank as
  # "required" and would never let you move on. A non-numeric value (e.g. the
  # literal "cores-1") would serialize to null on the claim and be rejected.
  while :; do
    read -rp "Max concurrent jobs — a NUMBER, or just press Enter for auto: " JOB_MAX_CONCURRENT >&2 || true
    case "$JOB_MAX_CONCURRENT" in
      "")            break ;;                       # blank = auto (cores-1)
      *[!0-9]*|0)    echo "  enter a positive whole number (e.g. 5), or press Enter for auto" >&2 ;;
      *)             break ;;
    esac
  done
fi

# ---------- optional ECR credential validation -----------------------------

if [ "$HAS_AWS_CLI" = "1" ]; then
  echo "" >&2
  info "Validating ECR credentials..."
  while :; do
    if AWS_ACCESS_KEY_ID="$ECR_AWS_ACCESS_KEY_ID" \
       AWS_SECRET_ACCESS_KEY="$ECR_AWS_SECRET_ACCESS_KEY" \
       AWS_REGION="$ECR_REGION" \
       aws sts get-caller-identity >/dev/null 2>&1; then
      info "ECR credentials OK."
      break
    fi
    err "ECR credential validation failed."
    retry=$(ask "Re-enter ECR credentials? (yes/no)" "yes")
    if [ "$retry" != "yes" ]; then exit 1; fi
    ECR_AWS_ACCESS_KEY_ID=$(ask "ECR Access Key ID" "$ECR_AWS_ACCESS_KEY_ID")
    ECR_AWS_SECRET_ACCESS_KEY=$(ask_secret "ECR Secret Access Key")
  done
else
  info "aws-cli not installed — skipping credential validation."
fi

# ---------- write .env ------------------------------------------------------

umask 077
cat > .env <<EOF
# Generated by install-sim.sh on $(date -u +%Y-%m-%dT%H:%M:%SZ)

# Pin every bare \`docker compose\` call (including the updater sidecar's) to
# the sim stack + project.
COMPOSE_FILE=$COMPOSE_FILE_SIM

# Image source (multi-arch borzoi-backend manifest; the node pulls its arch).
ECR_REGISTRY=$ECR_REGISTRY
BACKEND_TAG=latest

# OTA updater sidecar — absolute host paths (compose interpolates these; the
# updater mounts the project at its real host path so relative bind mounts and
# the data/upgrade channel resolve identically inside and out).
INSTALL_DIR=$(pwd)
HOST_AWS_DIR=$HOME/.aws

# Coordinator (job queue) — outbound only.
COORDINATOR_URL=$COORDINATOR_URL
JOB_AUTH_TOKEN=$JOB_AUTH_TOKEN
JOB_NODE_ID=$JOB_NODE_ID
JOB_MAX_CONCURRENT=$JOB_MAX_CONCURRENT
EOF
chmod 600 .env
info ".env written (mode 600)."

# ---------- directories ----------------------------------------------------
# Shared OTA-upgrade channel between the sim container and the updater sidecar.

mkdir -p data/upgrade

# ---------- ECR credential helper ------------------------------------------
# Identical mechanism to the Hub setup.sh: ECR pull credentials live in a
# borzoi-specific AWS profile, invoked through a wrapper that pins
# AWS_PROFILE=borzoi-ecr so they never collide with the host's [default].

info "Writing ECR credentials to ~/.aws/credentials [borzoi-ecr] profile..."
mkdir -p "$HOME/.aws"
umask 077
touch "$HOME/.aws/credentials" "$HOME/.aws/config"
chmod 600 "$HOME/.aws/credentials" "$HOME/.aws/config"

# Remove any previous [borzoi-ecr] block, then append fresh values (awk
# in-place rewrite leaves other profiles intact).
for f in "$HOME/.aws/credentials" "$HOME/.aws/config"; do
  awk '
    BEGIN { skip = 0 }
    /^\[borzoi-ecr\][[:space:]]*$/ { skip = 1; next }
    /^\[/ && skip == 1 { skip = 0 }
    skip == 0 { print }
  ' "$f" > "$f.tmp" && mv "$f.tmp" "$f"
done

cat >> "$HOME/.aws/credentials" <<EOF
[borzoi-ecr]
aws_access_key_id = $ECR_AWS_ACCESS_KEY_ID
aws_secret_access_key = $ECR_AWS_SECRET_ACCESS_KEY
EOF

cat >> "$HOME/.aws/config" <<EOF
[profile borzoi-ecr]
region = $ECR_REGION
EOF

if ! command -v docker-credential-ecr-login >/dev/null 2>&1; then
  info "Installing amazon-ecr-credential-helper..."
  if command -v apt-get >/dev/null 2>&1; then
    sudo apt-get update
    sudo apt-get install -y amazon-ecr-credential-helper
  elif command -v dnf >/dev/null 2>&1; then
    # Amazon Linux 2023 / Fedora / RHEL 8+.
    sudo dnf install -y amazon-ecr-credential-helper
  elif command -v yum >/dev/null 2>&1; then
    # Amazon Linux 2 / older RHEL/CentOS.
    sudo yum install -y amazon-ecr-credential-helper
  else
    err "amazon-ecr-credential-helper not installed and no supported package"
    err "manager (apt-get / dnf / yum) found."
    err "Install manually: https://github.com/awslabs/amazon-ecr-credential-helper"
    exit 1
  fi
fi

info "Installing borzoi-ecr-login wrapper script..."
# Install to /usr/local/bin AND symlink into /usr/bin so docker finds it
# regardless of PATH. Explicit mode 0755 (umask 077 above would otherwise make
# `sudo tee` create it 0600 → docker "not in PATH").
sudo tee /usr/local/bin/docker-credential-borzoi-ecr-login >/dev/null <<'WRAPPER'
#!/bin/sh
# Pins AWS_PROFILE so the ECR credential helper uses the borzoi-specific
# profile in ~/.aws/credentials, not whatever [default] happens to be.
AWS_PROFILE=borzoi-ecr exec docker-credential-ecr-login "$@"
WRAPPER
sudo chmod 0755 /usr/local/bin/docker-credential-borzoi-ecr-login
sudo ln -sf /usr/local/bin/docker-credential-borzoi-ecr-login \
            /usr/bin/docker-credential-borzoi-ecr-login

if ! command -v docker-credential-borzoi-ecr-login >/dev/null 2>&1; then
  err "Wrapper not on PATH after install. PATH=$PATH"
  exit 1
fi
if ! command -v docker-credential-ecr-login >/dev/null 2>&1; then
  err "amazon-ecr-credential-helper is not installed correctly (docker-credential-ecr-login missing from PATH)."
  err "Reinstall it with your package manager and re-run, e.g.:"
  err "  apt-get install --reinstall amazon-ecr-credential-helper   (Debian/Ubuntu)"
  err "  dnf reinstall amazon-ecr-credential-helper                 (Amazon Linux 2023 / RHEL)"
  err "  yum reinstall amazon-ecr-credential-helper                 (Amazon Linux 2)"
  exit 1
fi

info "Configuring docker to use the borzoi ECR credential helper..."
mkdir -p "$HOME/.docker"
if [ -f "$HOME/.docker/config.json" ] && command -v jq >/dev/null 2>&1; then
  tmp=$(mktemp)
  jq --arg reg "$ECR_REGISTRY" '.credHelpers[$reg] = "borzoi-ecr-login"' \
     "$HOME/.docker/config.json" > "$tmp" && mv "$tmp" "$HOME/.docker/config.json"
else
  cat > "$HOME/.docker/config.json" <<EOF
{
  "credHelpers": {
    "$ECR_REGISTRY": "borzoi-ecr-login"
  }
}
EOF
fi
chmod 600 "$HOME/.docker/config.json"

# ---------- pull + up ------------------------------------------------------
# Explicit -f here (the updater's own bare calls rely on COMPOSE_FILE in .env).

info "Pulling sim image from ECR..."
docker compose -f "$COMPOSE_FILE_SIM" pull sim

info "Bringing the sim node up..."
docker compose -f "$COMPOSE_FILE_SIM" up -d

# ---------- done -----------------------------------------------------------

cat <<EOF

============================================================
Sim node is up.
  Node id:      $JOB_NODE_ID
  Coordinator:  $COORDINATOR_URL
  Compose:      $COMPOSE_FILE_SIM (sim + updater)

It should appear on the Voltini "Background jobs" page within a
minute and start claiming simulation jobs. OTA updates are
delivered from there (an 'update' job drains this node, then the
updater sidecar pulls the new image and restarts it).

  Logs:    docker compose -f $COMPOSE_FILE_SIM logs -f sim
  Status:  docker compose -f $COMPOSE_FILE_SIM ps
============================================================
EOF
