#!/usr/bin/env bash
# Replace the current database with a dump made by backup.sh.
#   ./deploy/restore.sh backups/vici-qa-20261018-021500.sql.gz
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f "${1:-}" ] || { echo "usage: $0 <backups/vici-qa-....sql.gz>"; exit 1; }
# shellcheck disable=SC1091
. ./.env
DB="${POSTGRES_DB:-vici_qa}"
USER_="${POSTGRES_USER:-vici_qa}"

read -r -p "This REPLACES database '$DB' with $1. Type RESTORE to continue: " ok
[ "$ok" = "RESTORE" ] || { echo "Cancelled."; exit 1; }

docker compose stop api worker
docker compose exec -T postgres psql -U "$USER_" -d postgres -v ON_ERROR_STOP=1 \
  -c "DROP DATABASE IF EXISTS \"$DB\";" -c "CREATE DATABASE \"$DB\";"
gunzip -c "$1" | docker compose exec -T postgres psql -U "$USER_" -d "$DB" -q -v ON_ERROR_STOP=1
docker compose start api worker
echo "Restored from $1."
