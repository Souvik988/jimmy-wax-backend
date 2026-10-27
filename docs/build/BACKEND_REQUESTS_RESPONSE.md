# Backend response to the dashboard's requests (contract 1.4.0, 2026-10-10)

Source: `jimmy&wax_dashboard/docs/build/BACKEND_REQUESTS.md` (DASH-BR-001 .. 050). Evidence for each row is a test name in `backend/` or a section of
`contracts/api/openapi.yaml`; the contract-level summary is `contracts/api/CHANGELOG.md` (1.3.0 and 1.4.0).

Status words: **resolved** (implemented and/or documented, tested), **partial** (what is done and what is not is stated), **deferred** (needs the owner, not the backend).

| ID | Status | What changed / where |
|---|---|---|
| 001 invite accept | resolved | OpenAPI `postAuthInviteAccept`: request `{token,password,fullName}`, 201 `{email,role}`, no session. |
| 002 recovery codes | resolved | OpenAPI/api-index: 8 codes, `{ codes: string[] }`. |
| 003 order CSV contract | resolved | `getAdminExportsOrdersCsv`: required `from`/`to`, half-open UTC, <= 400 days, `orders:read` + AAL2, attachment filename. |
| 004 CSV not streamed | partial | Now **bounded**: more than 50,000 orders in the range is 422 (it used to truncate silently); documented as in-memory, not streamed. Streaming/async export is not built. |
| 005 order list params | resolved | `adminListOrders`: `limit`, `cursor`, `status`, `paymentStatus`, `q`; fixed order; `AdminOrderPage` schema. |
| 006 checkout disable marked MFA | resolved | Description rewritten (`settings:write`, reason 3-300, 204, deliberately not MFA-gated); the generated api-index no longer marks it MFA (and recognises "not MFA-gated" wording). |
| 007 overview schemas | partial | Typed: dashboard (`AdminDashboard`), store status, audit (`AuditEntry`). Still `object`: readiness/settings, health, integrations, sales analytics. The dashboard's runtime parsers remain the guard for those. |
| 008 invoice GET issues (critical) | resolved | `GET` is read-only (404 if none; buyer address blanked for roles without `orders:fulfil`). `POST /v1/admin/orders/{id}/invoice` issues once: `orders:fulfil` + MFA + `reason`, audited. Test `invoices: reading is side-effect free...`. **Dashboard must call POST to issue.** |
| 009 order detail | resolved | `customerId` (role `customers:read`), `allocation`, `statusHistory` (DB trigger, backfilled), `shipments`, `returns`, `messages`, per-line ids/discount/tax. Schema `AdminOrderDetail`. Test `order detail carries what the console needs`. |
| 010 shipping/returns/refunds schemas | partial | Typed: returns list, refunds list, receive response, manual shipment create body, shipments list, shipment events rules, shipment cancel. Other B10 provider operations are still loosely typed. |
| 011 manual cancel | resolved (1.3.0, completed in 1.4.0) | 1.3.0 allowed cancelling a manual shipment without a provider but left the order stuck at `shipped` (it could never be shipped again). 1.4.0 returns the order to `processing` in the same transaction when the cancelled shipment was its only live one (new DB transition `shipped -> processing`, used only by cancel), with before/after in the audit row. Test `a manual shipment can be cancelled without a provider...`. |
| 012 manual package override | resolved | Body `package` + mandatory `overrideReason`; stored on the shipment and in the audit row. Test `manual shipment package snapshot`. |
| 013 return window for fulfilment | resolved | `GET /returns` returns `returnPolicy {returnWindowDays, configured}`. |
| 014 manual events forward-only | resolved (1.3.0) | `ILLEGAL_STATE` on non-forward events (a repeat or a hub re-route out_for_delivery -> in_transit is allowed); documented on `adminShipmentEvent`. Test `events only move forward...`. |
| 015 100-row caps | resolved | Returns and refunds are keyset-paged (`limit` default 100, max 200, `cursor`, `status`). Test `return policy ... lists page with a cursor`. |
| 016 receive needs inventory:write + AAL2 | resolved (1.3.0) | Documented on `adminReceiveReturn` with the response schema. |
| 017 refund process contract | resolved | `adminProcessRefund`: preconditions, 422 `UNSUPPORTED_PAYMENT_METHOD`, idempotent retry semantics, response schema. |
| 018 payment capability for finance | resolved | `paymentCapability {configured, provider, mode}` on the refund list plus per-row `processable` / `blockedReason`. |
| 019 shipping settings/PIN guards | resolved (earlier) | `expectedUpdatedAt`/`expectedEtag` + `reason`. |
| 020 catalogue/inventory schemas | partial | Typed now: variants list, categories, media assets, usage, import report. Products, inventory and collections bodies remain loosely typed. |
| 021 low-stock threshold | resolved (1.3.0) | `lowStockThreshold` on the variant PATCH. |
| 022 category count vs delete | resolved | `productCount` (live) + `archivedProductCount`; delete returns `error.lines` listing blockers, archived included. |
| 023 Finance cost price | **deferred** | Owner decision (whether Finance may see cost). Cost price stays Admin-only; no permission was widened. |
| 024 CSV commit guards | resolved (1.3.0) | `previewHash` + `reason`; documented on `postAdminCatalogImport` with `ImportReport` for 200 and 422. |
| 025 price change invalidates quotes | resolved (1.3.0) | `rules_version` bumped on price/MRP/availability changes. |
| 026 archive/restore guards | resolved (1.3.0) | `expectedVersion` + `reason`, before/after audit. |
| 027 product id is a slug | resolved | Product, variant, category and collection `{id}` parameters now reference the `Slug` parameter (12 operations). |
| 030 category/collection id is a slug | resolved | Same change. |
| 028 variants list | resolved | `productId` filter, keyset paging, `productId` and `hsnCode` per row (`updatedAt` was already there). |
| 029 variant metadata edit | resolved (1.3.0) | SKU/title/package/HSN/barcode/threshold/cost via the guarded PATCH. |
| 031 collection resolve | resolved | `resolve=true` documented on `getAdminCollectionsId` (`resolvedProductIds`, active and non-archived only). |
| 032 category versioning | resolved | `rev`/`updatedAt` on categories; PATCH needs `expectedRev`, reorder needs `expectedRevs`; before/after audit. Create stays unique-name based (a duplicate is a 400, a retry cannot create two). |
| 033 collection delete | resolved | `expectedRev` + `reason`; refused with `error.lines` while drafts, live releases or campaigns reference it. Test `collection delete needs revision + reason...`. |
| 034 import contract | resolved | `text/csv` body, `dryRun`, 2 MB / 5,000 rows, 200 and 422 `ImportReport`. |
| 035 catalogue export unbounded | partial | Bounded at 20,000 variant rows (422 beyond); documented as in-memory. No streaming. |
| 036 media upload contract | resolved | `postAdminMedia` documents raw bytes, sniffed type, caps (image 15 MiB, video 100 MiB, font 2 MiB), 201/200 duplicate, metadata via query **or** the `X-JW-Upload-Meta` header (keeps rights details out of URLs). No idempotency key is needed: uploads are content-addressed, so a retry returns the same asset. |
| 037 rights holder / provenance / consent | resolved | Columns `rights_holder`, `provenance_note`, `consent_reference` on media, in upload and PATCH, in the DTO. Public exposure: these fields are admin-only (never in bundles). |
| 038 approve/reject is admin-only | resolved | Docs say `media:write` AND role `admin`; reviewer, time and note are recorded; the rules are listed on `postAdminMediaIdApprove`. |
| 039 bundledKey | resolved | Returned in the DTO; set by administrators only, AAL2 required; audit has before/after. A verifiable manifest of allowed app asset paths is **not** provided (the app owns its bundle). |
| 040 media usage / archive guard | resolved | Usage covers products, categories, library entities, draft Studio documents, live releases, campaigns; archive/restore need `expectedUpdatedAt` + `reason`, are audited, and archive is refused with `error.lines`. |
| 041 `inUse` filter | resolved | `GET /media?inUse=true|false` (same SQL as the archive guard). |
| 042 public media serves pending/rejected | resolved | Approved-only public URL (view `v_public_media`); operators preview via `GET /v1/admin/media-files/{sha}/{file}`. Dev bridge flag for old consoles, refused in production. **The dashboard's `/api/media` route should switch to the authenticated route.** Caveat: copies already cached by a CDN cannot be recalled. |
| 043 BFF buffers uploads | partial | Backend side: Caddy now allows 105 MB only on `POST /v1/admin/media` and 6 MB elsewhere; per-kind caps documented. Streaming through the BFF remains a dashboard task. |
| 044 create product/variant idempotency | resolved (1.3.0) | `Idempotency-Key` on `POST /products` and add-variant; `expectedVersion` + `reason` for add-variant. |
| 045 custom pages in the BFF | resolved (dashboard) | - |
| 046 doc schemas | resolved | `doc-schemas.json` plus **`entity-schemas.json`** (care guides, stories, journal, testimonials, FAQ groups, announcements) generated from the validators. |
| 047 discard draft | resolved | `discard-draft` operation (now in the contract). |
| 048 ETag through the gateway | resolved / explained | commerce-api sends `ETag` on document GET/PUT/discard and on bundle responses; the dev gateway forwards every upstream header unchanged and Caddy passes it through (checked in the live run below). The loss happens in the dashboard BFF header whitelist - add `etag` there. Weak/list `If-None-Match` is now honoured on bundles. |
| 049 admin rate limit | resolved | Reads 600/min, writes 360/min per operator, configurable, 429 + `Retry-After` (was 240/min combined). Test `admin reads and writes have separate, configurable ceilings`. |
| 050 catalogue cache TTL | resolved (documented) | 5 s server cache + `max-age=30, stale-while-revalidate=60`: a hidden product is gone within about 95 s. Written into the OpenAPI description. No per-product purge. |

## What the dashboard has to do (not done by the backend)
1. **Invoices**: call `POST /v1/admin/orders/{id}/invoice` with a reason to issue; `GET` only reads (404 until issued).
2. **Media archive/restore, category edit/order, collection delete**: send the new stamps (`expectedUpdatedAt`, `expectedRev`, `expectedRevs`) and reasons - or keep those controls hidden.
3. **Media previews**: serve library thumbnails through `GET /v1/admin/media-files/{sha}/{file}` (session-authenticated) so unapproved media stays private; until then local development uses `MEDIA_PUBLIC_ALLOW_UNAPPROVED`.
4. **ETag**: forward the `ETag` response header in the BFF.
5. Optionally build screens for refunds capability (`processable`), email suppressions, order history/allocations and the new rights fields.
6. Replace the hand-mirrored library schemas (`src/features/studio/library-schemas.ts`) with `entity-schemas.json`, and use `x-slot` for exact image-size guidance.
