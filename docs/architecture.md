# Architecture

## Component overview

```
┌──────────────────────────── Raspberry Pi ────────────────────────────┐
│                                                                       │
│  ┌─────────┐   ┌──────────┐   ┌──────────┐   ┌─────────────────┐    │
│  │  nginx  │──▶│ backend  │──▶│ postgres │   │    frontend     │    │
│  │  :80    │   │  :3100   │   │  :5432   │   │  (one-shot)     │    │
│  │  :443   │   │          │   │ timescale│   │  copies static  │    │
│  └────┬────┘   └──────────┘   └──────────┘   │  → shared vol   │    │
│       │                                       └────────┬────────┘    │
│       │  serves static files from shared volume        │             │
│       └────────────────────────────────────────────────┘             │
│                                                                       │
│  Pulled from ECR:      ${ECR_REGISTRY}/borzoi-backend:${BACKEND_TAG} │
│                        ${ECR_REGISTRY}/borzoi-frontend:${FRONTEND_TAG}│
│                                                                       │
└───────────────────────────────────────────────────────────────────────┘
                            ▲                    ▲
                            │                    │
                    ECR pull creds       App AWS creds
                    (shared installer)   (customer-specific)
                            │                    │
                            ▼                    ▼
                      ┌──────────┐        ┌───────────┐
                      │   ECR    │        │  S3 + SES │
                      │ (your    │        │(customer's│
                      │  account)│        │  resources│
                      └──────────┘        └───────────┘
```

## Containers

| Service | Image | Role | Restart |
|---|---|---|---|
| `postgres` | `timescale/timescaledb:2.17.2-pg16` | Storage (entities + TimescaleDB hypertables) | `unless-stopped` |
| `backend` | `${ECR_REGISTRY}/borzoi-backend:...` | Node.js API on :3100, runs migrations + bootstrap-admin at startup | `unless-stopped` |
| `frontend` | `${ECR_REGISTRY}/borzoi-frontend:...` | One-shot: copies compiled Angular output into the shared `frontend-static` volume, exits 0 | `no` |
| `nginx` | `nginx:1.27-alpine` | Reverse proxy. Serves `/` from the shared volume, proxies `/api/*` → backend | `unless-stopped` |

Startup ordering is expressed via compose `depends_on`:

```
postgres (healthy)
  └─▶ backend starts
  └─▶ frontend one-shot runs (completes successfully)
        └─▶ nginx starts
```

The `migrate` step that used to exist as a separate container was folded into backend boot — it now runs right after `initServiceState()` and before `initBootstrapAdmin()`.

## Credentials model (two separate cred sets)

The Pi holds **two AWS credential sets** which never cross over:

### 1. ECR pull credentials — shared installer user

- **Scope**: ECR pull on `borzoi-backend` and `borzoi-frontend` repos only
- **Stored**: `~/.aws/credentials` under `[borzoi-ecr]` profile
- **Used by**: docker daemon (via the `amazon-ecr-credential-helper`) for `docker pull`
- **Reused** across every customer install — same IAM user, same keys
- **Cost of leakage**: attacker can pull compiled images (no source, no secrets)

A wrapper script at `/usr/local/bin/docker-credential-borzoi-ecr-login` pins `AWS_PROFILE=borzoi-ecr` before exec'ing the real `docker-credential-ecr-login`. This ensures docker auth never accidentally reads from `[default]` or any other profile that might be present on the host.

### 2. App AWS credentials — per-customer

- **Scope**: S3 on the customer's bucket + SES send
- **Stored**: `.env` (as `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`)
- **Used by**: backend container (via env_file) for S3 uploads and outbound email
- **Unique per customer** — each customer gets their own IAM user
- **Cost of leakage**: attacker can read/write that customer's S3 + send email from their SES sender

The two cred sets are prompted for separately by `setup.sh` and stored in separate locations. The backend container never sees the ECR creds; the docker daemon never sees the app creds.

## What lives on the Pi

```
/opt/borzoi/
├── .env                       # generated by setup.sh, mode 600
├── docker-compose.yml         # from the git repo
├── install.sh / setup.sh      # from the git repo
├── nginx/templates/           # nginx config templates (envsubst)
├── data/postgres/             # TimescaleDB data (volume)
├── certbot/conf/              # Let's Encrypt certs (after TLS setup)
└── certbot/www/               # webroot challenge path
```

Outside `/opt/borzoi`:

- `~/.aws/credentials` — ECR creds under `[borzoi-ecr]`
- `~/.aws/config` — `[profile borzoi-ecr]` region
- `~/.docker/config.json` — credHelper mapping for the ECR registry
- `/usr/local/bin/docker-credential-borzoi-ecr-login` — wrapper script

No source code, no developer tokens, no personal GitHub accounts are ever on the Pi.

## Backend boot sequence

```
initConfig           load JSON config
initStorage          AWS S3 SDK (requires real creds)
initEmail            AWS SES SDK (requires real creds)
initDatabase         connect to postgres
initExpress          listen on :3100
initSmart            homey / homeassistant clients
initCache
initTimescale        create hypertables if missing (idempotent)
initServiceState     create entity tables (via typeorm sync), seed tariffs
initMigrations       run pending typeorm migrations
initBootstrapAdmin   create admin from env if user table empty
initFlowTempRegulation  start recurring regulation loop (no-ops until configured)
initIngestion (×4)   start polling/sync loops (no-op until configured)
initScheduler        start 60s tick loop (no-ops until configured)
```

`initStorage` and `initEmail` are the only steps that throw on bad credentials. Everything else either boots successfully or degrades gracefully (logs "waiting for required settings" and no-ops until the configuration is provided via the UI).

## Per-tick config reload

The scheduler, flow-temp regulator, and ingestion services read their configuration from the settings table on every tick — not at `start()`. This means any setting edited through the UI takes effect within 60 seconds with no restart required.

Exceptions where a restart is still needed:
- Hardware ID changes (e.g. you swap the EV charger and the new unit has a different Homey device ID)
- `.env` changes (DB password, AWS keys, JWT secret) — these are read once on boot

See the backend's `src/services/scheduler.service.ts` `loadTickConfig()` method for the implementation.
