# Contract changelog

## 1.6.0 - 2026-10-25

- Product reads now carry all active `variants` within one product. Pagination counts products once; clients select the stable variant ID and its integer price/stock before adding it to the cart.
- Historical order lines include `orderItemId` so customers can request returns against immutable purchased quantities.
- Account deletion accepts either the existing password proof or a fresh six-digit OTP for the authenticated account's bound phone number. Failed OTP attempts remain rate-limited and persisted.
- Dashboard, website and Flutter snapshots are pinned to the same canonical OpenAPI hash. Real provider and device acceptance remain release gates.

## 1.0.0-draft.1 — 2026-10-02
Initial draft: experience reads, guest/customer cart, addresses, wishlist, quotes, orders (idempotent), payment attempts/status, cancel, webhooks, admin surface (loosely typed). 50 operations, parity with `commerce-api` + `experience-api` enforced by `scripts/contract-check.ts`.

## 1.2.0-draft.1 — 2026-10-06
Adds the operator-console surface (phases B8–B12) and coupons. 227 operations; parity enforced by `scripts/contract-check.ts`.

- **Customer-facing (the app/web must handle):** `POST|DELETE /v1/cart/coupon`; optional `couponCode` on `POST /v1/checkout/quotes`; `couponCode` on Cart/Quote/Order; `discountPaise` per order line and `shippingDiscountPaise` on Quote/Order; new error `COUPON_INVALID` (422, `error.reason`); `ordersPaused`/`pauseMessage`/`brandName`/`supportEmail`/`supportPhone` on `GET /v1/store-settings` (`checkoutOpen` is false while paused); `GET /v1/app/version-check`; `GET /v1/experience/{channel}` (ETag), `GET /v1/media/{sha}/{file}`, `GET /v1/collections/{slug}[/products]`.
- **Errors:** `MFA_REQUIRED` (403) and `ETAG_MISMATCH` (409).
- **Admin:** team/sessions, products/categories/collections/CSV/media (B8); Experience Studio documents, releases, campaigns, content library, preview (B9); Shipping Center (B10); customers, exports, analytics, store status, app versions, flags, integrations, health (B11); coupons, message templates, email outbox (B12).
- **Typing level:** request bodies are typed where a single zod schema backs them (coupons, flags, app versions, store status, customer notes); other admin request/response bodies are described as `object` — the dashboard prompt package (`docs/dashboard-prompt/03_BACKEND_CONTRACT.md`) holds the field-level descriptions. Tightening these is open work.

## 1.3.0-draft.1 - 2026-10-09
Operator-console safety guards (requested by the dashboard as DASH-BR-011, -014, -016, -021, -024, -025, -026, -029, -044). **Breaking for admin clients:**
- `POST /v1/admin/products/{id}/archive|restore` now require `{ expectedVersion, reason }`; 409 on a stale version or a repeated action; the audit row has before/after.
- `POST /v1/admin/products/{id}/variants` now requires `expectedVersion` and `reason`; honours `Idempotency-Key` (as does `POST /v1/admin/products`).
- `POST /v1/admin/catalog/import?dryRun=false` now requires `previewHash` (from the dry run of the same file) and `reason`; the dry run returns `changes[]` and `previewHash`.
- `PATCH /v1/admin/catalog/variants/{id}` also edits SKU/title/package/HSN/barcode/low-stock threshold/cost (admin); price/MRP/availability changes bump `rules_version`.
- Manual shipment events are forward-only (`ILLEGAL_STATE` otherwise); manual shipments can be cancelled without a provider; `POST /v1/admin/returns/{id}/receive` also needs `inventory:write` + MFA.
- `PUT /v1/admin/shipping/settings` requires `expectedUpdatedAt` + `reason` (GET now returns `updatedAt`); `PUT /v1/admin/shipping/pins` requires `expectedEtag` + `reason` (GET now returns `etag`) - DASH-BR-019.
- CSV import preview skips unchanged rows (a full export also lists archived products) and reports a changed-but-archived product as a row error.

## 1.4.0 - 2026-10-13
Contract hygiene plus the hardening the dashboard asked for (DASH-BR-001..050; the status of every request is in `docs/build/BACKEND_REQUESTS_RESPONSE.md`). 234 operations (was 228); parity enforced by `scripts/contract-check.ts`.

**New operations**
- `POST /v1/admin/experience/{channel}/docs/{kind}/{key}/discard-draft` - `If-Match` + `{ reason }`; returns the draft to the live (published) version as a NEW revision; 409 `ILLEGAL_STATE` if never published. (DASH-BR-047)
- `GET /v1/admin/analytics/gstr1?month=YYYY-MM&format=json|csv&table=b2cs|hsn` - GSTR-1 tables 7 and 12 working paper (not a filing). Schema `Gstr1Report`.
- `POST /v1/admin/orders/{id}/invoice` - issues the GST invoice exactly once (`orders:fulfil` + MFA + `reason`); 201 created / 200 replay.
- `GET /v1/admin/media-files/{sha}/{file}` - authenticated bytes of any library asset (operator previews of unapproved media).
- `GET /v1/admin/outbox/suppressions`, `POST /v1/admin/outbox/suppressions/lift` - email do-not-mail list (hard bounces, complaints).
- `POST /v1/webhooks/email` (provider `email`, only when `EMAIL_WEBHOOK_TOKEN` is set) - bounce/complaint callbacks.

