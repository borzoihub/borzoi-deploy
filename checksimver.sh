#!/usr/bin/env bash
set -euo pipefail

# ============================================================================
# checksimver.sh — report the sim node's running borzoi-backend version vs the
# latest published version in ECR. Read-only; run on the sim node itself.
#
# "Local" is read straight from the running `borzoi-sim` container. "Latest" is
# the semver tag riding on the ECR `latest` image — queried via aws-cli when
# available (no image pull), otherwise resolved by pulling `latest` and reading
# its package.json (the docker credential helper handles auth either way).
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

if [ -z "${ECR_REGISTRY:-}" ]; then
  err "ECR_REGISTRY not set in .env."
  exit 1
fi

# ---------- local (running) version -----------------------------------------

LOCAL_VER="$(docker exec borzoi-sim node -p "require('./package.json').version" 2>/dev/null || true)"
[ -z "$LOCAL_VER" ] && LOCAL_VER="(sim container not running)"

# ---------- latest published version in ECR ---------------------------------

REGION="$(printf '%s' "$ECR_REGISTRY" | cut -d. -f4)"
LATEST_VER=""

if command -v aws >/dev/null 2>&1; then
  # No pull: read the tags on the `latest` image and pick the semver sibling.
  LATEST_VER="$(aws ecr describe-images \
      --profile borzoi-ecr --region "$REGION" \
      --repository-name borzoi-backend \
      --image-ids imageTag=latest \
      --query 'imageDetails[0].imageTags' --output text 2>/dev/null \
    | tr '\t' '\n' | grep -E '^[0-9]+\.[0-9]+\.[0-9]+' | sort -V | tail -1 || true)"
fi

if [ -z "$LATEST_VER" ]; then
  # Fallback (no aws-cli, or the query found no semver tag): pull + read.
  echo "Resolving latest via docker pull (aws-cli unavailable or no semver tag)..."
  docker compose -f "$COMPOSE_FILE_SIM" pull sim >/dev/null 2>&1 || true
  LATEST_VER="$(docker run --rm --entrypoint node \
      "$ECR_REGISTRY/borzoi-backend:latest" \
      -p "require('./package.json').version" 2>/dev/null || true)"
fi
[ -z "$LATEST_VER" ] && LATEST_VER="(unknown)"

# ---------- report ----------------------------------------------------------

echo
echo "  Local (running):  $LOCAL_VER"
echo "  Latest (ECR):     $LATEST_VER"
echo

if [ "$LOCAL_VER" = "$LATEST_VER" ]; then
  echo "  → up to date"
elif [ "$LATEST_VER" = "(unknown)" ] || [ "$LOCAL_VER" = "(sim container not running)" ]; then
  echo "  → could not compare"
else
  echo "  → a newer version is published (run ./update-sim.sh to install it)"
fi
