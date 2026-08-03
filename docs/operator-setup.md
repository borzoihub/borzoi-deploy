# Operator setup (one-time)

Work you do **once**, before any customer installation.

Images live in **GitHub Container Registry** (`ghcr.io/borzoihub`) and are built
and published by each repo's GitHub Actions workflow. You do not build or push
images by hand. Image distribution is **entirely a GitHub concern** — a single
GitHub machine account and its pull token, no registry IAM user and nothing
per-customer. (AWS still appears elsewhere on a Hub, for the nightly database
backup, but never for pulling images — see
[connection-key.md](connection-key.md).)

## Prerequisites

- Owner/admin on the `borzoihub` GitHub org
- A GitHub account with access to the `@borzoihub/*` and `@digistrada/*` npm
  packages
- Docker Desktop (or equivalent) — only if you want to build images locally;
  CI does it otherwise

## 1. The machine account and its pull token

Every Pi authenticates to `ghcr.io` as a machine account. `voltini-autobot` is a
member of `borzoihub` and holds a **classic PAT with `read:packages` and nothing
else**, deliberately set never to expire so it cannot lapse on a fleet nobody is
watching.

This token is what `setup.sh` asks for, and it goes into `GHCR_TOKEN` in each
Pi's `.env`.

> **It is transitional.** A shared token has no per-Hub revocation, and rotating
> it means touching every Pi. Once a Hub has its own connection key, the update
> scripts broker a short-lived token instead and this one becomes a fallback —
> see [connection-key.md](connection-key.md). With two Hubs in the operator's
> own home it is proportionate; it stops being proportionate once the fleet is
> in customers' houses.

## 2. Local build token (only if you build by hand)

The Dockerfiles use a BuildKit secret to auth against GitHub Packages during
`npm ci`. It is never baked into the image.

```bash
echo "ghp_your_token_here" > ~/.borzoi-github-packages-token
chmod 600 ~/.borzoi-github-packages-token
```

Needed only for local builds (e.g. `npm run docker:build:sim`). CI uses its own
credentials.

## 3. Publishing images

CI does it. Each of `borzoi-backend` and `borzoi-frontend` has a
`.github/workflows/deploy.yml` that builds **multi-arch** (`linux/amd64` +
`linux/arm64`, one runner per platform rather than QEMU emulation) and pushes to
`ghcr.io/borzoihub/<name>`.

```bash
cd /path/to/borzoi-backend
npm version patch        # or minor/major
git push --follow-tags   # CI builds and publishes
```

A Pi only ever pulls. Nothing on the host builds anything, which is why the
`updater` sidecar is the one image built locally (`pull_policy: build`) — it
must never be fetched from a registry.

## 4. Central infrastructure

For the S3 bucket and IAM role behind Hub backups, run the provisioning script
in the central backend repo — the only place AWS still appears in this system:

```bash
cd /path/to/voltini.energy-backend
./scripts/setup-hub-backup-aws.sh \
    --bucket voltini-hub-backups \
    --central-principal arn:aws:iam::<account>:user/voltini-backend
```

Details, including why the role must stay narrow:
[`voltini.energy-backend/docs/HUB_CREDENTIAL_BROKER.md`](../../voltini.energy-backend/docs/HUB_CREDENTIAL_BROKER.md).

## 5. Host the deploy bundle

Customer Pis clone `borzoi-deploy`. A public repo is simplest — it contains no
secrets, only the compose file and setup scripts.

```bash
# In borzoi-deploy/install.sh
BORZOI_DEPLOY_REPO="${BORZOI_DEPLOY_REPO:-https://github.com/borzoihub/borzoi-deploy.git}"
```

## 6. Credential rotation

| Credential | Where | Rotating it |
|---|---|---|
| Hub connection key | per Hub, `VOLTINI_HUB_SECRET` | installer portal → **Byt nyckel**, then `set-hub-secret.sh` on the Pi. Per-Hub, safe on a live site. See [connection-key.md](connection-key.md). |
| `GHCR_TOKEN` | shared, every Pi | regenerate on `voltini-autobot` and update every `.env`. This is the pain the connection key removes — retire it per Hub as each adopts a key. |
| GitHub App key (registry brokering) | central only | regenerate in the App's settings; no Pi is touched. |

There are **no AWS credentials on any Pi** to rotate. The nightly backup fetches
short-lived ones from central per run.
