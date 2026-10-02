#!/usr/bin/env bash
# Live contract test of ARMSKit against the LOCAL stack (never staging/production).
#
# Prerequisites (repository root):
#   docker stack (Postgres :55433, GoTrue :9999, MinIO :9100) running and migrated:
#     DATABASE_ADMIN_URL=postgres://postgres:arms_dev_pw@127.0.0.1:55433/arms RUNTIME_DB_ROLE=arms_app node scripts/db/migrate.mjs
#   API running: (cd services/api && npx wrangler dev --port 8804 --inspector-port 9804 --ip 127.0.0.1)
#
# Usage: apps/ios/ARMSKit/Scripts/live-contract-test.sh
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
package="$(dirname "$here")"
root="$(cd "$package/../../.." && pwd)"
api="${ARMS_LIVE_API_BASE:-http://127.0.0.1:8804/api/v1}"

if ! curl -fsS "$api/health" >/dev/null; then
  echo "API is not reachable at $api (start wrangler dev first)" >&2
  exit 1
fi

fixture="$(mktemp -t arms-live-fixture.XXXXXX.json)"
trap 'rm -f "$fixture"' EXIT
(cd "$root" && node "$here/seed-live.mjs" "$fixture")
cd "$package"
ARMS_LIVE_API=1 ARMS_LIVE_FIXTURE="$fixture" ARMS_LIVE_API_BASE="$api" swift test --filter LiveAPITests "$@"
