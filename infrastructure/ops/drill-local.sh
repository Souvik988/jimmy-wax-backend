#!/usr/bin/env bash
# LOCAL restore drill against the dev Postgres container: back up jimmywax_dev, restore it into a scratch database, verify, drop the scratch.
# Run from the repo root:  docker cp infrastructure/ops jimmywax-backend-postgres-1:/tmp/ops && docker exec jimmywax-backend-postgres-1 bash /tmp/ops/drill-local.sh
# (the container image needs bash:  docker exec -u root jimmywax-backend-postgres-1 apk add --no-cache bash)
set -euo pipefail
cd "$(dirname "$0")"
sed -i 's/\r$//' ./*.sh
export BACKUP_DATABASE_URL="${BACKUP_DATABASE_URL:-postgres://postgres:postgres@127.0.0.1:5432/jimmywax_dev}"
export BACKUP_DIR="${BACKUP_DIR:-/tmp/backups}"
export DRILL_ADMIN_URL="${DRILL_ADMIN_URL:-postgres://postgres:postgres@127.0.0.1:5432/postgres}"
bash ./backup-postgres.sh
LATEST="$(ls -1t "$BACKUP_DIR"/jimmywax-*.dump | head -n 1)"
bash ./restore-drill.sh "$LATEST"
