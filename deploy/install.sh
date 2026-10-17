#!/usr/bin/env bash
# One-shot production install on a fresh Ubuntu/Debian server.
#
#   git clone https://github.com/abdulmanan69/vici-evalution.git vici-qa
#   cd vici-qa
#   ./deploy/install.sh                 # HTTP on port 3000
#   ./deploy/install.sh qa.example.com  # HTTPS with automatic certificates
#
# Safe to re-run: an existing .env is kept, containers are rebuilt in place.
set -euo pipefail
cd "$(dirname "$0")/.."

DOMAIN="${1:-${DOMAIN:-}}"

if ! command -v docker >/dev/null 2>&1; then
  echo "Installing Docker…"
  curl -fsSL https://get.docker.com | sh
  sudo usermod -aG docker "$USER" || true
fi
docker compose version >/dev/null 2>&1 || { echo "Docker Compose v2 is required (the 'docker compose' command)."; exit 1; }

rand() { openssl rand -hex "$1"; }

if [ ! -f .env ]; then
  cp .env.example .env
  sed -i "s#^NODE_ENV=.*#NODE_ENV=production#" .env
  sed -i "s#^POSTGRES_PASSWORD=.*#POSTGRES_PASSWORD=$(rand 24)#" .env
  sed -i "s#^APP_ENCRYPTION_KEY=.*#APP_ENCRYPTION_KEY=$(rand 32)#" .env
  sed -i "s#^SUPERADMIN_PASSWORD=.*#SUPERADMIN_PASSWORD=$(rand 9)#" .env
  if [ -n "$DOMAIN" ]; then
    sed -i "s#^DOMAIN=.*#DOMAIN=$DOMAIN#" .env
    sed -i "s#^COOKIE_SECURE=.*#COOKIE_SECURE=true#" .env
    sed -i "s#^WEB_BIND=.*#WEB_BIND=127.0.0.1#" .env
  fi
  echo "Created .env with generated secrets."
else
  echo ".env already exists — keeping it."
fi

# shellcheck disable=SC1091
. ./.env

if [ -n "${DOMAIN:-}" ]; then
  docker compose -f docker-compose.yml -f docker-compose.https.yml up -d --build
else
  docker compose up -d --build
fi

echo -n "Waiting for the API"
for _ in $(seq 1 60); do
  if docker compose exec -T api node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; then
    echo " — up."
    break
  fi
  echo -n "."
  sleep 3
done

echo
echo "================================================================"
if [ -n "${DOMAIN:-}" ]; then
  echo "  Open:      https://$DOMAIN"
else
  echo "  Open:      http://$(hostname -I 2>/dev/null | awk '{print $1}'):${WEB_PORT:-3000}"
fi
echo "  Sign in:   $SUPERADMIN_EMAIL"
echo "  Password:  $SUPERADMIN_PASSWORD"
echo "  (change the password after the first login; it is also in .env)"
echo "================================================================"
