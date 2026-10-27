> **READ THIS FIRST (2026-10-06):** the backend phases B8-B13 are BUILT. Sections 3, 4, 5 and 8-10 below are the original gap list and proposals and are HISTORICAL. The authoritative sources are ../backend-contract/openapi.yaml, api-index.md, blocks.schema.json and the "Implementation status and deviations" section at the END of this file.

# 03 — Backend contract: what exists, what is missing, what will be added

> Part of the Jimmy & Wax dashboard prompt package.
> **Read this carefully: §2 exists today and is tested; everything in §4–§6 is a *proposal* that is NOT implemented yet.** The backend repo’s session will implement it in the phases of §8 and publish the final shapes in `contracts/api/openapi.yaml`. Build the dashboard **contract-first against that file** (mock until the endpoints land, §9). Never claim a dashboard feature is “working” against the backend unless it ran against the live stack.

## 0. Status and rules

* Backend repo: `C:\Users\MSI\OneDrive\Desktop\jimmy&wax_backend` (pnpm monorepo: `commerce-api` :4000, `experience-api` :4001 (read model), `workers`, shared packages, `db/migrations`, `contracts/api`).
* Authoritative contract: `contracts/api/openapi.yaml`, OpenAPI 3.0.3, **v1.2.0-draft.1**, sha256 `95740d1125c702e155eb3c9e9f1aef7cea90f659bb384cf8a74cdf0256bafeb8`, **227 operations**, parity-checked against the router (`pnpm contract:check`). Changes are logged in `contracts/api/CHANGELOG.md` and `CONTRACT_DECISIONS.md`.
* **Pin the hash** in the dashboard (`contract.lock`); CI fails if the backend’s file changed without the lock being updated; regenerate types with `openapi-typescript`.
* Verified state (2026-10-05): 125 backend tests pass on PostgreSQL 17; the stack is **not** production-deployed; Razorpay, SMS, SMTP and Shiprocket are **not configured/verified**; checkout is **OFF** until stock is entered and an operator activates it.

## 1. Conventions (existing and binding)

| Topic | Rule |
|---|---|
| Base / format | `/v1/...`, JSON, UTF-8. |
| Money | Integer **paise** (`*_paise`), currency INR. **GST 18 % is included in listed prices** (`gst_rate_bps = 1800`, `tax_inclusive = true`); COD adds a **₹25** handling fee (`cod_fee_paise = 2500`); shipping ₹40, free from ₹2,000. Never compute totals in the UI — display server numbers. |
| IDs | Orders/users/etc. are UUIDs; products, variants, categories use slug ids `^[a-z0-9-]+$` (≤ 100). |
| Time | ISO-8601 UTC. Display in **IST** (Asia/Kolkata) with the UTC value in a tooltip. |
| Pagination | `limit` (1–50, default 20) + opaque `cursor` (keyset). |
| Concurrency | Admin mutations carry `expectedVersion` (stock) or `If-Match` (new Studio docs). Conflict ⇒ `409`. |
| Idempotency | `Idempotency-Key` header on creates/publish; replay returns the same result, different body ⇒ `422 DUPLICATE_REQUEST_MISMATCH`. |
| Errors | Body `{ "error": { "code", "message", "requestId", "retryable", "fields?", "lines?" } }`. Codes: `VALIDATION_FAILED` 400, `UNAUTHENTICATED` 401, `FORBIDDEN` 403, `NOT_FOUND` 404, `CART_VERSION_CONFLICT`/`QUOTE_*`/`ITEM_UNAVAILABLE`/`STOCK_SHORTAGE`/`ILLEGAL_STATE`/`REQUEST_IN_PROGRESS` 409, `UNSUPPORTED_PAYMENT_METHOD`/`NOT_SERVICEABLE`/`DUPLICATE_REQUEST_MISMATCH` 422, `PAYLOAD_TOO_LARGE` 413, `RATE_LIMITED` 429 (+`Retry-After`), `OTP_*` 401/503, `CHECKOUT_DISABLED`/`POLICY_NOT_CONFIGURED`/`UNAVAILABLE` 503, `INTERNAL` 500. Always surface `requestId` in the UI error panel (“copy details”). |
| Auth | Operators sign in via `POST /v1/auth/login` with `{email, password, client:'admin'}` → `{accessToken (EdDSA JWT, 15 min), refreshToken (rotating; reuse of an old one revokes the family), expiresIn, user, mfa:{required, enrolled}}`. TOTP: `/v1/auth/mfa/enroll`, `/v1/auth/mfa/verify` (returns an `aal2` token). `POST /v1/auth/refresh`, `/v1/auth/logout`. Login/OTP are rate-limited and locked out after repeated failures. |
| Step-up (MFA) | When `ADMIN_REQUIRE_MFA` is on, these permissions need an `aal2` session: `refunds:write`, `settings:write`, `ops:replay`, `orders:cancel`, `inventory:write`. **Today the failure is `403 FORBIDDEN` with the message “Re-authenticate with MFA to perform this action”** — there is no dedicated code. Backend request **BR-001** adds `MFA_REQUIRED`; until then detect by that message and open the TOTP prompt, then retry. |
| Admin gate | Every `/v1/admin/*` call checks: live session, `admin_users` row not disabled, role permission. Rate limit **240 requests/minute per signed-in operator**; responses carry `RateLimit-Limit`, `RateLimit-Remaining` and, when exceeded, `429` + `Retry-After` — drive the UI countdown/cooldown from these headers. |
| CORS | The dashboard calls the API **server-to-server from the Next.js BFF**; no browser→API CORS is needed or desired. |
| Observability | `x-request-id` request/response header; send your own correlation id and log it. |

