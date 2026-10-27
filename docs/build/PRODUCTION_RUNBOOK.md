# PRODUCTION_RUNBOOK (contract 1.6.0, updated 2026-10-25)

Everything an operator or engineer needs to deploy, run, back up, restore and roll back the JIMMY & WAX backend. It replaces the
"draft" sections of `OPERATIONS_RUNBOOK.md` and `DISASTER_RECOVERY.md` where they overlap (those remain as playbooks and history).

**Status of the procedures.** What was actually exercised is marked **verified** with the date and where. Everything else is
**written, not yet run in a deployed environment** - treat the first run as a rehearsal on staging.

* Verified 2026-10-10 (local Docker Postgres 17): migration ledger (`pnpm db:migrate`, baseline of an existing database, apply, status),
  backup + restore drill (`infrastructure/ops/drill-local.sh`, all 13 checks passed, 4 s), Caddyfile validation (`caddy validate`),
  production configuration validation (unit tests), `pnpm preflight`, the full automated test suite.
* Not verified: anything involving a real hosting provider, managed Postgres PITR, S3, a real SMTP server, Razorpay, Shiprocket.

---

## 1. Topology

```
website / app ──► api.<domain> (Caddy, HTTPS) ─┬─► experience-api  :4001   public GET reads (read-only DB role), bundles, media
                                               └─► commerce-api    :4000   accounts, cart, orders, webhooks, /v1/admin/*
dashboard (own deploy) ── server-to-server ───────► commerce-api    (/v1/admin/*)
workers (1 replica is enough) ──► PostgreSQL 17 (managed, PITR) ;  object storage (S3-compatible) ;  Redis (optional, rate limits only)
```

* Three database login roles, none a superuser: `jw_api_login` (member of `jw_commerce_api`), `jw_experience_login` (`jw_experience`, read-only
  views), `jw_worker_login` (`jw_worker`). Each service gets its own `DATABASE_URL`.
* **Redis is used for one thing**: shared per-client rate-limit counters (`REDIS_CACHE_URL`). It is optional and disposable; without it limits
  are counted per process (two API replicas = double the allowance) and if it is down the API fails open. The earlier "queue" Redis was never
  used and has been removed from the local compose file.
* `/v1/admin/*` is not meant for browsers. Restrict it at the edge to the dashboard host (Caddy `remote_ip`, a private network, or both).
  `/metrics` is blocked by the Caddyfile and additionally needs `METRICS_TOKEN`.
* The legacy in-repo console (`backend/apps/admin`) is retired in favour of the separate dashboard project; its compose service is commented out.

## 2. Configuration

Use `infrastructure/prod/.env.prod.example` for shared non-secret configuration,
then the separate commerce, experience and worker environment examples. Never
put commerce signing, payment or shipping secrets in the experience service.
Set `SERVICE_ROLE` to the matching service; Compose does this explicitly.
Shiprocket stays disabled until the owner supplies credentials. Follow
`SHIPROCKET_ACTIVATION.txt` for the read-only check and controlled activation.
Real phone sign-in uses `SMS_PROVIDER=twilio`, account SID/auth token and a
messaging service SID or approved sender. Configure `SMS_OTP_TEMPLATE` with
`{{code}}` and the provider-approved sender/template before real delivery tests.

Names only; the values belong to the owner and live in the host's secret manager. **Never put a value in git, a chat or a ticket.**
`NODE_ENV=production` makes the services refuse to start on an unsafe value (`packages/config` `productionProblems`, also run by
`pnpm preflight`).

