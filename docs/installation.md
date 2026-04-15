# Installation guide (fresh Raspberry Pi)

End-to-end walkthrough from blank SD card to a working Borzoi login.

**Estimated time**: 30-45 minutes, most of it waiting.

## Prerequisites

**Hardware**:
- Raspberry Pi 4 or 5 (8GB RAM recommended, 4GB works)
- 32GB+ microSD card (A2 class, or better: SSD via USB 3)
- Power supply (official PSU recommended)
- Ethernet cable or Wi-Fi access
- A monitor + keyboard for first boot, OR SSH pre-configured on the card

**Credentials packet** (from [customer-onboarding.md](customer-onboarding.md)):
- ECR pull credentials (shared across installs)
- Bootstrap admin email

**Network**:
- Outbound internet access (for ECR pulls, Cloudflare Tunnel connector)
- **No port forwarding required** — the stack binds to `127.0.0.1:8080`
  and is exposed publicly through a Cloudflare Tunnel (see [cloudflare-tunnel.md](cloudflare-tunnel.md))

**Cloudflare Tunnel** (optional but recommended):
- A Zero Trust account (free tier is fine — https://one.dash.cloudflare.com)
- A tunnel created in Networks → Tunnels → Create, with its connector token
- A public hostname configured on that tunnel, pointing at `http://localhost:8080`

## Step 1 — Flash Raspberry Pi OS

1. Download **Raspberry Pi Imager** from https://www.raspberrypi.com/software/
2. Choose the Pi model.
3. Operating system: **Raspberry Pi OS Lite (64-bit)** — no desktop needed.
4. Storage: the SD card.
5. Click the gear icon (⚙) to pre-configure:
   - Hostname: `borzoi`
   - Enable SSH with password or key auth
   - Username + password (e.g. `borzoi` / something strong)
   - Wi-Fi credentials (if not using Ethernet)
   - Locale: set to the customer's timezone
6. Write the card, insert it into the Pi, and power on.

## Step 2 — First SSH connection

Find the Pi's IP (check your router's DHCP table or use `ping borzoi.local`):

```bash
ssh borzoi@<pi-ip>
```

Set a static IP or DHCP reservation in your router so the address doesn't change.

## Step 3 — Update the OS

```bash
sudo apt update
sudo apt full-upgrade -y
sudo reboot
```

Reconnect after the reboot.

## Step 4 — Install Docker + Docker Compose