## 2. Endpoints that exist today (admin) — usable immediately

Role → permission map (existing): `support`: orders:read, customers:read, reviews:moderate · `catalog`: catalog:read/write, inventory:read · `fulfillment`: orders:read/fulfil/cancel, inventory:read/write, customers:read · `finance`: orders:read, payments:read, refunds:write, audit:read · `admin`: all 16.

| Method | Path | Permission | Notes / dashboard module |
|---|---|---|---|
| GET | `/v1/admin/me` | (any operator) | `{userId, role, permissions[], mfa}` — drive menu/guards. |
| GET | `/v1/admin/dashboard` | orders:read | KPI figures **with definitions**; 30-day window in IST; low-stock count, payment exceptions, outbox pending/dead, refunds pending. |
| GET | `/v1/admin/orders` | orders:read | List/filter/cursor. |
| GET | `/v1/admin/orders/{id}` | orders:read | Detail (snapshots, payment, shipments, returns). |
| POST | `/v1/admin/orders/{id}/status` | orders:fulfil | State machine enforced in DB: `pending_payment→placed→confirmed→processing→shipped→out_for_delivery→delivered`; `cancelled`/`expired`/`returned` branches. |
| POST | `/v1/admin/orders/{id}/cancel` | orders:cancel (**MFA**) | Reason required; restocks. |
| POST | `/v1/admin/orders/{id}/cod-collected` | orders:fulfil | COD collection confirmation. |
| GET | `/v1/admin/inventory` · `/{variantId}/movements` | inventory:read | On-hand / reserved / available + ledger. |
| POST | `/v1/admin/inventory/{variantId}/adjust` | inventory:write (**MFA**) | `{delta, reason, expectedVersion}`; cannot go below reserved. |
| GET / PATCH | `/v1/admin/catalog/variants` · `/{id}` | catalog:read / write | Variant price/MRP/active/stock threshold (no product create yet). |
| GET / PATCH | `/v1/admin/settings` | settings:read / write (**MFA** on write) | Shipping fee, free threshold, COD enabled/fee/max, GST rate/mode, merchant legal name/GSTIN/state/address, return window, payment window, checkout flags. |
| POST | `/v1/admin/checkout/activate` · `/disable` | settings:write (**MFA**) | Audited explicit activation (blocked until stock + policy confirmed). |
| GET / POST | `/v1/admin/refunds` · `/{id}/process` | payments:read / refunds:write (**MFA**) | Over-cap guard in DB. |
| GET / POST | `/v1/admin/ops/outbox` · `/{id}/replay` | ops:read / ops:replay (**MFA**) | Dead-letter replay. |
| GET | `/v1/admin/audit` | audit:read | Append-only before/after. |
| GET / POST | `/v1/admin/orders/{id}/shipments` · `/v1/admin/shipments/{id}/events` | orders:read / orders:fulfil | **Manual** courier + tracking number + status events (statuses: `label_created, in_transit, out_for_delivery, delivered, failed, returned_to_origin`). Replaced by Shiprocket in B10. |
| GET / PUT | `/v1/admin/shipping/pins` | orders:read / settings:write | Serviceable PIN **prefix** list (today: `743287`). |
| GET / POST | `/v1/admin/returns` · `/{id}/decide` · `/{id}/receive` | orders:read / orders:fulfil | Stock restored once on receive; online-paid ⇒ refund queued. |
| GET | `/v1/admin/orders/{id}/invoice` | orders:read | Immutable invoice (needs seller details). |
| GET / POST | `/v1/admin/reviews` · `/{id}/moderate` · `/v1/admin/review-media/{id}/moderate` · `GET …/image` | reviews:moderate | Quarantined photo streaming through the BFF. |
| GET / PUT / POST | `/v1/admin/content` · `/{slug}` · `/{slug}/publish` | catalog:read / write | Versioned Markdown policy/care-guide pages. |

