# TLS / HTTPS setup

Borzoi-deploy defaults to HTTP so Let's Encrypt's webroot challenge can answer on port 80 without nginx already serving HTTPS. Flip to HTTPS after the initial install.

## Prerequisites

- Port 80 reachable from the public internet (router port forwarding if the Pi is behind NAT)
- DNS A record pointing at the Pi's public IP
- The stack running and reachable at `http://$BORZOI_DOMAIN`

## 1. Issue the initial certificate

One-shot certbot run against the live nginx:

```bash
cd /opt/borzoi
source .env

docker run --rm \
  -v $PWD/certbot/conf:/etc/letsencrypt \
  -v $PWD/certbot/www:/var/www/certbot \
  certbot/certbot certonly \
  --webroot -w /var/www/certbot \
  -d "$BORZOI_DOMAIN" \
  --email "admin@$BORZOI_DOMAIN" \
  --agree-tos --no-eff-email \
  --non-interactive
```

Expected output:

```
Successfully received certificate.
Certificate is saved at: /etc/letsencrypt/live/<domain>/fullchain.pem
Key is saved at:         /etc/letsencrypt/live/<domain>/privkey.pem
```

If this fails with "challenge failed", DNS isn't pointing at the Pi, or port 80 isn't reachable. Run `curl http://<public-ip>/.well-known/acme-challenge/test` from an external network to verify connectivity.

## 2. Enable the HTTPS server block

Edit `nginx/templates/default.conf.template`. Uncomment the HTTPS `server { ... }` block at the bottom, and uncomment the `return 301 https://$host$request_uri;` line in the HTTP block to force all HTTP → HTTPS.

Final file should look like:

```nginx
server {
    listen 80;
    server_name ${BORZOI_DOMAIN};

    location /.well-known/acme-challenge/ {
        root /var/www/certbot;
    }

    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name ${BORZOI_DOMAIN};

    ssl_certificate     /etc/letsencrypt/live/${BORZOI_DOMAIN}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/${BORZOI_DOMAIN}/privkey.pem;

    client_max_body_size 25m;

    location /api/ {
        proxy_pass         http://backend:3100/api/;
        proxy_http_version 1.1;
        proxy_set_header   Host              $host;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
        proxy_set_header   Upgrade           $http_upgrade;
        proxy_set_header   Connection        "upgrade";
        proxy_read_timeout 300s;
    }

    location / {
        root /usr/share/nginx/html;
        try_files $uri $uri/ /index.html;
    }
}
```

Restart nginx to pick up the new template:

```bash
docker compose restart nginx
```

Visit `https://$BORZOI_DOMAIN` — should serve with a valid cert and no warnings.

## 3. Automate renewal

Let's Encrypt certs are valid for 90 days. Renewal is simple but needs to run periodically. Two options:

### Option A — cron + one-shot certbot

Add to root's crontab (`sudo crontab -e`):

```cron
0 3 * * 1 cd /opt/borzoi && docker run --rm -v $PWD/certbot/conf:/etc/letsencrypt -v $PWD/certbot/www:/var/www/certbot certbot/certbot renew --quiet && docker compose exec nginx nginx -s reload
```

Runs weekly at 03:00 Monday. Certbot only actually renews if within 30 days of expiry, so this is cheap.

### Option B — certbot service in compose (auto-renewing)

Add a `certbot` service to `docker-compose.yml`:

```yaml
  certbot:
    image: certbot/certbot:latest
    container_name: borzoi-certbot
    restart: unless-stopped
    volumes:
      - ./certbot/conf:/etc/letsencrypt
      - ./certbot/www:/var/www/certbot
    entrypoint: "/bin/sh -c 'trap exit TERM; while :; do certbot renew --quiet; sleep 12h & wait $${!}; done;'"
```

And a sidecar to reload nginx when certs change (or just let nginx serve the old cert until the next restart — Let's Encrypt doesn't revoke on renewal).

Option A is simpler and more robust for a Pi.

## Troubleshooting

- **"Challenge failed"**: check DNS (`dig $BORZOI_DOMAIN`), check port 80 is open from the internet, check `certbot/www` is writable.
- **"Too many requests"**: Let's Encrypt has rate limits (50 certs per registered domain per week). If you're iterating, use `--test-cert` to hit the staging server first.
- **"Certificate valid but browser warns"**: might be an intermediate chain issue. Run `openssl s_client -connect $BORZOI_DOMAIN:443 -servername $BORZOI_DOMAIN < /dev/null | grep -E "^(subject|issuer)"` to inspect.
