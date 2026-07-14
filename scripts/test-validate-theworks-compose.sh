#!/usr/bin/env bash
# ============================================================================
# test-validate-theworks-compose.sh — regression test for section 8
# (worker bind-mount scope) of validate-theworks-compose.sh.
#
# Issue #94 intent: the theworks-cases-worker now holds MORE THAN ONE scoped
# bind mount under theworks-data — the repo workspace (.../theworks-data/repos)
# AND the persisted Agent SDK session store (.../theworks-data/claude) that keeps
# ask_human-parked cases resumable across container recreation. A second, equally
# scoped subdir must NOT trip the least-privilege mount check; only mounting the
# parent ./theworks-data or the ./theworks-data/postgres cluster dir (the raw
# support-case DB on disk) may fail it.
#
# This drives the REAL validator against throwaway copies of the deploy files
# whose worker bind mount has been mutated, and asserts pass/fail per scenario.
# Read-only w.r.t. the working tree (all mutation happens in a temp dir).
#
# Usage: ./scripts/test-validate-theworks-compose.sh
# ============================================================================
set -euo pipefail

cd "$(dirname "$0")/.."

pass() { printf 'ok   %s\n' "$*"; }
fail() { printf 'FAIL %s\n' "$*" >&2; exit 1; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# Copy just the files the validator reads, preserving layout, so it runs against
# the fixture exactly as it would against the real clone.
make_fixture() {
  local dir="$1"
  rm -rf "$dir"
  mkdir -p "$dir/scripts"
  cp docker-compose.theworks.yml docker-compose.yml "$dir/"
  cp scripts/validate-theworks-compose.sh scripts/theworks-initdb.sh "$dir/scripts/"
  cp .env.theworks.example .env.theworks.be.example .env.theworks.worker.example "$dir/"
}

# Rewrite the worker's persisted-session bind-mount SOURCE inside a fixture.
set_claude_mount_source() {
  local dir="$1" src="$2"
  sed -i -E "s#- \./theworks-data/claude:/data/claude#- ${src}:/data/claude#" \
    "$dir/docker-compose.theworks.yml"
}

# Run the fixture's validator; echo PASS/FAIL by exit code (never aborts here).
validator_result() {
  local dir="$1"
  if ( cd "$dir" && ./scripts/validate-theworks-compose.sh ) >/dev/null 2>&1; then
    echo PASS
  else
    echo FAIL
  fi
}

expect() {  # expect <label> <expected PASS|FAIL> <mutated-source|"">
  local label="$1" want="$2" src="${3:-}"
  local dir="$TMP/case"
  make_fixture "$dir"
  [ -n "$src" ] && set_claude_mount_source "$dir" "$src"
  local got; got="$(validator_result "$dir")"
  [ "$got" = "$want" ] || fail "$label — expected validator to $want but it ${got}ed"
  pass "$label — validator ${got}s as expected"
}

# 1. Baseline: the shipped compose (repos + claude, both scoped) must PASS.
#    This is the regression guard for issue #94 — a second scoped subdir mount
#    must not be rejected.
expect "repos + scoped claude session store" PASS ""

# 2. The claude mount pointed at the PARENT ./theworks-data must still FAIL
#    (would expose ./theworks-data/postgres — the raw DB — to the worker).
expect "parent ./theworks-data over-mount" FAIL "./theworks-data"

# 3. The claude mount pointed straight at the Postgres cluster dir must FAIL.
expect "./theworks-data/postgres cluster mount" FAIL "./theworks-data/postgres"

# 4. An out-of-tree mount (not under theworks-data) must FAIL.
expect "unscoped host path mount" FAIL "/etc"

echo "All mount-scope regression checks passed."