Customer-side reads the Studio and clients rely on: `GET /v1/home` (categories + first 12 products + store policy), `GET /v1/products`, `GET /v1/products/{id}`, `GET /v1/categories`, `GET /v1/store-settings`, `GET /v1/content` and `/{slug}`.

**Existing data model facts you will need:** tables `products, product_variants (sku, price_paise, compare_at_price_paise, stock_quantity, active), product_media (asset_path, alt_text, position), categories, inventory_positions/movements, orders/order_items, shipments/shipment_events, returns/return_items, refunds, invoices, reviews/review_media, content_pages/content_versions, store_settings, serviceable_pin_prefixes, notifications, device_tokens, email_outbox, outbox/inbox, audit_log, admin_users, auth.*`. **Product variants have no weight, dimensions or HSN; products have no SEO fields, tags or storytelling fields; categories have no image field.** Seed catalogue: 4 products (`twinkle-shine-leather-polish ₹299/₹399 MRP`, `polish-cloth-kit ₹499/₹599`, `complete-care-kit ₹799/₹999`, `black-shoe-care ₹399/₹499`), inventory 0.

## 3. The gap list (what the dashboard needs that the backend does not have)

P0: product/category/collection CRUD, product shipping attributes, **media library + processing**, **Experience Studio API**, **Shiprocket**, team management, MFA error code. P1: customers, coupons/discount engine, message templates, analytics, integrations status, store pause, app-version control, GST reports. P2: campaigns, abandoned carts, segments, cohorts.

## 4. Proposed new/extended API (shapes are proposals — the backend will finalise in OpenAPI)

> Conventions for all new admin endpoints: `/v1/admin/...`, permission shown, **audited** (before/after), cursor pagination, `If-Match` on document-like resources, `Idempotency-Key` on creates that must not duplicate.

### 4.1 Platform & team (B8)
| Method | Path | Permission | Notes |
|---|---|---|---|
| — | error code `MFA_REQUIRED` (403) | — | **BR-001**: replaces the message match. |
| GET | `/v1/admin/team` | team:manage | Members, role, disabled, last login, MFA enrolled. |
| POST | `/v1/admin/team/invite` | team:manage (**MFA**) | `{email, role}` → one-time invite link by email; account created with forced password set + MFA enrolment. |
| PATCH | `/v1/admin/team/{id}` | team:manage (**MFA**) | role, disabled; cannot demote/disable the last admin. |
| POST | `/v1/admin/team/{id}/reset-mfa` | team:manage (**MFA**) | Audited. |
| GET / DELETE | `/v1/admin/sessions` · `/{id}` | (own) | List and revoke own sessions. |
| POST | `/v1/auth/mfa/recovery-codes` | (own, aal2) | Generate/rotate 8 one-time codes (shown once). |

