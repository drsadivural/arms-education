#!/usr/bin/env bash
# Nightly logical backup of the ARMS production database (cron, user ubuntu, /opt/arms-production/backup.sh):
# pg_dump (custom format) → R2 bucket arms-backups-production (private; lifecycle deletes after 30 days).
# The last 7 dumps are also kept locally in /opt/arms-production/backups. Restore drill: README_JA.md.
set -euo pipefail
export PATH="/usr/local/bin:/usr/bin:/bin:$PATH"
cd /opt/arms-production
stamp=$(date -u +%Y%m%dT%H%M%SZ)
mkdir -p backups
file="backups/arms-${stamp}.dump"
docker compose exec -T postgres pg_dump -U postgres -d arms -Fc > "${file}"
chmod 600 "${file}"
npx --yes wrangler@4.146.0 r2 object put "arms-backups-production/db/arms-${stamp}.dump" --file "${file}" --remote > /dev/null
find backups -name 'arms-*.dump' -mtime +7 -delete
echo "$(date -u +%FT%TZ) backup ok ${file} ($(stat -c %s "${file}") bytes)"
