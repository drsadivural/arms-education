#!/usr/bin/env bash
# certbot deploy hook (installed as /opt/arms-production/pg-cert-deploy.sh): installs the issued/renewed Let's Encrypt
# certificate of arms-db.ayonix.com for PostgreSQL and reloads it (no restart; existing connections stay open).
set -euo pipefail
live=/etc/letsencrypt/live/arms-db.ayonix.com
dest=/opt/arms-production/pg-tls
# uid/gid 70 = postgres inside the postgres:17-alpine image (no such user on the host, so set it numerically).
install -m 644 "${live}/fullchain.pem" "${dest}/server.crt"
install -m 600 "${live}/privkey.pem" "${dest}/server.key"
chown 70:70 "${dest}/server.crt" "${dest}/server.key"
cd /opt/arms-production
docker compose exec -T postgres psql -U postgres -d arms -tAc "SELECT pg_reload_conf()" > /dev/null
echo "$(date -u +%FT%TZ) PostgreSQL certificate installed and reloaded"
