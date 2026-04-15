# Borzoi deployment documentation

Complete guide to deploying Borzoi on a Raspberry Pi 4 or 5.

## For operators (one-time setup)

Do these once before onboarding any customer.

1. **[Architecture overview](architecture.md)** — how the pieces fit together
2. **[Operator setup](operator-setup.md)** — create ECR repos, build & push images, set up the shared installer IAM user

## Per-customer onboarding

For each new customer Pi you deploy:

3. **[Customer onboarding](customer-onboarding.md)** — create the customer's IAM user, assemble their credentials packet
4. **[Installation guide](installation.md)** — end-to-end walkthrough from a fresh Raspberry Pi OS install to first login
5. **[Cloudflare Tunnel](cloudflare-tunnel.md)** — default public-exposure model
6. **[TLS setup](tls.md)** — only for direct-internet installs (not recommended)

## Operations

6. **[Updating](updating.md)** — roll out a new release, pin a version, roll back
7. **[Troubleshooting](troubleshooting.md)** — diagnosing common problems

## Quick reference

| Concern | File |
|---|---|
| Deployment architecture (what runs where) | [architecture.md](architecture.md) |
| Building and publishing images | [operator-setup.md](operator-setup.md#publishing-images) |
| Per-customer IAM setup | [customer-onboarding.md](customer-onboarding.md#creating-the-app-iam-user) |
| Fresh Pi install, step by step | [installation.md](installation.md) |
| `setup.sh` interactive prompts | [installation.md#running-setupsh](installation.md#running-setupsh) |
| Public exposure via Cloudflare | [cloudflare-tunnel.md](cloudflare-tunnel.md) |
| Direct-internet TLS (rare) | [tls.md](tls.md) |
| Updates and rollback | [updating.md](updating.md) |
| ECR pull failures | [troubleshooting.md#ecr-pull-failures](troubleshooting.md#ecr-pull-failures) |
| Scheduler not activating | [troubleshooting.md#backend-logs-waiting-for-required-settings](troubleshooting.md#backend-logs-waiting-for-required-settings) |
