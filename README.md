# borzoi-deploy

## What this is

A self-contained deploy bundle for running the full Borzoi stack
(backend + frontend + TimescaleDB + nginx) on a single host — typically
a Raspberry Pi 4 or 5. Images are pulled from a private Amazon ECR
registry using per-customer IAM credentials; no source code or
developer credentials live on the device. A single `setup.sh` run
generates secrets, writes a `.env`, and brings the stack up.

## Full documentation

See [`docs/`](docs/README.md) for the complete guide:

- [Architecture](docs/architecture.md) — how the pieces fit together
- [Operator setup](docs/operator-setup.md) — one-time: ECR, IAM, image publishing
- [Customer onboarding](docs/customer-onboarding.md) — per-customer: IAM, credentials packet
- [Installation guide](docs/installation.md) — fresh Raspberry Pi, step by step
- [TLS / HTTPS](docs/tls.md) — Let's Encrypt setup
- [Updating](docs/updating.md) — releases, pinning, rollback, backup/restore
- [Troubleshooting](docs/troubleshooting.md) — diagnosing common problems

The rest of this README is a quick reference. Start with [`docs/installation.md`](docs/installation.md) for a fresh install.

## Prerequisites

- Raspberry Pi 4 or 5 (arm64), or any Linux arm64/amd64 host
- Docker Engine with the Compose v2 plugin (`docker compose version` must work)
- `openssl` (used to generate secrets)
- `git` (used by `install.sh`)
- `sudo` access (used to install the ECR credential helper)
- Optional but recommended: `aws-cli` — when present, `setup.sh`
  validates your AWS credentials and auto-fills the ECR registry URL
- ECR pull credentials (shared installer IAM user, distributed by the
  operator with each install). Permissions:
  `ecr:GetAuthorizationToken`, `ecr:BatchGetImage`,
  `ecr:GetDownloadUrlForLayer`, `ecr:BatchCheckLayerAvailability`,
  scoped to the `borzoi-backend` and `borzoi-frontend` repositories
  only. **Pull-only — no other AWS access.**
- A DNS record pointing your chosen domain at this host

Note: the backend has code paths for S3 and SES but they are not
currently used by the product. `setup.sh` writes placeholder AWS
credentials; no per-customer AWS account is required today.

## Install

One-liner from a fresh Pi:

```bash
curl -fsSL https://raw.githubusercontent.com/borzoihub/borzoi-deploy/main/install.sh | bash
```

Manual equivalent:

```bash
sudo mkdir -p /opt/borzoi && sudo chown "$USER" /opt/borzoi
git clone --depth 1 https://github.com/borzoihub/borzoi-deploy.git /opt/borzoi
cd /opt/borzoi
./setup.sh
```

`setup.sh` is interactive. It will prompt for the domain, the **ECR
pull credentials** (a shared installer IAM user), and an admin email.
It auto-generates the DB password, JWT secret, and bootstrap admin
password.

ECR creds are stored in `~/.aws/credentials` under the `[borzoi-ecr]`
profile, used by a wrapper around `amazon-ecr-credential-helper` so
`docker pull` works indefinitely without manual token refresh.

The admin login is printed once at the end — **save it**, it is not
stored anywhere.

## Update

```bash
cd /opt/borzoi
docker compose pull
docker compose up -d
```

The `migrate` one-shot runs before the backend, so schema upgrades are
applied automatically. The `frontend` one-shot refreshes the static
files in the shared nginx volume.

## Pin a version

`BACKEND_TAG` and `FRONTEND_TAG` in `.env` default to `latest`. To pin:

```bash
cd /opt/borzoi
# edit .env — set BACKEND_TAG=v1.4.2 (and/or FRONTEND_TAG=v1.4.2)
docker compose up -d
```

## Rollback

Reverse the pin:

```bash
cd /opt/borzoi
# edit .env — set BACKEND_TAG=v1.4.1 (the previous good version)
docker compose up -d
```

Because `synchronize: false` and migrations are forward-only, rolling
back the backend image is safe as long as the DB schema is still
compatible with that version. If a migration has been run that the old
backend can't tolerate, restore from a backup (see below).

## TLS

