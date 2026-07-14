#!/usr/bin/env bash
# ============================================================================
# validate-theworks-compose.sh — self-check for the theworks-cases cutover
# (issue #45). Asserts the old resolver is retired and the replacement stack is
# well-formed. Read-only; brings nothing up. Run from anywhere in the clone.
#
# Usage: ./scripts/validate-theworks-compose.sh
# ============================================================================
set -euo pipefail

cd "$(dirname "$0")/.."

pass() { printf 'ok   %s\n' "$*"; }
fail() { printf 'FAIL %s\n' "$*" >&2; exit 1; }

# extract_block SERVICE < yaml — print the top-level block for `  SERVICE:` from
# a compose YAML on stdin (raw file or rendered `docker compose config`). Stops
# at the next 2-space-indented key or any 0-indent key, so nested keys (4+ space
# indent) stay inside the block. Used to scope grep assertions to ONE service.
extract_block() {
  awk -v svc="$1" '
    $0 ~ "^  " svc ":[[:space:]]*$" { f=1; next }
    /^  [^[:space:]]/ { f=0 }
    /^[^[:space:]]/   { f=0 }
    f { print }
  '
}

THEWORKS_COMPOSE="docker-compose.theworks.yml"
HUB_COMPOSE="docker-compose.yml"
INIT_SCRIPT="scripts/theworks-initdb.sh"

# Backend-only secrets that must NEVER reach the worker container (a compromised
# worker must not hold the Postgres credential, the GitHub-mirror token, the
# outbound-webhook HMAC secret, or the AWS keys).
BACKEND_ONLY_SECRETS="DB_PASSWORD GITHUB_TOKEN NOTIFICATIONS_WEBHOOK_SECRET AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY"
# Worker-only secrets that must NEVER reach the backend container (a compromised
# backend must not hold the Claude OAuth token, the worker GitHub PAT, or the
# agentWorker service token).
WORKER_ONLY_SECRETS="CLAUDE_CODE_OAUTH_TOKEN GH_TOKEN AGENT_WORKER_TOKEN"

# 1. The old resolver is retired (removed).
[ ! -e docker-compose.agent.yml ] || fail "docker-compose.agent.yml still present — must be retired"
[ ! -e agent-worker ]             || fail "agent-worker/ still present — must be retired"
pass "old agent-worker + docker-compose.agent.yml retired"

# 2. Replacement artifacts exist.
[ -f "$THEWORKS_COMPOSE" ] || fail "$THEWORKS_COMPOSE missing"
[ -f "$INIT_SCRIPT" ]      || fail "$INIT_SCRIPT missing"
[ -x "$INIT_SCRIPT" ]      || fail "$INIT_SCRIPT is not executable"
[ -f .env.theworks.example ]        || fail ".env.theworks.example missing"
[ -f .env.theworks.be.example ]     || fail ".env.theworks.be.example missing"
[ -f .env.theworks.worker.example ] || fail ".env.theworks.worker.example missing"
pass "replacement compose, init script, and per-service env examples present"

# 3. The new compose is valid and defines the three expected services. `config`
#    interpolates env AND resolves each service's `env_file:` into its rendered
#    `environment:` block — which is exactly what lets sections 7–8 below prove
#    the secret split. The example file supplies defaults (empty values only
#    warn). The services reference per-service `env_file:`s (operator-created at
#    deploy time), so render against throwaway copies of the examples.
RENDERED=""
if command -v docker >/dev/null 2>&1; then
  # The services reference `env_file: .env.theworks.be` / `.env.theworks.worker`
  # (operator-created at deploy time). If any is absent, stand up a throwaway copy
  # of its example just for the render, and remove it again afterwards, so
  # `config` validates the full file.
  CLEANUP_ENVS=""
  for f in .env.theworks.be .env.theworks.worker; do
    if [ ! -e "$f" ]; then
      cp "$f.example" "$f"
      CLEANUP_ENVS="$CLEANUP_ENVS $f"
    fi
  done
  RENDERED="$(docker compose -f "$THEWORKS_COMPOSE" --env-file .env.theworks.example config 2>/dev/null || true)"
  SERVICES="$(docker compose -f "$THEWORKS_COMPOSE" --env-file .env.theworks.example config --services 2>/dev/null | sort)"
  [ -n "$CLEANUP_ENVS" ] && rm -f $CLEANUP_ENVS
  [ -n "$RENDERED" ] || fail "$THEWORKS_COMPOSE failed to render with 'docker compose config'"
  for svc in postgres theworks-cases-be theworks-cases-worker; do
    grep -qx "$svc" <<<"$SERVICES" || fail "$THEWORKS_COMPOSE does not define service '$svc'"
  done
  pass "$THEWORKS_COMPOSE is valid and defines postgres + theworks-cases-be + theworks-cases-worker"
else
  # No docker available (e.g. CI lint box): fall back to a structural check.
  for svc in "postgres:" "theworks-cases-be:" "theworks-cases-worker:"; do
    grep -q "  $svc" "$THEWORKS_COMPOSE" || fail "$THEWORKS_COMPOSE does not define service '$svc'"
  done
  pass "$THEWORKS_COMPOSE structurally defines the three services (docker not available for full config)"
fi

# 4. theworks-cases-be is INTERNAL — it must not publish a host port.
grep -qE '^\s*ports:' "$THEWORKS_COMPOSE" && fail "$THEWORKS_COMPOSE publishes a port — theworks-cases-be must stay internal"
pass "theworks-cases stack publishes no host port (internal only)"

