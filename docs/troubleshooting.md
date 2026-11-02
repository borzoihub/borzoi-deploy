# Troubleshooting

Common problems and their fixes, grouped by symptom.

## Can't log in as admin

### Symptom
`POST /api/auth/login` returns `{"code":-1000,"message":"Wrong password or login information!"}`

### Causes
- **Password mis-typed** — the auto-generated password was 24 characters, easy to typo. If you saved it, paste it exactly.
- **Bootstrap admin was skipped** — if `BORZOI_ADMIN_EMAIL` or `BORZOI_ADMIN_PASSWORD` were empty in `.env` on first boot, the admin was never created. Check with:
  ```bash
  docker compose exec postgres psql -U borzoi -d borzoi -c 'SELECT email FROM "user";'
  ```
  If the table is empty, edit `.env` to set both vars, then `docker compose restart backend` — bootstrap-admin runs on every boot and is a no-op only when at least one user exists.
- **Admin already existed** — bootstrap-admin is idempotent. If a user was created in a previous install and data was preserved across rebuilds, the old password still applies. Recover by logging in with the old creds, or reset it on the box (no email, works offline; postgres must be running):
  ```bash
  ./scripts/reset-admin-password.sh --list            # show local accounts
  ./scripts/reset-admin-password.sh admin@acme.example
  ```

## Backend logs "waiting for required settings"

### Symptom
```
[scheduler] scheduler: waiting for required settings (installation, battery, deviceConfig)
[scheduler] scheduler: waiting for required settings (battery config (missing device bindings), peak config (missing device bindings))
```

### Cause
**This is normal on a fresh install.** The scheduler skips every tick until the settings it needs exist in the DB, logging at most once a minute; once you fill them in via the UI, the next tick (≤60s later) picks them up. The flow-temp regulator skips silently until the heating settings exist.

The scheduler needs the `installation`, `battery` and `device_config` settings (`heating` and `ev_charging` are optional), and `device_config` must bind the devices battery control and peak management read: `batteryLevel`, `gridPower` and `houseConsumption`.

If you've already filled in all settings via the UI and the messages persist, check:

```bash
docker compose exec postgres psql -U borzoi -d borzoi -c 'SELECT key FROM settings;'
```

A missing `installation`, `battery` or `device_config` row is what the first message lists. If the second message appears, inspect the bindings:
```sql
SELECT value FROM settings WHERE key = 'device_config';
```
`batteryLevel`, `gridPower` and `houseConsumption` must each point at a device (`deviceId` set).

## Registry pull failures

### Symptom
```
Error response from daemon: pull access denied for ghcr.io/borzoihub/borzoi-backend
```
or
```
no basic auth credentials
```

### Diagnosis

Image pulls use exactly one credential — `GHCR_TOKEN` from `.env`. The
connection key is not involved (it only brokers backup credentials), so a Hub
with no key, or a blocked key, still pulls normally.

```bash
cd /opt/borzoi
./update.sh 2>&1 | head -20
# "Registry credentials OK."   → the login worked
```

Check the login by hand:

```bash
source /opt/borzoi/.env
printf '%s' "$GHCR_TOKEN" | docker login ghcr.io -u "$GHCR_USER" --password-stdin
```

### Fixes

- **`GHCR_TOKEN is not set in .env`** — the Hub was set up before this value was
  required, or it was blanked. Put the shared `read:packages` PAT back.
- **`docker login … failed`** — `GHCR_TOKEN` may have been regenerated on the
  `voltini-autobot` machine account. It is shared fleet-wide, so if one Hub is
  affected, all are. Update `.env` on each and `docker login` again.
- **`denied` / `403` on pull despite a successful login** — the PAT is valid but
  lacks `read:packages`, or the package is no longer linked to its repo.
- **Certificate errors after a long outage** — a Pi has no battery-backed clock,
  so after a power cut it can boot weeks in the past and reject certificates
  issued during the gap as "not yet valid". Check `date`; it self-heals once NTP
  syncs.

## postgres won't start / "password authentication failed"

### Symptom
Postgres container crashes on start, or backend logs "password authentication failed for user borzoi".

### Cause
Postgres only reads `POSTGRES_PASSWORD` **on the first init** — when `data/postgres` is empty. If `.env` is regenerated (e.g. by re-running `setup.sh`) with a new `DB_PASSWORD`, but `data/postgres` still contains the old cluster, the new password mismatches.

### Fix

Either:

**1. Keep the old password** (if you still have it):
```bash
# Restore the original DB_PASSWORD in .env, then
docker compose down
docker compose up -d
```

