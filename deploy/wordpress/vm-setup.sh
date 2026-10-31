#!/usr/bin/env bash
# Installs or updates the UNO chatbot WordPress site on the VM. Run by deploy.ps1 as:
#   sudo bash /opt/uno-wp/vm-setup.sh <domain>
# Expects /opt/uno-wp to contain docker-compose.yml, Caddyfile, plugin/, setup/ and a temporary
# plugin-settings.json ({"backend_url": ..., "api_key": ...}), which is deleted here. Safe to run again.
set -euo pipefail

DOMAIN="${1:?usage: vm-setup.sh <domain>}"
DIR=/opt/uno-wp
cd "$DIR"
SETTINGS="$DIR/plugin-settings.json"
trap 'rm -f "$SETTINGS"' EXIT

log() { echo "== $*"; }

if ! command -v docker >/dev/null 2>&1; then
  log "Installing Docker Engine"
  apt-get update -q
  apt-get install -y -q ca-certificates curl
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -q
  apt-get install -y -q docker-ce docker-ce-cli containerd.io docker-compose-plugin
fi

if ! swapon --show | grep -q /swapfile; then
  log "Adding 1 GB swap"
  [ -f /swapfile ] || { fallocate -l 1G /swapfile; chmod 600 /swapfile; mkswap /swapfile; }
  swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

if [ ! -f .env ]; then
  log "Generating database passwords"
  umask 077
  {
    echo "DB_PASSWORD=$(openssl rand -hex 24)"
    echo "DB_ROOT_PASSWORD=$(openssl rand -hex 24)"
    echo "SITE_DOMAIN=$DOMAIN"
  } > .env
  umask 022
fi
sed -i "s|^SITE_DOMAIN=.*|SITE_DOMAIN=$DOMAIN|" .env
# Proxies allowed to set the visitor IP: Cloudflare's ranges (bundled by deploy.ps1) or none when not behind Cloudflare
CF_IP_RANGES=private_ranges
[ -s cloudflare-ips.txt ] && CF_IP_RANGES="$(tr -s '[:space:]' ' ' < cloudflare-ips.txt | sed 's/ *$//')"
sed -i '/^CF_IP_RANGES=/d' .env
echo "CF_IP_RANGES=\"$CF_IP_RANGES\"" >> .env
chmod 600 .env

log "Starting containers"
docker compose pull -q --ignore-buildable
docker compose up -d --build --remove-orphans
# Bind mounts keep pointing at the plugin folder / Caddyfile that existed when a container started, and deploy.ps1
# replaces them, so recreate the stateless services to pick up the new files (data lives in volumes).
docker compose up -d --no-deps --force-recreate wordpress caddy

wp() { docker compose run --rm -T wpcli wp "$@"; }

log "Waiting for WordPress files"
for _ in $(seq 1 60); do
  docker compose exec -T wordpress test -f /var/www/html/wp-config.php && break
  sleep 2
done

if ! wp core is-installed >/dev/null 2>&1; then
  log "Installing WordPress for https://$DOMAIN"
  PASS="$(openssl rand -base64 18 | tr -d '/+=')"
  wp core install --url="https://$DOMAIN" --title="UNO Rules Chat" --admin_user=admin \
    --admin_password="$PASS" --admin_email="admin@$DOMAIN" --skip-email
  umask 077
  printf 'WordPress admin: https://%s/wp-admin  user: admin  password: %s\n' "$DOMAIN" "$PASS" > admin-credentials.txt
  umask 022
else
  log "WordPress already installed"
  wp option update home "https://$DOMAIN" >/dev/null
  wp option update siteurl "https://$DOMAIN" >/dev/null
fi

wp rewrite structure "/%postname%/" --hard >/dev/null
wp plugin activate uno-rag-chatbot
if [ -f "$SETTINGS" ]; then
  wp eval-file /setup/plugin-options.php < "$SETTINGS"
fi
wp eval-file /setup/pages.php

log "Status"
docker compose ps --format 'table {{.Service}}\t{{.Status}}'
free -m | head -3
echo "Site: https://$DOMAIN/   Chat: https://$DOMAIN/uno-rules-chat/"
