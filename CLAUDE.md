# Voltini Hub deploy bundle (repo name: borzoi-deploy)

Self-contained deploy bundle for running the full Voltini Hub stack
(`borzoi-backend` + `borzoi-frontend` + TimescaleDB + nginx) on a single
host — typically a Raspberry Pi 4 or 5 in a customer's home. Images are
pulled from a private Amazon ECR registry using per-customer IAM credentials;
no source code or developer credentials live on the device.

Full operator/installer documentation lives in [`docs/`](docs/README.md) and
the top-level [`README.md`](README.md). This CLAUDE.md only exists to give
Claude Code context across the ecosystem.

---

## Remote reachability (Cloudflare Tunnel)

Hubs do **not** expose any inbound ports to the customer's router. Remote
access to the Hub — from the central backend and from the mobile app when
off-LAN — goes through an **outbound Cloudflare Tunnel** started by this
bundle. The Hub also stays reachable over the LAN directly (its LAN IP is
published to central via the backend's `about` endpoint).

Tunnel topology (2026-04-22):

- **Today:** Cloudflare-public. Each Hub has a `<hubid>.hubs.voltini.energy`
  hostname; clients reach the Hub with a central-issued SSO token.
- **Planned future direction:** terminate the tunnel at
  `voltini.energy-backend` so Hubs are only reachable *through* central.
  This is a config change in this bundle (tunnel target + DNS) plus a
  change to what URL central publishes in the `installation` record — no
  application-code change on either side.

---

## Voltini ecosystem

**Voltini** is an intelligent energy management system for Swedish homes with
solar, home batteries, EVs, and heat pumps. It runs on a Raspberry Pi "Hub"
in each customer home (this bundle is what brings that stack up) and
coordinates with a central cloud service that installers use to manage their
catalogue of Hubs.

> **Naming note.** `borzoi-*` is the historical name for what is now marketed
> as **Voltini**. Repo names and image names are kept for now to avoid
> disrupting deployed Hubs; **customer-facing text must never say "Borzoi"**
> — always "Voltini". That covers the customer credentials packet, setup
> instructions, nginx welcome pages, anything printed by `setup.sh` that a
> non-technical customer might see.

### Repositories

**Central (cloud, Digistrada-hosted)**
- `voltini.energy` — Marketing site + installer portal UI.
- `voltini.energy-backend` — Installer/installation catalogue, SSO minter.
- `voltini.energy-common` — Central-side shared models.

**End user**
- `voltini-app` — End-user mobile app (customer-facing).

**Per-customer Hub (Raspberry Pi)**
- `borzoi-backend` — Hub backend (Docker image pulled by this bundle).
- `borzoi-frontend` — Installer/tech admin UI (Docker image pulled by this
  bundle).
- `borzoi-common` — Hub-side shared models.
- **`borzoi-deploy` — YOU ARE HERE.** Docker-Compose + nginx + TimescaleDB
  bundle. The thing that actually runs on the Pi.
- `borzoi-homeassistant`, `borzoi-homey` — integrations that talk to a Hub.

**Shared infrastructure**
- `theworks-common`, `theworks-be`, `theworks-fe`, `theworks-app`.

### What this bundle does, in one line

`setup.sh` on a fresh Raspberry Pi → Docker Compose pulls Hub images from
ECR → TimescaleDB comes up → `borzoi-backend` + `borzoi-frontend` come up
behind nginx with Let's Encrypt TLS → the Hub is reachable on the LAN and
(after registration) to the central backend for SSO.
