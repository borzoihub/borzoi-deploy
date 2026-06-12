#!/usr/bin/env bash
set -euo pipefail

# ============================================================================
# Build a sim-bundle.json for sim-node installs — run ONCE on the operator
# machine, then reuse the output for every node.
#
# It REUSES your existing shared ECR installer credentials (the same ones your
# Hubs use) and MINTS the WorkerService token for you. There is NO new AWS
# credential, no aws-setup.sh, no new IAM key, and no separate manual mint step.
#
# Usage:
#   ./make-sim-bundle.sh [--creds <installer-creds.json>]
#                        [--coordinator <url>]
#                        [--voltini-dir <path>] [--deployment <name>]
#                        [--token <JWT>]            # reuse instead of minting
#                        [--out <sim-bundle.json>]
#
# Inputs:
#   ECR creds   → installer-creds.json (default; fields ecr_region /
#                 ecr_registry / access_key_id / secret_access_key). If it's not
#                 here, copy it from your password manager or any deployed Hub
#                 (~/.aws/credentials [borzoi-ecr] + ECR_REGISTRY in
#                 /opt/borzoi/.env) — it's the same shared credential.
#   coordinator → committed prod value https://api.voltini.energy
#                 (override with --coordinator for a non-prod fleet).
#   worker token→ MINTED automatically by running
#                   voltini.energy-backend/scripts/mint-sim-worker-token.ts
#                 against --deployment (default Production). Requires that repo
#                 (default ../voltini.energy-backend) and DB/config access for
#                 that environment. The token is shared by the whole fleet and
#                 lasts ~180 days; one bundle is reused across all nodes.
#                 Pass --token / $WORKER_TOKEN to REUSE an existing token
#                 instead of minting a new one.
#
# NOTE: the token env must match the coordinator env — a Production token only
# validates against the prod coordinator. Keep --deployment and --coordinator
# consistent (both prod by default).
#
# Output sim-bundle.json (mode 600) is what install-sim.sh consumes:
#   ./install-sim.sh sim-bundle.json
# ============================================================================

CREDS="installer-creds.json"
COORDINATOR_URL="https://api.voltini.energy"
VOLTINI_DIR="../voltini.energy-backend"
DEPLOYMENT="Production"
TOKEN="${WORKER_TOKEN:-}"
OUT="sim-bundle.json"

while [ $# -gt 0 ]; do
  case "$1" in
    --creds)        CREDS="$2"; shift 2 ;;
    --coordinator)  COORDINATOR_URL="$2"; shift 2 ;;
    --voltini-dir)  VOLTINI_DIR="$2"; shift 2 ;;
    --deployment)   DEPLOYMENT="$2"; shift 2 ;;
    --token)        TOKEN="$2"; shift 2 ;;
    --out)          OUT="$2"; shift 2 ;;
    -h|--help)      sed -n '2,46p' "$0"; exit 0 ;;
    *)              echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
done

command -v jq >/dev/null 2>&1 || { echo "ERROR: jq is required (brew install jq)." >&2; exit 1; }

if [ ! -r "$CREDS" ]; then
  echo "ERROR: ECR creds file not found: $CREDS" >&2
  echo "  This is the SAME shared installer credential your Hubs use — reuse it," >&2
  echo "  don't create a new one. Point --creds at your installer-creds.json, or" >&2
  echo "  copy it from a deployed Hub (~/.aws/credentials [borzoi-ecr] + the" >&2
  echo "  ECR_REGISTRY line in /opt/borzoi/.env)." >&2
  exit 1
fi

# Validate the creds file has the four ECR fields.
for f in ecr_region ecr_registry access_key_id secret_access_key; do
  v=$(jq -r --arg f "$f" '.[$f] // empty' "$CREDS")
  [ -n "$v" ] || { echo "ERROR: $CREDS missing field: $f" >&2; exit 1; }
done

# --- worker token: mint it (default) or reuse a provided one ----------------
if [ -n "$TOKEN" ]; then
  echo "Reusing provided worker token (not minting)." >&2
else
  MINT="$VOLTINI_DIR/scripts/mint-sim-worker-token.ts"
  if [ ! -f "$MINT" ]; then
    echo "ERROR: mint script not found: $MINT" >&2
    echo "  Point --voltini-dir at your voltini.energy-backend checkout, or pass" >&2
    echo "  an existing token with --token / \$WORKER_TOKEN." >&2
    exit 1
  fi
  # The mint signs with that environment's JWT_SECRET, which config injects
  # from the env (config.Production.json ships an empty placeholder). On a box
  # without the prod secret, signing fails with "secretOrPrivateKey must have a
  # value". Flag it up front so it isn't a surprise stack trace.
  if [ -z "${JWT_SECRET:-}" ]; then
    echo "NOTE: JWT_SECRET is not set — minting a $DEPLOYMENT token needs that" >&2
    echo "      environment's JWT secret. If the mint fails below, either:" >&2
    echo "        JWT_SECRET='<$DEPLOYMENT jwt secret>' ./make-sim-bundle.sh" >&2
    echo "      or mint on the $DEPLOYMENT host and pass --token '<JWT>'." >&2
  fi
  echo "Minting a $DEPLOYMENT WorkerService token via $MINT ..." >&2
  if ! MINT_OUT=$( cd "$VOLTINI_DIR" && DEPLOYMENT_GROUP_NAME="$DEPLOYMENT" \
                     npx tsx scripts/mint-sim-worker-token.ts 2>&1 ); then
    echo "ERROR: token mint failed:" >&2
    echo "$MINT_OUT" >&2
    case "$MINT_OUT" in
      *secretOrPrivateKey*)
        echo "" >&2
        echo "→ This is the JWT secret, not the DB. Provide $DEPLOYMENT's JWT_SECRET:" >&2
        echo "    JWT_SECRET='<$DEPLOYMENT jwt secret>' ./make-sim-bundle.sh" >&2
        echo "  or mint on the $DEPLOYMENT host and pass --token '<JWT>'." >&2
        ;;
    esac
    exit 1
  fi
  # Extract the JWT (three base64url segments) from the script's output.
  TOKEN=$(printf '%s\n' "$MINT_OUT" \
          | grep -oE 'eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+' | tail -1)
  if [ -z "$TOKEN" ]; then
    echo "ERROR: could not extract a token from the mint output:" >&2
    echo "$MINT_OUT" >&2
    exit 1
  fi
  echo "Minted token (treat sim-bundle.json as a secret)." >&2
fi

# --- assemble ----------------------------------------------------------------
umask 077
jq --arg url "$COORDINATOR_URL" --arg tok "$TOKEN" \
   '{ecr_region, ecr_registry, access_key_id, secret_access_key} + {coordinator_url: $url, worker_token: $tok}' \
   "$CREDS" > "$OUT"
chmod 600 "$OUT"

echo "Wrote $OUT (mode 600) — reused ECR creds from $CREDS, coordinator $COORDINATOR_URL."
echo "Install a node with:  ./install-sim.sh $OUT"
