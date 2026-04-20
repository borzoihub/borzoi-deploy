# Cloudflare Tunnel

The default deployment model. The Pi binds only to `127.0.0.1:8080`, and Cloudflare Tunnel forwards public traffic from a Cloudflare-hosted hostname through an outbound connection that `cloudflared` maintains. No port forwarding, no public IP, no local TLS — Cloudflare handles HTTPS at its edge.

## Hostname convention

All installations live under `voltini.cloud` with the pattern:

```
<installation-id>.voltini.cloud
```

The `<installation-id>` is a short, URL-safe identifier chosen during onboarding — typically the customer name or site name (e.g. `joakim.voltini.cloud`, `forsmark.voltini.cloud`). The `voltini.cloud` domain is used exclusively for installations, so there is no risk of collisions with infrastructure subdomains.

## Why this model

- **Firewall-safe**: the Pi makes outbound connections to Cloudflare; nothing listens on the public internet from your side.
- **No TLS plumbing on the Pi**: Cloudflare terminates TLS. Certbot/Let's Encrypt on the Pi is unnecessary.
- **Revocable per install**: the connector token is scoped to one tunnel. Revoke the tunnel in the dashboard and the Pi is immediately offline.
- **DDoS protection + caching for free** (Cloudflare's edge).

## Prerequisites

- A Cloudflare account (free tier is fine)
- Zero Trust enabled on that account (free up to 50 users)
- `voltini.cloud` added as a zone in Cloudflare DNS

## 1. Create the tunnel in the Zero Trust dashboard

1. https://one.dash.cloudflare.com → **Networks** → **Tunnels** → **Create a tunnel**.
2. Select connector type: **Cloudflared**.
3. Name the tunnel to match the installation (e.g. `joakim`). Save.
4. Pick the environment: **Debian** / **64-bit**. The dashboard will show a long install command that looks like:
   ```
   sudo cloudflared service install eyJhIjoi...
   ```
   You can copy the whole line or just the `eyJ...` token part — `setup.sh` accepts both forms and extracts the token automatically. Copying the whole line is usually easier because the dashboard doesn't offer a "copy just the token" button.

> **Don't run the copied command directly.** `setup.sh` handles the install (including adding Cloudflare's apt repo) when you paste it. Running it manually first leads to two competing connector installations.

5. Under **Public Hostnames** tab, add:
   - **Subdomain**: `<installation-id>` (e.g. `joakim`)
   - **Domain**: `voltini.cloud`
   - **Type**: HTTP
   - **URL**: `localhost:8080`
6. Save. Cloudflare automatically creates the DNS CNAME record for `<installation-id>.voltini.cloud`.

## 2. Paste the token into `setup.sh`

When `setup.sh` prompts for the Cloudflare Tunnel token, paste the token from step 1.4. The script then:

1. Adds Cloudflare's apt repo and installs the `cloudflared` package.
2. Runs `sudo cloudflared service install <token>`, which:
   - Registers a systemd unit (`cloudflared.service`) that starts on boot
   - Connects to Cloudflare's edge using the token
   - Starts immediately (no reboot needed)

Verify after setup:

```bash
sudo systemctl status cloudflared
sudo journalctl -u cloudflared -n 30
```

Expected: log lines like `Connection ... registered connIndex=0 ...`.

## 3. Test

From a browser outside the Pi's network:

```
https://joakim.voltini.cloud    ← your chosen public hostname
```

You should reach the login page. If you get a Cloudflare "tunnel offline" page, the `cloudflared` service isn't running or connected — check `journalctl`.

## Running `setup.sh` without a token

You can leave the token prompt empty during install. The stack still comes up on `127.0.0.1:8080`, but nothing outside the Pi reaches it.

To add the tunnel later:

```bash
# Create the tunnel in Zero Trust dashboard, grab the token, then:
sudo apt update && sudo apt install -y cloudflared

# Add Cloudflare's apt repo first if not already done:
sudo mkdir -p --mode=0755 /usr/share/keyrings
curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | \
    sudo tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null
echo 'deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main' | \
    sudo tee /etc/apt/sources.list.d/cloudflared.list >/dev/null
sudo apt-get update
sudo apt-get install -y cloudflared

sudo cloudflared service install <YOUR-TOKEN-HERE>
```

## Swapping the token / reconfiguring

If you rotate the token or switch to a different tunnel:

```bash
sudo cloudflared service uninstall
sudo cloudflared service install <NEW-TOKEN-HERE>
```

## Email links and the public URL

The backend reads `BORZOI_BASE_URL` from `.env` when generating links inside outbound emails (password reset, verification). `setup.sh` defaults this to `http://localhost:8080` — fine for the current product since those email paths are dormant.

When email features become active, edit `.env` to use the Cloudflare-tunneled URL:

```bash
BORZOI_DOMAIN=joakim.voltini.cloud
BORZOI_BASE_URL=https://joakim.voltini.cloud
```

Then:

```bash
docker compose restart backend
```

The nginx template uses `server_name _` (catch-all), so `BORZOI_DOMAIN` doesn't need to match for web traffic to work — it only matters for the base URL in emails.

## Troubleshooting

### "Tunnel offline" page
- `sudo systemctl status cloudflared` — should be active
- `sudo journalctl -u cloudflared -n 100` — look for connection errors
- Token may be invalid. Regenerate in the dashboard and re-run `sudo cloudflared service install <new-token>`.

### 502 Bad Gateway from Cloudflare
- Cloudflared is running but can't reach `localhost:8080`.
- Check the stack is up: `docker compose ps`.
- `curl -v http://localhost:8080` from the Pi — should return the Borzoi index.html.
- The public-hostname config in the Zero Trust dashboard must have URL = `localhost:8080` (not `127.0.0.1:8080` — cloudflared resolves `localhost` to 127.0.0.1 but rejects the bare IP in some config versions).

### Websocket / streaming breaks
Cloudflare Tunnel supports websockets by default, but if you see hangs, enable "HTTP/2 to origin" in the tunnel's Access settings.
