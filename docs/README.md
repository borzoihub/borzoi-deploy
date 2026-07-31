# Borzoi deployment documentation

Complete guide to deploying Borzoi on a Raspberry Pi 4 or 5.

## For operators (one-time setup)

Do these once before onboarding any customer.

1. **[Architecture overview](architecture.md)** — how the pieces fit together
2. **[Operator setup](operator-setup.md)** — the GHCR machine account, how CI publishes images, central's AWS provisioning

## Per-customer onboarding

For each new customer Pi you deploy:

3. **[Customer onboarding](customer-onboarding.md)** — register the installation, issue its connection key, assemble the credentials packet
4. **[Installation guide](installation.md)** — end-to-end walkthrough from a fresh Raspberry Pi OS install to first login
5. **[Cloudflare Tunnel](cloudflare-tunnel.md)** — default public-exposure model
6. **[TLS setup](tls.md)** — only for direct-internet installs (not recommended)

## Simulation nodes

8. **[Sim nodes](sim-nodes.md)** — install a simulation worker (`BORZOI_MODE=sim`), its OTA flow, and publishing the multi-arch image

## Operations

6. **[Updating](updating.md)** — roll out a new release, pin a version, roll back
7. **[Connection key](connection-key.md)** — the Hub's one credential for Voltini: installing it, replacing it safely on a live site, blocking a leaked one, and enabling cloud backups
8. **[Troubleshooting](troubleshooting.md)** — diagnosing common problems

## Quick reference

| Concern | File |
|---|---|
| Deployment architecture (what runs where) | [architecture.md](architecture.md) |
| Building and publishing images | [operator-setup.md](operator-setup.md#3-publishing-images) |
| Issuing a Hub's connection key | [customer-onboarding.md](customer-onboarding.md#3-issue-the-connection-key) |
| Fresh Pi install, step by step | [installation.md](installation.md) |
| `setup.sh` interactive prompts | [installation.md#running-setupsh](installation.md#running-setupsh) |
| Public exposure via Cloudflare | [cloudflare-tunnel.md](cloudflare-tunnel.md) |
| Direct-internet TLS (rare) | [tls.md](tls.md) |
| Updates and rollback | [updating.md](updating.md) |
| Installing / replacing / blocking a Hub's connection key | [connection-key.md](connection-key.md) |
| Nightly backups to Voltini's S3 bucket | [connection-key.md#cloud-backups](connection-key.md#cloud-backups) |
| Install a simulation worker node | [sim-nodes.md](sim-nodes.md) |
| Publishing a multi-arch image | [sim-nodes.md#operator-publishing-a-multi-arch-image](sim-nodes.md#operator-publishing-a-multi-arch-image) |
| Registry pull failures | [troubleshooting.md#registry-pull-failures](troubleshooting.md#registry-pull-failures) |
| Scheduler not activating | [troubleshooting.md#backend-logs-waiting-for-required-settings](troubleshooting.md#backend-logs-waiting-for-required-settings) |
