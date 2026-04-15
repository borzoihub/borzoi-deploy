# TLS / HTTPS

**The default deployment uses [Cloudflare Tunnel](cloudflare-tunnel.md), which terminates HTTPS at Cloudflare's edge. You don't need a local TLS cert. Skip this file unless you're intentionally doing a direct-internet install.**

---

## Direct-internet install (advanced / not recommended)

If you want to bypass Cloudflare Tunnel and expose the Pi directly on the public internet — for example on a static IP with port forwarding — you'll need to:

1. Rebind nginx to public ports (edit `docker-compose.yml`: change the `ports:` line from `"127.0.0.1:8080:80"` to `"80:80"` and add `"443:443"`).
2. Add the HTTPS server block back into `nginx/templates/default.conf.template` (removed in the current template for the Cloudflare Tunnel default).
3. Issue certificates with certbot (see below).
4. Open 80/tcp and 443/tcp on the router.

This mode is **not recommended** for customer installs: you expose a Pi directly to the internet, manage DDoS yourself, renew certificates, and maintain DNS. Cloudflare Tunnel avoids all of this.

### Issuing the certificate

One-shot certbot run:

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

### nginx HTTPS server block

Add to `nginx/templates/default.conf.template`:

```nginx
server {
    listen 80 default_server;
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
        proxy_read_timeout 300s;
    }

    location / {
        root /usr/share/nginx/html;
        try_files $uri $uri/ /index.html;
    }
}
```

Mount the certbot volumes back in the nginx service (`docker-compose.yml`):

```yaml
    volumes:
      - ./nginx/templates:/etc/nginx/templates:ro
      - frontend-static:/usr/share/nginx/html:ro
      - ./certbot/conf:/etc/letsencrypt:ro
      - ./certbot/www:/var/www/certbot:ro
```

Restart nginx: `docker compose restart nginx`.

### Automated renewal

Add to root's crontab (`sudo crontab -e`):

```cron
0 3 * * 1 cd /opt/borzoi && docker run --rm -v $PWD/certbot/conf:/etc/letsencrypt -v $PWD/certbot/www:/var/www/certbot certbot/certbot renew --quiet && docker compose exec nginx nginx -s reload
```

Runs weekly. Certbot only actually renews if within 30 days of expiry.
