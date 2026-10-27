# OPERATIONS_RUNBOOK (draft — procedures not yet exercised in a deployed environment)

## Kill switches (fastest first)
1. Console → Store settings → **Disable checkout now** (no MFA needed; audited). Effect: new quotes/orders refused (`CHECKOUT_DISABLED`); in-flight payments/webhooks still processed.
2. Env flags `FEATURE_CHECKOUT|COD|ONLINE_PAYMENTS=false` + redeploy (per-method kill).
3. There is no legacy checkout path to fall back to; to stop selling use 1 or 2. Roll the app back by image tag.

## Signals to watch (Prometheus `/metrics`)
`http_request_duration_seconds{route,status}`, `outbox_oldest_pending_age_seconds`, `db_pool_connections`, `commerce_events_total`. Dashboard page shows payment exceptions, open refunds, dead letters. **Alerts/dashboards as code are not written yet.**
Suggested alerts: outbox age > 120 s (page); dead letters > 0 (ticket); payment exceptions > 0 (ticket, finance); 5xx > 1 % 5 min (page); `/readyz` failing (page).

## Playbooks
| Symptom | Likely cause | Action |
|---|---|---|
| Customers paid but order `pending_payment` | webhook missed/delayed | Worker `payment-reconcile` polls provider every 60 s; check `payment_events` status `failed`; console → order → attempts. Do **not** hand-edit order status. |
| `payment_status = exception` | amount mismatch or capture after expiry/cancel | Console → Refunds (a full refund is queued for late capture) → Process (MFA). Mismatch: investigate provider dashboard first. |
| Dead-lettered events | handler failing | Console → Queues → read `last_error`, fix cause, **Replay** (MFA). Handlers are idempotent (inbox). |
| Stock looks wrong | manual SQL / bug | Compare `inventory_positions` vs `sum(inventory_movements)` (query in `docs`: ledger must equal position); fix only via Admin **Adjust** (ledger). |
| Pool exhaustion / 503 UNAVAILABLE | long transactions / lock waits | `lock_timeout` 2 s turns waits into retryable 503; inspect `pg_stat_activity`; scale replicas only after confirming DB is not the bottleneck. |
| Reservation not released | worker down | `reservation-expiry` loop (15 s) is DB-driven; restart workers — nothing is lost. |

## Deploy / drain
SIGTERM → API stops accepting, finishes requests (25 s hard cap), closes pool; workers stop loops, 2 s grace. Run migrations **before** the app, expand-only. Roll back app by image tag; DB changes are forward-only (restore from PITR if required).

## Routine
Daily: dead letters, exceptions, refunds open. Weekly: ledger-vs-position reconciliation query; idempotency cleanup runs hourly. Quarterly: restore drill (see DISASTER_RECOVERY).

## Added in v1.1
* **Sign-in problems**: operators — `PG_ADMIN_URL=… tsx scripts/create-admin.ts --email … --role …` resets the password and unlocks the account (it prints a new one-time password). Lost authenticator: delete the row in `auth.admin_totp` for that user, then they re-enrol under *My security* (no recovery codes yet).
* **Emails not arriving**: check `email_outbox` (`status`, `last_error`); without `SMTP_HOST` emails are only logged by the workers.
* **Key handling**: `AUTH_SIGNING_PRIVATE_KEY` rotation = add the old public key to `AUTH_VERIFY_PUBLIC_KEYS`, switch `AUTH_SIGNING_KID`/private key, remove the old one after 1 hour. Losing `AUTH_TOTP_ENC_KEY` forces every operator to re-enrol MFA.
* **Returns**: stock returns only when a return is *received* in the console; COD refunds are sent manually by you.
* **Invoices**: refused until seller GST details are saved; numbers are consecutive per financial year (April–March, IST) and immutable.

## 2026-10-06 additions
* **Pause orders:** Console → Store status (`PUT /v1/admin/store-status`). Quotes and order placement are refused with your message; browsing continues. Resume the same way.
* **Shipping stuck?** `GET /v1/admin/health` shows unprocessed provider events and stuck shipment requests; workers retry (`shipping-event-sweep`, `shipping-reconcile`, `shipping-bulk-sweep`). A timeout after the provider accepted an order never creates a second one (the request resumes by reference).
* **Provider down:** set `SHIPPING_PROVIDER=none` and ship manually; existing shipments keep their state.
* **Bad release:** Experience → Releases → Roll back (instant), or the per-channel kill switch to fall back to the bundled design.
* **Coupon abuse:** deactivate the coupon (`POST /v1/admin/coupons/{id}/deactivate`); placed orders keep their discount.
* **Force an app update:** raise the minimum supported version (`PUT /v1/admin/app-versions/{platform}`).
