# BACKEND_OWNER_INPUTS (updated 2026-10-03)

## Resolved by the owner
| Item | Value |
|---|---|
| Identity | Own service; **no Supabase** |
| Prices / MRP | As shown in the customer app (₹299/399, ₹499/599, ₹799/999, ₹399/499) |
| Shipping | ₹40; free from ₹2,000; "3–5 business days" |
| GST | 18%, treated as included in listed prices (change in console if needed) |
| COD | Allowed; **₹25 handling fee** per COD order; no order limit set |
| Demo login | Phone **9800000001**, code **123456** (fixed demo code; works without SMS; account flagged "demo" in the console; off in production unless `AUTH_DEMO_ENABLED=true`) |
| First delivery area | PIN **743287** (more in console → Shipping areas) |
| Map SDK | Owner will supply later (no map code is built yet) |

## Still needed (nothing below is guessed; checkout stays OFF until 1–4 are done)
| # | Needed | Where it goes | Blocks |
|---|---|---|---|
| 1 | **Physical stock counts** per SKU | Console → Inventory | checkout |
| 2 | ~~Serviceable PIN prefixes~~ — **743287 done**; add more as you expand | Console → Shipping areas | — |
| 3 | An **operator account** — run `scripts/create-admin.ts` on the server, then set up MFA | CLI + Console → My security | console access |
| 4 | Decide to **activate** (explicit button, audited) | Console → Store settings | checkout |
| 5 | **GSTIN, legal name, state, registered address** | Console → Store settings → Seller details | GST invoices (checkout works without; invoices refuse until set) |
| 6 | **Return window** (days) and return/refund policy text | Settings + Policies | returns |
| 7 | Policy texts: Terms, Privacy, Refund/Return, Shipping, care guide (your/adviser's wording) | Console → Policies & guides | publishing pages |
| 8 | **Email sender** (SMTP host/user/password, From address) | env `SMTP_*` | real emails (otherwise logged only) — password reset & verification cannot reach customers without it |
| 9 | **Payment gateway** (Razorpay assumed) key id/secret/webhook secret; payment window | env + Settings | online payments (COD works without) |
| 10 | **Courier(s)** you use — fulfilment is manual entry of courier + tracking number (no courier API integration) | — | optional automation later |
| 11 | Hosting target/region, domain, backups with PITR | Infra | deployment |
| 12 | **HSN code** per product (if your CA requires it on invoices) | not captured yet | invoice completeness |
| 13 | Retention periods (orders, invoices, audit) | — | privacy/tax compliance |
| 14 | **SMS provider** (DLT-registered sender + template) so customers other than the demo number can sign in by phone; push (FCM/APNs) credentials | SMS sender adapter slot exists; provider not built | real phone sign-in, push |
| 17 | **Map SDK / API keys** (Google Maps or other) for address picking / tracking maps | Flutter side | map features |
| 15 | Confirm scale target (1M registered / 100k DAU / 10k sessions vs 1M *concurrent*) | — | capacity sign-off |
| 16 | Permission to provision paid infra + run load tests on staging | — | capacity evidence |

## Added 2026-10-06 (dashboard backend)
| # | Needed | Blocks |
|---|---|---|
| 18 | **Shiprocket**: account, API user (email/password), pickup location name + PIN, webhook token; wallet and COD remittance terms | live shipping (manual entry works meanwhile) |
| 19 | **Testimonials**: each person's consent (or replace with verified reviews); video files for the website | publishing the experience |
| 20 | **App store links** and the current / minimum app versions | update prompts |
| 21 | Support email / phone / brand name (Settings → Store) | footer and contact surfaces |
| 22 | First coupon campaign wording and limits (if any) | coupons |
| 23 | Object storage + CDN choice for media (the local-disk driver is dev-only) | production media |
