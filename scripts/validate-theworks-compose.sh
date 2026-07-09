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

THEWORKS_COMPOSE="docker-compose.theworks.yml"
HUB_COMPOSE="docker-compose.yml"
INIT_SCRIPT="scripts/theworks-initdb.sh"

# 1. The old resolver is retired (removed).
[ ! -e docker-compose.agent.yml ] || fail "docker-compose.agent.yml still present — must be retired"
[ ! -e agent-worker ]             || fail "agent-worker/ still present — must be retired"
pass "old agent-worker + docker-compose.agent.yml retired"

# 2. Replacement artifacts exist.
[ -f "$THEWORKS_COMPOSE" ] || fail "$THEWORKS_COMPOSE missing"
[ -f "$INIT_SCRIPT" ]      || fail "$INIT_SCRIPT missing"
[ -x "$INIT_SCRIPT" ]      || fail "$INIT_SCRIPT is not executable"
[ -f .env.theworks.example ] || fail ".env.theworks.example missing"
pass "replacement compose, init script, and env example present"

# 3. The new compose is valid and defines the three expected services. `config`
#    interpolates env; the example file supplies defaults (empty values only warn).
#    The services reference `.env.theworks` (operator-created at deploy time), so
#    render against a throwaway copy of the example to fully validate the file.
if command -v docker >/dev/null 2>&1; then
  # The services reference `env_file: .env.theworks` (operator-created at deploy
  # time). If it is absent, stand up a throwaway copy of the example just for the
  # render, and remove it again afterwards, so `config` validates the full file.
  CLEANUP_ENV=0
  if [ ! -e .env.theworks ]; then
    cp .env.theworks.example .env.theworks
    CLEANUP_ENV=1
  fi
  SERVICES="$(docker compose -f "$THEWORKS_COMPOSE" --env-file .env.theworks.example config --services 2>/dev/null | sort)"
  [ "$CLEANUP_ENV" = 1 ] && rm -f .env.theworks
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

# 7. Invariant: the customer Hub stack must NEVER host the resolver / cases backend.
if [ -f "$HUB_COMPOSE" ]; then
  grep -q "theworks-cases" "$HUB_COMPOSE" && fail "$HUB_COMPOSE references theworks-cases — must stay off the customer Pi"
  pass "customer Hub compose does not host the resolver / cases backend"
fi

echo "All theworks-cases cutover checks passed."