| Name | Required in production | Meaning / rule |
|---|---|---|
| `DATABASE_URL` | yes, per service | The service's own login role. Must not contain a development password. |
| `PORT` | per service | commerce-api 4000, experience-api 4001. |
| `CORS_ORIGINS` | yes | Comma list of exact `https://` origins (the website). No `*`, no paths, no localhost. |
| `TRUST_PROXY_HOPS` | yes (>= 1) | Number of proxies in front (Caddy = 1); otherwise all clients share one rate-limit bucket. |
| `AUTH_SIGNING_PRIVATE_KEY`, `AUTH_TOTP_ENC_KEY` | yes | Ed25519 PKCS#8 PEM; 32-byte base64 key. See rotation below. |
| `AUTH_ACCESS_TTL_S`, `AUTH_ADMIN_ACCESS_TTL_S` | optional | Admin tokens must be <= 1800 s. |
| `ADMIN_REQUIRE_MFA` | must be `true` | Step-up for money/stock/publish/team actions. |
| `ADMIN_RATE_READ_PER_MIN`, `ADMIN_RATE_WRITE_PER_MIN` | optional | Per operator; defaults 600 / 360. |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `EMAIL_FROM` | yes | Operator invitations and password resets are delivered by email only. `EMAIL_FROM` must be a real address. |
| `EMAIL_WEBHOOK_TOKEN` | recommended | Enables `POST /v1/webhooks/email` for provider bounce/complaint callbacks (section 8). |
| `STORAGE_DRIVER` | `s3` | `disk` only with `STORAGE_ALLOW_LOCAL_DISK=true` (one host, backed-up volume). |
| `S3_BUCKET`, `S3_REGION` (or `S3_ENDPOINT`), `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_FORCE_PATH_STYLE`, `S3_PREFIX` | with `s3` | Any S3-compatible store. `S3_ENDPOINT` must be https. |
| `METRICS_TOKEN` | recommended | Bearer token for `GET /metrics`; without it `/metrics` answers 404 in production. |
| `REDIS_CACHE_URL` | recommended with >1 API replica | Shared rate-limit counters. |
| `FEATURE_CHECKOUT`, `FEATURE_COD`, `FEATURE_ONLINE_PAYMENTS` | per rollout | Process-level kill switches on top of the Settings gates. `FEATURE_ONLINE_PAYMENTS=true` needs `PAYMENT_PROVIDER`. |
| `PAYMENT_PROVIDER` | `none` until the owner enables Razorpay | `test` is refused in production. |
| `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET` | with `razorpay` | |
| `SHIPPING_PROVIDER` | `none` until the sandbox run | `fake` is refused in production. |
| `SHIPROCKET_EMAIL`, `SHIPROCKET_PASSWORD` **or** `SHIPROCKET_API_TOKEN`, `SHIPROCKET_WEBHOOK_TOKEN`, `SHIPROCKET_BASE_URL` | with `shiprocket` | Dedicated API user (not the panel login) or an expiring bearer token. Base URL must be https. Keep these out of the experience service. |
| `AUTH_DEMO_ENABLED` | leave unset | The fixed-code demo login. Refused with the default OTP. |
| `MEDIA_PUBLIC_ALLOW_UNAPPROVED` | must be unset/`false` | Development bridge for old consoles; refused in production. |
| `LOG_LEVEL` | optional | `info` by default; logs are JSON with `requestId`. |

Dashboard and clients (names only): dashboard `BACKEND_ORIGIN`, `DASHBOARD_PUBLIC_ORIGIN`, `DASHBOARD_SESSION_SECRET`,
`DASHBOARD_STOREFRONT_ORIGIN`, `DASHBOARD_HOST`, `ACME_EMAIL` (see its `deploy/README.md`); website `VITE_API_ORIGIN=https://<api-domain>`;
app `--dart-define=API_ORIGIN=https://<api-domain>` and `APP_ENV=production` (`EXPERIENCE_PREVIEW_TOKEN` is debug-only).

### Secret handling and rotation
* Generate: `openssl genpkey -algorithm ed25519` (signing key), `openssl rand -base64 32` (TOTP key), `openssl rand -hex 24` (tokens).
* Signing key rotation: add the old public key to `AUTH_VERIFY_PUBLIC_KEYS`, change `AUTH_SIGNING_KID` + private key, remove the old key after 1 hour.
  Losing it only signs everyone out.
* `AUTH_TOTP_ENC_KEY`: losing it forces every operator to re-enrol MFA; keep a second sealed copy. Rotating it needs a re-encryption job (not written): treat it as non-rotatable.
* Database passwords: create new login roles' passwords in the provider, update each service's secret, restart one replica at a time.
* A token that leaks (`METRICS_TOKEN`, `EMAIL_WEBHOOK_TOKEN`, `SHIPROCKET_WEBHOOK_TOKEN`): change it at both ends; there is no state to migrate.

## 3. First deployment (in this order)

