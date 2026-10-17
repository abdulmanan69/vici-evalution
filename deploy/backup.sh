#!/usr/bin/env bash
# Dump the database to backups/ and keep the newest 14 dumps.
# Nightly:  crontab -e  →  15 2 * * * /opt/vici-qa/deploy/backup.sh >> /var/log/vici-qa-backup.log 2>&1
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck disable=SC1091
. ./.env

mkdir -p backups
file="backups/vici-qa-$(date +%Y%m%d-%H%M%S).sql.gz"
docker compose exec -T postgres pg_dump -U "${POSTGRES_USER:-vici_qa}" "${POSTGRES_DB:-vici_qa}" | gzip > "$file"
ls -1t backups/vici-qa-*.sql.gz | tail -n +15 | xargs -r rm -f
echo "Backup written: $file ($(du -h "$file" | cut -f1))"
