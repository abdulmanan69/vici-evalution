#!/usr/bin/env bash
# Pull the latest code and roll the containers. Database migrations run
# automatically when the API starts; nothing else to do.
set -euo pipefail
cd "$(dirname "$0")/.."

git pull --ff-only

FILES="-f docker-compose.yml"
# shellcheck disable=SC1091
[ -f .env ] && . ./.env
[ -n "${DOMAIN:-}" ] && FILES="$FILES -f docker-compose.https.yml"

# shellcheck disable=SC2086
docker compose $FILES up -d --build
docker image prune -f >/dev/null
echo "Updated. Check: docker compose ps"
