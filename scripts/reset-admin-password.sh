#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────
# Voltini Hub — reset a local account's password, on the box.
#
# WHY THIS EXISTS
#
# Hub-local accounts are the deliberate offline fallback: when central or the
# internet is down, this is how you get into the Hub on site. So they must stay
# recoverable — but the recovery path used to be an emailed reset link, and that
# went away on 2026-07-31 with the backend's SES stack.
#
# Removing it cost nothing operationally, because it had never worked in
# production: setup.sh wrote `AKIA-unused-placeholder` as the Hub's AWS access
# key, so every send failed. What it did cost was a credential — the Hub had to
# carry AWS keys purely so a dead code path would satisfy a boot-time env check.
# The Hub now holds no long-lived AWS credential at all (the nightly backup
# brokers short-lived, per-Hub STS credentials from central instead).
#
# This script is the replacement: it sets a password directly against the local
# database. No email, no network, no central. Works with the internet unplugged,
# which is exactly when you need it.
#
# BORZOI_ADMIN_EMAIL / BORZOI_ADMIN_PASSWORD in .env are honoured on FIRST BOOT
# ONLY (see the backend's bootstrap-admin), so editing them on a running Hub
# does nothing. That is what left a forgotten password unrecoverable.
#
# USAGE
#   ./scripts/reset-admin-password.sh                 # prompt for both
#   ./scripts/reset-admin-password.sh user@example.com
#   ./scripts/reset-admin-password.sh --list          # show local accounts
#
# The password is read with hidden input and never appears in argv (and so never
# in `ps`, nor in your shell history).
# ─────────────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
INSTALL_DIR="$(dirname "$SCRIPT_DIR")"
COMPOSE="docker compose -f ${INSTALL_DIR}/docker-compose.yml"

cd "$INSTALL_DIR"

if [ ! -f .env ]; then
    echo "FATAL: no .env in ${INSTALL_DIR} — is this a Hub install directory?" >&2
    exit 1
fi
# shellcheck disable=SC1091
set -a; . ./.env; set +a

: "${DB_USER:?DB_USER missing from .env}"
: "${DB_NAME:?DB_NAME missing from .env}"

# The postgres container must be up; this script deliberately does NOT start it,
# because bringing the stack up as a side effect of a password reset is a
# surprise on a box that someone may have stopped on purpose.
if ! $COMPOSE ps --status running --services 2>/dev/null | grep -qx postgres; then
    echo "FATAL: the postgres container is not running." >&2
    echo "       Start the stack first:  docker compose up -d postgres" >&2
    exit 1
fi

psql_q() {
    # -tA: tuples only, unaligned — parseable output.
    $COMPOSE exec -T postgres psql -U "$DB_USER" -d "$DB_NAME" -tA -c "$1"
}

# ---- --list ---------------------------------------------------------------

if [ "${1:-}" = "--list" ]; then
    echo "Local accounts on this Hub:"
    psql_q 'SELECT id || E'"'"'\t'"'"' || email || E'"'"'\t'"'"' || role ||
            E'"'"'\t'"'"' || CASE WHEN enabled THEN '"'"'enabled'"'"' ELSE '"'"'disabled'"'"' END
            FROM "user" WHERE "deletedAt" IS NULL ORDER BY id' \
        | sed 's/^/  /'
    exit 0
fi

# ---- Which account --------------------------------------------------------

EMAIL="${1:-}"
if [ -z "$EMAIL" ]; then
    printf 'Account email: ' >&2
    read -r EMAIL
fi
if [ -z "$EMAIL" ]; then
    echo "FATAL: no email given." >&2
    exit 1
fi

EXISTS="$(psql_q "SELECT count(*) FROM \"user\" WHERE email = '$(printf '%s' "$EMAIL" | sed "s/'/''/g")' AND \"deletedAt\" IS NULL")"
if [ "$EXISTS" != "1" ]; then
    echo "FATAL: no active local account with email '${EMAIL}'." >&2
    echo "       Run with --list to see the accounts on this Hub." >&2
    exit 1
fi

# ---- The new password -----------------------------------------------------

# Hidden input, twice. Never passed as an argument, so it cannot leak via `ps`.
printf 'New password: ' >&2; read -rs PASSWORD; printf '\n' >&2
printf 'Repeat:       ' >&2; read -rs PASSWORD2; printf '\n' >&2

if [ "$PASSWORD" != "$PASSWORD2" ]; then
    echo "FATAL: the two entries differ." >&2
    exit 1
fi

# Mirrors the backend's own policy (PasswordMinLength = 8 and
# StrongPasswordRegex in @digistrada/theworks-common): at least 8 characters,
# with an upper-case letter, a lower-case letter and a digit. Checked here so a
# password this script accepts is one the login endpoint would also accept —
# writing a hash the app then refuses would be a nasty way to find out.
if ! printf '%s' "$PASSWORD" | grep -qE '^.{8,}$' \
   || ! printf '%s' "$PASSWORD" | grep -q '[A-Z]' \
   || ! printf '%s' "$PASSWORD" | grep -q '[a-z]' \
   || ! printf '%s' "$PASSWORD" | grep -q '[0-9]'; then
    echo "FATAL: password must be at least 8 characters and contain an upper-case" >&2
    echo "       letter, a lower-case letter and a digit." >&2
    exit 1
fi

# ---- Hash it with the backend's own bcrypt --------------------------------

# Hashing runs inside the backend container, using the very bcrypt build the
# login path verifies with (cost 10, matching BCRYPT_SALT_ROUNDS). Doing it on
# the host would mean depending on a host toolchain a Pi may not have, and
# risking a different cost factor or implementation.
#
# The plaintext goes in on stdin, never as an argument.
if ! $COMPOSE ps --status running --services 2>/dev/null | grep -qx backend; then
    echo "FATAL: the backend container is not running (needed to hash the password)." >&2
    echo "       Start it first:  docker compose up -d backend" >&2
    exit 1
fi

HASH="$(printf '%s' "$PASSWORD" | $COMPOSE exec -T backend node -e '
let input = "";
process.stdin.on("data", d => input += d);
process.stdin.on("end", () => {
    const bcrypt = require("bcrypt");
    process.stdout.write(bcrypt.hashSync(input, 10));
});
')"

case "$HASH" in
    '$2'*) ;;  # bcrypt hashes start $2a$/$2b$/$2y$
    *)
        echo "FATAL: did not get a bcrypt hash back from the backend container." >&2
        exit 1
        ;;
esac

# ---- Write it -------------------------------------------------------------

# `verified` is set too: an account that predates this change may still be
# unverified, and the backend refuses to authenticate an unverified user. There
# is no way left to verify one by email, so a reset that left it unverified
# would hand back an account that still cannot log in.
UPDATED="$(psql_q "UPDATE \"user\"
                   SET password = '$(printf '%s' "$HASH" | sed "s/'/''/g")',
                       verified = true,
                       enabled  = true
                   WHERE email = '$(printf '%s' "$EMAIL" | sed "s/'/''/g")'
                     AND \"deletedAt\" IS NULL
                   RETURNING id")"

if [ -z "$UPDATED" ]; then
    echo "FATAL: the update affected no rows." >&2
    exit 1
fi

echo "Password updated for ${EMAIL} (user id ${UPDATED})."
echo "The account is enabled and verified. No restart is needed — the backend"
echo "reads the password on each login."