### 4.2 Catalogue & media (B8)
| Method | Path | Permission | Notes |
|---|---|---|---|
| GET / POST | `/v1/admin/products` | catalog:read / write | Filters `q, category, status(active\|inactive\|archived), stock(low\|out)`; create with variants + media. |
| GET / PATCH | `/v1/admin/products/{id}` | catalog:read / write | `expectedVersion`. Fields: name, subtitle, description, keyBenefits[], suitableSurfaces, boxContents, categoryId, tags[], `seo{title,description}`, active, sortOrder. |
| POST | `/v1/admin/products/{id}/variants` · PATCH `/v1/admin/catalog/variants/{id}` | catalog:write | Adds **`weightGrams`, `lengthMm`, `widthMm`, `heightMm`, `hsnCode`, `barcode`, `costPricePaise` (finance-only read)**. |
| PUT | `/v1/admin/products/{id}/media` | catalog:write | Ordered `[{mediaId, alt}]`. |
| POST | `/v1/admin/products/{id}/archive` · `/restore` · `/duplicate` | catalog:write | Archive instead of delete when orders exist. |
| GET / POST / PATCH | `/v1/admin/categories`; PUT `/v1/admin/categories/order` | catalog:read / write | Adds `description`, `imageMediaId`, SEO; reorder. |
| GET / POST / PATCH / DELETE | `/v1/admin/collections` | catalog:write | `kind manual\|smart`, manual ordered ids or rule. |
| POST | `/v1/admin/catalog/import` (multipart CSV; `dryRun`) · GET `/v1/admin/catalog/export` | catalog:write | Row-level error report; no partial silent success. |
| POST | `/v1/admin/media` (init upload → signed URL or multipart) · `POST /v1/admin/media/{id}/complete` | media:write | Content-type sniffing, size caps (images ≤ 15 MB, video ≤ 200 MB — configurable), virus scan hook, EXIF strip. |
| GET / PATCH | `/v1/admin/media` · `/{id}` | media:read / write | Filters `q, kind, tag, folder, approval, provenance, unused`; patch `alt, decorative, focal, tags, folder, role, provenance`. |
| POST | `/v1/admin/media/{id}/approve` · `/reject` · `/archive` | media:write | Approval carries reviewer + note + “does not alter packaging” attestation for `generated`. |
| GET | `/v1/admin/media/{id}/usage` | media:read | Docs/blocks/releases using it. |

Backend dependencies: object storage adapter (S3-compatible + CDN; today `LocalDiskStorage`), image pipeline (exists for review photos), **video transcoding/poster extraction (ffmpeg worker) — new**.

