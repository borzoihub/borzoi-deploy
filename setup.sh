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
# - Prompts for environment-specific values (registry token, Cloudflare token)
# - Generates strong secrets for DB, JWT, and the bootstrap admin password
# - Writes a .env file (mode 0600)
# - Logs docker in to the image registry (read-only token)
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

# ---------- DNS resilience --------------------------------------------------
# dockerd uses the host's /etc/resolv.conf for registry pulls. When the
# customer's router DNS is slow or flaky, pulls fail mid-stream with
# "i/o timeout" on the router IP. Override DNS on all wifi+ethernet
# connection profiles to point at Cloudflare + Google public resolvers
# and ignore DHCP-provided DNS. The Hub talks only to loopback and to
# public services — it never needs to resolve LAN hostnames — so
# dropping the router's resolver has no functional cost.

DNS_V4="1.1.1.1 8.8.8.8"
DNS_V6="2606:4700:4700::1111 2001:4860:4860::8888"

if command -v nmcli >/dev/null 2>&1; then
  # Read connection names line-by-line so names with spaces (e.g. the
  # default Raspbian profile "Wired connection 1") survive intact.
  while IFS=: read -r conn type; do
    [ "$type" = "802-11-wireless" ] || [ "$type" = "802-3-ethernet" ] || continue
    CUR_V4=$(nmcli -t -f ipv4.dns connection show "$conn" 2>/dev/null | cut -d: -f2-)
    CUR_IGN=$(nmcli -t -f ipv4.ignore-auto-dns connection show "$conn" 2>/dev/null | cut -d: -f2)
    NORM_CUR=$(echo "$CUR_V4" | tr ',' ' ' | xargs)
    if [ "$NORM_CUR" = "1.1.1.1 8.8.8.8" ] && [ "$CUR_IGN" = "yes" ]; then
      info "DNS already configured on connection '$conn'."
      continue
    fi
    info "Setting DNS on connection '$conn' → $DNS_V4 (ignore router DNS)..."
    sudo nmcli connection modify "$conn" \
      ipv4.dns "$DNS_V4" \
      ipv4.ignore-auto-dns yes \
      ipv6.dns "$DNS_V6" \
      ipv6.ignore-auto-dns yes
    # Apply to the running device without dropping the connection
    # (avoids killing in-progress SSH sessions during install).
    DEV=$(nmcli -t -f NAME,DEVICE connection show --active 2>/dev/null | \
      awk -F: -v c="$conn" '$1==c{print $2; exit}')
    if [ -n "$DEV" ]; then
      sudo nmcli device reapply "$DEV" >/dev/null 2>&1 || true
    fi
    info "DNS configured on '$conn'."
  done < <(nmcli -t -f NAME,TYPE connection show)
else
  info "nmcli not available — skipping DNS override."
  info "If pulls fail with DNS timeouts, set /etc/resolv.conf to 1.1.1.1 manually."
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

# ---- Registry pull credential ----
# Images live in GitHub Container Registry. The Hub needs a read-only token to
# pull them and nothing else, so there is no credentials packet to paste any
# more — just the token.
echo "" >&2
echo "Registry pull token (GitHub classic PAT, scope: read:packages ONLY)." >&2
echo "Issued from the machine account by the operator; the same token serves" >&2
echo "every Hub and can be revoked centrally." >&2
echo "" >&2

REGISTRY="${REGISTRY:-ghcr.io/borzoihub}"
GHCR_USER=$(ask "Registry username (machine account)" "voltini-autobot")

GHCR_TOKEN=""
while [ -z "$GHCR_TOKEN" ]; do
  printf "Registry token (input hidden): " >&2
  stty -echo 2>/dev/null; read -r GHCR_TOKEN; stty echo 2>/dev/null; echo "" >&2
  [ -z "$GHCR_TOKEN" ] && err "Token cannot be empty."
done

# Verify now: a bad token here is far cheaper to diagnose than at the first pull.
info "Verifying registry credentials..."
if printf '%s' "$GHCR_TOKEN" | docker login "${REGISTRY%%/*}" -u "$GHCR_USER" --password-stdin >/dev/null 2>&1; then
  info "Registry login OK (${REGISTRY%%/*}). Stored in ~/.docker/config.json."
else
  err "docker login to ${REGISTRY%%/*} failed — check the username and token."
  exit 1
fi

# ---- No application AWS credentials ----
# There used to be five here (BORZOI_AWS_REGION / _ACCESS_KEY_ID /
# _SECRET_ACCESS_KEY / S3_BUCKET / SES_SENDER), written as
# "AKIA-unused-placeholder" and friends purely to satisfy the backend
# entrypoint's env-var gate. The S3/SES stack they described was removed from
# the backend on 2026-07-31, so the gate is gone and so are they.
#
# A Hub now holds NO long-lived AWS credential. The one thing that genuinely
# needs AWS — the nightly database backup — obtains short-lived, per-Hub STS
# credentials from central's broker using VOLTINI_HUB_SECRET, scoped to this
# installation's own S3 prefix. See docs/connection-key.md and
# voltini.energy-backend/docs/HUB_CREDENTIAL_BROKER.md.

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

# ---------- (no AWS credential validation) ----------------------------------
# A block here used to validate the app's AWS credentials with
# `aws sts get-caller-identity`. It had already been disabled behind `if false`
# because the credentials were placeholders; both are gone now, along with the
# credentials themselves. Brokered backup credentials are verified where they
# are used, not here.

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
REGISTRY=$REGISTRY
GHCR_USER=$GHCR_USER
GHCR_TOKEN=$GHCR_TOKEN
BACKEND_TAG=latest
FRONTEND_TAG=latest

# OTA updater sidecar — needs the install dir as an absolute host path
# (compose interpolates it; the updater mounts the project at its real host
# path so relative bind mounts resolve correctly). Nothing else is mounted in:
# the updater authenticates to the registry with GHCR_TOKEN from this .env.
INSTALL_DIR=$(pwd)

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

# ── Hub credential broker + cloud backup ───────────────────────────────────
# Written blank on purpose. docker-compose.yml interpolates all four whether or
# not the cloud-backup profile is active, and compose warns on an *undefined*
# variable — an empty one is fine. Declaring them here is what keeps every
# compose command quiet on a Hub that has not been issued a secret yet.
#
# Fill VOLTINI_HUB_SECRET / VOLTINI_INSTALLATION_ID with scripts/set-hub-secret.sh
# (never by hand — it derives the installation id from the secret and verifies
# against central before keeping either).
#
# These do NOT affect image pulls; that is GHCR_TOKEN above, always.
VOLTINI_HUB_SECRET=
VOLTINI_INSTALLATION_ID=
VOLTINI_BROKER_URL=https://api.voltini.energy/api/hub/credentials

# Cloud backup — inert until COMPOSE_PROFILES contains 'cloud-backup'.
COMPOSE_PROFILES=
BACKUP_S3_BUCKET=
BACKUP_AWS_REGION=eu-north-1
BACKUP_SCHEDULE=0 2 * * *
BACKUP_RETENTION_DAYS=14

EOF
chmod 600 .env
info ".env written (mode 600)."

# ---------- directories ----------------------------------------------------

mkdir -p data/postgres data/backups data/upgrade nginx/templates

# ---------- registry auth ---------------------------------------------------
# Nothing to do here. The `docker login` during the credential prompt above
# wrote ~/.docker/config.json, which persists across reboots. GHCR takes a
# plain bearer token, so there is no credential helper and no wrapper script —
# that file is the whole of the Hub's registry auth.

# ---------- pull + up ------------------------------------------------------

info "Pulling images..."
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