1. **Provision** managed PostgreSQL 17 with point-in-time recovery, in an Indian region. Create the three NOLOGIN group roles and three LOGIN roles
   (`db/migrations` creates the groups if missing; login roles come from the secret manager - `db-reset.ts` shows the shape for development only).
2. **Secrets** into the host's secret manager (section 2). Build images from `infrastructure/docker/Dockerfile` (targets `commerce-api`,
   `experience-api`, `workers`).
3. **Migrate**: `MIGRATE_DATABASE_URL=<schema-owner connection> pnpm db:migrate --yes` (section 4). Empty database: it applies everything.
4. **Preflight**: load the production environment and run `pnpm preflight --probe`. Every line must say PASS (database up to date, storage
   write/read/delete, SMTP login, tokens set). Fix and repeat; do not start services on a FAIL.
5. **Start** commerce-api (2 replicas), experience-api (2), workers (1), Caddy (`infrastructure/prod/docker-compose.prod.yml`, `Caddyfile`).
   Check `/readyz` on each and `GET https://api.<domain>/v1/store-settings`.
6. **First operator**: `PG_ADMIN_URL=... pnpm exec tsx scripts/create-admin.ts --email ... --role admin` on the server; sign in to the dashboard and
   enrol the authenticator; download the recovery codes. Delete every local/test operator.
7. **Store setup in the dashboard** (nothing is guessed - see `BACKEND_OWNER_INPUTS.md`): stock counts, serviceable PINs, seller GST profile,
   return window, support contacts, app version policy. Checkout stays OFF until the owner presses Activate.
8. **Smoke test with a real phone**: browse, sign in, place a COD order, see it in the dashboard, cancel it.

## 4. Migrations (verified locally 2026-10-10)

* The only way schema changes reach a database with real data: `pnpm db:migrate` (`scripts/migrate.ts`). It keeps a ledger table
  `public.schema_migrations` (version, file name, SHA-256, applied time), takes an advisory lock, and runs each pending file in its own transaction
  together with its ledger row. `--status` and `--dry-run` change nothing. A non-local database needs `--yes`.
* **Never edit a migration that has shipped.** The runner stops with "drift" when an applied file's checksum changed. Add a new file instead.
* A database created before the ledger existed is adopted once with `--baseline <last applied version>`; the 2026-10-10 local dev database was
  adopted that way (`--baseline 20261009000000_catalog_edit_guards`, then `20261010000000_contract_hardening` applied).
* `db-reset.ts` (drop and recreate) is for localhost and CI only and refuses anything else. **Never run it, or `dev-stack.ps1 -Reset`, in production.**
  `db/seed.sql` and `dev-seed.ts` are development data.
* Release order: take a backup, migrate (expand-only changes), then roll out the new images. Contract/destructive changes ship one release later,
  after every old image is gone.
* Rolling back a bad migration = restore (section 5) or write a corrective forward migration. The database does not go backwards.

## 5. Backups and the restore drill

**Targets (provisional, owner to confirm): RPO <= 5 minutes, RTO <= 60 minutes.** They are met only if the managed Postgres has PITR switched
on. The scripts below are the portable, provider-independent second line.

* **Daily logical backup** - `infrastructure/ops/backup-postgres.sh` (`pg_dump` custom format, with grants and RLS policies, SHA-256 file, listing check,
  retention of the newest 14 dumps). Run it from cron with a read-only backup role; copy the directory off the host to versioned object storage in
  another account/region. Keys (`AUTH_*`) are NOT in the dump: keep them in the secret manager with a sealed second copy.
* **Restore drill** - `infrastructure/ops/restore-drill.sh <dump>` restores into a throw-away database on a scratch server and runs
  `infrastructure/ops/restore-verify.sql` (migration ledger present, orders readable, order lines not orphaned, totals reconcile with the database
  constraint, stock never negative, invoice numbers consecutive per FY, audit log append-only trigger present, catalogue and published experience present,
  RLS still on, application roles exist and their privileges came back). Exit code 0 only when every check passes. Run it **quarterly**, after any
  infrastructure change, and record each result in `docs/build/RESTORE_DRILLS.md`.
