#!/usr/bin/env bash
set -euo pipefail

# ============================================================================
# checksimver.sh — report the sim node's running borzoi-backend version vs the
# latest published version in the registry. Read-only; run on the sim node itself.
#
# "Local" is read straight from the running `borzoi-sim` container. "Latest" is
# the version inside the published `latest` image, resolved by pulling it and
# reading its package.json. Auth comes from the `ghcr.io` entry that
# setup.sh/install-sim.sh wrote to ~/.docker/config.json.
#
# Usage: ./checksimver.sh
# ============================================================================

cd "$(dirname "$0")"

err()  { echo "ERROR: $*" >&2; }

COMPOSE_FILE_SIM="docker-compose.sim.yml"

if [ ! -f .env ]; then
  err ".env not found — run this from the borzoi-deploy clone (where install-sim.sh ran)."
  exit 1
fi

set -a
# shellcheck disable=SC1091
source .env
set +a

if [ -z "${REGISTRY:-}" ]; then
  err "REGISTRY not set in .env."
  exit 1
fi

# ---------- local (running) version -----------------------------------------

LOCAL_VER="$(docker exec borzoi-sim node -p "require('./package.json').version" 2>/dev/null || true)"
[ -z "$LOCAL_VER" ] && LOCAL_VER="(sim container not running)"

# ---------- latest published version ----------------------------------------

# GHCR has no one-liner that reads the semver tag riding on `latest` using only
# a read:packages token, so we pull and read the version out of the image
# itself. That is authoritative rather than inferred from tags, which is what we
# want anyway — the tag can lie, `package.json` in the image cannot.
echo "Resolving latest published version..."
docker compose -f "$COMPOSE_FILE_SIM" pull sim >/dev/null 2>&1 || true
LATEST_VER="$(docker run --rm --entrypoint node \
    "$REGISTRY/borzoi-backend:latest" \
    -p "require('./package.json').version" 2>/dev/null || true)"
[ -z "$LATEST_VER" ] && LATEST_VER="(unknown)"

# ---------- report ----------------------------------------------------------

echo
echo "  Local (running):  $LOCAL_VER"
echo "  Latest (published): $LATEST_VER"
echo

if [ "$LOCAL_VER" = "$LATEST_VER" ]; then
  echo "  → up to date"
elif [ "$LATEST_VER" = "(unknown)" ] || [ "$LOCAL_VER" = "(sim container not running)" ]; then
  echo "  → could not compare"
else
  echo "  → a newer version is published (run ./update-sim.sh to install it)"
fi
