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

# ---------- filesystem expansion (SD card) ----------------------------------
# SD card images are often smaller than the physical card. Offer to expand
# the root partition to use all available space.

ROOT_DEV=$(findmnt -n -o SOURCE /)
ROOT_DISK=$(lsblk -no PKNAME "$ROOT_DEV" 2>/dev/null || true)

if [ -n "$ROOT_DISK" ]; then
  DISK_SIZE=$(lsblk -bno SIZE "/dev/$ROOT_DISK" | head -1)
  PART_SIZE=$(lsblk -bno SIZE "$ROOT_DEV" | head -1)

  if [ -n "$DISK_SIZE" ] && [ -n "$PART_SIZE" ]; then
    DISK_GB=$(awk "BEGIN { printf \"%.0f\", $DISK_SIZE / 1073741824 }")
    PART_GB=$(awk "BEGIN { printf \"%.0f\", $PART_SIZE / 1073741824 }")
    UNUSED_GB=$(awk "BEGIN { printf \"%.0f\", ($DISK_SIZE - $PART_SIZE) / 1073741824 }")

    if [ "$UNUSED_GB" -gt 1 ]; then
      echo "" >&2
      echo "The root filesystem uses ${PART_GB}GB of a ${DISK_GB}GB disk" >&2
      echo "(${UNUSED_GB}GB unused)." >&2
      expand=$(ask "Expand filesystem to use the full disk? (yes/no)" "yes")
      if [ "$expand" = "yes" ]; then
        PART_NUM=$(echo "$ROOT_DEV" | grep -o '[0-9]*$')
        info "Expanding partition ${ROOT_DISK}p${PART_NUM}..."
        if command -v growpart >/dev/null 2>&1; then
          sudo growpart "/dev/$ROOT_DISK" "$PART_NUM"
        else
          info "Installing growpart..."
          sudo apt-get update && sudo apt-get install -y cloud-guest-utils
          sudo growpart "/dev/$ROOT_DISK" "$PART_NUM"
        fi
        sudo resize2fs "$ROOT_DEV"
        NEW_SIZE=$(df -h / | awk 'NR==2 {print $2}')
        info "Filesystem expanded to $NEW_SIZE."
      fi
    fi
  fi
fi

# ---------- WiFi power-save off --------------------------------------------
# WiFi power save causes the Pi to miss inbound packets (ARP, TCP) when
# idle, making the Cloudflare tunnel and LAN access unreliable. Disable it
# permanently via NetworkManager (default on Raspbian Bookworm+).

if command -v nmcli >/dev/null 2>&1; then
  WIFI_CON=$(nmcli -t -f NAME,TYPE connection show | awk -F: '$2=="802-11-wireless"{print $1; exit}')
  if [ -n "$WIFI_CON" ]; then
    CURRENT_PS=$(nmcli -t -f 802-11-wireless.powersave connection show "$WIFI_CON" 2>/dev/null | cut -d: -f2)
    if [ "$CURRENT_PS" != "2" ]; then
      info "Disabling WiFi power save for connection '$WIFI_CON'..."
      sudo nmcli connection modify "$WIFI_CON" 802-11-wireless.powersave 2
      sudo nmcli connection down "$WIFI_CON" && sudo nmcli connection up "$WIFI_CON"
      info "WiFi power save disabled."
    else
      info "WiFi power save already disabled."
    fi
  else
    info "No WiFi connection found in NetworkManager — skipping power-save config."
  fi
else
  # Fallback: create a systemd oneshot that disables power save at boot.
  if iw wlan0 get power_save 2>/dev/null | grep -q "on"; then
    info "Disabling WiFi power save via systemd service..."
    sudo tee /etc/systemd/system/wifi-powersave-off.service >/dev/null <<'UNIT'
[Unit]
Description=Disable WiFi power save
After=network.target

[Service]
Type=oneshot
ExecStart=/usr/sbin/iw wlan0 set power_save off
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
UNIT
    sudo systemctl enable --now wifi-powersave-off.service
    info "WiFi power save disabled (systemd service installed)."
  fi
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

# If tunnel token provided, optionally configure routes + DNS via API.
CF_API_TOKEN=""
CF_HOSTNAME=""
if [ -n "${CLOUDFLARE_TUNNEL_TOKEN:-}" ]; then
  echo "" >&2
  echo "To automatically configure tunnel routes (HTTP + SSH) and DNS records," >&2
  echo "provide a Cloudflare API token with 'Cloudflare Tunnel:Edit' and" >&2
  echo "'DNS:Edit' permissions. Leave blank to configure manually in the" >&2
  echo "Zero Trust dashboard." >&2
  echo "" >&2
  read -rp "Cloudflare API token (or empty to skip): " CF_API_TOKEN >&2 || true

  if [ -n "${CF_API_TOKEN:-}" ]; then
    CF_HOSTNAME=$(ask "Public hostname for this Hub (e.g. pilot1.voltini.cloud)" "")
  fi
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

# App AWS credentials (S3 + SES) — prefixed BORZOI_ to avoid colliding
# with the standard AWS_* env vars used by the ECR credential helper.
BORZOI_AWS_REGION=$AWS_REGION
BORZOI_AWS_ACCESS_KEY_ID=$AWS_ACCESS_KEY_ID
BORZOI_AWS_SECRET_ACCESS_KEY=$AWS_SECRET_ACCESS_KEY
S3_BUCKET=$S3_BUCKET
SES_SENDER=$SES_SENDER

