# Single-host deployment preparation

This optional overlay reuses `docker-compose.prod.yml` and adds PostgreSQL 17
and a persistent disk media volume. It is a starting configuration, not a
completed deployment: it has not been tested on the chosen host or with real
SMTP. There is one host and one database, so a host failure causes downtime.

## Before first start

1. Choose a Linux host with Docker Compose, persistent disk, a public IP, and
   inbound TCP 80 and 443. Point a hostname at that IP and replace the hostname
   in `Caddyfile`. Caddy needs reachable ports to obtain its HTTPS certificate.
2. Copy the four existing production environment examples and
   `.env.postgres.prod.example` to their corresponding non-example names on the
   host. Keep them private and outside Git. Configure SMTP, the HTTPS origins,
   signing keys, and separate strong database credentials. In each service's
   `DATABASE_URL`, use hostname `postgres` and that service's login role. URL
   encode any special characters in passwords. The overlay opts into local
   disk storage; the S3 settings in the shared example are not used.
3. Start only PostgreSQL with the two Compose files. Apply the migration ledger
   with the administrative database URL, create the separate least-privilege
   login roles described in `docs/build/PRODUCTION_RUNBOOK.md`, then run the
   production preflight with `--probe`. Do not use `dev-roles.sql` or reset
   scripts against production. Migrations and role provisioning are deliberately
   not automatic; review the existing runbook before the first start.
4. Restrict `/v1/admin/*` to the dashboard's trusted server or private network
   at the edge. The example Caddyfile does not provide that restriction.
   Only after the preflight and restriction are in place, start the services:

   ```sh
   cd infrastructure/prod
   docker compose -f docker-compose.prod.yml -f docker-compose.single-host.yml up -d --build
   docker compose -f docker-compose.prod.yml -f docker-compose.single-host.yml ps
   ```

5. Verify each API's readiness, the public `/readyz` and `/v1/store-settings`,
   worker processing, SMTP delivery, and media upload/read access. Keep checkout
   and unconfigured integrations disabled until their own acceptance tests pass.

PostgreSQL is not published on a host port. The overlay uses one replica of each
API to reduce resource use; capacity and availability have not been measured.
Never remove the named volumes when updating or stopping the stack.

## Backup and recovery plan

* Schedule the existing `infrastructure/ops/backup-postgres.sh` against the
  production database daily, and copy encrypted dumps and checksums off the
  server to a separately accessible location. Set retention on both copies.
  Protect the connection string and backup files. A daily dump can lose up to a
  day's writes; this setup does not provide point-in-time recovery.
* Back up the `storage` volume as well as the database. Quiesce media writes
  while taking a coordinated database and media backup, and preserve file names
  and permissions. Docker volumes on the same server are not off-host backups.
* Periodically restore the database and media into an isolated environment,
  run `infrastructure/ops/restore-verify.sql`, and test media access. Verify the
  role provisioning and keep the encryption/signing keys available separately.
  Test a restore before relying on the backup schedule; no restore has yet been
  verified for this overlay.