**Breaking for admin clients** (the console must adopt these)
- `GET /v1/admin/orders/{id}/invoice` no longer issues: it returns the issued invoice or 404 `NOT_FOUND`. Issue with `POST` (above). Roles without `orders:fulfil` get `buyer.address` blanked. (DASH-BR-008)
- `POST /v1/admin/media/{id}/archive|restore` require `{ expectedUpdatedAt, reason }`; archive is refused (409, `error.lines`) while ANY durable reference exists (catalogue, library entities, draft Studio documents, live releases, campaigns). (DASH-BR-040)
- `PATCH /v1/admin/categories/{id}` requires `expectedRev`; `PUT /v1/admin/categories/order` requires `expectedRevs`; categories expose `rev`, `updatedAt`, `archivedProductCount`. Delete lists blockers (archived products count). (DASH-BR-022, -032)
- `DELETE /v1/admin/collections/{id}` requires `{ expectedRev, reason }` and is refused while Studio drafts, live releases or campaigns use the collection. (DASH-BR-033)
- `GET /v1/media/{sha}/{file}` (public) serves only approved, ready, non-archived media; everything else is 404. Dev bridge `MEDIA_PUBLIC_ALLOW_UNAPPROVED=true` (refused in production). (DASH-BR-042)
- `PATCH /v1/admin/media/{id}` with `bundledKey` is administrators-only and needs MFA. (DASH-BR-039)

**Fix**
- Cancelling a manual shipment before pickup now returns the order from `shipped` to `processing` (1.3.0 left it stuck). `POST /v1/admin/shipments/{id}/cancel`. (DASH-BR-011)

**Additive**
- Admin order detail: `customerId` (role `customers:read`), `couponCode`, `shippingDiscountPaise`, `allocation`, `statusHistory` (recorded by the database), `shipments`, `returns`, `messages`, per-line `id/productId/variantId/discountPaise/taxablePaise/taxPaise`. (DASH-BR-009)
- `GET /v1/admin/returns` and `/refunds`: keyset paging (`limit` default 100, `cursor`, `status`); returns carry `returnPolicy`, refunds carry `paymentCapability` and per-row `processable`/`blockedReason`. (DASH-BR-013, -015, -017, -018)
- Manual shipment create accepts a `package` snapshot plus mandatory `overrideReason`; shipments return `package`, `packageOverrideReason`. (DASH-BR-012)
- Media: `rightsHolder`, `provenanceNote`, `consentReference`, `bundledKey`, `updatedAt` on every asset; upload metadata may travel in the `X-JW-Upload-Meta` header (base64url JSON); `inUse` list filter; usage lists Studio drafts, live releases and campaigns. (DASH-BR-036..041)
- `GET /v1/admin/catalog/variants`: `productId` filter, keyset paging, `productId`/`hsnCode` per row. (DASH-BR-028)
- Invoices print the variant HSN per line (`lines[].hsn`, `hsnIncluded`). GSTR-1 table 12 already used it.
- Experience bundle: `resolved.outOfStockIds`; sold-out products never lead rule-fed rails; `If-None-Match` accepts weak/list/`*` validators. Block props carry `x-slot` image requirements in `blocks.schema.json`; the publish validator raises `media.slot_too_small` / `media.slot_shape` warnings. Content-library entity JSON Schemas are published as `entity-schemas.json`. (DASH-BR-046 remainder)
- Admin rate limits split: reads 600/min, writes 360/min per operator (`ADMIN_RATE_READ_PER_MIN`, `ADMIN_RATE_WRITE_PER_MIN`). (DASH-BR-049)
- Product, category, collection and variant admin path parameters are slugs (`#/components/parameters/Slug`), not UUIDs. (DASH-BR-027, -030)
- Documented: invite accept (201 `{ email, role }`, no session), MFA recovery codes (8), order CSV export, order list parameters, checkout disable (not MFA-gated), CSV import (`text/csv`, 200/422 `ImportReport`), catalogue export bounds, catalogue cache TTL, admin overview schemas, `GET /v1/app/version-check`.
- Operational: `/metrics` needs `METRICS_TOKEN` (404 in production without it); production configuration fails fast on unsafe values; S3-compatible storage; migration ledger.

## 1.5.0 - 2026-10-13
Online payments (Razorpay, tested against Razorpay's TEST API). 238 operations. **Additive: no existing operation changed**, so clients that only offer Cash on Delivery need no change.

- `GET /v1/store-settings` (and the home bootstrap `store`) now carries `onlinePaymentsEnabled`. Offer "Pay online" only when it is true.
- Website flow (no third-party script on the storefront origin): create the order with a quote made with `paymentMethod: online`, call `POST /v1/orders/{id}/payment-attempts` (now also returns `keyId` when resuming), POST a form to the provider's hosted checkout with `callback_url = <api>/v1/payments/razorpay/return`; the provider posts the browser back there and the API answers `303` to `<website>/orders/{id}?pay=paid|pending|failed` (`&placed=1` when paid).
- `POST /v1/payments/{provider}/return` (browser landing, provider-only) and `GET /v1/payments/{provider}/start` (signed hand-off page for the app).
- `POST /v1/orders/{id}/payment-link` - for the mobile app: returns a 10 minute signed `url` that forwards to the hosted checkout.
- `POST /v1/orders/{id}/payment-attempts/confirm` - for SDK callbacks: `{ providerOrderId, providerPaymentId, signature }`; verified server-side and cross-checked with the provider; returns `{ orderStatus, paymentStatus, attemptStatus }`.
- In every flow the client reads the final state from `GET /v1/orders/{id}/payment`; success is never inferred from a redirect or SDK callback.
- New configuration: `STOREFRONT_ORIGIN` (required with online payments in production, https), `PUBLIC_API_ORIGIN`, `APP_RETURN_URL` (optional deep link), plus the existing `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` / `RAZORPAY_WEBHOOK_SECRET`.
