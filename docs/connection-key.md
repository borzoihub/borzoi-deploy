# Hub connection key

The single credential a Hub holds for Voltini central. It removes the AWS key
that would otherwise sit on an SD card in a customer's house: instead of holding
a cloud key forever, the Pi holds one key for *central* and exchanges it, on
demand, for short-lived access scoped to this Hub alone.

Central-side design and API:
[`voltini.energy-backend/docs/HUB_CREDENTIAL_BROKER.md`](../../voltini.energy-backend/docs/HUB_CREDENTIAL_BROKER.md).

## What it is used for

| Use | How |
|---|---|
| Upload nightly backups | the `db-backup` service sets `AWS_CONTAINER_CREDENTIALS_FULL_URI`, and the AWS CLI fetches credentials itself |

That is the whole list.

**It is not used to pull images.** It was meant to be — the original design
brokered a short-lived per-Hub registry token, and `scripts/broker.sh` existed
to fetch it. That was removed on 2026-07-31: GHCR accepts a classic PAT or an
Actions `GITHUB_TOKEN` and nothing else, so no credential central can mint will
ever work there. Measured, not assumed — a correctly configured GitHub App
minted tokens fine and got `403` on every manifest read, while a classic PAT got
`200`. Confirmed by GitHub staff as a platform limitation:
<https://github.com/orgs/community/discussions/171423>.

Image pulls use `GHCR_TOKEN` from `.env`, shared across the fleet, and will keep
doing so.

## Deploy/infra layer only — never the application

The Voltini architecture says the Hub never originates traffic to central (JWKS
excepted). That was amended on 2026-07-30 to permit **one** scoped, revocable
central credential, used **only by the deploy/infra layer** — these scripts and
the compose env, never `borzoi-backend/src`. A CI check over that source tree
enforces it. If you find yourself wanting this value inside the application,
stop: the exception was granted on the basis that it stays out.

## Installing it

Issue the key in the installer portal (installation → **Nyckel** → *Skapa
nyckel*). It is shown once. Then, on the Pi:

```bash
cd /opt/borzoi
./scripts/set-hub-secret.sh          # prompts, hidden input
./scripts/set-hub-secret.sh --check  # report state, change nothing
```

The script validates the format, backs up `.env`, writes the key, confirms it
against central, and restarts only the services that read it. A failed
confirmation restores the backup, so a mistyped key leaves the Hub exactly as it
was.

**It deliberately does not restart the backend or the database.** A credential
change must never interrupt the control loop, which does not read this value.

## Replacing it

Portal → **Byt nyckel**, then run `set-hub-secret.sh` again with the new value.

Replacing is safe on a site in service, and worth understanding so you don't
avoid it:

1. Central refuses to start a replacement unless the Hub answers a live check.
2. The **current key keeps working** while the new one is staged.
3. Only when the Hub has actually authenticated with the new key does central
   retire the old one.
4. If that never happens, the staged key lapses after 24 h and the Hub carries
   on with what it had.

So a failed or abandoned replacement costs nothing, and there is no state in
which the Hub holds a key central will not accept.

**This is why `set-hub-secret.sh` writes `.env` before confirming**, which looks
backwards. The confirmation call *is* what completes the handover at central, so
confirming first would retire the old key before the new one was on disk.
Writing first is safe precisely because both keys work during the window.

## If a key may have leaked

Portal → **Spärra nyckel**, then *Skapa nyckel* and deliver the new one by hand.

Do **not** reach for replace here. A replacement is fetched by the Hub using its
current key, so anyone holding the leaked key could obtain the replacement too.
Blocking first is what makes the old key useless.

## Cloud backups

Off unless enabled. A Hub without a key keeps using the local-only
`scripts/db-backup.sh`.

```dotenv
COMPOSE_PROFILES=cloud-backup
BACKUP_S3_BUCKET=<the Voltini backup bucket>
VOLTINI_INSTALLATION_ID=<this Hub's id — also its S3 key prefix>
```

```bash
docker compose up -d db-backup
```

There is **no AWS key on the Pi**. `db-backup` runs the generic
`theworks-db-backup` image, which contains no Voltini code and needs none: the
two `AWS_CONTAINER_*` variables are an AWS-standard mechanism that the AWS CLI
resolves by itself. Central authenticates that fetch with the connection key and
returns credentials confined to `s3://<bucket>/<installation-id>/*`, so a
compromised Hub can write to its own prefix and nowhere else.

`VOLTINI_INSTALLATION_ID` must match the id embedded in the key, or every upload
fails with `AccessDenied`.

### The nightly bundle contains this key

`theworks-db-backup` tars everything under `/host` — here, `.env` — so the
bundle carries `JWT_SECRET`, the DB password, the admin password **and
`VOLTINI_HUB_SECRET` itself**. That is what makes a dead Pi recoverable, and it
is a deliberate decision, but it means a leaked bundle hands over this Hub's
central credential along with its database. **Rotate the key after any restore.**

## The static registry token — permanent, not transitional

`GHCR_TOKEN` in `.env` is a shared `read:packages` classic PAT with no expiry
and no per-Hub revocation. It is what pulls images, on every Hub, always.

**Do not blank it** (revised 2026-07-31). The plan was to retire it per Hub once
the portal showed a recent *Senast använd*. That is not achievable: GHCR accepts
a classic PAT or an Actions `GITHUB_TOKEN` and nothing else, so there is no
brokered credential to move to and never will be without a change at GitHub.

Accepted consequences, stated plainly so nobody re-opens this expecting a win:

- The same credential is on every Hub. A stolen Pi exposes it fleet-wide.
- Rotating it means updating every Hub's `.env`.
- Blocking one Hub's connection key does **not** stop it pulling images.

*Senast använd* still tells you the Hub reached central and its key works — that
part is real, and it is what gates cloud backups. It says nothing about image
pulls.

## Troubleshooting

| Symptom | Cause |
|---|---|
| `docker login … failed` during an update | `GHCR_TOKEN` is unset, mistyped, or was regenerated on `voltini-autobot`. Test it by hand: `printf '%s' "$GHCR_TOKEN" \| docker login ghcr.io -u "$GHCR_USER" --password-stdin`. |
| Cloud backup returns HTTP 401 | key wrong, or blocked in the portal. Issue a new one. |
| Cloud backup returns HTTP 503 | central is up and has accepted the key — it just has no backup bucket/role provisioned yet. `set-hub-secret.sh` treats this as proof the key is good. |
| Backups fail `AccessDenied` | `VOLTINI_INSTALLATION_ID` does not match the key's installation. |
| Backups fail `RequestTimeTooSkewed` | the Pi's clock is off by more than 15 min. A Pi has no RTC; after a power cut it can boot weeks in the past until NTP syncs. Self-heals. |
| Everything HTTPS fails after a long outage | same clock problem — a stale clock rejects certificates issued during the outage as "not yet valid". Self-heals once NTP syncs; the updater retries every 10 s. |
