# DISASTER_RECOVERY

Targets (provisional, from brief): RPO ≤ 5 min, RTO ≤ 60 min. **Not yet achievable to claim**: they depend on the managed PostgreSQL's PITR (owner input 11).

## What was actually drilled (2026-10-03, local only)
`pg_dump -Fc` of the dev database (2,399 orders, 2,399 outbox rows, 2.0 MB) → `pg_restore` into a fresh database.
| Step | Time |
|---|---|
| Dump | 0.9 s |
| Restore | 2.5 s |
Verification (identical on source and restore): orders 2,399 · order_items 2,399 · Σ on_hand 1,997,601 = Σ ledger deltas 1,997,601 · outbox 2,399 · idempotency keys 2,399 · integrity triggers present. This proves the dump/restore *procedure and invariants* at toy scale; it says nothing about RPO/RTO on production-size data or PITR.

## What must be recoverable
PostgreSQL (all business truth incl. identity, outbox, idempotency, invoices), the object store (`STORAGE_DIR` / bucket: review photos), secrets (`AUTH_SIGNING_PRIVATE_KEY`, `AUTH_TOTP_ENC_KEY` — **losing the TOTP key makes every operator re-enrol MFA; losing the signing key only logs everyone out**), IaC/compose files. Redis is disposable.

## Plan
1. Managed Postgres with PITR + daily logical dump to a separate account/region; object-store versioning; keep keys in a secret manager with a second sealed copy.
2. Quarterly drill: restore to a new instance at a chosen timestamp, run the verification queries above (plus: refunds ≤ totals, every order has items, invoice numbers consecutive per FY), point staging at it, run `pnpm test:integration` against it, record elapsed time here.
3. After a restore: set `checkout_enabled=false`; let `payment-reconcile` ask the provider about every pending attempt; replay missed webhooks from the provider dashboard; reconcile; re-enable.
4. App rollback = previous image tag; never assume the database can go backwards.

## Known consistency risk
Orders restored to time T may lack payments captured after T → the provider is the truth; reconciliation produces `exception` + refund records. Agree customer-communication steps with the owner.
