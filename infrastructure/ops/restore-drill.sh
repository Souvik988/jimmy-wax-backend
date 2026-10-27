#!/usr/bin/env bash
# RESTORE DRILL: restore a backup into a throw-away database on a scratch server and verify it. Run quarterly and after any
# infrastructure change; record the result in docs/build/RESTORE_DRILLS.md. Never point this at production.
#   DRILL_ADMIN_URL=postgres://postgres:<pw>@scratch-host:5432/postgres  ./ops/restore-drill.sh /path/to/jimmywax-<stamp>.dump
set -euo pipefail
DUMP="${1:?path to a .dump file}"
: "${DRILL_ADMIN_URL:?set DRILL_ADMIN_URL (a scratch server, NOT production)}"
DB="jimmywax_drill_$(date -u +%Y%m%d%H%M%S)"
HERE="$(cd "$(dirname "$0")" && pwd)"
START=$(date +%s)
[ -f "$DUMP.sha256" ] && sha256sum -c "$DUMP.sha256"
psql "$DRILL_ADMIN_URL" -v ON_ERROR_STOP=1 -c "CREATE DATABASE $DB"
ADMIN_BASE="${DRILL_ADMIN_URL%/*}"
# roles are cluster objects, so make sure the three application roles exist on the scratch server (no logins needed for a drill)
psql "$DRILL_ADMIN_URL" -v ON_ERROR_STOP=1 -c "DO \$\$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='jw_commerce_api') THEN CREATE ROLE jw_commerce_api NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='jw_experience') THEN CREATE ROLE jw_experience NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='jw_worker') THEN CREATE ROLE jw_worker NOLOGIN; END IF; END \$\$"
pg_restore --no-owner --dbname="$ADMIN_BASE/$DB" --exit-on-error "$DUMP"
RESULT=$(psql "$ADMIN_BASE/$DB" -v ON_ERROR_STOP=1 -At -F ' | ' -f "$HERE/restore-verify.sql")
echo "$RESULT"
BAD=$(echo "$RESULT" | grep -c '| f$' || true)
psql "$DRILL_ADMIN_URL" -c "DROP DATABASE $DB WITH (FORCE)"
echo "restore drill finished in $(( $(date +%s) - START )) s; failed checks: $BAD"
[ "$BAD" -eq 0 ]
