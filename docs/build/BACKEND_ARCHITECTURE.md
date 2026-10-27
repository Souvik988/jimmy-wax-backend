# BACKEND_ARCHITECTURE

```
Flutter ──► experience-api (public reads, cacheable, views only)   ─┐
        ──► commerce-api   (writes, auth, checkout, admin API)      ├─► PostgreSQL (plain, self-managed or managed — no Supabase)
Next.js admin ─► (BFF cookie) ─► commerce-api /v1/admin             │
workers (outbox relay, expiry, reconcile) ─────────────────────────┘      Redis: rate limits only (fail-open)
```
Workspace: `backend/packages/{config,contracts,database,commerce-domain,integrations,observability,test-support}`, `backend/apps/{commerce-api,experience-api,workers,admin}`. Contract: `contracts/api/openapi.yaml`.

## ADRs (short form)
* **ADR-002 Boundaries.** Commerce rules live only in `commerce-domain`, called by commerce-api and workers. The Next.js app has **no** pricing/stock/payment logic: it forwards the operator's token. Experience-api reads **views** through a role with no table grants and cannot write. *Honest note:* commerce-api and workers share one database and one domain package; they are separately deployable processes, **not** independent microservices. Extraction triggers (documented, not met): search needing its own index (>~50k SKUs or p95 breach), notification fan-out volume, or a second fulfilment location.
* **ADR-003 Data access.** Explicit parameterised SQL via `pg` for every transactional/concurrency-sensitive path; **Drizzle is not used** (deviation from the brief, deliberately). Reasons: every critical statement is a conditional `UPDATE … WHERE on_hand-reserved >= $q`, `FOR UPDATE`, `ON CONFLICT` or `SKIP LOCKED` that an ORM would hide; one migration authority (the SQL ledger in `db/migrations`) with no second schema model to drift. Revisit if read-model code grows.
* **ADR-004 Concurrency.** Stock take is a single conditional UPDATE (row lock serialises); lines sorted by variant id; global lock order **order → attempt → reservation → inventory**; `lock_timeout` 2 s, `statement_timeout` 5 s; deadlock/serialization retry ×3 in `Db.tx`. No provider call inside any transaction.
* **ADR-005 Idempotency.** Claim row `(scope,key)` inside the order transaction; concurrent duplicates block on the unique index then replay the stored response; different request hash → `DUPLICATE_REQUEST_MISMATCH`. Permanent tombstones: `orders (user_id, idempotency_key)` unique and `checkout_quotes.consumed_order_id`; `idempotency_keys` rows retained 90 days then cleaned without enabling re-purchase of a consumed quote.
* **ADR-006 Inventory.** Ledger (`inventory_movements`) + position (`on_hand`, `reserved`, CHECK `reserved<=on_hand`). COD **commits** stock at order time; online **reserves** until `payment_window_minutes` (unset ⇒ online disabled), commit on verified capture, release/expire exactly once (`settleReservations` status-guarded). Returns restock on *receipt*, once.
* **ADR-007 Payments.** Local attempt persisted before the provider call; provider receipt = attempt id so a timeout-after-accept is recovered by lookup; webhook = raw-body HMAC, durable intake before 200, dedupe on `(provider,event_id)`, state guards for reordering; late capture ⇒ `payment_status='exception'` + full-refund request, never fulfilment; paid only from provider-confirmed capture.
* **ADR-008 Async.** Outbox rows written in the business transaction; relay claims with lease (`SKIP LOCKED`), consumer inbox dedupe in the same tx as effect, backoff+jitter, dead-letter, admin replay. Loops discover work from the DB, so Redis loss loses nothing. BullMQ is a dependency but not yet used (no external-effect providers configured).
* **ADR-009 Admin security.** `admin_users` (server-side roles), per-role permission matrix, MFA (`aal2`) required for refunds/settings/cancel/stock/replay, kill switch not MFA-gated, DB-level admin gate, append-only `audit_log` (trigger blocks UPDATE/DELETE).

## State machines
Order: `pending_payment→{placed,expired,cancelled}`, `placed→{confirmed,cancelled}`, `confirmed→{processing,cancelled}`, `processing→{shipped,cancelled}`, `shipped→{out_for_delivery,delivered,returned}`, `out_for_delivery→{delivered,returned}`, `delivered→returned` (table `private.order_transitions`, enforced by trigger).
Payment attempt: `created→pending→authorized→captured` (never downgrades from `captured`), `failed|expired|cancelled`; ≤1 live attempt per order (partial unique index).
Reservation: `active→committed|released|expired` (once). Refund: `requested→pending→processed|failed`, sum ≤ order total (trigger).

## Data model
See `db/migrations/20261002100000_*.sql` (carts, inventory, reservations, quotes, idempotency, payment_attempts/events, refunds, outbox/inbox, audit, admin_users) and `…101000_admin_surface.sql`, `…102000_experience_read_models.sql`, `20261003000000_own_identity_and_commerce_v2.sql` (identity, GST/COD fee, shipping, returns, invoices, review media, devices, content, email outbox). Orders carry immutable line/address snapshots and a `rules_version`.
**Not built yet:** coupons/promotions, courier API integration, HSN codes, search service, SMS/push delivery.

## ADR-010 Own identity (replaces Supabase Auth)
Passwords: scrypt (N=16384,r=8,p=1) with constant-work dummy hash for unknown users. Sessions: Ed25519 access JWT (15 min; 30 min for operators) + opaque rotating refresh token stored hashed per **family**; reuse of a rotated token revokes the family. MFA: RFC 6238 TOTP for operators, secret AES-256-GCM encrypted, replay-protected by last counter; `aal2` is recorded on the session family and surfaced as a claim. Failures that must persist (lockout counters, family revocation) are returned as results and thrown by the route after COMMIT. Email: durable `email_outbox` (API can insert but not read back), worker sends via SMTP, payload redacted after send.

## ADR-011 Tax and fees
`store_settings.gst_rate_bps` (1800) + `tax_inclusive` (true). Per component (each item line, shipping, COD fee) GST is extracted with integer round-half-up; the breakdown is stored on the quote and copied immutably to the order. Total = items − discount + shipping + COD fee (+ tax only if exclusive); a CHECK constraint enforces it. Invoices split CGST/SGST vs IGST at issue time from the buyer state vs the seller state.
