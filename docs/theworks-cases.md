# theworks-cases stack (support-case system)

Internal maintainer infrastructure — **not** part of the customer Hub stack and
**never** run on a customer Raspberry Pi. It runs on a dedicated dev/ops box, the
same way the retired `agent-worker` did.

This is the production cutover of the Voltini support-case system (issue #45).
`theworks-cases-be` becomes the system of record for support cases; the old
in-repo resolver (`agent-worker/` + `docker-compose.agent.yml`) is retired and
replaced by `theworks-cases-worker`.

## What runs

`docker-compose.theworks.yml` brings up three services on one private network:

| Service | Role | Exposure |
|---|---|---|
| `postgres` | Shared Postgres. Its `POSTGRES_DB` is the primary (Voltini) database; `scripts/theworks-initdb.sh` provisions the **separate** `theworks_cases` database on the same server. | internal |
| `theworks-cases-be` | System of record: storage, status, title generation, the GitHub mirror (`borzoihub/voltini-support`), and the `/api/agent/*` contract. `casesConfig: voltini`. | **internal only — no published port** |
| `theworks-cases-worker` | The autonomous resolver. Talks directly to `theworks-cases-be`'s `/api/agent/*`, runs `PROJECT_HOOK=voltini`, and reads live installation data from Voltini central via `LIVE_DATA_API_URL`. | internal |

### One Postgres, two databases

Decision from the blueprint: a **separate database on the shared Postgres
instance**, not a schema. Voltini keeps PostGIS + its own migrations on the
primary database; `theworks-cases-be` needs neither and owns its own migrations
on `theworks_cases`. The container's `POSTGRES_DB` only creates the primary
database, so `scripts/theworks-initdb.sh` (mounted into
`/docker-entrypoint-initdb.d`) creates the second one on first cluster init.

If the shared Postgres already exists (an established instance rather than a
fresh volume), run the equivalent one-time DDL instead:

```sql
CREATE DATABASE theworks_cases OWNER voltini;
GRANT ALL PRIVILEGES ON DATABASE theworks_cases TO voltini;
```

## Deploy (fresh ops box)

```bash
git pull
# Secrets are split per-service (least privilege): each container is handed only
# the secrets it uses. Copy and fill in all three:
cp .env.theworks.example        .env.theworks         # compose-CLI interpolation
cp .env.theworks.be.example     .env.theworks.be      # theworks-cases-be only
cp .env.theworks.worker.example .env.theworks.worker  # theworks-cases-worker only
mkdir -p theworks-data/repos theworks-data/claude   # REPOS_DIR + Agent SDK session store
# clone the Voltini CODE repos the worker opens PRs against into theworks-data/repos/
# (theworks-data/claude persists parked/ask_human sessions across container restarts)
docker compose -f docker-compose.theworks.yml --env-file .env.theworks up -d
# run migrations on deploy (synchronize is false):
docker compose -f docker-compose.theworks.yml exec theworks-cases-be npm run migration:up
```

### Secret split (least privilege)

Each container sees only the secrets it uses, so a compromise of one image does
not leak the other's credentials:

| File | Injected into | Holds |
|---|---|---|
| `.env.theworks` | nothing (compose-CLI `--env-file` interpolation only) | shared infra (registry/tags/ports), the shared Postgres credential, the worker's central live-data URL |
| `.env.theworks.be` | `theworks-cases-be` only | GitHub mirror token, webhook HMAC secret + URL, AWS (SES/S3/Bedrock) keys |
| `.env.theworks.worker` | `theworks-cases-worker` only | Claude subscription OAuth token, worker GitHub PAT, `agentWorker` token, behaviour knobs |

The Postgres credential lives in `.env.theworks` and is interpolated into the
`postgres` and `theworks-cases-be` `environment:` blocks — the worker, which
keeps no local DB, never receives it.

This split is machine-checked: `scripts/validate-theworks-compose.sh` renders
`docker compose config` and asserts the worker block holds none of the backend's
secrets (`DB_PASSWORD`, `GITHUB_TOKEN`, `NOTIFICATIONS_WEBHOOK_SECRET`, the AWS
keys) and vice versa, and that every worker bind mount is a scoped subdirectory
of `./theworks-data` (the repo workspace `./theworks-data/repos` and the
persisted Agent SDK session store `./theworks-data/claude`) — never the parent
`./theworks-data` nor the `./theworks-data/postgres` cluster dir, which hold the
raw Postgres cluster files. A regression that re-widens either fails the check.

Images (`theworks-cases-be`, `theworks-cases-worker`) are built and published
from their own repos to `${THEWORKS_REGISTRY}`; this bundle only orchestrates
them and holds no application source.

## Retired

- `agent-worker/` — the old resolver source (was vendored here).
- `docker-compose.agent.yml` — the old resolver's compose.

Nothing drives `voltini.energy-backend/api/support/agent/*` after cutover; the
worker now talks to `theworks-cases-be` directly.
