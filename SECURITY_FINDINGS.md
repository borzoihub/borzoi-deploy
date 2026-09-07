# Security findings — borzoi-deploy

This file lists security findings from the recurring audit (case #87) that were
**not** auto-fixed because they are scope-heavy, would change application
behaviour, or require a human decision. Auto-fixable findings were fixed in the
same run and are not listed here.

## Findings requiring human decision

### 1. TimescaleDB image pinned to an older exact patch — `timescale/timescaledb:2.17.2-pg16`
- **Severity:** Medium
- **Pass:** B3 (container / OS vulnerabilities)
- **Where:** `docker-compose.yml` line 5
- **Found:** The database image is pinned to the exact patch `2.17.2-pg16`.
  Newer TimescaleDB/Postgres patch releases fix OS- and engine-layer CVEs.
- **Why not auto-fixed:** A version bump of the database engine is a
  behaviour-relevant change — it affects on-disk data-directory compatibility
  and the TimescaleDB extension, and on a Raspberry Pi with SD storage a bad
  upgrade is hard to recover. This is not a safe drop-in.
- **Fix would require:** A human to select a validated newer `*-pg16` tag,
  confirm data-directory compatibility, and roll it out through the normal OTA
  path with a backup in place.

### 2. OTA updater sidecar runs as root (no non-root `USER`)
- **Severity:** Low
- **Pass:** B3 (container hardening)
- **Where:** `updater/Dockerfile` (no `USER` directive)
- **Found:** The updater image has no non-root `USER`, so the container runs as
  root.
- **Why not auto-fixed:** The sidecar is root **by design** — it mounts the
  host Docker socket to drive `docker compose`, and uses `setpriv`
  (util-linux) to drop to the host checkout's owner for `git`. Forcing a
  non-root `USER` would break OTA upgrades. This is a behaviour change.
- **Fix would require:** A redesign of the OTA privilege model (e.g. a socket
  proxy / rootless Docker), which is a structural change and a human decision.

### 3. Container images pinned by tag, not by digest
- **Severity:** Low
- **Pass:** B3 (supply chain)
- **Where:** `docker-compose.yml` (`nginx:1.27-alpine`,
  `timescale/timescaledb:2.17.2-pg16`,
  `ghcr.io/digistrada/theworks-db-backup:${DB_BACKUP_TAG:-latest}`,
  `${REGISTRY}/borzoi-backend`, `${REGISTRY}/borzoi-frontend`),
  `docker-compose.sim.yml`, and `updater/Dockerfile` (`debian:bookworm-slim`).
- **Found:** All images are referenced by mutable tag rather than by immutable
  `@sha256:` digest; several service tags fall back to `:-latest` when the
  corresponding `*_TAG` variable is unset in `.env`.
- **Why not auto-fixed:** Digest pinning is explicitly a human call
  (per the audit's B3 rule), and it conflicts with the OTA model, which pulls
  operator-selected tags at update time. Hard-pinning digests here would freeze
  the fleet's update mechanism.
- **Fix would require:** A human decision on a digest-pinning strategy
  compatible with OTA (e.g. central publishing digests alongside tags), plus
  ensuring `BACKEND_TAG` / `FRONTEND_TAG` / `DB_BACKUP_TAG` are always set to a
  concrete tag so the `:-latest` fallback is never used in production.

### 4. nginx: Content-Security-Policy and HSTS not set
- **Severity:** Low
- **Pass:** B4 (security misconfiguration)
- **Where:** `nginx/templates/default.conf.template`
- **Found:** `X-Content-Type-Options`, `X-Frame-Options` and `Referrer-Policy`
  were added in this run (safe drop-ins). A Content-Security-Policy and
  Strict-Transport-Security header are still absent.
- **Why not auto-fixed:**
  - **CSP** cannot be added blind without risking breakage of the Angular admin
    UI (inline styles/scripts, asset origins) — it needs a policy authored and
    tested against the actual frontend build.
  - **HSTS** must **not** be set at this layer: the Hub is also served over
    plain HTTP on the customer LAN (nginx listens on `127.0.0.1:8080`, TLS is
    terminated upstream by the Cloudflare Tunnel). An HSTS header would force
    HTTPS upgrades and break LAN access. If wanted, it belongs at the edge.
- **Fix would require:** A human to author and test a CSP against the frontend,
  and to decide HSTS placement at the TLS-terminating edge.

## Audit metadata
- **Run completed:** 2026-09-07
- **Repo:** borzoi-deploy (Docker Compose + nginx + shell deploy bundle)
- **Passes run:** B1 (secrets — clean: no `.env` or credentials committed to the
  working tree or across git history), B2 (dependency vulns — N/A, no
  `package.json`), B3 (containers — see findings 1–3), B4 (misconfiguration —
  headers hardened; CSP/HSTS flagged, see finding 4), B5 (CI/CD — N/A, no
  GitHub Actions workflows in repo), B6 (logging/data leakage — no secrets or
  PII found in log statements or error output).
