#!/usr/bin/env bash
# Logical backup of the production database (custom format, compressed), with a checksum and simple retention.
#   BACKUP_DATABASE_URL=postgres://<read-only backup role>@host/db  BACKUP_DIR=/var/backups/jimmywax  ./ops/backup-postgres.sh
# Grants are included on purpose: after a disaster the application roles (jw_commerce_api, jw_experience, jw_worker and their login roles) must
# exist on the new server BEFORE pg_restore, and the dump re-applies their privileges and row-level-security policies.
# Run it from cron (daily) and ALSO keep the managed provider's point-in-time recovery switched on: this script is the portable,
# provider-independent copy; PITR is what lets you recover to "five minutes ago". Copy BACKUP_DIR off the host (object storage with
# versioning + a different account/region). Never store the connection string in the repo.
set -euo pipefail
: "${BACKUP_DATABASE_URL:?set BACKUP_DATABASE_URL}"
DIR="${BACKUP_DIR:-./backups}"
KEEP_DAILY="${KEEP_DAILY:-14}"
mkdir -p "$DIR"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="$DIR/jimmywax-$STAMP.dump"
pg_dump --format=custom --compress=6 --no-owner --file="$OUT" "$BACKUP_DATABASE_URL"
sha256sum "$OUT" > "$OUT.sha256"
pg_restore --list "$OUT" > /dev/null   # fails if the archive is unreadable
echo "backup ok: $OUT ($(du -h "$OUT" | cut -f1))"
# retention: keep the newest $KEEP_DAILY dumps (the off-host copy follows its own lifecycle rule)
ls -1t "$DIR"/jimmywax-*.dump 2>/dev/null | tail -n +$((KEEP_DAILY + 1)) | while read -r old; do rm -f "$old" "$old.sha256"; done
