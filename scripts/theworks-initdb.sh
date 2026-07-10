#!/usr/bin/env bash
# ============================================================================
# theworks-initdb.sh — provision the SECOND database on the shared Postgres.
#
# Postgres' own POSTGRES_DB only creates the PRIMARY database (the Voltini
# database on the shared instance). theworks-cases-be owns a SEPARATE database
# on the SAME server — a separate database, NOT a schema, so the two datasources
# keep independent migration histories and extensions (Voltini needs PostGIS and
# owns its migrations; theworks-cases-be needs neither and owns its own).
#
# The official postgres image runs every executable *.sh in
# /docker-entrypoint-initdb.d exactly once, on FIRST cluster init only, as the
# superuser. Mount this file there (see docker-compose.theworks.yml). It is a
# no-op on every subsequent boot (the volume already holds the cluster), and it
# creates the database idempotently so a re-run against an existing cluster is
# harmless.
#
# THEWORKS_DB_NAME defaults to `theworks_cases`; the owner is the shared
# POSTGRES_USER so theworks-cases-be connects with the same credentials it uses
# for the primary database (only DB_NAME differs).
# ============================================================================
set -euo pipefail

THEWORKS_DB_NAME="${THEWORKS_DB_NAME:-theworks_cases}"
OWNER="${POSTGRES_USER}"

# CREATE DATABASE cannot run inside a transaction block and has no IF NOT EXISTS,
# so guard it with a existence check and only create when missing (idempotent).
psql -v ON_ERROR_STOP=1 --username "${POSTGRES_USER}" --dbname "${POSTGRES_DB}" <<SQL
SELECT 'CREATE DATABASE "${THEWORKS_DB_NAME}" OWNER "${OWNER}"'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = '${THEWORKS_DB_NAME}')\gexec

GRANT ALL PRIVILEGES ON DATABASE "${THEWORKS_DB_NAME}" TO "${OWNER}";
SQL

echo "theworks-initdb: ensured database '${THEWORKS_DB_NAME}' (owner '${OWNER}') on the shared Postgres."
