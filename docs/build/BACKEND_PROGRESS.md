# BACKEND_PROGRESS (2026-10-03)

| Phase | State | Evidence / gap |
|---|---|---|
| B0 Audit | ✅ | BACKEND_BASELINE, MIGRATION_PLAN (ADR-001 revised: no Supabase) |
| B1 Foundation | ✅ local | pnpm workspace, strict TS (all projects typecheck), config validation, metrics/logs, compose, forward-only migration chain from an empty DB, CI YAML (never run), Dockerfile (never built) |
| B2 Identity & shopping | ✅ | own auth (register/login/refresh/reset/verify/MFA/export/delete), cart/guest/merge, addresses, wishlist, catalogue/home/content reads, cursor pagination |
| B3 Transactional commerce | ✅ (COD proven; online with test gateway) | quote → idempotent order tx, reservations/ledger, payment attempts, webhooks, reconciliation, expiry, refunds, **GST 18% + ₹25 COD fee**, hot-SKU lock hold minimised |
| B4 Operations | ✅ core | outbox/inbox + email queue + workers, shipments/tracking, merchant PIN serviceability, returns (restock on receipt), GST invoices (consecutive/immutable), reviews + sanitised photos + moderation, devices, in-app + email notifications, versioned content, account export/delete |
| B5 Administration | ✅ core | console: dashboard, orders (+shipments), inventory, prices, settings (COD fee/GST/seller/return window), shipping areas, returns, refunds, reviews, policies, queues, audit, My security (MFA) |
| B6 Reliability & capacity | ⚠️ local only | smoke + checkout load (≤60 orders/s clean, hot-SKU fixed), toy-scale restore drill; **no production-scale evidence** |
| B7 Integration & release | ❌ | Flutter not switched to this API; nothing deployed; Razorpay/SMTP unverified live |

## Test evidence
`pnpm exec vitest run --no-file-parallelism` → 10 files / **117 tests** pass (unit + real-PG integration). `pnpm contract:check` → 96/96 operations. Typecheck clean on every project; the Next.js console was exercised in a real browser (own login, MFA enrolment, shipping areas, settings, order pages).

Defects found by tests/load and fixed this round: login-failure counter lost on rollback; refresh-reuse revocation lost on rollback; `ON CONFLICT` needing a SELECT policy (email outbox → column-limited grant); account-deletion FK on quotes; **hot-SKU serialisation (journey p95 3.4 s → 91 ms)**; over-broad review policy; JSON-flow YAML errors in the contract.

## Deviations from the brief (deliberate)
Drizzle not used (ADR-003); BullMQ not used (DB-leased loops; dependency removed); OpenTelemetry tracing not added; `commerce-api` hosts the admin API; single-host compose instead of Terraform/ECS; fulfilment is manual courier entry (no courier API).

## 2026-10-05 update
Phone OTP + demo login (9800000001/123456), PIN 743287, Flutter app switched to this API, debug APK built. Latest run: 125 backend tests passing, contract 98/98. See FINAL_INTEGRATION_REPORT.md for what is still unverified. Security note: the demo login is a fixed-code account; keep AUTH_DEMO_ENABLED unset in production until launch decisions are made.

## 2026-10-06 update — dashboard phases B8–B13
| Phase | State | Evidence / gap |
|---|---|---|
| B8 Platform, catalogue, media | ✅ | team invites + recovery codes, designer role, product/variant/category/collection CRUD, CSV import/export (all-or-nothing, formula-safe), content-addressed media library with approval/provenance (12 tests) |
| B9 Experience Studio | ✅ | typed block documents, If-Match revisions, validation gate, immutable releases, schedule/kill switch, preview tokens, campaigns, content library, public bundle with ETag (12 tests) |
| B10 Shipping (Shiprocket) | ✅ against a fake provider; ❌ live | idempotent shipment state machine, webhooks, reconcile, bulk jobs, labels, serviceability gate (18 tests). **Shiprocket endpoints are mock-tested only** |
| B11 Platform ops | ✅ | customers (masked, audited reveal, notes, block with MFA, export), order notes/packing slip/resend, exports, 7 analytics reports with definitions, store pause, app versions + launch check, feature flags, integrations status/test, health (10 tests) |
| B12 Coupons + messaging | ✅ | percentage / flat / free-shipping coupons; GST on discounted lines; per-line allocation; net refunds on returns; per-customer and total limits that hold under concurrent orders; editable order emails with validated placeholders (13 tests) |
| B13 Hardening | ✅ docs/contract; ⚠️ not load-tested | OpenAPI 1.2.0-draft.1: 227 documented = 227 served; typecheck clean everywhere |

Latest run: **190 tests pass / 16 files**; `pnpm contract:check` 227/227, spec sha256 `95740d1125c702e155eb3c9e9f1aef7cea90f659bb384cf8a74cdf0256bafeb8`.

Defects found by these tests and fixed: the customer role could not see other customers' coupon redemptions (total limit would oversell) → counts come from a definer function; coupon row locks are refused by RLS for the customer role → advisory lock; column-level grants missing on new settings columns; system-actor webhook updates blocked by RLS; order address snapshot keys mismatched in shipping; test suites leaking catalogue rows across files.
