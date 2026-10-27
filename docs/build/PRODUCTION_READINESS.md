# PRODUCTION_READINESS — verdict (2026-10-03): **close for a controlled soft launch of COD; not "production-ready" for the stated scale or for online payments**

| Gate | Status | Evidence |
|---|---|---|
| Customer API: auth, cart, addresses, wishlist, quote → idempotent order, cancel, history, tracking, returns, invoices, reviews (+photos), notifications, devices, export/delete | **Implemented & tested** | 117 tests; 96/96 operations match OpenAPI; real responses validated against schemas |
| GST 18% (inclusive) + ₹25 COD fee | **Implemented & tested** | unit + HTTP tests; totals reconcile in DB constraint |
| Money/stock invariants | **Proven** on PG17 | race, idempotency, webhook, expiry, refund-cap tests; load runs checked ledger == position |
| Operator console | **Works in a real browser** (own login, MFA enrolment, shipping areas, settings, order flows, 375 px) | not covered: keyboard-only pass, large datasets, other browsers |
| Own identity | **Implemented & tested** | no external dependency; needs SMTP to deliver reset/verify emails |
| Email | Implemented; **sends only when SMTP configured** | owner input 8 |
| Online payments (Razorpay) | **Unverified** | no credentials; COD works without it |
| Courier integration | **Not built by design**: fulfilment = merchant enters courier + tracking | owner input 10 |
| Push/SMS | Not built | owner input 14 |
| Capacity (1M / 500 rps) | **Not demonstrated**; local smoke only: 60 orders/s clean, saturates ~100/s on one laptop process | CAPACITY_REPORT |
| Observability | Prometheus metrics, structured logs, alert rules **written, not deployed**; no tracing | `infrastructure/observability` |
| Deploy artifacts | `docker-compose.prod.yml`, `Caddyfile`, Dockerfile, CI YAML **written, never run** | repo is `git init`-ed only |
| Backup/DR | Dump/restore procedure drilled at toy scale; PITR/RPO/RTO unmeasured | DISASTER_RECOVERY |
| Security | Self-assessed; no external test | SECURITY_REVIEW |
| Flutter integration | **Not done** — the Flutter app still talks to Supabase; it must switch to this API (see handoff) | BACKEND_FLUTTER_HANDOFF |
| Policies/legal copy, GSTIN, stock, PIN list | **Owner inputs pending** | BACKEND_OWNER_INPUTS |

Checkout remains OFF until stock, serviceable PINs and an explicit activation exist.

## Minimum to go live with COD only
1. Deploy (compose or your host) with real `AUTH_SIGNING_PRIVATE_KEY`, `AUTH_TOTP_ENC_KEY`, SMTP, database with backups.
2. `scripts/create-admin.ts`, set up MFA, enter stock, PIN list, GST/seller details, publish policy pages, set return window.
3. Flutter app switched to the API and tested on a device against staging.
4. Activate checkout; watch the dashboard, dead letters and the alert rules.

## 2026-10-06 — added surface (B8–B13)
| Gate | Status | Evidence |
|---|---|---|
| Operator API for the new dashboard (team, catalogue, media, Experience Studio, shipping, customers, analytics, coupons, messaging, flags, versions) | **Implemented & tested** on PG17 | 65 new tests; 227/227 operations documented |
| Coupons / discounts | **Implemented & tested**, incl. the concurrent total-limit race and GST/refund correctness | b12.test.ts |
| Store pause | **Implemented & tested**; blocks quotes and orders | b11.test.ts |
| Shiprocket | **Mock-tested only**: run the sandbox flow with a real account before relying on it; keep `SHIPPING_PROVIDER=none` (manual entry) until then | b10.test.ts |
| Typing of admin request/response bodies | **Partial**: most are `object` in OpenAPI; details in docs/dashboard-prompt/03_BACKEND_CONTRACT.md | CHANGELOG 1.2.0 |
| Load/capacity of the new endpoints | **Not measured** | — |
