#!/usr/bin/env bash
# One-command deploy for a fresh Ubuntu EC2 host. Idempotent: safe to re-run after every sync.
#
#   ./deploy.sh          # install missing deps, build certs, bring the stack up, verify
#   ./deploy.sh --no-chat  # core only (proxy, web, producer, ticker), no LibreChat
#
# One-time database seeding is NOT here: it is a heavyweight, run-once step documented in
# DEPLOY_EC2.md section "Build the databases".
set -euo pipefail
cd "$(dirname "$0")"

PROFILE=(--profile chat)
[ "${1:-}" = "--no-chat" ] && PROFILE=()

echo "== dependencies"
if ! command -v docker >/dev/null 2>&1; then
  sudo apt-get update -qq
  sudo apt-get install -y docker.io docker-compose-v2
  sudo usermod -aG docker "$USER"
  echo "NOTE: added $USER to the docker group; run 'newgrp docker' (or relogin) if the compose step below fails with a permission error."
fi
docker compose version >/dev/null 2>&1 || { sudo apt-get update -qq && sudo apt-get install -y docker-compose-v2; }

# scp/FileZilla/zip drop the exec bits and the resulting bare "Permission denied" looks nothing
# like its cause.
chmod +x scripts/*.sh deploy/*.sh

echo "== TLS cert"
if [ ! -f deploy/ssl/fullchain.pem ] || [ ! -f deploy/ssl/privkey.pem ]; then
  [ -f ssl_star_dot_io/cricheroes.crt ] || { echo "FAIL: no deploy/ssl/* and no ssl_star_dot_io/ source certs to build them from" >&2; exit 1; }
  mkdir -p deploy/ssl
  cat ssl_star_dot_io/cricheroes.crt ssl_star_dot_io/cricheroes.ca-bundle > deploy/ssl/fullchain.pem
  cp ssl_star_dot_io/cricheroes.key deploy/ssl/privkey.pem
  chmod 600 deploy/ssl/privkey.pem
fi

echo "== env"
[ -f .env ] || { cp .env.example .env; echo "FAIL: created .env from .env.example; fill in the CH_* credentials and re-run" >&2; exit 1; }
grep -q '^CH_PASSWORD=..*' .env || { echo "FAIL: CH_PASSWORD is empty in .env" >&2; exit 1; }

echo "== up"
docker compose "${PROFILE[@]}" up -d --build

echo "== verify"
./scripts/check_published_ports.sh
sleep 5
for probe in "http://localhost/ 301" "https://localhost/ 200" "https://localhost/v2 200"; do
  url="${probe% *}"; want="${probe#* }"
  got="$(curl -sk -o /dev/null -w '%{http_code}' "$url" || true)"
  [ "$got" = "$want" ] && echo "ok: $url -> $got" || echo "WARN: $url -> $got (wanted $want; web may still be starting, retry in a minute)"
done
docker compose "${PROFILE[@]}" ps
echo "done. Site: https://the-phoenix.cricheroes.io  Chat: https://the-phoenix.cricheroes.io:3080"