### 4.3 Experience Studio (B9) — see `02_EXPERIENCE_STUDIO_SPEC.md`
| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/v1/admin/experience/{channel}/docs` | experience:read | Index: `[{kind,key,rev,etag,updatedAt,updatedBy,dirtyVsLive}]`. `channel ∈ app\|web\|shared`. |
| GET / PUT / DELETE | `/v1/admin/experience/{channel}/docs/{kind}/{key}` | read / write | `PUT` requires `If-Match`; body = document body; server validates schema; `409 ETAG_MISMATCH` returns the server copy for merge. Revisions kept (≥ 200). |
| GET | `/v1/admin/experience/{channel}/docs/{kind}/{key}/revisions` | experience:read | For restore. |
| POST | `/v1/admin/experience/{channel}/validate` | experience:read | Full `ValidationReport` (spec §9.1). |
| GET | `/v1/admin/experience/{channel}/diff?against=live\|release:{id}` | experience:read | Structured human-readable diff. |
| POST / DELETE | `/v1/admin/experience/{channel}/preview-tokens` · `/{id}` | experience:write | `{ttlMinutes ≤ 1440, releaseId?}` → `{token, expiresAt, url}`. |
| POST | `/v1/admin/experience/releases` | experience:publish (**MFA**) | `{channels[], label, note?, scheduledAt?}` + `Idempotency-Key`; `422` with `ValidationReport` on errors. |
| GET | `/v1/admin/experience/releases` · `/{id}` | experience:read | Filters channel/status; detail includes change summary. |
| POST | `/v1/admin/experience/releases/{id}/rollback` · `/cancel` | experience:publish (**MFA**) | `{reason}`; cancel only for `scheduled`. |
| POST | `/v1/admin/experience/{channel}/kill` | admin (**MFA**) | `{enabled:boolean, reason}`. |
| GET / PUT | `/v1/admin/experience/campaigns` · `/{id}` | experience:write | Window, per-channel overlay; overlap check. |
| PUT / GET | `/v1/admin/experience/{channel}/presence` | experience:write | Heartbeat + who’s editing. |
| GET | `/v1/admin/experience/variables` | experience:read | Registry of `{{variables}}` with current resolved values. |
| CRUD | `/v1/admin/content-library/{entity}` | experience:write | `entity ∈ care-guides, stories, journal, testimonials, faq-groups, announcements`; each with `rev`/`If-Match` and `status`. |

**Testimonials in bundles:** for `mode: verified_reviews` the bundle resolver selects approved reviews (rating ≥ 4, bounded text length, author shown as first name + initial only, photos only if moderated-approved); curated testimonials are stored entities with `source` + consent. No endpoint exposes unmoderated review content.

**Public (cacheable):** `GET /v1/experience/{channel}` (bundle, spec §11; `?preview=<token>` ⇒ draft, `no-store`), `GET /v1/collections/{slug}` and `/products`, `GET /v1/products?ids=a,b,c`, `GET /v1/stories`, `GET /v1/journal` and `/{slug}` (P1), `GET /v1/app/version-check?platform=&build=` (anonymous).

### 4.4 Shipping — Shiprocket (B10) — full detail in `04_SHIPROCKET_SPEC.md`
Provider status, settings, pickup locations, serviceability check, shipment planning (rates/couriers), create+AWB+pickup, bulk ship, labels/manifest, tracking timeline, cancel, NDR queue/actions, RTO, reverse pickup for returns, COD remittance reconciliation, webhook receiver.

### 4.5 Customers, orders extras, privacy (B11)
| Method | Path | Permission |
|---|---|---|
| GET | `/v1/admin/customers?q&status&cursor` · `/{id}` | customers:read (PII access audited) |
| PATCH | `/v1/admin/customers/{id}` (notes, tags) | customers:write |
| POST | `/v1/admin/customers/{id}/block` · `/unblock` | customers:write (**MFA**) |
| GET | `/v1/admin/customers/export` | customers:export (**MFA**, audited) |
| GET / POST | `/v1/admin/privacy-requests` · `/{id}/fulfil` | customers:write (**MFA**) |
| POST | `/v1/admin/orders/{id}/notes` · `/resend-confirmation` | orders:fulfil |
| GET | `/v1/admin/orders/export` · `/{id}/packing-slip` | orders:read |

### 4.6 Offers & messaging (B12)
Coupons: `GET/POST/PATCH /v1/admin/coupons`, `POST /{id}/deactivate`, `GET /{id}/analytics` — types `percentage|flat|free_shipping`, min order, max discount, per-customer and total usage limits, validity window, product/category scope. Requires a **discount engine inside the quote** (GST-correct, invoice-correct) and `POST /v1/cart/coupon`. Message templates: `GET/PUT /v1/admin/message-templates/{key}` (email now; SMS/push when providers exist; variables validated), `POST …/test-send`, `GET /v1/admin/messages` (outbox viewer: status, attempts, last error).

### 4.7 Analytics & reports (B11)
`GET /v1/admin/analytics/{sales|products|customers|shipping|returns|geo|gst}` with `from, to, groupBy(day|week|month)`, definitions returned with the data; CSV exports (audited). Funnel/cohorts/dead-stock need event tracking — P2.

### 4.8 Settings, integrations, store status, versions, flags (B11)
* `GET/PATCH /v1/admin/settings` (extend: brand name, support email/phone/WhatsApp, return policy text refs).
* `GET /v1/admin/integrations/status` → per provider `{configured, mode (test|live), lastVerifiedAt, lastWebhookAt, lastError}` for Razorpay, Shiprocket, SMTP, SMS, Ola Maps, storage/CDN — **never secrets**; `POST /v1/admin/integrations/{name}/test` (rate-limited, audited).
* `GET/PUT /v1/admin/store-status` (pause orders, message, optional banner media).
* `GET/PUT /v1/admin/app-versions/{platform}` (`minSupportedBuild, latestBuild, latestVersionName, updateMessage, storeUrl`).
* `GET/PUT /v1/admin/flags` (admin only).
* `GET /v1/admin/health` (readiness, worker lag, outbox depth, last backup (when reported)).

## 5. New data (proposed tables; migrations are forward-only; RLS + audit as in the existing schema)

`exp_documents(channel, kind, key, rev, body jsonb, updated_by, updated_at, UNIQUE(channel,kind,key))` + `exp_document_revisions` (append-only) · `exp_releases(id, channel, number, status, label, note, snapshot jsonb, checksum, scheduled_at, activated_at, created_by, supersedes_id)` · `exp_channel_state(channel PK, active_release_id, enabled, kill_reason, kill_by, kill_at)` · `exp_preview_tokens(id, channel, token_hash, release_id?, expires_at, created_by, revoked_at)` · `exp_campaigns` · `media_assets(id, kind, sha256, mime, bytes, width, height, duration_ms, status, provenance, approval, approval_by/at/note, alt, decorative, focal jsonb, tags text[], folder, role, variants jsonb, archived_at, created_by)` · `collections` + `collection_items` · `care_guides` · `stories` · `journal_notes` · `testimonials(source, consent jsonb)` · `faq_groups` · `announcements` · product columns (`weight_grams, length_mm, width_mm, height_mm, hsn_code, barcode, cost_price_paise, seo_title, seo_description, tags`) · category columns (`description, image_media_id, seo_*`) · `coupons`, `coupon_redemptions` · `message_templates` · shipping tables/columns (see Shiprocket spec) · `admin_invites` · `app_versions` · `feature_flags` · `store_status`.

## 6. Roles and permissions (target matrix)

New permissions: `customers:write`, `customers:export`, `experience:read`, `experience:write`, `experience:publish`, `media:read`, `media:write`, `shipping:read`, `shipping:write`, `coupons:read`, `coupons:write`, `analytics:read`, `integrations:read`, `integrations:manage`, `team:manage`, `flags:manage`. New role **`designer`**.

| Permission group | support | catalog | fulfillment | finance | designer | admin |
|---|:-:|:-:|:-:|:-:|:-:|:-:|
| orders read / fulfil / cancel | R / – / – | – | R / F / C | R / – / – | – | all |
| customers read / write / export | R / – / – | – | R / – / – | – | – | all |
| catalog + inventory | – | W | inv W | – | R | all |
| media | R | W | – | – | W | all |
| experience read / write / publish | – | R | – | – | R / W / (P if granted, **MFA**) | all |
| shipping read / write | R | – | R / W | R | – | all |
| refunds / payments | – | – | – | W | – | all |
| coupons | – | – | – | R | – | W |
| analytics | – | – | R | R | – | R |
| settings / integrations / team / flags | – | – | – | – | – | all |
| audit / ops | – | – | – | audit R | – | all |
Step-up (**MFA/AAL2**) for: refunds, settings writes, integrations manage, team changes, inventory writes, order cancel, customer block/export, **experience publish/rollback/kill**, brand-lock changes, shipment cancellation, label/bulk ship over a configurable count.

## 7. Caching, CDN, events

* Published bundle: `Cache-Control: public, max-age=60, stale-while-revalidate=300`, `ETag`; no purge needed (TTL + etag). Preview: `no-store`.
* Media: content-addressed immutable URLs, `Cache-Control: public, max-age=31536000, immutable`, served from a CDN origin that the web CSP and the app both allow-list.
* Webhooks: `/v1/webhooks/{provider}` exists for payments; Shiprocket will use the same pattern (signature/token verification, raw payload stored, dedupe, retry-safe).
* Outbox/inbox + leased workers already exist for emails and settlement; scheduled-release activation and media processing use the same worker framework.

## 8. Backend phases (the backend session works these; the dashboard can start each module as soon as its contract draft is merged)

| Phase | Scope | Dashboard phases that depend on it |
|---|---|---|
| **B8** Platform & Catalogue | `MFA_REQUIRED`, team/invite/sessions/recovery codes, products/variants/categories/collections CRUD, shipping attributes, media upload + image pipeline + storage adapter, CSV import/export | D1–D2 |
| **B9** Experience Studio API | docs/revisions/validate/diff/preview/releases/rollback/kill/campaigns/presence, content-library entities, variables, public bundle + collections + `products?ids`, **shared fixture corpus** | D3–D6 |
| **B10** Shipping (Shiprocket) | adapter, planning, ship/AWB/pickup, labels/manifest, webhooks, NDR/RTO/returns, reconciliation | D7 |
| **B11** Customers, analytics, integrations | customers + privacy requests, analytics endpoints, integration status/test, store pause, app versions, flags, health | D8 |
| **B12** Offers & messaging | coupons + discount engine, message templates, outbox viewer, push when creds exist | D8 |
| **B13** Hardening | load/soak tests for new modules, backups/DR for media + experience tables, observability, security review | D9 |

Each phase ends with: OpenAPI bump (`v1.2.0-draft.N` …), contract + conformance tests green, mock fixtures/examples updated, `docs/build/*` updated. The dashboard repo records what it needs in **`docs/build/BACKEND_REQUESTS.md`** (see §10).

## 9. Mock-server rules (until an endpoint is live)

* Generate mocks from the OpenAPI **examples** (Prism or MSW handlers generated from the spec). If a needed endpoint has no example, write the request in `BACKEND_REQUESTS.md` — do not invent shapes silently.
* `API_MODE=mock|live`. In mock mode show a **permanent banner “MOCK API — data is fake”**; mock data never ships in a production build.
* Two Playwright projects: `mock` (fast, runs everywhere) and `live` (docker stack from the backend repo, `scripts/dev-stack.ps1`). **Only `live` results can mark a parity-matrix row “verified”.**
* Never code against a response field you did not see in the OpenAPI file.

## 10. Backend request protocol (`docs/build/BACKEND_REQUESTS.md` in the dashboard repo)

One row per request: `ID (BR-###) | need | proposed endpoint/shape | why/impact | blocks (module/phase) | priority | status (open / accepted / contract-drafted / implemented / verified) | links`. Seed it with **BR-001 `MFA_REQUIRED` error code**. The backend session answers by amending this file’s §4 and the OpenAPI, then flips the status. Do not wait idle on a request: build against the mock and continue.

## 11. Local development against the real backend

```powershell
# backend repo
cd "C:\Users\MSI\OneDrive\Desktop\jimmy&wax_backend\backend"
./scripts/dev-stack.ps1 -Reset         # docker postgres + redis, migrations, seed, commerce-api :4000, experience-api :4001, workers, gateway :8080
pnpm exec tsx scripts/create-admin.ts  # operator account (prompts); then enrol TOTP in the dashboard
```
Ports in use on the owner’s machine: backend 4000/4001/8080, existing minimal admin console 3177 (port 3100 is occupied by an unrelated process) — run the new dashboard on **:3200**. The existing console in `backend/apps/admin` is a minimal operator console that the new dashboard **supersedes**; reuse its session design (encrypted HTTP-only cookie via a BFF, refresh rotation, TOTP) rather than reinventing it, and retire it only after parity is verified.

## Implementation status and deviations (2026-10-06)
Phases B8–B13 are **built and tested** (190 backend tests; parity 227/227). Where the build differs from the text above, **the build wins**:

* **Preview** is served by commerce-api: `GET /v1/experience/{channel}/preview?token=` (not experience-api); `no-store`, `noindex`.
* **Preview-token overrides** are stored as `{ overrides: ... }`.
* **Testimonials** are referenced from blocks **by id**; the app channel validates them text-only (no video), the web channel may reference video.
* **Errors:** `ETAG_MISMATCH` is HTTP **409**; `MFA_REQUIRED` 403; `COUPON_INVALID` 422 with `error.reason`; a paused store returns `CHECKOUT_DISABLED` (503) with `paused: true` and the operator's message.
* **Store pause** (`PUT /v1/admin/store-status`) is deliberately not MFA-gated (like the checkout kill switch); resuming is equally quick.
* **Exports** live under `/v1/admin/exports/{customers|orders}.csv` (MFA + audited, formula-safe).
* **Support role** gained `customers:write` (notes/tags only); blocking a customer additionally needs an MFA session.
* **Coupon discount** is allocated per line, GST is charged on discounted amounts, free-shipping waives shipping and its GST, returns refund net of the coupon share. Free-shipping eligibility and the COD limit are judged on the **pre-discount** subtotal.
* **Integrations test** never fakes success: Razorpay/SMS/maps report "configured, no safe live probe".
* **Shiprocket:** mock-tested only; NDR actions and reverse pickup are not implemented. Keep `SHIPPING_PROVIDER=none` until a sandbox run succeeds.
* **Admin bodies** are mostly untyped (`object`) in OpenAPI; request schemas are typed for coupons, flags, app versions, store status and customer notes.

## Contract 1.4.0 (2026-10-10) - additions and changes since the build above
The authoritative description is `contracts/api/openapi.yaml` (234 operations) and `contracts/api/CHANGELOG.md`; this summary is for orientation.

* **Guarded writes everywhere an operator can hurt the shop.** Product archive/restore, add-variant, variant edits, CSV commit, shipping settings and PIN list (1.3.0) now joined by media archive/restore (`expectedUpdatedAt` + `reason`), category edit/order (`expectedRev` / `expectedRevs`), collection delete (`expectedRev` + `reason`), invoice issue (`reason`, MFA). A stale stamp is `409 CART_VERSION_CONFLICT`; blockers come back in `error.lines`.
* **Reading never changes data.** `GET .../invoice` returns the issued invoice or 404; issuing is `POST .../invoice`.
* **Public media is approved-only.** Draft, rejected and archived media answers 404 on `/v1/media/...`. Operators preview with `GET /v1/admin/media-files/{sha}/{file}`. Approving and rejecting is administrators-only. A development bridge (`MEDIA_PUBLIC_ALLOW_UNAPPROVED`) exists for older consoles and is refused in production.
* **Complete usage.** Media usage and the `inUse` filter cover products, categories, library entities, draft Studio documents, the live release of each channel and campaigns. Collection delete checks the same Studio references.
* **Image slots.** `blocks.schema.json` carries `x-slot: { minWidth, minHeight?, aspect?, kind? }` on every media prop and `brandSlotSpecs` for chrome slots. Files that are smaller or the wrong shape still publish, with `media.slot_too_small` / `media.slot_shape` warnings in the validation report. The numbers are proposed defaults held in `packages/commerce-domain/src/experience/slots.ts`.
* **Schemas from the validators.** `doc-schemas.json` (design system, token overrides, navigation, chrome) and `entity-schemas.json` (care guides, stories, journal, testimonials, FAQ groups, announcements) are generated; `pnpm contract:pack` regenerates the whole pack.
* **Order detail** gained `customerId` (for the audited reveal), allocation, status history, shipments, returns and email delivery state. **Lists** of returns and refunds are keyset-paged; returns carry the return-window policy, refunds carry `paymentCapability` and per-row `processable`.
* **Out-of-stock rule for product rails:** sold-out products stay in the list but never lead a rule-fed rail; a manual list keeps the editor's order; `resolved.outOfStockIds` names them.
* **Limits:** admin reads 600/min and writes 360/min per operator (429 + `Retry-After`); catalogue exports are bounded (20,000 variants / 50,000 orders, never silently truncated); public catalogue changes reach clients within about 95 s.
* **Operations:** `/metrics` needs `METRICS_TOKEN`; production configuration is validated at start (`pnpm preflight`); media can live in S3-compatible storage; migrations run through a ledger (`pnpm db:migrate`); email hard bounces suppress the address.
* **Deferred on purpose:** Finance-safe cost price (DASH-BR-023) needs an owner decision; Shiprocket and Razorpay live runs need the owner's sandbox credentials.
