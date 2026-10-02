#!/usr/bin/env bash
# certbot deploy hook (installed as /opt/arms-production/pg-cert-deploy.sh): installs the issued/renewed Let's Encrypt
# certificate of arms-db.ayonix.com for PostgreSQL and reloads it (no restart; existing connections stay open).
set -euo pipefail
live=/etc/letsencrypt/live/arms-db.ayonix.com
dest=/opt/arms-production/pg-tls
install -o 70 -g 70 -m 644 "${live}/fullchain.pem" "${dest}/server.crt"
install -o 70 -g 70 -m 600 "${live}/privkey.pem" "${dest}/server.key"
cd /opt/arms-production
docker compose exec -T postgres psql -U postgres -d arms -tAc "SELECT pg_reload_conf()" > /dev/null
echo "$(date -u +%FT%TZ) PostgreSQL certificate installed and reloaded"