The default install does **not** terminate TLS on the Pi — the docker
stack's nginx binds `127.0.0.1:8080` plain HTTP, and TLS is terminated
externally by Cloudflare Tunnel. See [docs/cloudflare-tunnel.md](docs/cloudflare-tunnel.md).

There is no Let's Encrypt / certbot wiring in the docker-compose stack.
For the legacy direct-internet setup (not recommended), see [docs/tls.md](docs/tls.md).

## Backup

The stateful data lives in two places: the postgres data volume and
the `.env` file (contains DB password, JWT secret, AWS creds, admin
password). Back up both:

```bash
cd /opt/borzoi
sudo tar czf borzoi-backup-$(date +%F).tgz data/postgres .env
```

**Also copy `.env` to a separate secure location** (password manager,
encrypted cloud storage) — without it, the DB password is unrecoverable
and the encrypted data volume can't be read by a new deployment.

For a logical (portable) DB backup instead:

```bash
docker compose exec -T postgres pg_dump -U borzoi borzoi | gzip > borzoi-$(date +%F).sql.gz
```

## Restart

Most configuration changes (battery settings, price tariffs, device
mappings) are applied within 60 seconds with no restart — the
scheduler re-reads settings from the DB every tick.

A restart **is** required for hardware swaps where device IDs change:

- Replacing the battery inverter with a different unit
- Swapping the EV charger or adding a new one
- Changing the smart-meter/grid-sensor hardware
- Changing any device that the backend binds by ID at ingestion start

After making such changes in settings:

```bash
docker compose restart backend
```

## Troubleshooting

### Backend logs "waiting for required settings"

Normal on first boot before any settings are posted. The scheduler,
flow-temp regulator, and ingestion services all self-skip until their
required settings exist in the DB. Log in as admin via the frontend
and fill in the installation/battery/heating settings; the subsystems
will activate within 60 seconds.

### postgres restart fails / "password authentication failed"

TimescaleDB (and stock postgres) only reads `POSTGRES_PASSWORD` on the
**initial** cluster init — the first time `data/postgres` is populated.
If you regenerate `.env` without wiping `data/postgres`, the new
password won't match the cluster's stored password.

Two fixes:

- **Keep the old password** — restore the original `DB_PASSWORD` in
  `.env` from your backup.
- **Rotate in-cluster** — exec into the running container and run
  `ALTER USER borzoi WITH PASSWORD '<new>';` before updating `.env`.

### ECR pull fails with `no basic auth credentials` or `denied`

The ECR credential helper translates IAM creds → ECR tokens, so the
underlying issue is almost always with the ECR IAM creds in
`~/.aws/credentials [borzoi-ecr]` (or with that user's permissions).

Verify the helper and wrapper are installed and configured:

```bash
which docker-credential-ecr-login                  # should exist
which docker-credential-borzoi-ecr-login           # should exist (wrapper)
cat ~/.docker/config.json                          # should map registry → borzoi-ecr-login
```

Verify the ECR creds work (note the explicit profile):

```bash
AWS_PROFILE=borzoi-ecr aws sts get-caller-identity
AWS_PROFILE=borzoi-ecr aws ecr get-login-password --region eu-north-1 >/dev/null && echo OK
```

If those work but `docker compose pull` still fails, the ECR IAM user
is missing one of `ecr:GetAuthorizationToken`, `ecr:BatchGetImage`, or
`ecr:GetDownloadUrlForLayer`.

### Rotating the ECR pull credentials

Edit `~/.aws/credentials` and replace the values under
`[borzoi-ecr]`. No other change needed — the wrapper picks up the new
creds on the next `docker pull`.

### nginx can't find the frontend files

The `frontend` service is a one-shot that copies static files into a
shared volume, then exits. If it failed, the volume is empty. Check
its logs:

```bash
docker compose logs frontend
docker compose up -d frontend   # re-run the one-shot
```

### Migrations fail to run

Check `docker compose logs migrate`. Most common cause: DB not yet
healthy at the time migrate was scheduled (should be prevented by the
`service_healthy` depends_on, but a very slow first boot on a Pi can
still cause issues). Retry:

```bash
docker compose up -d migrate
docker compose up -d backend
```