EOF
chmod 600 .env
info ".env written (mode 600)."

# ---------- directories ----------------------------------------------------

mkdir -p data/postgres data/backups nginx/templates

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

# ---------- nightly database backup cron -----------------------------------

BACKUP_SCRIPT="$(pwd)/scripts/db-backup.sh"
CRON_SCHEDULE="0 2 * * *"
CRON_LINE="$CRON_SCHEDULE cd $(pwd) && . .env && $BACKUP_SCRIPT >> data/backups/backup.log 2>&1"

# Install (or replace) the cron entry — idempotent.
( crontab -l 2>/dev/null | grep -v "db-backup.sh" || true
  echo "$CRON_LINE"
) | crontab -
info "Nightly database backup cron installed (02:00)."

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
  info "cloudflared running."

  # ---- Configure tunnel ingress + DNS via Cloudflare API (optional) ----
  if [ -n "${CF_API_TOKEN:-}" ] && [ -n "${CF_HOSTNAME:-}" ]; then
    CF_SSH_HOSTNAME="ssh-${CF_HOSTNAME}"

    # Decode the tunnel token (URL-safe base64 JSON: {"a":"account","t":"tunnel","s":"secret"})
    TUNNEL_JSON=$(printf '%s' "$CLOUDFLARE_TUNNEL_TOKEN" | \
      awk '{
        gsub(/-/, "+"); gsub(/_/, "/")
        mod = length($0) % 4
        if (mod == 2) $0 = $0 "=="
        else if (mod == 3) $0 = $0 "="
        print
      }' | base64 -d 2>/dev/null || true)
    CF_ACCOUNT_ID=$(extract_json_field "a" "$TUNNEL_JSON")
    CF_TUNNEL_ID=$(extract_json_field "t" "$TUNNEL_JSON")

    if [ -z "$CF_ACCOUNT_ID" ] || [ -z "$CF_TUNNEL_ID" ]; then
      err "Could not extract account/tunnel ID from tunnel token."
      err "Configure tunnel routes manually in the Cloudflare dashboard."
    else
      # Configure tunnel ingress: HTTP + SSH + catch-all
      info "Configuring tunnel routes: $CF_HOSTNAME → http, $CF_SSH_HOSTNAME → ssh..."
      INGRESS_RESP=$(curl -sS -X PUT \
        "https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/cfd_tunnel/${CF_TUNNEL_ID}/configurations" \
        -H "Authorization: Bearer ${CF_API_TOKEN}" \
        -H "Content-Type: application/json" \
        -d "{
          \"config\": {
            \"ingress\": [
              {\"hostname\": \"${CF_HOSTNAME}\", \"service\": \"http://localhost:8080\"},
              {\"hostname\": \"${CF_SSH_HOSTNAME}\", \"service\": \"ssh://127.0.0.1:22\"},
              {\"service\": \"http_status:404\"}
            ]
          }
        }" 2>&1)

      if printf '%s' "$INGRESS_RESP" | grep -q '"success":true'; then
        info "Tunnel ingress configured."
      else
        err "Failed to configure tunnel ingress:"
        err "$INGRESS_RESP"
        err "Configure manually in the Cloudflare dashboard."
      fi

      # Create DNS CNAME records pointing to the tunnel
      CF_ZONE=$(printf '%s' "$CF_HOSTNAME" | awk -F. '{print $(NF-1)"."$NF}')
      info "Looking up zone ID for $CF_ZONE..."
      ZONE_RESP=$(curl -sS \
        "https://api.cloudflare.com/client/v4/zones?name=${CF_ZONE}" \
        -H "Authorization: Bearer ${CF_API_TOKEN}" 2>&1)
      CF_ZONE_ID=$(printf '%s' "$ZONE_RESP" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)

      if [ -n "$CF_ZONE_ID" ]; then
        TUNNEL_CNAME="${CF_TUNNEL_ID}.cfargotunnel.com"
        for hn in "$CF_HOSTNAME" "$CF_SSH_HOSTNAME"; do
          info "Creating DNS CNAME: $hn → $TUNNEL_CNAME..."
          DNS_RESP=$(curl -sS -X POST \
            "https://api.cloudflare.com/client/v4/zones/${CF_ZONE_ID}/dns_records" \
            -H "Authorization: Bearer ${CF_API_TOKEN}" \
            -H "Content-Type: application/json" \
            -d "{
              \"type\": \"CNAME\",
              \"name\": \"${hn}\",
              \"content\": \"${TUNNEL_CNAME}\",
              \"proxied\": true
            }" 2>&1)
          if printf '%s' "$DNS_RESP" | grep -q '"success":true'; then
            info "DNS record created: $hn"
          else
            err "DNS record for $hn may already exist or failed. Check the dashboard."
          fi
        done
      else
        err "Could not find zone ID for $CF_ZONE. Create DNS records manually."
      fi
    fi
  else
    info "Configure the public hostname → http://localhost:8080"
    info "in the Cloudflare Zero Trust dashboard."
  fi
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
