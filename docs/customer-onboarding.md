# Customer onboarding

Per-install checklist for the operator.

There is **no per-customer cloud account of any kind** — no IAM user, no bucket,
no SES identity. A Hub holds exactly one credential for Voltini (its connection
key) and exchanges it for whatever short-lived access it needs. Onboarding is
correspondingly light.

## 1. Register the installation in the portal

Create the installation in the installer portal first — it assigns the numeric
installation id that everything else keys off, including the S3 prefix its
backups land under.

## 2. Choose a hostname

Pick a short, URL-safe identifier (e.g. `joakim`, `forsmark`, `acme`). The public
hostname is `<installation-id>.voltini.cloud`. Naming convention and reserved
subdomains: [cloudflare-tunnel.md](cloudflare-tunnel.md).

## 3. Issue the connection key

Portal → the installation → **Nyckel** → *Skapa nyckel*. **It is shown once.**

Full lifecycle — replacing it safely on a live site, blocking a leaked one:
[connection-key.md](connection-key.md).

## 4. Assemble the credentials packet

A text file to hand to the installer. Delete it from your machine after
delivery; keep a copy only in your password manager.

```
================================================================
Voltini installation credentials — KEEP SECRET
================================================================

Customer:         Acme Heating
Installation ID:  42
Public hostname:  acme.voltini.cloud
Pi hardware:      Raspberry Pi 5, 8GB

─── Registry pull token (shared — same for every site) ───
GHCR_USER=voltini-autobot
GHCR_TOKEN=ghp_...

─── Connection key (unique to THIS installation) ───
vhs_42_...

─── Bootstrap admin ───
Admin email:      admin@acme.example (or the customer's own)
(password is auto-generated during setup.sh and printed once)

─── Cloudflare Tunnel ───
Tunnel token:     <paste from Zero Trust dashboard>
================================================================
```

## 5. Hand off

The installer uses the packet during [installation](installation.md). Once the
Pi is up, run `./scripts/set-hub-secret.sh` to install the connection key.

Confirm afterwards that the portal shows a time under **Senast använd** for that
installation — that is how you know the Hub really picked the key up, rather than
one merely having been created for it.

## If a Pi is stolen, decommissioned or compromised

1. **Block its connection key** — portal → **Spärra nyckel**. Immediate, and it
   affects no other site. That Hub can no longer pull images or upload backups.
2. Wipe the Pi.
3. Consider the `.env` compromised in full: it carries `JWT_SECRET`, the DB
   password and the bootstrap admin password. None of them reach beyond that
   Hub, but nothing about them expires on its own.

Note the nightly backup bundle contains that same `.env`, so **rotate a Hub's
key after restoring one onto new hardware**.

The shared `GHCR_TOKEN` is the one credential a single stolen Pi exposes
fleet-wide, since every Pi holds the same one. There is no way to narrow that:
GHCR accepts only a classic PAT or an Actions `GITHUB_TOKEN`, so a per-Hub
registry credential is not possible and blocking a Hub's connection key does not
stop it pulling images. Rotating means updating every Hub's `.env`. See
[connection-key.md](connection-key.md).
