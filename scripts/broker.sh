#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────
# Hub credential broker client — sourced by update.sh and scripts/updater.sh.
#
# The Hub holds ONE secret for central (VOLTINI_HUB_SECRET) and exchanges it on
# demand for short-lived cloud credentials, instead of keeping a long-lived
# cloud key on an SD card in a customer's house. Central-side spec:
#   voltini.energy-backend/docs/HUB_CREDENTIAL_BROKER.md
#
# ── This is deploy/infra only ────────────────────────────────────────
# The architecture invariant (hub-services-to-central.BLUEPRINT.md, amended
# 2026-07-30) permits the Hub exactly one central credential, used ONLY by the
# deploy/infra layer. No optimiser, executor, shedder, device, ingestion or
# controller code in borzoi-backend/src may call central — JWKS excepted, and a
# CI check over that tree enforces it. This file lives in borzoi-deploy for
# that reason: the credential must never be readable from the application.
#
# ── S3 needs nothing from this file ──────────────────────────────────
# Only the REGISTRY path calls the broker from a script. The backup path is
# handled entirely by the AWS SDK inside the theworks-db-backup container via
# AWS_CONTAINER_CREDENTIALS_FULL_URI (an AWS-standard mechanism, not ours), so
# theworks-db-backup stays a generic theworks tool with no Voltini knowledge.
# ─────────────────────────────────────────────────────────────────────

# ── Results come back in globals, NOT on stdout ──────────────────────
# These functions deliberately do not echo their result. The obvious shape —
# `token="$(broker_registry_token)"` — runs the function in a SUBSHELL, so
# every diagnostic it sets (BROKER_ERR, REGISTRY_CRED_SOURCE) is discarded the
# moment it returns, and the caller reports a blank reason. That is precisely
# the wrong failure mode for a box in a customer's basement that nobody will
# attach a terminal to, so the token travels in a global too.
#
#   registry_credential || die "$BROKER_ERR"
#   printf '%s' "$REGISTRY_CREDENTIAL" | docker login ...

# broker_configured — true when this Hub has a central secret + broker URL.
broker_configured() {
  [ -n "${VOLTINI_HUB_SECRET:-}" ] && [ -n "${VOLTINI_BROKER_URL:-}" ]
}

# broker_registry_token — sets BROKER_TOKEN to a short-lived GHCR token.
# Returns non-zero and sets BROKER_ERR on failure.
broker_registry_token() {
  BROKER_ERR=""
  BROKER_TOKEN=""
  local url response http body

  url="${VOLTINI_BROKER_URL%/}/registry-pull"

  # -sS: quiet but keep errors. The HTTP status is appended on its own line so
  # a 503 (central up, broker not configured) stays distinguishable from a
  # network failure, and neither can be mistaken for a valid token.
  if ! response="$(curl -sS --max-time 15 -w $'\n%{http_code}' \
            -H "Authorization: Bearer ${VOLTINI_HUB_SECRET}" \
            "$url" 2>&1)"; then
    BROKER_ERR="cannot reach broker at ${url}: ${response}"
    return 1
  fi

  http="${response##*$'\n'}"
  body="${response%$'\n'*}"

  if [ "$http" != "200" ]; then
    BROKER_ERR="broker at ${url} returned HTTP ${http}: $(printf '%s' "$body" | head -c 200)"
    return 1
  fi

  # Avoid a jq dependency — the Pi image is deliberately thin. The token is a
  # plain JSON string field with no escapes.
  BROKER_TOKEN="$(printf '%s' "$body" | sed -n 's/.*"token"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"
  if [ -z "$BROKER_TOKEN" ]; then
    BROKER_ERR="broker response contained no token"
    return 1
  fi
}

# registry_credential — sets REGISTRY_CREDENTIAL (the docker login password)
# and REGISTRY_CRED_SOURCE ('broker' | 'static'). Returns non-zero with
# BROKER_ERR set when no credential can be obtained at all.
#
# The static fallback is deliberate and load-bearing during the transition: a
# Hub that has not been given its central secret yet must keep pulling images
# exactly as before. Retire the fallback only once every Hub shows a recent
# "last used" in the portal — that field exists precisely to answer "has this
# Hub adopted its secret yet?".
registry_credential() {
  REGISTRY_CREDENTIAL=""
  REGISTRY_CRED_SOURCE=""
  BROKER_ERR=""

  if broker_configured; then
    if broker_registry_token; then
      REGISTRY_CREDENTIAL="$BROKER_TOKEN"
      REGISTRY_CRED_SOURCE="broker"
      return 0
    fi
    # Fall through to the static token, but say so loudly. Silently degrading
    # to the credential this whole mechanism exists to retire is how a broken
    # broker goes unnoticed for months.
    echo "broker: ${BROKER_ERR} — falling back to static GHCR_TOKEN" >&2
  fi

  if [ -n "${GHCR_TOKEN:-}" ]; then
    REGISTRY_CREDENTIAL="$GHCR_TOKEN"
    REGISTRY_CRED_SOURCE="static"
    return 0
  fi

  BROKER_ERR="no registry credential: neither VOLTINI_HUB_SECRET nor GHCR_TOKEN is set in .env${BROKER_ERR:+ (broker: ${BROKER_ERR})}"
  return 1
}
