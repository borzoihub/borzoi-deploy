# Updating

How new backend or frontend releases reach a customer Pi.

## Publish new images (operator)

On your Mac:

```bash
cd /path/to/borzoi-backend
npm version patch   # or minor/major
npm run docker:release

cd /path/to/borzoi-frontend
npm version patch
npm run docker:release
```

See [operator-setup.md § 4](operator-setup.md#4-publishing-images) for details.

## Pull and restart on the Pi

Standard update:

```bash
ssh borzoi@<pi>
cd /opt/borzoi
docker compose pull
docker compose up -d
```

What happens:
- `postgres` is untouched (data preserved)
- `backend` recreates with the new image. On boot: runs migrations, bootstrap-admin is a no-op (user exists), schema-sync adds any new entity columns (opt-in mode), scheduler restarts
- `frontend` one-shot recreates, copies fresh static files into the shared volume
- `nginx` picks up the new static files on next request

Expected downtime: **~10-20 seconds** (backend restart + first-tick warmup).

## Pin a specific version

By default both `BACKEND_TAG` and `FRONTEND_TAG` in `.env` are `latest`. To pin:

```bash
cd /opt/borzoi
# Edit .env
BACKEND_TAG=v1.4.2
FRONTEND_TAG=v1.4.2
# Save, then:
docker compose up -d
```

Use case: roll forward to a tested release across many Pis on a known-good tag, not whatever is tagged `latest` at the moment.

## Rollback

Point back at the previous tag:

```bash
cd /opt/borzoi
# Edit .env
BACKEND_TAG=v1.4.1
FRONTEND_TAG=v1.4.1
# Save, then:
docker compose up -d
```

**Database migrations are forward-only** — typeorm doesn't auto-reverse. If the new version ran a migration that the old version can't tolerate, the old backend will fail to boot. In that case you have two options:

1. **Schema-compatible rollback** — if the migration was additive (new columns with defaults, new tables), the old backend ignores the new schema and runs fine.
2. **Restore a pre-migration backup** (see below). Point `.env` back at the old tag, restore data, start up.

## Backup before updating

A full backup captures everything needed to recreate the install:

```bash
cd /opt/borzoi
docker compose stop backend frontend nginx    # leave postgres up for pg_dump
docker compose exec -T postgres pg_dump -U borzoi borzoi | gzip > \
    /tmp/borzoi-$(date +%F-%H%M).sql.gz
docker compose start backend frontend nginx

# Also copy .env separately
cp .env /tmp/borzoi-$(date +%F-%H%M).env
```

Store both files off-device (password manager, encrypted cloud storage, external drive).

## Restore from backup

```bash
cd /opt/borzoi
docker compose down
rm -rf data/postgres/*        # only if starting fresh; SKIP if postgres is already initialized

docker compose up -d postgres
# Wait for healthy:
until docker compose exec postgres pg_isready -U borzoi -d borzoi >/dev/null 2>&1; do sleep 1; done

gunzip -c /path/to/borzoi-YYYY-MM-DD-HHMM.sql.gz | \
    docker compose exec -T postgres psql -U borzoi -d borzoi

docker compose up -d
```

**Important**: restore requires the **same DB password** as when the backup was taken. Postgres only honors `POSTGRES_PASSWORD` on initial cluster init — if you wipe `data/postgres` and use a new password, the restored role won't match. Keep the old `.env` alongside the SQL dump.

## OS package updates

Keep the Pi's OS patched separately:

```bash
sudo apt update && sudo apt upgrade -y
sudo reboot
```

Docker + Borzoi stack restart automatically (via `restart: unless-stopped`).

## Updating Docker itself

```bash
sudo apt upgrade docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
```

Docker Compose v2 is part of the `docker compose` plugin, included above.

## Updating the deploy bundle itself

If you update `borzoi-deploy` (new compose options, nginx template changes, setup.sh improvements):

```bash
cd /opt/borzoi
git pull
docker compose up -d            # picks up compose-file changes
docker compose restart nginx     # picks up template changes
```

`setup.sh` is idempotent-ish but **re-running it will prompt to overwrite `.env` and rotate credentials** — only do this intentionally.