* **Verified 2026-10-10**: dev database (7 orders, 548 audit rows, 18 products) dumped and restored in 4 s; 13/13 checks passed. This proves the
  procedure and the invariants at toy scale; it says nothing about production-size RTO or PITR.

### Restoring production (disaster)
1. Stop the services (or at least set `checkout_enabled=false` through a direct SQL session) so nothing writes while you restore.
2. Provision the new server, create the roles, restore either **PITR to just before the incident** (provider tooling) or the newest dump:
   `pg_restore --no-owner --dbname <new db> --exit-on-error <dump>`.
3. Run `pnpm db:migrate --status` against it (it should be up to date; if the dump is older than the code, run `pnpm db:migrate --yes`).
4. Run `restore-verify.sql`; all rows must say `t`.
5. Point the services at it, start workers, then `pnpm preflight --probe`.
6. Reconcile with the payment provider (`payment-reconcile` polls pending attempts; replay missed webhooks from the provider dashboard). Orders restored
   to time T may lack payments captured after T - the provider is the truth (`DISASTER_RECOVERY.md`, "Known consistency risk").
7. Re-enable checkout only after reconciliation.

## 6. Rolling back

| What went wrong | Rollback |
|---|---|
| Bad deploy of the API / workers | Previous image tag. The database stays on the new schema (migrations are expand-only, so the old code still works). |
| Bad Studio release | Dashboard -> Experience -> Releases -> **Roll back** (instant, publishes an older immutable snapshot) or the per-channel **kill switch** (clients show their built-in design). |
| Bad price / stock edit | Re-edit with a reason (every guarded write is audited with before/after). |
| Need to stop selling now | Dashboard -> **Disable checkout** (no MFA, audited), or **Pause orders** (store status). Or `FEATURE_CHECKOUT=false` and redeploy. |
| Shipping provider down | `SHIPPING_PROVIDER=none`; ship manually. Existing shipments keep their state. |
| Bad migration | Section 4: restore or corrective forward migration. |

## 7. Observability

* **Logs**: JSON lines (pino) with `requestId` (echoed to clients as `X-Request-Id`; callers may send their own). Bodies and auth headers are never logged.
  Ship stdout to the provider's log service; keep 30 days hot.
* **Health**: `/healthz` (process), `/readyz` (database). Used by the compose health checks.
* **Metrics**: `GET /metrics` with `Authorization: Bearer <METRICS_TOKEN>` from the private network. Rules in `infrastructure/observability/alerts.yml`:
  5xx rate, p95 latency, outbox lag, pool saturation, process down, **auth failures**, **sustained 403 on /v1/admin**, **429 rate limiting**,
  **rejected webhooks**, 5xx bursts. Thresholds are starting points - tune after the first week of real traffic.
* **Audit log** (`audit_log`): every guarded admin write records actor, role, reason, before/after and request id. The table is **append-only**
  (a trigger rejects UPDATE/DELETE). **Retention policy (proposal for the owner and their accountant to confirm):** keep every row for at least 8 years;
  there is no automated deletion. When the table grows large, archive by year: export old rows to cold storage and remove them with a reviewed migration
  that temporarily disables the trigger inside one transaction - never by hand.
* Dashboard shows dead letters, payment exceptions, open refunds and integration status (Settings -> Platform -> Health).

## 8. Email

* Set `SMTP_*` and `EMAIL_FROM`; publish SPF, DKIM and DMARC for the sending domain. Check with the integrations test (`POST /v1/admin/integrations/smtp/test`, in the dashboard under Platform; it sends a test mail to your own address).
* Templates are managed in the dashboard (Messaging); token-carrying templates (invitation, password reset, verification) are not editable.
* **Bounces**: a permanent SMTP failure (5xx) fails the message once (no retry storm), redacts its payload and adds the address to `email_suppressions`; later
  mail to it is skipped as `suppressed`. If your provider reports bounces asynchronously (SES, SendGrid, Postmark...), point its webhook at
  `POST https://api.<domain>/v1/webhooks/email` with `Authorization: Bearer <EMAIL_WEBHOOK_TOKEN>` and body `{ "events": [{ "type": "bounce"|"complaint", "email": "...", "detail": "..." }] }`
  (a small mapping function on the provider side, or an automation, is needed - providers use their own formats). Operators review the list with
  `GET /v1/admin/outbox/suppressions` and lift an entry with a reason (`POST /v1/admin/outbox/suppressions/lift`, MFA). **The dashboard has no screen for this yet.**

