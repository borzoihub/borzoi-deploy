# Simulation nodes

A **sim node** turns any Docker host into a distributed simulation worker for
the Voltini job queue. It is the same `borzoi-backend` image as a customer Hub,
run in `BORZOI_MODE=sim` — a pure outbound job-queue worker
(`borzoi-backend/src/sim-server.ts`): no database, no scheduler, no inbound HTTP
except a local `/healthz` probe. It long-polls the central coordinator
(`voltini.energy-backend`) over outbound HTTPS, runs simulation jobs, and
appears on the installer portal's **Background jobs** page.

Sim nodes give simulations the same lifecycle as a real Hub:

- **Install once** from a clone — no per-machine image build.
- **Pull a prebuilt multi-arch image** from ECR (amd64 or arm64 automatically).
- **Self-update OTA** via the same updater sidecar the Hub uses — triggered by
  an `update` job on the queue, so no Cloudflare Tunnel per node is needed.

---

## Installing a sim node

On a host that already has **Docker Engine + the Compose v2 plugin**
(`docker compose version` must work — the installer does *not* install Docker):

```bash
git clone https://github.com/borzoihub/borzoi-deploy.git
cd borzoi-deploy
./install-sim.sh
```

`install-sim.sh` prompts for the **sim bundle** JSON, then writes `.env`
(mode 0600), installs the ECR credential helper, pulls the sim image, and brings
up two containers (`borzoi-sim` + `borzoi-sim-updater`) defined in
[`docker-compose.sim.yml`](../docker-compose.sim.yml).

The node should appear on the Background jobs page within a minute.

```bash
docker compose -f docker-compose.sim.yml ps          # status
docker compose -f docker-compose.sim.yml logs -f sim # logs
```

> `.env` sets `COMPOSE_FILE=docker-compose.sim.yml`, so plain
> `docker compose …` commands run from the repo also target the sim stack.

### The sim bundle

A flat JSON the operator produces once and reuses across nodes (a single shared
WorkerService token + ECR read credentials):

```json
{
  "ecr_region":        "eu-north-1",
  "ecr_registry":      "<account>.dkr.ecr.<region>.amazonaws.com",
  "access_key_id":     "AKIA...",
  "secret_access_key": "...",
  "coordinator_url":   "https://api.voltini.energy",
  "worker_token":      "<long-lived WorkerService JWT>"
}
```

- `ecr_*` / `access_key_id` / `secret_access_key` — the same ECR read
  credentials used for Hub installs (see
  [customer-onboarding.md](customer-onboarding.md)).
- `coordinator_url` — the central job-queue base URL.
- `worker_token` — a WorkerService JWT minted by central; it authenticates the
  node's `claim`/`heartbeat`/`result` calls. (Token TTL / rotation policy: see
  the Voltini job-queue docs.)

The installer also asks for a **node id** (defaults to the hostname; shown on the
Background jobs page) and an optional **max concurrent** (blank = cores−1).

---

## OTA updates

OTA is **identical to the full Hub from `data/upgrade/request.json` onward** —
same `updater` sidecar ([`scripts/updater.sh`](../scripts/updater.sh)), same
ECR-login → pull → recreate sequence, same `status.json`. Only two things differ:

1. **Trigger.** A Hub is updated by an inbound call through its Cloudflare
   Tunnel. A sim node has no inbound path, so instead the update rides the job
   queue: central enqueues an `update` job **targeted at that node**; the node
   stops claiming new work, lets its in-flight jobs drain, then writes
   `request.json` itself. The sidecar takes over from there.
2. **Scope.** The sim updater is parameterized via
   [`docker-compose.sim.yml`](../docker-compose.sim.yml):
   - `OTA_SERVICES=sim` — only the `sim` service is pulled and recreated.
   - `OTA_BACKUP=0` — the pre-update DB backup is skipped (a sim node has no DB).

   These default to the full-Hub behavior
   (`OTA_SERVICES="postgres backend frontend nginx"`, `OTA_BACKUP=1`) when unset,
   so the Hub stack is unaffected.

Trigger updates from the Background jobs page: a node whose reported version is
behind the latest published image shows as outdated, with an **Update** button.

---

## Operator: publishing a multi-arch image

Sim nodes run on mixed hardware (x86_64 cloud/desktops **and** arm64), so ECR
must serve a **multi-arch manifest** for `borzoi-backend`. The Hub-only build
(`npm run docker:build`) is arm64 + `--load` and cannot be used here.

In **borzoi-backend**, publish with:

```bash
npm run docker:login     # authenticate to ECR
npm run docker:release   # version:bump → docker:buildx (amd64+arm64) → push
```

`docker:buildx` runs
`docker buildx build --platform linux/amd64,linux/arm64 … --push` — a multi-arch
build must `--push` the manifest directly (it cannot `--load` into the local
daemon). The Pi keeps pulling the arm64 variant from the same manifest; x86 sim
nodes pull amd64 automatically.

**Prerequisite — a buildx builder that supports multiple platforms.** The
default `docker` driver cannot build/push manifest lists. One-time setup on the
build machine:

```bash
docker buildx create --name borzoi --driver docker-container --use
docker run --privileged --rm tonistiigi/binfmt --install all   # QEMU for cross-arch
```

(or use a native amd64 builder / CI runner). Verify a published image is
multi-arch:

```bash
docker buildx imagetools inspect <registry>/borzoi-backend:latest
# → should list both linux/amd64 and linux/arm64
```

---

## What a sim node does *not* run

No `postgres`, `frontend`, or `nginx`; no DB-backup cron; no Cloudflare Tunnel.
It opens no inbound ports — all communication is outbound to the coordinator.
The only local surface is `/healthz`, used by the container healthcheck.
