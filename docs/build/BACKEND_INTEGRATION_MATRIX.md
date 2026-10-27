# BACKEND_INTEGRATION_MATRIX (2026-10-03)

Levels: **T** automated test on real PostgreSQL · **B** exercised manually in a browser · **S** simulated provider only · **U** unverified/not run · **—** not built.

| Capability | Where | Level |
|---|---|---|
| Register/login/refresh/logout, lockout, reuse detection | commerce-api `/v1/auth` | T |
| Password reset/change, email verification codes | commerce-api + `email_outbox` | T (delivery: U — needs SMTP) |
| Operator login, TOTP MFA enrolment/verify, `aal2` gating | commerce-api + console | T + B |
| Account export / deletion (retains financial record) | commerce-api | T |
| Catalogue, home, store policy, content, approved review photos | experience-api | T |
| Cart, guest cart, merge, addresses, wishlist, profile | commerce-api | T |
| Quote (GST included, COD ₹25), idempotent order, history, cancel | commerce-api | T |
| Merchant PIN serviceability | domain + console | T + B |
| Shipments / tracking (manual entry) → order status | commerce-api + console | T + B |
| Returns (request → decide → receive/restock → refund queue) | commerce-api + console | T |
| GST invoices (consecutive, immutable, CGST/SGST vs IGST, HTML) | commerce-api | T |
| Reviews (verified purchase), sanitised photos, moderation, public media | commerce-api + experience-api | T |
| Notifications (in-app + email queue/redaction/backoff) | workers + domain | T (SMTP: U) |
| Devices (push tokens stored) | commerce-api | T (push delivery: —) |
| Online order + payment attempt, webhooks, reconciliation, expiry | commerce-api + **test gateway** | T / S |
| Razorpay orders/refunds/webhook headers | RazorpayGateway | U (signature unit-tested only) |
| Admin API (RBAC/MFA/audit/inventory/price/settings/refund/replay/content/shipping/returns/reviews) | commerce-api | T |
| Operator console UI | Next.js | B (login, MFA, shipping areas, settings, order pages, mobile width) |
| Courier API, SMS, push delivery | — | — |
| Flutter ↔ API | — | U (app still on Supabase) |