Use the official Docker install script (includes Compose v2):

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER
newgrp docker    # or log out and back in
docker compose version    # should print v2.x.x
```

## Step 5 — Install the supporting tools

```bash
sudo apt install -y openssl git jq amazon-ecr-credential-helper awscli
```

- `openssl` — secret generation
- `git` — fetching borzoi-deploy
- `jq` — merging docker config (optional but nice)
- `amazon-ecr-credential-helper` — handles ECR token refresh transparently
- `awscli` — optional, used by setup.sh to validate credentials and auto-derive the ECR registry URL

**Note**: `amazon-ecr-credential-helper` is in Debian 12 (bookworm) and later. On older images, either:
- Upgrade the OS (recommended)
- Install from the GitHub release binary: https://github.com/awslabs/amazon-ecr-credential-helper/releases

## Step 6 — Create the install directory

```bash
sudo mkdir -p /opt/borzoi
sudo chown $USER:$USER /opt/borzoi
```

## Step 7 — Clone the deploy bundle

```bash
git clone --depth 1 https://github.com/borzoihub/borzoi-deploy.git /opt/borzoi
cd /opt/borzoi
```

Replace the URL with wherever your `borzoi-deploy` repo lives. If public, no auth needed. If private, use HTTPS with a token or SSH with a deploy key.

## Step 8 — Run `setup.sh`

```bash
cd /opt/borzoi
./setup.sh
```

### Running setup.sh

You'll be prompted for the following, in order:

| Prompt | What to enter | From credentials packet |
|---|---|---|
| `ECR region` | e.g. `eu-north-1` | yes |
| `ECR Access Key ID` | shared installer access key | yes |
| `ECR Secret Access Key` | shared installer secret | yes (hidden) |
| `ECR registry URL` | auto-derived if aws-cli is installed; else e.g. `123456789012.dkr.ecr.eu-north-1.amazonaws.com` | derived or manual |
| `Bootstrap admin email` | e.g. `admin@acme.example` | yes |
| `Cloudflare Tunnel token` | from Cloudflare Zero Trust dashboard; leave empty to configure later | yes or skip |

> **Note on AWS app credentials**: the backend has code paths for S3
> (file uploads) and SES (account emails) but they are not used by the
> product today. `setup.sh` writes placeholder values to `.env` to
> satisfy the entrypoint's env-var check. If those features get wired
> in later, edit `.env` with real AWS credentials and restart the
> backend.

What happens after the prompts:

1. **Credential validation** — if `aws-cli` is installed, the ECR creds are tested with `sts get-caller-identity`. If validation fails, you can re-enter.
2. **Secret generation** — DB password (32 chars), JWT secret (48 chars), bootstrap admin password (24 chars) are auto-generated.
3. **.env written** to `/opt/borzoi/.env`, mode 600.
4. **Directories created** — `data/postgres`, `certbot/conf`, `certbot/www`, `nginx/templates`.
5. **AWS profile installed** — ECR creds written to `~/.aws/credentials` under `[borzoi-ecr]`. Any existing AWS profiles are preserved.
6. **ECR credential helper wired up** — a wrapper at `/usr/local/bin/docker-credential-borzoi-ecr-login` is installed (requires sudo), and `~/.docker/config.json` is configured to use it.
7. **Images pulled** — `docker compose pull`.
8. **Stack brought up** — `docker compose up -d`. Binds to `127.0.0.1:8080`.
9. **Cloudflare Tunnel enrolled** (if a token was provided) — installs `cloudflared` via apt, runs `cloudflared service install <token>`, starts as a systemd service.

At the end, the admin credentials are printed **once**:

```
============================================================
Borzoi admin login (save this — shown only once):
  URL:      https://borzoi.acme.example
  Email:    admin@acme.example
  Password: aB3-Kf9s-VxLm-...
============================================================
```

Copy this to a password manager immediately. It is not stored anywhere retrievable.

## Step 9 — First login

Through the Cloudflare Tunnel (if configured during setup.sh), visit the public hostname you set up in the Zero Trust dashboard. Cloudflare terminates HTTPS and forwards to `http://localhost:8080` on the Pi.

Without Cloudflare Tunnel, SSH-port-forward to test:

```bash
# From your laptop:
ssh -L 8080:localhost:8080 borzoi@<pi-ip>
# Then browse to http://localhost:8080 on your laptop
```

1. Log in with the bootstrap admin email + password.
2. You should reach the main dashboard.
3. The backend logs (`docker compose logs backend -f`) will show "waiting for required settings" messages every 60s — this is expected until you fill in the installation settings.

## Step 10 — Configure the installation

Via the Borzoi UI, enter:
- Installation settings (latitude, longitude, solar sections)
- Battery settings (capacity, charge limits)
- Heating settings (max/min flow temp, curve parameters)
- Spot price settings (tariff, pricing area)
- EV charging settings (if applicable)
- Device configuration (map smart-meter, inverter, EV charger, heat pump to the discovered Homey / HA / SmartThings devices)

Within 60 seconds of saving the last required setting, the scheduler, flow-temp regulator, and ingestion services activate automatically. No restart required. The "waiting for required settings" log messages stop.

## Step 11 — Verify

```bash
cd /opt/borzoi
docker compose ps           # all services should be "Up" or "Exited" (frontend is a one-shot)
docker compose logs -f backend    # look for scheduler ticks, no more "waiting"
```

Check that actual device metrics are coming in (settings → insights → devices in the UI).

## Done

The stack restarts automatically on Pi reboot (`restart: unless-stopped`). The frontend one-shot re-runs on every `docker compose up` to refresh the static volume.

Next: [updating.md](updating.md), [troubleshooting.md](troubleshooting.md).