## 9. Media storage

* Set `STORAGE_DRIVER=s3` and the `S3_*` names. Keys are content-addressed (`media/<sha256>/<file>`), so objects are immutable.
* Bucket: **private**, versioning ON, server-side encryption ON. Lifecycle: expire *non-current* versions after 30 days, abort incomplete multipart uploads after
  7 days, **no expiry on current `media/*`** (published releases refer to those keys forever). Cross-region replication is optional.
* The API is the only reader; the public URL `/v1/media/<sha>/<file>` serves **approved media only**. Put a CDN in front of the API origin for `/v1/media/*` if traffic needs it.
  Rejecting or archiving an asset stops the origin immediately, but a copy already cached by a browser or CDN (immutable, one year) cannot be recalled - purge the CDN for emergencies.
* Moving from local disk: copy the directory tree to the bucket under the same keys (`aws s3 sync .data/storage/ s3://<bucket>/<prefix>/`), switch the driver, run `pnpm preflight --probe`.

## 10. Payments (Razorpay)

Built and exercised against Razorpay's TEST API on 2026-10-13: order creation and lookup, hosted-checkout hand-off (page loads with brand, description and amount; Cancel returns to the website), signature and status verification (unit + integration tests with the in-memory gateway). **Not yet run end to end with a real test payment or a real webhook**: complete one test payment yourself (step 4) before going live.

**How it works (all three clients)**
* The customer's order is created first (`pending_payment`, stock reserved for the payment window), then a payment attempt creates a Razorpay order whose receipt is our attempt id.
* Website: a full-page redirect to Razorpay's hosted checkout (no Razorpay script runs on the storefront origin, because that origin keeps the sign-in token). Razorpay posts the browser to `https://<api>/v1/payments/razorpay/return`; the API verifies the signature, asks Razorpay for the order status itself, applies it through the same idempotent path as webhooks and answers `303` to `STOREFRONT_ORIGIN/orders/<id>?pay=...`.
* App: `POST /v1/orders/<id>/payment-link` returns a signed 10 minute link; the system browser opens it, it forwards to the hosted checkout, and the app polls `GET /v1/orders/<id>/payment` when the customer returns. Optional `APP_RETURN_URL` deep link; without it the browser shows a "return to the app" page.
* Webhooks (`payment.captured`, `payment.failed`, `order.paid`) remain the backstop and are the only path in production for a customer who closes the browser after paying. The reconciliation worker also polls pending attempts after 2 minutes.

**Configuration (names only; values in the secret manager, never in git)**
| Name | Notes |
|---|---|
| `PAYMENT_PROVIDER=razorpay`, `FEATURE_ONLINE_PAYMENTS=true` | |
| `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` | `rzp_test_...` while testing, `rzp_live_...` only after step 5. |
| `RAZORPAY_WEBHOOK_SECRET` | You choose it when you create the webhook in the Razorpay dashboard; the same string goes here. |
| `STOREFRONT_ORIGIN` | Required in production with online payments, https, no path (for example the website origin). The redirect destination comes only from here. |
| `PUBLIC_API_ORIGIN` | Optional; the public https API origin used in the callback URL. Falls back to the request host. |
| `APP_RETURN_URL` | Optional deep link (for example `jimmywax://payment`); needs the matching intent filter / URL scheme in the app. |

**Enable and verify**
1. Put the keys and secrets in the host's secret manager; set the variables above; redeploy. `GET /v1/store-settings` must now show `onlinePaymentsEnabled: true`.
2. In the Razorpay dashboard (Test mode) add a webhook to `https://<api-domain>/v1/webhooks/razorpay` with events `payment.authorized`, `payment.captured`, `payment.failed`, `order.paid` and the webhook secret from step 1. Local machines cannot receive webhooks; the redirect return path covers them.
3. The website CSP must allow the form post: `form-action 'self' https://api.razorpay.com` (already in `deploy/Caddyfile.example` of the website).
4. Place a test order on the website and in the app. On Razorpay's page use their published test payment details (cards, UPI `success@razorpay`). Confirm the order becomes `placed` / paid in the dashboard and the website/app show it. Also try Cancel and a failed payment.
5. Refund the test order from the dashboard (Refunds -> Process, MFA). The list shows `paymentCapability` and per-row `processable`. Refunds against the live provider are still unverified.
6. Switch to live keys only after the owner has seen steps 4-5 work in test mode, and rotate any key that was ever pasted into chat or email.