**2. Rotate the password in-cluster** (if you want the new one):
```bash
# Start postgres only
docker compose up -d postgres

# Connect with the OLD password (from your backup .env) and ALTER:
docker compose exec postgres psql -U borzoi -d borzoi -c \
  "ALTER USER borzoi WITH PASSWORD '<new-password-from-new-env>';"

# Then bring up the rest:
docker compose up -d
```

**3. Start completely fresh** (DESTROYS all data):
```bash
docker compose down
sudo rm -rf data/postgres
docker compose up -d
```

Always back up `.env` alongside DB dumps — the password is the bridge between them.

## Migrations fail / "relation X does not exist"

### Symptom
```
QueryFailedError: relation "tariffs" does not exist
```

### Cause
The whole schema, including the initial one, is created by typeorm migrations at backend boot (`initMigrations`). Entity auto-sync is off unless `DB_SYNCHRONIZE=true`; `BORZOI_ALLOW_SYNC_IN_PROD` is not read by the backend and changes nothing. A missing relation means a migration failed or has not run yet.

### Fix

Find the failing migration in the boot log, fix its cause, and restart the backend — pending migrations run again on every boot:

```bash
docker compose logs backend | grep -i -A5 migration
docker compose up -d backend
```

## Frontend shows 404 or old version

### Symptom
Browser shows the nginx default page, or stale assets from a previous release.

### Cause
The `frontend` service is a one-shot: it copies files into a shared volume and exits. If it failed to exit successfully, nginx has nothing (or stale files) to serve.

### Fix

```bash
docker compose ps frontend     # should show "Exited (0)"
docker compose logs frontend   # should end with "frontend deployed"
```

If the copy failed:
```bash
docker compose up -d frontend  # re-run the one-shot
docker compose restart nginx   # force nginx to reopen file handles
```

If nginx is serving the old version after a `docker compose pull`:
```bash
docker compose up -d frontend   # ensure the new frontend one-shot ran
```

## nginx: "host not found in upstream 'backend'"

### Cause
nginx starts before the `backend` DNS resolves. Happens if the backend is crash-looping.

### Fix
Fix the backend crash first (`docker compose logs backend`), then nginx picks up the upstream on the next restart:
```bash
docker compose restart nginx
```

## Backend won't start with ESM "Cannot find module" errors

### Symptom
```
Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/app/node_modules/dayjs/plugin/timezone'
```

### Cause
Node's strict ESM resolution rejects bare specifiers without file extensions. The Dockerfile uses `tsx` to work around this — if you changed it to `node dist/index.js`, some transitive deps will fail.

### Fix
Confirm the Dockerfile CMD uses tsx:
```dockerfile
CMD ["npx", "tsx", "-r", "tsconfig-paths/register", "src/index.ts"]
```

Rebuild and push a new backend image.

## Pi out of disk space

### Symptom
```
no space left on device
```
Postgres may stop accepting writes; backend crashes.

### Fix
```bash
df -h            # check usage
docker system df # docker-specific breakdown

# Clear old images:
docker image prune -af

# If postgres is the culprit (TimescaleDB compresses badly on small devices), see below.
```

For long-term control: configure TimescaleDB retention on `device_metrics` and `computed_metrics` hypertables. Default is unbounded.

## Stack won't come up after power loss

### Symptom
Pi boots but `docker compose up` reports health-check timeouts or restart loops.

### Diagnosis
- SD card corruption — check with `dmesg | grep -i error` and `fsck` on the data partition.
- Postgres WAL replay stalling — check `docker compose logs postgres`.

### Fix for SD card corruption
Restore from backup onto a new SD card; the SD-card lifetime on a Pi doing heavy database writes is 1-3 years. Consider moving to a USB 3 SSD for long-term installs.

## Gathering logs for support

If you need to escalate, run:

```bash
cd /opt/borzoi
(
  echo "=== docker compose ps ==="
  docker compose ps
  echo
  echo "=== backend (last 200) ==="
  docker compose logs --tail=200 backend
  echo
  echo "=== postgres (last 50) ==="
  docker compose logs --tail=50 postgres
  echo
  echo "=== nginx (last 50) ==="
  docker compose logs --tail=50 nginx
  echo
  echo "=== .env (secrets redacted) ==="
  grep -v -E 'PASSWORD|SECRET|KEY|TOKEN' .env
) > /tmp/borzoi-support.log
```

Send `/tmp/borzoi-support.log` (already secret-redacted). Never include raw `.env` without redaction.
