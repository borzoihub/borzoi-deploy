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
- **Pull a prebuilt multi-arch image** from GHCR (amd64 or arm64 automatically).
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

`install-sim.sh` obtains the **sim bundle** (see below), then writes `.env`
(mode 0600), logs in to `ghcr.io`, pulls the sim image, and brings
up two containers (`borzoi-sim` + `borzoi-sim-updater`) defined in
[`docker-compose.sim.yml`](../docker-compose.sim.yml).

For fleet rollout, skip the paste — pass the bundle non-interactively:

```bash
./install-sim.sh sim-bundle.json          # file argument
SIM_BUNDLE_FILE=/path/sim-bundle.json ./install-sim.sh
SIM_BUNDLE_JSON="$(cat sim-bundle.json)" ./install-sim.sh
```

The node should appear on the Background jobs page within a minute.

```bash
docker compose -f docker-compose.sim.yml ps          # status
docker compose -f docker-compose.sim.yml logs -f sim # logs
```

> `.env` sets `COMPOSE_FILE=docker-compose.sim.yml`, so plain
> `docker compose …` commands run from the repo also target the sim stack.

### The sim bundle

A flat JSON the operator builds **once on their own machine** and reuses across
every node. It is **not** new credentials — it's the **same registry pull token**
your Hubs use, plus the coordinator URL and one worker token:

```json
{
  "registry":          "ghcr.io/borzoihub",
  "ghcr_user":         "voltini-autobot",
  "ghcr_token":        "ghp_...",
  "coordinator_url":   "https://api.voltini.energy",
  "worker_token":      "<long-lived WorkerService JWT>"
}
```

Build it with one command (reuses `installer-creds.json` and mints the worker
token for you):

```bash
./make-sim-bundle.sh
#   → reuses installer-creds.json (registry pull token)
#   → mints a Production WorkerService token via ../voltini.energy-backend
#   → writes sim-bundle.json (mode 600)
```

Flags: `--voltini-dir <path>` if that repo isn't a sibling, `--deployment Local`
+ `--coordinator <url>` for a non-prod fleet, or `--token <JWT>` / `$WORKER_TOKEN`
to **reuse** an existing token instead of minting a new one.

Minting needs that environment's **DB access** *and* its **`JWT_SECRET`** (the
token is signed with it, and the secret is injected from the environment rather
than living in any config file). So either run with the secret in the shell:

```bash
JWT_SECRET='<prod jwt secret>' ./make-sim-bundle.sh
```

or mint on the prod host (where `JWT_SECRET` already lives) and pass the result:

```bash
./make-sim-bundle.sh --token '<JWT minted on prod>'
```

- `registry` / `ghcr_user` / `ghcr_token` — the same `read:packages` pull token
  every Hub uses. If `installer-creds.json` isn't on this machine, copy the
  `REGISTRY` / `GHCR_USER` / `GHCR_TOKEN` lines from any deployed Hub's
  `/opt/borzoi/.env`. See [customer-onboarding.md](customer-onboarding.md).

  > A sim node is operator-run infrastructure, not a customer Hub, so it gets no
  > connection key — it has no database to back up and nothing per-installation
  > to scope.
- `coordinator_url` — the central job-queue base URL (prod:
  `https://api.voltini.energy`).
- `worker_token` — a 180-day WorkerService JWT minted by central; authenticates
  the node's `claim`/`heartbeat`/`result` calls. It is **environment-bound**
  (a `Production` token only works against the prod coordinator) and **shared**
  across the fleet — re-minting means rolling the new value to every node's
  `.env` (`JOB_AUTH_TOKEN`). Central emails ops ~21 days before expiry.

Then install nodes with `./install-sim.sh sim-bundle.json` (no pasting). The
installer also asks for a **node id** (defaults to the hostname; shown on the
Background jobs page) and an optional **max concurrent** (blank = cores−1) —
both are skipped when sourced non-interactively (defaults apply).

---

## OTA updates

OTA is **identical to the full Hub from `data/upgrade/request.json` onward** —
same `updater` sidecar ([`scripts/updater.sh`](../scripts/updater.sh)), same
registry-login → pull → recreate sequence, same `status.json`. Only two things differ:

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

Sim nodes run on mixed hardware (x86_64 cloud/desktops **and** arm64), so the
registry must serve a **multi-arch manifest** for `borzoi-backend`.

CI already does this. `borzoi-backend`'s `.github/workflows/deploy.yml` builds
each platform on its own native runner (rather than emulating one under QEMU)
and pushes a combined manifest to `ghcr.io/borzoihub/borzoi-backend`:

```bash
cd /path/to/borzoi-backend
npm version patch
git push --follow-tags   # CI builds amd64 + arm64 and publishes
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
