#!/usr/bin/env bash
set -euo pipefail

# ============================================================================
# Borzoi deploy setup — interactive, first-boot orchestration.
#
# - Prompts for environment-specific values (domain, AWS creds)
# - Generates strong secrets for DB, JWT, and the bootstrap admin password
# - Writes a .env file (mode 0600)
# - Creates data / certbot / nginx directories
# - Installs amazon-ecr-credential-helper and configures docker to use it
#   so ECR auth tokens auto-refresh (no PATs, no expiring logins)
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

BORZOI_DOMAIN=$(ask "Public domain (e.g. borzoi.example.com)" "")
BORZOI_BASE_URL=$(ask "Public base URL" "https://$BORZOI_DOMAIN")

# ---- ECR pull credentials (installer-shared, distinct from app creds) ----
echo "" >&2
echo "ECR pull credentials — used only by docker on this host to pull images." >&2
echo "These are separate from the application's AWS credentials below." >&2
echo "" >&2
ECR_REGION=$(ask "ECR region" "eu-north-1")
ECR_AWS_ACCESS_KEY_ID=$(ask "ECR Access Key ID" "")
ECR_AWS_SECRET_ACCESS_KEY=$(ask_secret "ECR Secret Access Key")

# Derive registry URL from the ECR account if aws-cli is available.
ECR_REGISTRY_DEFAULT=""
if [ "$HAS_AWS_CLI" = "1" ]; then
  ECR_ACCOUNT_ID=$(AWS_ACCESS_KEY_ID="$ECR_AWS_ACCESS_KEY_ID" \
                   AWS_SECRET_ACCESS_KEY="$ECR_AWS_SECRET_ACCESS_KEY" \
                   AWS_REGION="$ECR_REGION" \
                   aws sts get-caller-identity --query Account --output text 2>/dev/null || true)
  if [ -n "$ECR_ACCOUNT_ID" ]; then
    ECR_REGISTRY_DEFAULT="${ECR_ACCOUNT_ID}.dkr.ecr.${ECR_REGION}.amazonaws.com"
  fi
fi
ECR_REGISTRY=$(ask "ECR registry URL" "$ECR_REGISTRY_DEFAULT")

# ---- Application AWS credentials (S3 + SES, customer-specific) ----
echo "" >&2
echo "Application AWS credentials — used by the backend container for S3" >&2
echo "(file storage) and SES (outbound email). Distinct from the ECR pull" >&2
echo "credentials above." >&2
echo "" >&2
AWS_REGION=$(ask "App AWS region" "eu-north-1")
AWS_ACCESS_KEY_ID=$(ask "App AWS Access Key ID" "")
AWS_SECRET_ACCESS_KEY=$(ask_secret "App AWS Secret Access Key")
S3_BUCKET=$(ask "S3 bucket (for file storage)" "")
SES_SENDER=$(ask "SES sender address" "no-reply@$BORZOI_DOMAIN")

BORZOI_ADMIN_EMAIL=$(ask "Bootstrap admin email" "")

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
sudo tee /usr/local/bin/docker-credential-borzoi-ecr-login >/dev/null <<'WRAPPER'
#!/bin/sh
# Pins AWS_PROFILE so the ECR credential helper uses the borzoi-specific
# profile in ~/.aws/credentials, not whatever [default] happens to be.
AWS_PROFILE=borzoi-ecr exec docker-credential-ecr-login "$@"
WRAPPER
sudo chmod +x /usr/local/bin/docker-credential-borzoi-ecr-login

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

# ---------- admin credentials banner ---------------------------------------

cat <<EOF

============================================================
Borzoi admin login (save this — shown only once):
  URL:      $BORZOI_BASE_URL
  Email:    $BORZOI_ADMIN_EMAIL
  Password: $BORZOI_ADMIN_PASSWORD
============================================================
EOF