**Known limits**
* Razorpay's order list can lag creation by minutes, so recovery after a timeout (look up the order by receipt) is best effort; the worst case is one unused extra Razorpay order, never a double charge.
* A customer who abandons the payment page leaves the order pending until the payment window expires and releases the stock; the app has no "pay again from order history" button yet (the website order page has "Complete payment").

## 11. Shipping (Shiprocket) - sandbox checklist (not yet run)

Prerequisites from the owner: Shiprocket account, an **API user** (not the panel login), pickup location name, webhook token, wallet balance.
1. On staging set `SHIPPING_PROVIDER=shiprocket`, `SHIPROCKET_EMAIL`, `SHIPROCKET_PASSWORD`, `SHIPROCKET_WEBHOOK_TOKEN`; register `https://<staging-api>/v1/webhooks/shiprocket` with header `x-api-key: <token>`.
2. Dashboard -> Shipping -> Provider: reachable, wallet balance, pickup locations listed.
3. One low-value test order: Plan (serviceability + courier choice) -> Ship -> check AWB, label PDF (downloaded server-side from an allow-listed Shiprocket/S3 host, size-capped, no redirects) -> manifest -> webhook status changes advance the order -> cancel.
4. Pull the plug mid-ship (kill the API after the provider call) and confirm no second shipment is created on retry.
5. Only then set it in production, and ship one real low-value order first. The mock-tested adapter has never spoken to the real service.
6. After forward shipping passes, run one controlled reverse-return acceptance. Approval alone does not book a reverse shipment: require a separate merchant review of the buyer pickup, merchant return address, immutable order lines and parcel details. Confirm its tracking webhook reaches the same dashboard, website and app status views. Until that acceptance passes, coordinate returns manually and record physical receipt through the dashboard.

`SHIPROCKET_ACTIVATION.txt` is the authoritative credential handoff and recovery procedure. It includes the read-only readiness command and explicitly prevents blind retries of a timed-out provider create request.

## 12. Security checklist (see also `SECURITY_REVIEW.md`)

* Authorisation: `apps/commerce-api/test/integration/ops-hardening.test.ts` generates a request for **every** admin operation in the OpenAPI file
  and checks anonymous = 401 and a role lacking the documented permission = 403 (about 140 operations; self-service routes are listed explicitly).
  The dashboard's role matrix (`tools/run-role-matrix.ps1`) is the second, independent check.
* Rate limits: public and customer buckets per route; admin reads/writes per operator; auth routes per email/IP/phone.
* Bodies: JSON 32 KB (Studio documents 512 KB, content library 256 KB), webhooks 256 KB, CSV import 2 MB / 5,000 rows, uploads 100 MB (video) with per-type caps, Caddy 6 MB elsewhere.
* Uploads: type sniffed from bytes, images re-encoded (metadata and embedded payloads dropped), pixel and size limits, content-addressed storage.
* SSRF: the only server-side fetch of a provider-supplied URL is the label/manifest download: https, registered DNS name on the provider's hosts only, no credentials, no redirects, 10 MB cap.
* Dependencies: `pnpm audit --prod` is clean (2026-10-10, after upgrading nodemailer, sharp and the AWS SDK). Dev-only advisories on `vitest`/`tinypool` remain (test tooling, no untrusted input).
* Edge: HSTS, `nosniff`, no `Server` header; `/metrics` blocked; `/v1/admin` limited to the dashboard host (to be configured per environment).

## 13. Known limitations and deferred items

* Finance-safe cost price (DASH-BR-023) is an owner decision; cost price stays Admin-only.
* Live runs against Razorpay and Shiprocket need the owner's sandbox credentials.
* `AUTH_TOTP_ENC_KEY` rotation tooling does not exist.
* Order and catalogue CSV exports are bounded, not streamed.
* A draft Studio preview shows only already-approved media (the public media URL is approved-only by design).