# 5. The second database is provisioned via the init script and wired into compose.
grep -q "theworks_cases" "$INIT_SCRIPT" || fail "init script does not provision theworks_cases"
grep -q "docker-entrypoint-initdb.d" "$THEWORKS_COMPOSE" || fail "init script not mounted into postgres initdb dir"
pass "separate theworks_cases database provisioned via init script"

# 6. Worker wiring: voltini hook + central live-data + direct-to-backend.
grep -q "PROJECT_HOOK: voltini" "$THEWORKS_COMPOSE" || fail "worker missing PROJECT_HOOK=voltini"
grep -q "LIVE_DATA_API_URL" "$THEWORKS_COMPOSE"     || fail "worker missing LIVE_DATA_API_URL (central live data)"
pass "worker configured with voltini hook + central live-data URL"

# 7. Secret split (least privilege — the headline safety property of the cutover).
#    The worker must never hold the backend's secrets and vice versa. When docker
#    is available we assert on the RENDERED config, where each `env_file:` has
#    been merged into the service's `environment:` — so re-adding
#    `env_file: .env.theworks.be` to the worker, or pasting DB_PASSWORD into its
#    `environment:`, would surface the key here and fail. Without docker we can
#    only see literal keys in the raw block (still catches direct additions).
if [ -n "$RENDERED" ]; then
  WORKER_BLOCK="$(extract_block theworks-cases-worker <<<"$RENDERED")"
  BE_BLOCK="$(extract_block theworks-cases-be <<<"$RENDERED")"
else
  WORKER_BLOCK="$(extract_block theworks-cases-worker <"$THEWORKS_COMPOSE")"
  BE_BLOCK="$(extract_block theworks-cases-be <"$THEWORKS_COMPOSE")"
  # Belt-and-braces on the raw file: the worker must not pull in the backend's
  # env_file (the render can't be inspected without docker).
  grep -qE '^\s*env_file:.*\.env\.theworks\.be' <<<"$WORKER_BLOCK" \
    && fail "worker references backend env_file (.env.theworks.be) — secret split violated"
  grep -qE '^\s*env_file:.*\.env\.theworks\.worker' <<<"$BE_BLOCK" \
    && fail "backend references worker env_file (.env.theworks.worker) — secret split violated"
fi
[ -n "$WORKER_BLOCK" ] || fail "could not locate theworks-cases-worker service block"
[ -n "$BE_BLOCK" ]     || fail "could not locate theworks-cases-be service block"
for key in $BACKEND_ONLY_SECRETS; do
  grep -qE "\b$key:" <<<"$WORKER_BLOCK" \
    && fail "worker holds backend-only secret '$key' — least-privilege secret split violated"
done
for key in $WORKER_ONLY_SECRETS; do
  grep -qE "\b$key:" <<<"$BE_BLOCK" \
    && fail "backend holds worker-only secret '$key' — least-privilege secret split violated"
done
pass "secret split holds: worker has no backend secrets and backend has no worker secrets"

# 8. Mount scope: every worker bind mount must be a SCOPED SUBDIRECTORY under
#    theworks-data — e.g. .../theworks-data/repos (the repo workspace) or
#    .../theworks-data/claude (the persisted Agent SDK session store that keeps
#    ask_human-parked cases resumable across container recreation). It must NEVER
#    be the parent ./theworks-data — whose ./theworks-data/postgres subdir holds
#    the raw Postgres cluster (the support-case DB on disk) — and must never be
#    that ./theworks-data/postgres subdir itself. Mounting either would hand a
#    compromised worker the database files, defeating the least-privilege split.
if [ -n "$RENDERED" ]; then
  # Rendered config normalises binds to long form: `source: /abs/.../theworks-data/repos`.
  SOURCES="$(grep -E '^\s*source:' <<<"$WORKER_BLOCK" | awk '{print $2}')"
else
  # Raw short form: `- ./theworks-data/repos:/data/repos` → take the host side.
  SOURCES="$(grep -E '^\s*-\s+[^ ]+:[^ ]+' <<<"$WORKER_BLOCK" | sed -E 's/^\s*-\s+//; s/:.*//')"
fi
[ -n "$SOURCES" ] || fail "worker has no bind mount source — expected at least .../theworks-data/repos"
while IFS= read -r src; do
  [ -z "$src" ] && continue
  norm="${src%/}"   # tolerate a trailing slash on the host source path
  case "$norm" in
    */theworks-data)          fail "worker bind mount source '$src' is the parent ./theworks-data — mount a scoped subdirectory (e.g. .../theworks-data/repos), never the parent" ;;
    */theworks-data/postgres) fail "worker bind mount source '$src' is the Postgres cluster dir — the raw support-case DB must stay out of the worker's reach" ;;
    */theworks-data/*)        ;;  # a scoped subdir (repos, claude, …) — allowed
    *)                        fail "worker bind mount source '$src' is not scoped under .../theworks-data (must be a subdirectory such as .../theworks-data/repos)" ;;
  esac
done <<<"$SOURCES"
pass "worker bind mounts are scoped subdirectories of theworks-data (parent + Postgres cluster files stay out of reach)"

# 9. Invariant: the customer Hub stack must NEVER host the resolver / cases backend.
if [ -f "$HUB_COMPOSE" ]; then
  grep -q "theworks-cases" "$HUB_COMPOSE" && fail "$HUB_COMPOSE references theworks-cases — must stay off the customer Pi"
  pass "customer Hub compose does not host the resolver / cases backend"
fi

echo "All theworks-cases cutover checks passed."
