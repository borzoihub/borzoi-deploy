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
- **Admin already existed** — bootstrap-admin is idempotent. If a user was created in a previous install and data was preserved across rebuilds, the old password still applies. Recover by logging in with the old creds, or reset directly in the DB:
  ```sql
  -- Inside postgres:
  UPDATE "user" SET password = '<new-bcrypt-hash>' WHERE email = 'admin@...';
  ```
  Generate the bcrypt hash with rounds=10 (use any bcrypt CLI or a one-liner).

## Backend logs "waiting for required settings"

### Symptom
```
[scheduler] scheduler: waiting for required settings (installation, battery, heating, deviceConfig)
[flowtemp] flowtemp: waiting for required settings (heating, deviceConfig.heatpumpOutdoorTemp)
```

### Cause
**This is normal on a fresh install.** The scheduler, flow-temp regulator, and ingestion services self-skip every tick until the required settings exist in the DB. Once you fill them in via the UI, the next tick (≤60s later) picks them up and activates the subsystem.

If you've already filled in all settings via the UI and the messages persist, check:

```bash
docker compose exec postgres psql -U borzoi -d borzoi -c 'SELECT key FROM settings;'
```

You should see rows for `installation`, `battery`, `heating`, `ev_charging`, `spot_prices`, `device_config`. Missing ones are what the scheduler is waiting for.

If `device_config` is there but the scheduler still complains, inspect it:
```sql
SELECT value FROM settings WHERE key = 'device_config';
```
Look for nullable fields (e.g. `gridPower`, `solarPower`, `batteryLevel`) — these must be set to actual device IDs.

## ECR pull failures

### Symptom
```
Error response from daemon: pull access denied for <registry>/borzoi-backend
```
or
```
no basic auth credentials
```

### Diagnosis

Verify the ECR credential helper and wrapper:

```bash
which docker-credential-ecr-login                  # /usr/bin/... or similar
which docker-credential-borzoi-ecr-login           # /usr/local/bin/...
cat ~/.docker/config.json                           # should map registry → borzoi-ecr-login
```

Verify the ECR creds work (note the explicit profile):

```bash
AWS_PROFILE=borzoi-ecr aws sts get-caller-identity
AWS_PROFILE=borzoi-ecr aws ecr get-login-password --region eu-north-1 >/dev/null && echo OK
```

### Fixes

- **Helper missing**: `sudo apt install amazon-ecr-credential-helper`
- **Wrapper missing**: re-run `setup.sh` or copy manually:
  ```bash
  sudo tee /usr/local/bin/docker-credential-borzoi-ecr-login >/dev/null <<'WRAPPER'
  #!/bin/sh
  AWS_PROFILE=borzoi-ecr exec docker-credential-ecr-login "$@"
  WRAPPER
  sudo chmod +x /usr/local/bin/docker-credential-borzoi-ecr-login
  ```
- **`[borzoi-ecr]` profile missing**: open `~/.aws/credentials` and add it (see installation.md for format)
- **IAM perms missing**: the shared installer user must have `ecr:GetAuthorizationToken`, `ecr:BatchGetImage`, `ecr:GetDownloadUrlForLayer`, `ecr:BatchCheckLayerAvailability` for both repos. See [operator-setup.md § 5](operator-setup.md#5-create-the-shared-ecr-pull-iam-user).

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
The backend runs init SQL (hypertables), entity sync, and typeorm migrations in that order. If entity sync was disabled (`BORZOI_ALLOW_SYNC_IN_PROD` unset and `NODE_ENV=production`), entity tables were never created.

### Fix

Check `.env`:
```bash
grep BORZOI_ALLOW_SYNC_IN_PROD /opt/borzoi/.env
```

Should be `BORZOI_ALLOW_SYNC_IN_PROD=true`. If missing or `false`, add / flip it and restart:

```bash
echo "BORZOI_ALLOW_SYNC_IN_PROD=true" >> /opt/borzoi/.env
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
  grep -v -E 'PASSWORD|SECRET|KEY' .env
) > /tmp/borzoi-support.log
```

Send `/tmp/borzoi-support.log` (already secret-redacted). Never include raw `.env` without redaction.
