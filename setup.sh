#!/usr/bin/env bash
set -euo pipefail

# ============================================================================
# Borzoi deploy setup — interactive, first-boot orchestration.
#
# The stack binds to http://localhost:8080 on the host. Public access is
# expected to come through a Cloudflare Tunnel (or any reverse proxy
# the operator puts in front). Setup optionally installs + enrolls
# cloudflared with a tunnel token.
#
# - Prompts for environment-specific values (ECR creds, Cloudflare token)
# - Generates strong secrets for DB, JWT, and the bootstrap admin password
# - Writes a .env file (mode 0600)
# - Installs amazon-ecr-credential-helper and configures docker to use it
# - Optionally installs cloudflared and enrolls a Zero Trust tunnel
# - Pulls images and brings the stack up
# - Prints the admin login ONCE at the end — not stored anywhere else
# ============================================================================

# ---------- helpers ---------------------------------------------------------

err() { echo "ERROR: $*" >&2; }
info() { echo "$*"; }

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    err "required command not found: $1"
    exit 1
  fi
}

# Generate a URL-safe secret of length $1.
gen_secret() {
  local len="$1"
  # openssl base64 can include =+/; strip those and newlines, then truncate.
  openssl rand -base64 $((len * 2)) | tr -d '\n=+/' | cut -c1-"$len"
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

# ---------- preflight -------------------------------------------------------

require_cmd docker
require_cmd openssl

# Require docker compose v2 (plugin form: `docker compose`).
if ! docker compose version >/dev/null 2>&1; then
  err "docker compose v2 not available (need the 'docker compose' plugin, not docker-compose v1)"
  exit 1
fi

HAS_AWS_CLI=0
if command -v aws >/dev/null 2>&1; then
  HAS_AWS_CLI=1
fi

cd "$(dirname "$0")"

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

# ---------- prompts ---------------------------------------------------------

echo "" >&2
echo "Borzoi setup — please answer the following prompts." >&2
echo "" >&2

# The stack always binds to http://localhost:8080 on the host. Public
# access comes through a Cloudflare Tunnel (or another reverse proxy).
# These defaults can be overridden after install by editing .env; needed
# only when SES/email features are enabled and links in outbound mail
# must point at a real public URL.
BORZOI_DOMAIN="localhost"
BORZOI_BASE_URL="http://localhost:8080"

# ---- ECR pull credentials (paste the JSON the operator generated) ----
echo "" >&2
echo "Paste the installer credentials JSON (produced by scripts/aws-setup.sh" >&2
echo "on the operator machine). End the paste with Ctrl-D on a blank line." >&2
echo "" >&2
echo "Shape expected (values will differ):" >&2
echo "  {" >&2
echo "    \"ecr_region\":        \"eu-north-1\"," >&2
echo "    \"ecr_registry\":      \"<account>.dkr.ecr.<region>.amazonaws.com\"," >&2
echo "    \"access_key_id\":     \"AKIA...\"," >&2
echo "    \"secret_access_key\": \"...\"" >&2
echo "  }" >&2
echo "" >&2
echo "(Paste now, then Ctrl-D):" >&2

CREDS_JSON=$(cat)

if [ -z "$CREDS_JSON" ]; then
  err "Empty input. Paste the JSON from aws-setup.sh and try again."
  exit 1
fi

# Minimal JSON field extractor — avoids a hard dependency on jq.
# Handles the simple flat structure aws-setup.sh emits (no nesting, no arrays).
extract_json_field() {
  local field="$1" input="$2"
  # Match   "field": "value"   with flexible whitespace; unescapes basic \" only.
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

ECR_REGION=$(extract_json_field "ecr_region" "$CREDS_JSON")
ECR_REGISTRY=$(extract_json_field "ecr_registry" "$CREDS_JSON")
ECR_AWS_ACCESS_KEY_ID=$(extract_json_field "access_key_id" "$CREDS_JSON")
ECR_AWS_SECRET_ACCESS_KEY=$(extract_json_field "secret_access_key" "$CREDS_JSON")

MISSING=""
[ -z "$ECR_REGION" ]              && MISSING="$MISSING ecr_region"
[ -z "$ECR_REGISTRY" ]            && MISSING="$MISSING ecr_registry"
[ -z "$ECR_AWS_ACCESS_KEY_ID" ]   && MISSING="$MISSING access_key_id"
[ -z "$ECR_AWS_SECRET_ACCESS_KEY" ] && MISSING="$MISSING secret_access_key"
if [ -n "$MISSING" ]; then
  err "Pasted JSON is missing:$MISSING"
  exit 1
fi

info "Parsed ECR credentials for region $ECR_REGION, registry $ECR_REGISTRY."

# ---- Application AWS credentials (S3 + SES) ----
# The backend has code paths for S3 (file uploads) and SES (account
# emails) but they are currently unused in the product. Placeholders
# satisfy the entrypoint's env-var validation; the backend never
# actually authenticates against AWS with these. When/if S3 or SES
# features get wired into the product, edit .env with real creds and
# restart the backend.
AWS_REGION="${AWS_REGION:-eu-north-1}"
AWS_ACCESS_KEY_ID="AKIA-unused-placeholder"
AWS_SECRET_ACCESS_KEY="unused-placeholder-secret"
S3_BUCKET="borzoi-unused"
SES_SENDER="no-reply@$BORZOI_DOMAIN"

BORZOI_ADMIN_EMAIL=$(ask "Bootstrap admin email" "")

# ---- Cloudflare Tunnel (optional) ----
echo "" >&2
echo "Cloudflare Tunnel exposes this Pi at a public URL via Cloudflare's" >&2
echo "edge (no port forwarding, no direct public IP). Create the tunnel" >&2
echo "in the Zero Trust dashboard (https://one.dash.cloudflare.com → Networks" >&2
echo "→ Tunnels → Create)." >&2
echo "" >&2
echo "Paste EITHER the full command Cloudflare shows you (starts with" >&2
echo "'sudo cloudflared service install eyJ...') OR just the eyJ... token." >&2
echo "Either works — we extract the token automatically." >&2
echo "" >&2
echo "Configure the public hostname → http://localhost:8080 in the same UI." >&2
echo "Leave blank to skip — you can run this step later from the docs." >&2
echo "" >&2
read -rp "Cloudflare Tunnel token (or command, or empty to skip): " CLOUDFLARE_TUNNEL_INPUT >&2 || true

# Extract the token. Cloudflare tokens are base64-encoded JSON so they
# always start with 'eyJ' (the encoded '{"') and contain only URL-safe
# base64 characters. This regex finds that pattern wherever it sits in
# what the user pasted.
if [ -n "${CLOUDFLARE_TUNNEL_INPUT:-}" ]; then
  CLOUDFLARE_TUNNEL_TOKEN=$(printf '%s' "$CLOUDFLARE_TUNNEL_INPUT" | \
    grep -oE 'eyJ[A-Za-z0-9+/=_-]+' | head -1 || true)
  if [ -z "$CLOUDFLARE_TUNNEL_TOKEN" ]; then
    err "Could not find a Cloudflare token (expected to start with 'eyJ') in the pasted input."
    err "Paste either the full 'sudo cloudflared service install <token>' command"
    err "or just the token itself."
    exit 1
  fi
else
  CLOUDFLARE_TUNNEL_TOKEN=""
fi

# ---------- optional AWS validation ----------------------------------------

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

  # App AWS creds are placeholders — skip validation. Re-enable if/when
  # S3 or SES features become active in the product.
  if false; then
  info "Validating app AWS credentials..."
  while :; do
    if AWS_ACCESS_KEY_ID="$AWS_ACCESS_KEY_ID" \
       AWS_SECRET_ACCESS_KEY="$AWS_SECRET_ACCESS_KEY" \
       AWS_REGION="$AWS_REGION" \
       aws sts get-caller-identity >/dev/null 2>&1; then
      info "App AWS credentials OK."
      break
    fi
    err "App AWS credential validation failed."
    retry=$(ask "Re-enter app credentials? (yes/no)" "yes")
    if [ "$retry" != "yes" ]; then exit 1; fi
    AWS_ACCESS_KEY_ID=$(ask "App AWS Access Key ID" "$AWS_ACCESS_KEY_ID")
    AWS_SECRET_ACCESS_KEY=$(ask_secret "App AWS Secret Access Key")
  done
  fi
else
  info "aws-cli not installed — skipping credential validation."
fi

# ---------- generate secrets ------------------------------------------------

DB_PASSWORD=$(gen_secret 32)
JWT_SECRET=$(gen_secret 48)
BORZOI_ADMIN_PASSWORD=$(gen_secret 24)

# ---------- write .env ------------------------------------------------------

umask 077
cat > .env <<EOF
# Generated by setup.sh on $(date -u +%Y-%m-%dT%H:%M:%SZ)
# DO NOT edit DB_PASSWORD after first boot — postgres only reads it on
# initial cluster init. Rotating requires manual ALTER USER + this file.

# Image source
ECR_REGISTRY=$ECR_REGISTRY
BACKEND_TAG=latest
FRONTEND_TAG=latest

# Public URL / domain
BORZOI_DOMAIN=$BORZOI_DOMAIN
BORZOI_BASE_URL=$BORZOI_BASE_URL

# Database
DB_HOST=postgres
DB_PORT=5432
DB_NAME=borzoi
DB_USER=borzoi
DB_PASSWORD=$DB_PASSWORD

# Auth
JWT_SECRET=$JWT_SECRET

# Bootstrap admin (created on first boot only)
BORZOI_ADMIN_EMAIL=$BORZOI_ADMIN_EMAIL
BORZOI_ADMIN_PASSWORD=$BORZOI_ADMIN_PASSWORD

# AWS credentials (S3 + SES)
AWS_REGION=$AWS_REGION
AWS_ACCESS_KEY_ID=$AWS_ACCESS_KEY_ID
AWS_SECRET_ACCESS_KEY=$AWS_SECRET_ACCESS_KEY
S3_BUCKET=$S3_BUCKET
SES_SENDER=$SES_SENDER

# Allow typeorm synchronize in Production (required for self-hosted first
# install without an initial-schema migration). SaaS production does NOT
# set this.
BORZOI_ALLOW_SYNC_IN_PROD=true
EOF
chmod 600 .env
info ".env written (mode 600)."

# ---------- directories ----------------------------------------------------

mkdir -p data/postgres certbot/conf certbot/www nginx/templates

# ---------- ECR credential helper -----------------------------------------
# Two-profile setup: the ECR pull credentials live in a borzoi-specific
# AWS profile (so they don't collide with anything else on the host); the
# helper is invoked through a wrapper that pins AWS_PROFILE=borzoi-ecr.
# The application's AWS credentials are never touched by docker — they
# only live in .env and reach the backend via env_file.

info "Writing ECR credentials to ~/.aws/credentials [borzoi-ecr] profile..."
mkdir -p "$HOME/.aws"
umask 077
touch "$HOME/.aws/credentials" "$HOME/.aws/config"
chmod 600 "$HOME/.aws/credentials" "$HOME/.aws/config"

# Remove any previous [borzoi-ecr] block, then append fresh values.
# Use awk for an in-place rewrite that leaves other profiles intact.
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
  else
    err "amazon-ecr-credential-helper not installed and apt-get unavailable."
    err "Install manually: https://github.com/awslabs/amazon-ecr-credential-helper"
    exit 1
  fi
fi

info "Installing borzoi-ecr-login wrapper script..."
# Install to /usr/local/bin (FHS convention for admin scripts) AND
# symlink into /usr/bin so docker can always find it regardless of the
# shell's PATH (non-login SSH sessions, systemd-spawned contexts, etc.
# sometimes miss /usr/local/bin).
#
# We use an explicit mode 0755 (not chmod +x) because the umask 077 set
# earlier in this script for .env propagates through `sudo tee`, which
# would otherwise create the file as 0600 — making it unreadable/
# unexecutable by the docker user and producing a misleading "not in
# PATH" error from docker.
sudo tee /usr/local/bin/docker-credential-borzoi-ecr-login >/dev/null <<'WRAPPER'
#!/bin/sh
# Pins AWS_PROFILE so the ECR credential helper uses the borzoi-specific
# profile in ~/.aws/credentials, not whatever [default] happens to be.
AWS_PROFILE=borzoi-ecr exec docker-credential-ecr-login "$@"
WRAPPER
sudo chmod 0755 /usr/local/bin/docker-credential-borzoi-ecr-login
sudo ln -sf /usr/local/bin/docker-credential-borzoi-ecr-login \
            /usr/bin/docker-credential-borzoi-ecr-login

# Verify both the wrapper and the underlying helper resolve before we
# try `docker compose pull` — otherwise the pull failure is opaque.
if ! command -v docker-credential-borzoi-ecr-login >/dev/null 2>&1; then
  err "Wrapper not on PATH after install. PATH=$PATH"
  err "Expected at /usr/local/bin/docker-credential-borzoi-ecr-login and /usr/bin/..."
  ls -la /usr/local/bin/docker-credential-borzoi-ecr-login \
         /usr/bin/docker-credential-borzoi-ecr-login 2>&1 >&2 || true
  exit 1
fi
if ! command -v docker-credential-ecr-login >/dev/null 2>&1; then
  err "amazon-ecr-credential-helper is not installed correctly (docker-credential-ecr-login missing from PATH)."
  err "Try: sudo apt-get install --reinstall amazon-ecr-credential-helper"
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

info "Pulling images from ECR..."
docker compose pull

info "Bringing stack up..."
docker compose up -d

# ---------- Cloudflare Tunnel (optional) -----------------------------------

if [ -n "${CLOUDFLARE_TUNNEL_TOKEN:-}" ]; then
  if ! command -v cloudflared >/dev/null 2>&1; then
    info "Installing cloudflared from Cloudflare's apt repo..."
    sudo mkdir -p --mode=0755 /usr/share/keyrings
    curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | \
      sudo tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null
    echo 'deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main' | \
      sudo tee /etc/apt/sources.list.d/cloudflared.list >/dev/null
    sudo apt-get update
    sudo apt-get install -y cloudflared
  fi

  info "Enrolling cloudflared as a systemd service..."
  # `cloudflared service install <TOKEN>` registers + starts a systemd unit
  # that runs the connector with the provided tunnel token. Idempotent:
  # uninstall first if already present to pick up a new token.
  if systemctl list-unit-files cloudflared.service >/dev/null 2>&1; then
    sudo cloudflared service uninstall || true
  fi
  sudo cloudflared service install "$CLOUDFLARE_TUNNEL_TOKEN"
  info "cloudflared running. Configure the public hostname → http://localhost:8080"
  info "in the Cloudflare Zero Trust dashboard."
else
  info "Cloudflare Tunnel skipped. The stack is reachable at http://localhost:8080"
  info "from the Pi itself; run 'cloudflared service install <token>' later"
  info "to expose it publicly."
fi

# ---------- admin credentials banner ---------------------------------------

cat <<EOF

============================================================
Borzoi admin login (save this — shown only once):
  URL:      $BORZOI_BASE_URL
  Email:    $BORZOI_ADMIN_EMAIL
  Password: $BORZOI_ADMIN_PASSWORD
============================================================
EOF
