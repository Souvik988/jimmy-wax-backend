# API index (generated from contracts/api/openapi.yaml)

Spec version 1.6.0, 238 operations. Permission/MFA are taken from the operation description. Bodies not typed here are described in 03_BACKEND_CONTRACT.md and blocks.schema.json.


## admin/analytics

| Method | Path | Auth | Permission | operationId | Notes |
|---|---|---|---|---|---|
| GET | `/v1/admin/analytics/sales` | bearer | analytics:read | getAdminAnalyticsSales | Orders in status placed→delivered; see `definitions` in the response. Requires permission `analytics:read`. |
| GET | `/v1/admin/analytics/products` | bearer | analytics:read | getAdminAnalyticsProducts | Requires permission `analytics:read`. |
| GET | `/v1/admin/analytics/customers` | bearer | analytics:read | getAdminAnalyticsCustomers | Requires permission `analytics:read`. |
| GET | `/v1/admin/analytics/shipping` | bearer | analytics:read | getAdminAnalyticsShipping | Requires permission `analytics:read`. |
| GET | `/v1/admin/analytics/returns` | bearer | analytics:read | getAdminAnalyticsReturns | Requires permission `analytics:read`. |
| GET | `/v1/admin/analytics/geo` | bearer | analytics:read | getAdminAnalyticsGeo | Requires permission `analytics:read`. |
| GET | `/v1/admin/analytics/gstr1` | bearer | analytics:read | getAdminAnalyticsGstr1 | Requires permission `analytics:read`. GSTR-1 WORKING PAPER (tables 7 B2CS and 12 HSN summary) for one India Standard Time calendar month, built from the stored order tax breakdowns of orders in placed..delivered. It is a preparation aid for the accountant, not a filing: credit notes, B2B invoices, exports and nil-rated supplies are out of scope (the response `warnings` say so). Place of supply comes from the delivery state; CGST/SGST vs IGST is decided against the state of `store_settings.merchant_gstin` (without a valid GSTIN every sale is shown as IGST and a warning is added). HSN rows use the variant `hsnCode`; lines without one appear as `NOT SET`. Amounts are integer paise in JSON. `format=csv` returns ONE table (`table=b2cs\|hsn`) in the offline-tool column layout as `text/csv; charset=utf-8` with `Content-Disposition: attachment; filename="jimmywax-gstr1-<table>-<month>.csv"`; amounts are rupees there. |
| GET | `/v1/admin/analytics/gst` | bearer | analytics:read | getAdminAnalyticsGst | Requires permission `analytics:read`. |

## admin/app-versions

| Method | Path | Auth | Permission | operationId | Notes |
|---|---|---|---|---|---|
| GET | `/v1/admin/app-versions` | bearer | settings:read | getAdminAppVersions | Requires permission `settings:read`. |
| PUT | `/v1/admin/app-versions/{platform}` | bearer | settings:write · MFA | putAdminAppVersionsPlatform | Requires permission `settings:write` and an MFA (aal2) session. |

## admin/audit

| Method | Path | Auth | Permission | operationId | Notes |
|---|---|---|---|---|---|
| GET | `/v1/admin/audit` | bearer | audit:read | adminAudit | Requires permission `audit:read`. Newest first, last 100 entries, optional `resourceType` filter. `before`/`after` are JSON images whose shape depends on the action. |

## admin/catalog

| Method | Path | Auth | Permission | operationId | Notes |
|---|---|---|---|---|---|
| GET | `/v1/admin/catalog/variants` | bearer | catalog:read | adminVariants | Requires permission `catalog:read`. Variants with the `updatedAt` stamp that price/metadata edits need (`expectedUpdatedAt`). Filter with `productId`; keyset-paged (`limit` default 500, max 1000, `nextCursor`). |
| PATCH | `/v1/admin/catalog/variants/{id}` | bearer |  | adminUpdateVariant | Guarded, audited variant edit. `expectedUpdatedAt` (the variant's updatedAt you loaded) and `reason` are required; a stale timestamp is 409. Besides price/MRP/active it edits SKU, title, package weight/dimensions, HSN, barcode, low-stock threshold and (admin only) cost. A change to selling price, MRP or availability bumps `rules_version`, so open checkout quotes become stale. |
| GET | `/v1/admin/catalog/export` | bearer | catalog:read | getAdminCatalogExport | Requires permission `catalog:read`. The complete catalogue as CSV (`text/csv; charset=utf-8`, attachment `jimmywax-catalogue.csv`), formula-injection protected. Bounded: at most 20,000 variant rows, otherwise 422 `VALIDATION_FAILED`. Built in memory (not streamed): label the download as complete/unpaged. |
| POST | `/v1/admin/catalog/import` | bearer | catalog:write | postAdminCatalogImport | Requires permission `catalog:write`. Body is raw UTF-8 CSV (`text/csv`, max 2 MB / 5,000 rows). `dryRun` (query, default true) returns the report only; HTTP 422 with the same report shape when any row has errors. Applying (`dryRun=false`) additionally requires `previewHash` (echo of the dry run for this exact file against current data; otherwise 409 `CART_VERSION_CONFLICT`) and `reason` (3-300 chars); it is all-or-nothing and a replay fails because the data moved on. |

## admin/categories

| Method | Path | Auth | Permission | operationId | Notes |
|---|---|---|---|---|---|
| GET | `/v1/admin/categories` | bearer | catalog:read | getAdminCategories | Requires permission `catalog:read`. `productCount` counts live products, `archivedProductCount` archived ones; a category can be deleted only when both are 0. `rev` is the revision for guarded writes. |
| POST | `/v1/admin/categories` | bearer | catalog:write | postAdminCategories | Requires permission `catalog:write`. |
| PUT | `/v1/admin/categories/order` | bearer | catalog:write | putAdminCategoriesOrder | Requires permission `catalog:write`. Body `{ ids: string[] (every category exactly once), expectedRevs: { [id]: rev } }`. 409 `CART_VERSION_CONFLICT` naming the stale ids; bumps every `rev`; audited with before/after order. |
| PATCH | `/v1/admin/categories/{id}` | bearer | catalog:write | patchAdminCategoriesId | Requires permission `catalog:write`. Body is any subset of the category fields plus `expectedRev` (required). 409 `CART_VERSION_CONFLICT` (current copy in `error.lines[0]`) when stale. Bumps `rev`; audited with before/after values. |
| DELETE | `/v1/admin/categories/{id}` | bearer | catalog:write | deleteAdminCategoriesId | Requires permission `catalog:write`. 409 `ILLEGAL_STATE` while ANY product (archived ones too) still uses the category; `error.lines` lists up to 50 blockers `{ type: "product", id, label, archived }` so they can be moved. |

## admin/checkout

| Method | Path | Auth | Permission | operationId | Notes |
|---|---|---|---|---|---|
| POST | `/v1/admin/checkout/activate` | bearer | settings:write · MFA | adminActivateCheckout | Requires permission `settings:write` and an MFA (aal2) session. Refused until every readiness check passes. Body `{ confirm: true, reason, expectedVersion }`; 204. |
| POST | `/v1/admin/checkout/disable` | bearer | settings:write | adminDisableCheckout | Requires permission `settings:write`. Emergency kill switch: deliberately NOT MFA-gated. Body `{ reason: string(3-300) }`; 204. |

## admin/collections

| Method | Path | Auth | Permission | operationId | Notes |
|---|---|---|---|---|---|
| GET | `/v1/admin/collections` | bearer | catalog:read | getAdminCollections | Requires permission `catalog:read`. |
| POST | `/v1/admin/collections` | bearer | catalog:write | postAdminCollections | Requires permission `catalog:write`. |
| GET | `/v1/admin/collections/{id}` | bearer | catalog:read | getAdminCollectionsId | Requires permission `catalog:read`. With `resolve=true` the response adds `resolvedProductIds`: the ordered ids the collection currently resolves to (active, non-archived products only; capped by the rule limit for smart collections). |
| PUT | `/v1/admin/collections/{id}` | bearer | catalog:write | putAdminCollectionsId | Requires permission `catalog:write`. |
| DELETE | `/v1/admin/collections/{id}` | bearer | catalog:write | deleteAdminCollectionsId | Requires permission `catalog:write`. Body `{ expectedRev, reason }` (both required). 409 `CART_VERSION_CONFLICT` when stale. 409 `ILLEGAL_STATE` with `error.lines` while a draft Studio document, a live release or a campaign still points at the collection by slug. Audited with the reason. |

## admin/content

| Method | Path | Auth | Permission | operationId | Notes |
|---|---|---|---|---|---|
| GET | `/v1/admin/content` | bearer |  | adminContentList |  |
| GET | `/v1/admin/content/{slug}` | bearer |  | adminContentGet |  |
| PUT | `/v1/admin/content/{slug}` | bearer |  | adminContentSave |  |
| POST | `/v1/admin/content/{slug}/publish` | bearer |  | adminContentPublish |  |

## admin/content-library

| Method | Path | Auth | Permission | operationId | Notes |
|---|---|---|---|---|---|
| GET | `/v1/admin/content-library/{entity}` | bearer | experience:read | getAdminContentLibraryEntity | Requires permission `experience:read`. |
| POST | `/v1/admin/content-library/{entity}` | bearer | experience:write | postAdminContentLibraryEntity | Requires permission `experience:write`. |
| GET | `/v1/admin/content-library/{entity}/{id}` | bearer | experience:read | getAdminContentLibraryEntityId | Requires permission `experience:read`. |
| PATCH | `/v1/admin/content-library/{entity}/{id}` | bearer | experience:write | patchAdminContentLibraryEntityId | Requires permission `experience:write`. |
| DELETE | `/v1/admin/content-library/{entity}/{id}` | bearer | experience:write | deleteAdminContentLibraryEntityId | Requires permission `experience:write`. |

## admin/coupons

| Method | Path | Auth | Permission | operationId | Notes |
|---|---|---|---|---|---|
| GET | `/v1/admin/coupons` | bearer | coupons:read | getAdminCoupons | Requires permission `coupons:read`. |
| POST | `/v1/admin/coupons` | bearer | coupons:write | postAdminCoupons | Requires permission `coupons:write`. |
| GET | `/v1/admin/coupons/analytics` | bearer | coupons:read | getAdminCouponsAnalytics | Requires permission `coupons:read`. |
| GET | `/v1/admin/coupons/{id}` | bearer | coupons:read | getAdminCouponsId | Requires permission `coupons:read`. |
| PATCH | `/v1/admin/coupons/{id}` | bearer | coupons:write | patchAdminCouponsId | Requires permission `coupons:write`. |
| POST | `/v1/admin/coupons/{id}/deactivate` | bearer | coupons:write | postAdminCouponsIdDeactivate | Requires permission `coupons:write`. |

## admin/customers

| Method | Path | Auth | Permission | operationId | Notes |
|---|---|---|---|---|---|
| GET | `/v1/admin/customers` | bearer | customers:read | getAdminCustomers | Requires permission `customers:read`. |
| GET | `/v1/admin/customers/{id}` | bearer | customers:read | getAdminCustomersId | Requires permission `customers:read`. |
| PATCH | `/v1/admin/customers/{id}` | bearer | customers:write | patchAdminCustomersId | Requires permission `customers:write`. |
| POST | `/v1/admin/customers/{id}/reveal` | bearer | customers:read | postAdminCustomersIdReveal | Requires permission `customers:read`. |
| POST | `/v1/admin/customers/{id}/block` | bearer | customers:write | postAdminCustomersIdBlock | Requires permission `customers:write`. |

## admin/dashboard

| Method | Path | Auth | Permission | operationId | Notes |
|---|---|---|---|---|---|
| GET | `/v1/admin/dashboard` | bearer | orders:read | adminDashboard | Requires permission `orders:read`. Figures cover the last 30 calendar days in Asia/Kolkata; `definitions` states exactly what each figure means. |

## admin/experience

| Method | Path | Auth | Permission | operationId | Notes |
|---|---|---|---|---|---|
| GET | `/v1/admin/experience/state` | bearer | experience:read | getAdminExperienceState | Requires permission `experience:read`. |
| GET | `/v1/admin/experience/variables` | bearer | experience:read | getAdminExperienceVariables | Requires permission `experience:read`. |
| POST | `/v1/admin/experience/releases` | bearer | experience:publish · MFA | postAdminExperienceReleases | Requires permission `experience:publish` and an MFA (aal2) session. |
| GET | `/v1/admin/experience/releases` | bearer | experience:read | getAdminExperienceReleases | Requires permission `experience:read`. |
| GET | `/v1/admin/experience/releases/{id}` | bearer | experience:read | getAdminExperienceReleasesId | Requires permission `experience:read`. |
| POST | `/v1/admin/experience/releases/{id}/rollback` | bearer | experience:publish · MFA | postAdminExperienceReleasesIdRollback | Requires permission `experience:publish` and an MFA (aal2) session. |
| POST | `/v1/admin/experience/releases/{id}/cancel` | bearer | experience:publish · MFA | postAdminExperienceReleasesIdCancel | Requires permission `experience:publish` and an MFA (aal2) session. |
| DELETE | `/v1/admin/experience/preview-tokens/{id}` | bearer | experience:write | deleteAdminExperiencePreviewTokensId | Requires permission `experience:write`. |
| GET | `/v1/admin/experience/campaigns` | bearer | experience:read | getAdminExperienceCampaigns | Requires permission `experience:read`. |
| POST | `/v1/admin/experience/campaigns` | bearer | experience:write | postAdminExperienceCampaigns | Requires permission `experience:write`. |
| PUT | `/v1/admin/experience/campaigns/{id}` | bearer | experience:write | putAdminExperienceCampaignsId | Requires permission `experience:write`. |
| GET | `/v1/admin/experience/{channel}/docs` | bearer | experience:read | getAdminExperienceChannelDocs | Requires permission `experience:read`. |
| GET | `/v1/admin/experience/{channel}/docs/{kind}/{key}` | bearer | experience:read | getAdminExperienceChannelDocsKindKey | Requires permission `experience:read`. |
| PUT | `/v1/admin/experience/{channel}/docs/{kind}/{key}` | bearer | experience:write | putAdminExperienceChannelDocsKindKey | Requires permission `experience:write`. |
| DELETE | `/v1/admin/experience/{channel}/docs/{kind}/{key}` | bearer | experience:write | deleteAdminExperienceChannelDocsKindKey | Requires permission `experience:write`. |
| POST | `/v1/admin/experience/{channel}/docs/{kind}/{key}/discard-draft` | bearer | experience:write | postAdminExperienceChannelDocsKindKeyDiscardDraft | Requires permission `experience:write`. Returns the draft to the version that is currently live (the last published snapshot) as a NEW revision, so the discarded edits stay in the revision history. Send the draft's current revision in `If-Match`; a stale one is 409 `ETAG_MISMATCH` with the current document in `error.lines[0]`. `ILLEGAL_STATE` (409) when the document was never published (nothing to return to) or for the shared design system (`channel=shared` has no published copy). When the draft already equals the live version the current row is returned unchanged and no revision is written. Audited as `experience.draft.discard` with the reason. |
| GET | `/v1/admin/experience/{channel}/docs/{kind}/{key}/revisions` | bearer | experience:read | getAdminExperienceChannelDocsKindKeyRevisions | Requires permission `experience:read`. |
| POST | `/v1/admin/experience/{channel}/validate` | bearer | experience:read | postAdminExperienceChannelValidate | Requires permission `experience:read`. |
| GET | `/v1/admin/experience/{channel}/diff` | bearer | experience:read | getAdminExperienceChannelDiff | Requires permission `experience:read`. |
| POST | `/v1/admin/experience/{channel}/preview-tokens` | bearer | experience:write | postAdminExperienceChannelPreviewTokens | Requires permission `experience:write`. |
| POST | `/v1/admin/experience/{channel}/kill` | bearer | experience:publish · MFA | postAdminExperienceChannelKill | Requires permission `experience:publish` and an MFA (aal2) session. |
| PUT | `/v1/admin/experience/{channel}/presence` | bearer | experience:write | putAdminExperienceChannelPresence | Requires permission `experience:write`. |
| GET | `/v1/admin/experience/{channel}/presence` | bearer | experience:read | getAdminExperienceChannelPresence | Requires permission `experience:read`. |

## admin/exports

| Method | Path | Auth | Permission | operationId | Notes |
|---|---|---|---|---|---|
| GET | `/v1/admin/exports/customers.csv` | bearer | customers:export · MFA | getAdminExportsCustomersCsv | Requires permission `customers:export` and an MFA (aal2) session. |
| GET | `/v1/admin/exports/orders.csv` | bearer | orders:read · MFA | getAdminExportsOrdersCsv | Requires permission `orders:read` and an MFA (aal2) session. Query `from` and `to` are required `YYYY-MM-DD` dates (UTC, half-open: `from` inclusive, `to` exclusive); `to` must be after `from` and the range at most 400 days. Responds `text/csv; charset=utf-8` with `Content-Disposition: attachment; filename="jimmywax-orders-<from>-<to>.csv"` and `Cache-Control: no-store`. Bounded: more than 50,000 orders in the range is 422 `VALIDATION_FAILED` (it is never silently truncated). Built in memory, not streamed. |

## admin/flags

| Method | Path | Auth | Permission | operationId | Notes |
|---|---|---|---|---|---|
| GET | `/v1/admin/flags` | bearer | settings:read | getAdminFlags | Requires permission `settings:read`. |
| PUT | `/v1/admin/flags/{key}` | bearer | flags:manage · MFA | putAdminFlagsKey | Requires permission `flags:manage` and an MFA (aal2) session. |
| DELETE | `/v1/admin/flags/{key}` | bearer | flags:manage · MFA | deleteAdminFlagsKey | Requires permission `flags:manage` and an MFA (aal2) session. |

## admin/health

| Method | Path | Auth | Permission | operationId | Notes |
|---|---|---|---|---|---|
| GET | `/v1/admin/health` | bearer | ops:read | getAdminHealth | Requires permission `ops:read`. |

## admin/integrations

| Method | Path | Auth | Permission | operationId | Notes |
|---|---|---|---|---|---|
| GET | `/v1/admin/integrations` | bearer | integrations:read | getAdminIntegrations | Requires permission `integrations:read`. |
| POST | `/v1/admin/integrations/{name}/test` | bearer | integrations:manage · MFA | postAdminIntegrationsNameTest | Requires permission `integrations:manage` and an MFA (aal2) session. |

## admin/inventory

| Method | Path | Auth | Permission | operationId | Notes |
|---|---|---|---|---|---|
| GET | `/v1/admin/inventory` | bearer |  | adminInventory |  |
| GET | `/v1/admin/inventory/{variantId}/movements` | bearer |  | adminInventoryMovements |  |
| POST | `/v1/admin/inventory/{variantId}/adjust` | bearer | MFA | adminAdjustStock | Requires MFA; reason + expectedVersion mandatory. |

## admin/me

| Method | Path | Auth | Permission | operationId | Notes |
|---|---|---|---|---|---|
| GET | `/v1/admin/me` | bearer |  | adminMe |  |

## admin/media

| Method | Path | Auth | Permission | operationId | Notes |
|---|---|---|---|---|---|
| POST | `/v1/admin/media` | bearer | media:write | postAdminMedia | Requires permission `media:write`. Upload raw bytes as the request body (`application/octet-stream`; the type is sniffed from the bytes, the declared Content-Type is never trusted). Images (PNG/JPEG/WebP/GIF) are re-encoded to sanitised WebP derivatives; videos are MP4/WebM; fonts WOF2/OTF/TTF. Size caps: image 15 MiB, video 100 MiB, font 2 MiB (413/400 otherwise). Metadata travels in the query string (`filename` required; `alt`, `provenance`, `folder`, `license`, `rightsHolder`, `provenanceNote`, `consentReference`) OR, preferably, in the `X-JW-Upload-Meta` header as base64url-encoded JSON with the same keys (keeps rights details out of URLs and access logs; header values win). Content-addressed: identical bytes return the existing asset with 200 and `duplicate: true`; a new asset is 201. New assets are `draft` and NOT public until an administrator approves them. 30 uploads per minute per operator. |
| GET | `/v1/admin/media` | bearer | media:read | getAdminMedia | Requires permission `media:read`. Keyset-paged, newest first. `inUse=true\|false` filters by COMPLETE usage (catalogue, library entities, draft Studio documents, live releases, campaigns), so "unused" is reliable. |
| GET | `/v1/admin/media/{id}` | bearer | media:read | getAdminMediaId | Requires permission `media:read`. |
| PATCH | `/v1/admin/media/{id}` | bearer | media:write · MFA | patchAdminMediaId | Requires permission `media:write`. Edits metadata (alt, decorative, focal point, tags, folder, role, provenance, license, rightsHolder, provenanceNote, consentReference, posterMediaId). Changing provenance or role of an approved asset resets it to `draft` for re-review. `bundledKey` (maps the picture to a file shipped inside the app) is administrators-only AND needs an MFA (aal2) session; it is audited with before/after values. |
| POST | `/v1/admin/media/{id}/approve` | bearer | media:write | postAdminMediaIdApprove | Requires permission `media:write` AND role `admin` (403 for other roles). Body `{ note?, packagingAttested? }`. Rules: file ready and not archived; images need alt text or `decorative`; generated images need `packagingAttested`; product pack-shots must be original/edited photography; videos need a poster; fonts need a licence. The reviewer (`approval_by`), time and note are recorded and audited. |
| POST | `/v1/admin/media/{id}/reject` | bearer | media:write | postAdminMediaIdReject | Requires permission `media:write` AND role `admin`. Body `{ note: string(3-300) }`. A rejected asset is never served publicly. |
| POST | `/v1/admin/media/{id}/archive` | bearer | media:write | postAdminMediaIdArchive | Requires permission `media:write`. Body `{ expectedUpdatedAt, reason }` (the asset `updatedAt` you loaded; reason 3-300 chars). 409 `CART_VERSION_CONFLICT` when stale; 409 `ILLEGAL_STATE` with `error.lines` (MediaUsageRow[]) while ANY durable reference exists (catalogue, library entities, draft Studio documents, live releases, campaigns), or when already archived. Archived media is no longer served publicly. Audited with reason and before/after. |
| POST | `/v1/admin/media/{id}/restore` | bearer | media:write | postAdminMediaIdRestore | Requires permission `media:write`. Same body and rules as archive; 409 `ILLEGAL_STATE` when the asset is not archived. |
| GET | `/v1/admin/media/{id}/usage` | bearer | media:read | getAdminMediaIdUsage | Requires permission `media:read`. Every durable reference to the asset: products, categories, poster links, draft Studio documents (`studio_draft`, id `channel/kind:key`), the live release of a channel (`studio_live`), campaigns, care guides, stories, journal notes and testimonials. |

## admin/media-files

| Method | Path | Auth | Permission | operationId | Notes |
|---|---|---|---|---|---|
| GET | `/v1/admin/media-files/{sha}/{file}` | bearer | media:read | getAdminMediaFilesShaFile | Requires permission `media:read`. Authenticated bytes of ANY library asset, approved or not, for operator previews (the public URL serves approved media only). `Cache-Control: private, no-store`. 404 for an unknown sha or file. |

## admin/message-templates

| Method | Path | Auth | Permission | operationId | Notes |
|---|---|---|---|---|---|
| GET | `/v1/admin/message-templates` | bearer | settings:read | getAdminMessageTemplates | Requires permission `settings:read`. |
| PUT | `/v1/admin/message-templates/{key}` | bearer | settings:write · MFA | putAdminMessageTemplatesKey | Requires permission `settings:write` and an MFA (aal2) session. |
| DELETE | `/v1/admin/message-templates/{key}` | bearer | settings:write · MFA | deleteAdminMessageTemplatesKey | Requires permission `settings:write` and an MFA (aal2) session. |
| POST | `/v1/admin/message-templates/{key}/test` | bearer | settings:write · MFA | postAdminMessageTemplatesKeyTest | Requires permission `settings:write` and an MFA (aal2) session. |

## admin/ops

| Method | Path | Auth | Permission | operationId | Notes |
|---|---|---|---|---|---|
| GET | `/v1/admin/ops/outbox` | bearer |  | adminOutbox |  |
| POST | `/v1/admin/ops/outbox/{id}/replay` | bearer |  | adminReplayOutbox |  |

## admin/orders

| Method | Path | Auth | Permission | operationId | Notes |
|---|---|---|---|---|---|
| GET | `/v1/admin/orders` | bearer | orders:read | adminListOrders | Requires permission `orders:read`. Keyset-paged, newest first. The order is fixed (`created_at DESC, id DESC`); no sort parameter exists. `q` matches the order number prefix (max 40 chars). |
| GET | `/v1/admin/orders/{id}` | bearer | orders:read | adminGetOrder | Requires permission `orders:read`. `customerId` is returned only to roles with `customers:read`. Roles without `orders:fulfil` get a redacted address. Includes the immutable tax/shipping allocation, status history (recorded by the database), shipments, returns and email delivery state. |
| POST | `/v1/admin/orders/{id}/status` | bearer |  | adminOrderStatus |  |
| POST | `/v1/admin/orders/{id}/cancel` | bearer | MFA | adminCancelOrder | Requires MFA (aal2). |
| POST | `/v1/admin/orders/{id}/cod-collected` | bearer |  | adminCodCollected |  |
| GET | `/v1/admin/orders/{id}/shipments` | bearer | orders:read | adminOrderShipments | Requires permission `orders:read`. Shipments of an order with their events and, for manual shipments, the package snapshot. |
| POST | `/v1/admin/orders/{id}/shipments` | bearer | orders:fulfil | adminCreateShipment | Requires permission `orders:fulfil`. MANUAL shipment (courier and tracking typed in). The order must be `processing`; it becomes `shipped`. Optional `package` records the real parcel when it differs from the catalogue and then `overrideReason` (3-200 chars) is mandatory; both are stored on the shipment and in the audit row. |
| GET | `/v1/admin/orders/{id}/invoice` | bearer | orders:read | adminInvoice | Requires permission `orders:read`. READ ONLY: returns the already-issued invoice or 404 `NOT_FOUND` when none has been issued (it never issues one). Roles without `orders:fulfil` get `buyer.address` blanked. Issue with `POST` on the same path. |
| POST | `/v1/admin/orders/{id}/invoice` | bearer | orders:fulfil · MFA | adminIssueInvoice | Requires permission `orders:fulfil` and an MFA (aal2) session. Issues the GST invoice for a confirmed-or-later order exactly once: numbers are consecutive per financial year and immutable. Needs a `reason` (3-300 chars), audited as `invoice.issue`. 201 when created, 200 with the original when already issued (replay-safe). 503 `POLICY_NOT_CONFIGURED` until the seller GST profile (GSTIN, legal name, state, address) is set in Settings; 409 `ILLEGAL_STATE` before the order is confirmed. |
| POST | `/v1/admin/orders/{id}/shipments/plan` | bearer | shipping:write | postAdminOrdersIdShipmentsPlan | Requires permission `shipping:write`. |
| POST | `/v1/admin/orders/{id}/ship` | bearer | shipping:write | postAdminOrdersIdShip | Requires permission `shipping:write`. |
| GET | `/v1/admin/orders/{id}/notes` | bearer | orders:read | getAdminOrdersIdNotes | Requires permission `orders:read`. |
| POST | `/v1/admin/orders/{id}/notes` | bearer | orders:read | postAdminOrdersIdNotes | Requires permission `orders:read`. |
| GET | `/v1/admin/orders/{id}/packing-slip` | bearer | orders:fulfil | getAdminOrdersIdPackingSlip | Requires permission `orders:fulfil`. |
| POST | `/v1/admin/orders/{id}/resend-confirmation` | bearer | orders:fulfil | postAdminOrdersIdResendConfirmation | Requires permission `orders:fulfil`. |

## admin/outbox

| Method | Path | Auth | Permission | operationId | Notes |
|---|---|---|---|---|---|
| GET | `/v1/admin/outbox/emails` | bearer | ops:read | getAdminOutboxEmails | Requires permission `ops:read`. |
| GET | `/v1/admin/outbox/suppressions` | bearer | ops:read | getAdminOutboxSuppressions | Requires permission `ops:read`. Addresses that hard-bounced (permanent SMTP failure or provider bounce) or complained: they are never mailed again until lifted. Newest first, last 200. |
| POST | `/v1/admin/outbox/suppressions/lift` | bearer | settings:write · MFA | postAdminOutboxSuppressionsLift | Requires permission `settings:write` and an MFA (aal2) session. Removes an address from the do-not-mail list (for example after the customer fixed a full mailbox). Body `{ email, reason }` (reason 3-300 chars, audited as `email.suppression.lift`). 204; 404 when the address is not suppressed. |

## admin/products

| Method | Path | Auth | Permission | operationId | Notes |
|---|---|---|---|---|---|
| GET | `/v1/admin/products` | bearer | catalog:read | getAdminProducts | Requires permission `catalog:read`. |
| POST | `/v1/admin/products` | bearer | catalog:write | postAdminProducts | Requires permission `catalog:write`. Send `Idempotency-Key` (8-128 chars) to make retries safe: the same key and body replays the stored 201 (`Idempotent-Replay: true`); the same key with a different body is 422 `DUPLICATE_REQUEST_MISMATCH`. |
| GET | `/v1/admin/products/{id}` | bearer | catalog:read | getAdminProductsId | Requires permission `catalog:read`. |
| PATCH | `/v1/admin/products/{id}` | bearer | catalog:write | patchAdminProductsId | Requires permission `catalog:write`. |
| PUT | `/v1/admin/products/{id}/media` | bearer | catalog:write | putAdminProductsIdMedia | Requires permission `catalog:write`. |
| POST | `/v1/admin/products/{id}/variants` | bearer | catalog:write | postAdminProductsIdVariants | Requires permission `catalog:write`. The body is the variant plus `expectedVersion` (the product version you loaded; 409 if stale) and `reason`. Send `Idempotency-Key` (8-128 chars) to make retries safe: the same key and body replays the stored 201 (`Idempotent-Replay: true`), the same key with a different body is 422 `DUPLICATE_REQUEST_MISMATCH`. |
| POST | `/v1/admin/products/{id}/archive` | bearer | catalog:write | postAdminProductsIdArchive | Requires permission `catalog:write`. Guarded and audited: `expectedVersion` (409 `CART_VERSION_CONFLICT` if the product changed) and `reason` are required; archiveing a product that is already in that state is 409 `ILLEGAL_STATE`. Returns the product with its new `version`; the audit row carries before/after. |
| POST | `/v1/admin/products/{id}/restore` | bearer | catalog:write | postAdminProductsIdRestore | Requires permission `catalog:write`. Guarded and audited: `expectedVersion` (409 `CART_VERSION_CONFLICT` if the product changed) and `reason` are required; restoreing a product that is already in that state is 409 `ILLEGAL_STATE`. Returns the product with its new `version`; the audit row carries before/after. |
| POST | `/v1/admin/products/{id}/duplicate` | bearer | catalog:write | postAdminProductsIdDuplicate | Requires permission `catalog:write`. Creates an INACTIVE copy of the product. Without `newId` the copy takes the first free `<id>-copy`, `<id>-copy-2`, `<id>-copy-3`, ... (up to 50; then 422 asking for an explicit id) and its variants get SKUs that cannot collide with an earlier copy, so duplicating the same product repeatedly always succeeds. With `newId` (slug) that id is used; an id that already exists is 422 `VALIDATION_FAILED`. Responds 201 with the new Product. |

## admin/refunds

| Method | Path | Auth | Permission | operationId | Notes |
|---|---|---|---|---|---|
| GET | `/v1/admin/refunds` | bearer | payments:read | adminRefunds | Requires permission `payments:read`. Newest first, keyset-paged (default 100, max 200), optional `status` filter. `paymentCapability` says whether processing can work without exposing any key. |
| POST | `/v1/admin/refunds/{id}/process` | bearer | refunds:write · MFA | adminProcessRefund | Requires permission `refunds:write` and an MFA (aal2) session. Preconditions: a payment gateway is configured (else 422 `UNSUPPORTED_PAYMENT_METHOD`; check `paymentCapability` on the list first) and the order has a captured online payment (else 409 `ILLEGAL_STATE`; COD refunds are manual). Safe to retry: the gateway call uses the refund idempotency key, an already-processed refund returns `{ id, status: "processed" }`, and a gateway failure leaves the refund `failed` so it can be retried. |

## admin/returns

| Method | Path | Auth | Permission | operationId | Notes |
|---|---|---|---|---|---|
| GET | `/v1/admin/returns` | bearer | orders:read | adminReturns | Requires permission `orders:read`. Newest first, keyset-paged (default 100, max 200). `status` filters. The response also carries the store return-window policy so roles without `settings:read` can see it (DASH-BR-013). |
| POST | `/v1/admin/returns/{id}/decide` | bearer | orders:fulfil | adminDecideReturn | Requires permission `orders:fulfil`. Body `{ approve: boolean, note: string(3-300) }`; 204. Only a `requested` return can be decided (409 `ILLEGAL_STATE` otherwise). |
| POST | `/v1/admin/returns/{id}/receive` | bearer | orders:fulfil · MFA | adminReceiveReturn | Requires permission `orders:fulfil` AND `inventory:write`, and an MFA (aal2) session (it restocks inventory). Once-only: a repeat is 409 `ILLEGAL_STATE`. For online-paid orders it queues a refund (`refundQueued`); for COD `manualRefundRequired` is true. |

## admin/review-media

| Method | Path | Auth | Permission | operationId | Notes |
|---|---|---|---|---|---|
| POST | `/v1/admin/review-media/{id}/moderate` | bearer |  | adminModerateMedia |  |
| GET | `/v1/admin/review-media/{id}/image` | bearer |  | adminReviewMediaImage |  |

## admin/reviews

| Method | Path | Auth | Permission | operationId | Notes |
|---|---|---|---|---|---|
| GET | `/v1/admin/reviews` | bearer |  | adminReviews |  |
| POST | `/v1/admin/reviews/{id}/moderate` | bearer |  | adminModerateReview |  |

## admin/sessions

| Method | Path | Auth | Permission | operationId | Notes |
|---|---|---|---|---|---|
| GET | `/v1/admin/sessions` | bearer |  | getAdminSessions |  |
| DELETE | `/v1/admin/sessions/{id}` | bearer |  | deleteAdminSessionsId |  |

## admin/settings

| Method | Path | Auth | Permission | operationId | Notes |
|---|---|---|---|---|---|
| GET | `/v1/admin/settings` | bearer |  | adminSettings |  |
| PATCH | `/v1/admin/settings` | bearer |  | adminUpdateSettings |  |

## admin/shipments

| Method | Path | Auth | Permission | operationId | Notes |
|---|---|---|---|---|---|
| POST | `/v1/admin/shipments/{id}/events` | bearer | orders:fulfil | adminShipmentEvent | Requires permission `orders:fulfil`. Manual tracking events are FORWARD ONLY (label_created -> in_transit -> out_for_delivery -> delivered, or failed / returned_to_origin); a non-forward or post-terminal event is 409 `ILLEGAL_STATE`. The server decides; the console should offer only legal next states. |
| POST | `/v1/admin/shipments/bulk` | bearer | shipping:write | postAdminShipmentsBulk | Requires permission `shipping:write`. |
| GET | `/v1/admin/shipments/bulk/{jobId}` | bearer | shipping:read | getAdminShipmentsBulkJobId | Requires permission `shipping:read`. |
| GET | `/v1/admin/shipments/overview` | bearer | shipping:read | getAdminShipmentsOverview | Requires permission `shipping:read`. |
| POST | `/v1/admin/shipments/manifest` | bearer | shipping:write | postAdminShipmentsManifest | Requires permission `shipping:write`. |
| GET | `/v1/admin/shipments` | bearer | shipping:read | getAdminShipments | Requires permission `shipping:read`. |
| GET | `/v1/admin/shipments/{id}` | bearer | shipping:read | getAdminShipmentsId | Requires permission `shipping:read`. |
| POST | `/v1/admin/shipments/{id}/cancel` | bearer | shipping:write · MFA | postAdminShipmentsIdCancel | Requires permission `shipping:write` and an MFA (aal2) session. Body `{ reason }`. Works for provider shipments (calls the provider) and for manual shipments (no provider needed): the shipment is cancelled, the order returns to `processing`, audited with the reason. |
| GET | `/v1/admin/shipments/{id}/label` | bearer | shipping:read | getAdminShipmentsIdLabel | Requires permission `shipping:read`. |

## admin/shipping

| Method | Path | Auth | Permission | operationId | Notes |
|---|---|---|---|---|---|
| GET | `/v1/admin/shipping/pins` | bearer |  | adminPins | Returns { items: [{prefix, note}], etag } — the etag is a fingerprint of the list that a write must echo back. |
| PUT | `/v1/admin/shipping/pins` | bearer | MFA | adminSetPins | Requires MFA. Guarded and audited: `expectedEtag` (from GET; 409 `CART_VERSION_CONFLICT` if the list changed) and `reason` are required. Bumps `rules_version` so open checkout quotes are re-validated. |
| GET | `/v1/admin/shipping/provider` | bearer | shipping:read | getAdminShippingProvider | Requires permission `shipping:read`. |
| GET | `/v1/admin/shipping/settings` | bearer | shipping:read | getAdminShippingSettings | Requires permission `shipping:read`. |
| PUT | `/v1/admin/shipping/settings` | bearer | shipping:write | putAdminShippingSettings | Requires permission `shipping:write`. Guarded and audited: the body must include `expectedUpdatedAt` (the `updatedAt` returned by GET; 409 `CART_VERSION_CONFLICT` if stale) and `reason` (3-300 chars) next to the fields being changed. |
| GET | `/v1/admin/shipping/pickup-locations` | bearer | shipping:read | getAdminShippingPickupLocations | Requires permission `shipping:read`. |
| POST | `/v1/admin/shipping/serviceability/check` | bearer | shipping:read | postAdminShippingServiceabilityCheck | Requires permission `shipping:read`. |
| GET | `/v1/admin/shipping/ready` | bearer | shipping:read | getAdminShippingReady | Requires permission `shipping:read`. |

## admin/store-status

| Method | Path | Auth | Permission | operationId | Notes |
|---|---|---|---|---|---|
| GET | `/v1/admin/store-status` | bearer | settings:read | getAdminStoreStatus | Requires permission `settings:read`. |
| PUT | `/v1/admin/store-status` | bearer | settings:write | putAdminStoreStatus | Requires permission `settings:write`. NOT MFA-gated on purpose: stopping sales must always be fast. Body `{ ordersPaused: boolean, pauseMessage?: string(<=300) }`. |

## admin/team

| Method | Path | Auth | Permission | operationId | Notes |
|---|---|---|---|---|---|
| GET | `/v1/admin/team` | bearer | team:manage · MFA | getAdminTeam | Requires permission `team:manage` and an MFA (aal2) session. |
| POST | `/v1/admin/team/invite` | bearer | team:manage · MFA | postAdminTeamInvite | Requires permission `team:manage` and an MFA (aal2) session. |
| DELETE | `/v1/admin/team/invites/{id}` | bearer | team:manage · MFA | deleteAdminTeamInvitesId | Requires permission `team:manage` and an MFA (aal2) session. |
| PATCH | `/v1/admin/team/{id}` | bearer | team:manage · MFA | patchAdminTeamId | Requires permission `team:manage` and an MFA (aal2) session. |
| POST | `/v1/admin/team/{id}/reset-mfa` | bearer | team:manage · MFA | postAdminTeamIdResetMfa | Requires permission `team:manage` and an MFA (aal2) session. |

## auth

| Method | Path | Auth | Permission | operationId | Notes |
|---|---|---|---|---|---|
| POST | `/v1/auth/register` | public |  | register | Creates an account (email + password, min 10 chars) and signs it in. A verification code is emailed. |
| POST | `/v1/auth/login` | public |  | login | Same generic 401 for unknown email and wrong password. 5 failures lock the account for 15 minutes (429). `client=admin` is for the operator console. |
| POST | `/v1/auth/refresh` | public |  | refreshSession | Rotates the refresh token. Replaying an old token revokes the whole session (401). |
| POST | `/v1/auth/logout` | public |  | logout |  |
| POST | `/v1/auth/password/forgot` | public |  | forgotPassword | Always 202, whether or not the account exists. A reset code is emailed. |
| POST | `/v1/auth/password/reset` | public |  | resetPassword | Single-use code. All sessions on all devices are revoked. |
| POST | `/v1/auth/email/verify` | public |  | verifyEmail |  |
| POST | `/v1/auth/mfa/enroll` | bearer |  | mfaEnroll | Operator accounts only. Returns the TOTP secret once. |
| POST | `/v1/auth/mfa/verify` | bearer | MFA | mfaVerify | A valid, unused 6-digit code upgrades the session to aal2 and returns a new access token. |
| POST | `/v1/auth/password/change` | bearer |  | changePassword | Signs out every OTHER device. |
| POST | `/v1/auth/account/delete` | bearer |  | deleteAccount | Erases personal data after reauthentication by password or a fresh single-use OTP bound to the signed-in account phone. Request a new code through the OTP request endpoint. Orders and their address snapshots are retained. Refused (409) while orders are in progress. |
| GET | `/v1/auth/account/export` | bearer |  | exportAccount |  |
| POST | `/v1/auth/otp/request` | public |  | requestPhoneOtp | Sends a 6-digit code (valid 5 minutes) by SMS to an Indian mobile number. 30 s resend cooldown, 5 per hour. 503 OTP_UNAVAILABLE while no SMS provider is configured (the app should fall back to email). The configured DEMO number never sends anything. |
| POST | `/v1/auth/otp/verify` | public |  | verifyPhoneOtp | Verifies the code and signs in (creating the account on first use). 5 wrong guesses burn the code. Errors: OTP_INVALID, OTP_EXPIRED (401). |
| POST | `/v1/auth/mfa/recovery-codes` | bearer | MFA | postAuthMfaRecoveryCodes | Rotates the operator's ten single-use recovery codes (shown once). Requires an MFA session. |
| POST | `/v1/auth/invite/accept` | public | MFA | postAuthInviteAccept | Accepts a team invitation. Body `{ token, password, fullName }`. 201 `{ email, role }`. It does NOT sign the invitee in or issue any token: sign in afterwards with `/v1/auth/login` (then MFA enrolment where required). |

## public+customer

| Method | Path | Auth | Permission | operationId | Notes |
|---|---|---|---|---|---|
| GET | `/v1/store-settings` | public |  | getStoreSettings |  |
| GET | `/v1/categories` | public |  | listCategories |  |
| GET | `/v1/products` | public |  | listProducts | Keyset pagination ordered by (sort_order, id). `q` is a case-insensitive substring search over name/subtitle/description (min 2 chars). |
| GET | `/v1/products/{id}` | public |  | getProduct |  |
| GET | `/v1/products/{id}/reviews` | public |  | listProductReviews | Approved reviews only; no author identity. |
| POST | `/v1/products/{id}/reviews` | bearer |  | createReview | Verified purchasers only (delivered order containing the product). One review per product; starts as pending moderation. |
| POST | `/v1/guest-carts` | public |  | createGuestCart | Creates an anonymous cart. The returned token is a bearer secret (store in secure storage); only its hash is stored. |
| GET | `/v1/guest-cart` | public |  | getGuestCart |  |
| PUT | `/v1/guest-cart/lines/{variantId}` | public |  | setGuestCartLine |  |
| GET | `/v1/me` | bearer |  | getMe |  |
| PATCH | `/v1/me` | bearer |  | updateMe |  |
| PUT | `/v1/me/preferences` | bearer |  | setPreferences |  |
| GET | `/v1/addresses` | bearer |  | listAddresses |  |
| POST | `/v1/addresses` | bearer |  | createAddress |  |
| PUT | `/v1/addresses/{id}` | bearer |  | updateAddress |  |
| DELETE | `/v1/addresses/{id}` | bearer |  | deleteAddress | Deleting a saved address never alters past orders (each order keeps an immutable address snapshot). |
| GET | `/v1/cart` | bearer |  | getCart |  |
| PUT | `/v1/cart/lines/{variantId}` | bearer |  | setCartLine | Sets the quantity of one variant (0 removes). Pass `expectedVersion` for optimistic concurrency; a mismatch returns 409 CART_VERSION_CONFLICT. |
| POST | `/v1/cart/merge` | bearer |  | mergeGuestCart | Merge policy: per variant quantity = min(99, userQty + guestQty); the guest cart is consumed. |
| GET | `/v1/wishlist` | bearer |  | listWishlist |  |
| PUT | `/v1/wishlist/{productId}` | bearer |  | addWishlist | Idempotent add. |
| DELETE | `/v1/wishlist/{productId}` | bearer |  | removeWishlist | Idempotent remove. |
| POST | `/v1/checkout/quotes` | bearer |  | createQuote | Server-calculated quote from the caller's cart. Does NOT reserve stock (`stockReserved: false`). Errors: CHECKOUT_DISABLED, POLICY_NOT_CONFIGURED, UNSUPPORTED_PAYMENT_METHOD, NOT_SERVICEABLE, ITEM_UNAVAILABLE, STOCK_SHORTAGE (never silently buys a valid subset). |
| POST | `/v1/orders` | bearer |  | createOrder | Places an order from a quote in ONE transaction. Requires `Idempotency-Key`. Same key + same quote → the original response again (`Idempotent-Replayed: true`); same key + different quote → 422 DUPLICATE_REQUEST_MISMATCH; concurrent duplicates serialise. Cart changed after the quote → 409 CART_VERSION_CONFLICT; expired → 409 QUOTE_EXPIRED; prices/rules changed → 409 QUOTE_STALE. COD orders are `placed`/`cod_due`; online orders are `pending_payment` with stock reserved until the payment window ends. |
| GET | `/v1/orders` | bearer |  | listOrders |  |
| GET | `/v1/orders/{id}` | bearer |  | getOrder |  |
| POST | `/v1/orders/{id}/cancel` | bearer |  | cancelOrder | Allowed while `pending_payment` or `placed`. Idempotent. A paid online order queues a refund. |
| POST | `/v1/orders/{id}/payment-attempts` | bearer |  | createPaymentAttempt | Creates or resumes the single live payment attempt for an online order. `clientConfig` is what the gateway SDK needs. The app NEVER decides payment success from an SDK callback; poll `/payment`. |
| POST | `/v1/orders/{id}/payment-attempts/confirm` | bearer |  | confirmPaymentAttempt | Finishes an online payment from the checkout SDK callback without waiting for the provider webhook (webhooks cannot reach a development machine and may lag). Send the references the SDK returned: Razorpay `razorpay_order_id` as `providerOrderId`, `razorpay_payment_id` as `providerPaymentId` and `razorpay_signature` as `signature`. The server verifies the signature (HMAC-SHA256 of `order_id\|payment_id` with the key secret), then asks the provider for the order status itself and applies it through the same idempotent path as webhooks; the client never decides success. The response is the server-confirmed state (`paymentStatus` is `paid` once the provider reports the order paid; otherwise keep polling `GET /v1/orders/{id}/payment`). Safe to repeat. 401 when the signature is wrong, 404 when the reference does not belong to the caller's order, 503 (retryable) when the provider cannot confirm yet. |
| GET | `/v1/orders/{id}/payment` | bearer |  | getOrderPayment | Server-confirmed payment state (the only source of truth for "paid"). |
| POST | `/v1/orders/{id}/payment-link` | bearer |  | createPaymentLink | For the mobile app, which cannot POST a form to the provider. Creates or resumes the order's single live payment attempt (same rules as `createPaymentAttempt`) and returns a short-lived (10 minutes) signed `url` to open in the system browser; that page forwards the customer to the provider's hosted checkout. When the customer returns, read the server-confirmed state from `GET /v1/orders/{id}/payment` (also on app resume); never infer success from the browser. If `APP_RETURN_URL` is configured the browser is sent to `<APP_RETURN_URL>?order=<id>&pay=paid\|pending\|failed`, otherwise it shows a "return to the app" page. |
| GET | `/v1/payments/{provider}/start` | public |  | paymentCheckoutStart | Browser page reached through the signed link from `createPaymentLink`; not called by app code. Verifies the token (HMAC, 10 minute expiry, names only the order) and renders a tiny page that auto-submits the hosted-checkout form built from our own data. 410 when the link expired or the order can no longer be paid. |
| POST | `/v1/payments/{provider}/return` | public |  | paymentCheckoutReturn | Browser landing for hosted (redirect) checkout - not called by app code. The website posts the customer to the provider's hosted page with this URL as `callback_url`; the provider then POSTs the browser here as `application/x-www-form-urlencoded` (Razorpay: `razorpay_payment_id`, `razorpay_order_id`, `razorpay_signature`, or `error[...]` fields when the payment failed or was cancelled). No session is needed: the server verifies the signature, asks the provider for the order status itself, applies it idempotently and answers `303` to `STOREFRONT_ORIGIN/orders/{orderId}?pay=paid\|pending\|failed` (`&placed=1` when paid). The destination comes only from server configuration, never from the request. Always read the final state from `GET /v1/orders/{id}/payment`. |
| POST | `/v1/webhooks/{provider}` | public |  | receiveWebhook | Provider-only; not for clients. `provider` is the configured payment gateway (`razorpay`), the configured shipping provider (`shiprocket`) or `email`. Payment: verified against the RAW body signature. Shipping: verified with the shared `x-api-key` token. Email (only when `EMAIL_WEBHOOK_TOKEN` is set, otherwise 404): `Authorization: Bearer <token>` and body `{ events: [{ type: "bounce"\|"hard_bounce"\|"complaint"\|"delivered"\|..., email, detail? }] }` - hard bounces and complaints suppress the address (response `{ received: true, suppressed: <newly suppressed> }`). Everything is persisted durably before the 200 acknowledgement and processing is idempotent (duplicates return `duplicate: true` / `suppressed: 0`). |
| GET | `/v1/orders/{id}/shipments` | bearer |  | getOrderShipments | Tracking as entered by the merchant (courier, AWB, events). Never auto-generated. |
| POST | `/v1/orders/{id}/returns` | bearer |  | requestReturn | Delivered orders only, inside the merchant's return window (POLICY_NOT_CONFIGURED while unset). One open return per order; quantities cannot exceed what was delivered. |
| GET | `/v1/orders/{id}/returns` | bearer |  | listOrderReturns |  |
| GET | `/v1/orders/{id}/invoice` | bearer |  | getInvoice | GST tax invoice (issued once, consecutive number per financial year, immutable). 503 POLICY_NOT_CONFIGURED until the seller's GST details are set. |
| GET | `/v1/orders/{id}/invoice.html` | bearer |  | getInvoiceHtml | Printable invoice (HTML, strict CSP). |
| GET | `/v1/me/reviews` | bearer |  | listMyReviews |  |
| POST | `/v1/reviews/{id}/photos` | bearer |  | uploadReviewPhoto | Raw image bytes as the body (JPEG/PNG/WebP, max 5 MB, 3 per review). Type is detected from the bytes; the image is re-encoded (metadata stripped) and stays private until a moderator approves it. |
| GET | `/v1/reviews/{id}/photos/{mediaId}` | bearer |  | getMyReviewPhoto | The author's own (possibly pending) photo. |
| POST | `/v1/devices` | bearer |  | registerDevice | Stores a push token for the signed-in user (a token belongs to one account). Push delivery is not configured yet. |
| DELETE | `/v1/devices/{token}` | bearer |  | unregisterDevice |  |
| GET | `/v1/notifications` | bearer |  | listNotifications |  |
| POST | `/v1/notifications/{id}/read` | bearer |  | markNotificationRead |  |
| GET | `/v1/media/reviews/{id}` | public |  | getApprovedReviewPhoto | Approved review photos only (immutable, CDN-cacheable). |
| GET | `/v1/content` | public |  | listContent |  |
| GET | `/v1/content/{slug}` | public |  | getContent | Published policy / care-guide page (Markdown). |
| GET | `/v1/home` | public |  | getHome | One cacheable call: categories, catalogue (display order) and store policy. |
| GET | `/v1/experience/{channel}/preview` | public |  | getExperienceChannelPreview | Draft bundle for a preview token. `Cache-Control: no-store`, `X-Robots-Tag: noindex`. Served by commerce-api. |
| POST | `/v1/cart/coupon` | bearer |  | postCartCoupon | Attaches a coupon to the cart. 422 COUPON_INVALID with `error.reason` (unknown, expired, not_started, min_order, not_applicable, fully_redeemed, already_used, first_order_only, shipping_already_free). The discount is final only on the quote. |
| DELETE | `/v1/cart/coupon` | bearer |  | deleteCartCoupon |  |
| GET | `/v1/app/version-check` | public |  | getAppVersionCheck | Launch-time gate for the mobile app (public, short-cached). Required query: `platform` (android\|ios) and `version` (x.y.z). `status` is `ok`, `update_available` (older than `latestVersion`) or `force_update` (older than `minSupportedVersion`); show `message` and send the user to `storeUrl`. Operators edit the policy in Settings -> Platform -> App versions (`/v1/admin/app-versions`). Clients must treat any failure as `ok`. |
| GET | `/v1/experience/{channel}` | public |  | getExperienceChannel | The published experience bundle for `app` or `web`: `{ schemaVersion, channel, enabled, release, tokens, navigation, chrome, pages, content, media, variables, diagnostics, generatedAt }`. `enabled:false` means use the built-in design (kill switch). Send `X-JW-Client: <web\|app>/<version>[+build]; platform=<android\|ios\|web>; caps=<block types>`: block types not listed in `caps` are held back (counted in `diagnostics.heldBack`). Responses carry `ETag` and `Cache-Control: public, max-age=60, stale-while-revalidate=300` with `Vary: X-JW-Client`; send `If-None-Match` (strong, weak, list or `*`) for 304. Campaigns apply by time, `{{store.*}}` variables are substituted, and product sources are resolved against live data into `pages.<key>.blocks[].resolved.productIds`. OUT-OF-STOCK RULE: sold-out products stay in the list but never lead it - rule-fed sources (collection, category, newest, bestsellers) list in-stock first, a manual source keeps the editor order - and `resolved.outOfStockIds` names the sold-out ones. `media.<id>` carries `kind`, `url`, `alt`, `poster`, `bundledKey`. Media referenced here must be approved to be served (see getMediaShaFile). |
| GET | `/v1/media/{sha}/{file}` | public |  | getMediaShaFile | Immutable content-addressed media (public). Serves ONLY approved, ready, non-archived library media; draft, rejected, archived and unknown files are all 404. Supports Range (206/416). Approved responses: `Cache-Control: public, max-age=31536000, immutable`. |
| GET | `/v1/collections/{slug}` | public |  | getCollectionsSlug |  |
| GET | `/v1/collections/{slug}/products` | public |  | getCollectionsSlugProducts |  |
| GET | `/v1/serviceability/{pin}` | public |  | getServiceability | Do we deliver to this PIN? `serviceable` is null while no delivery area is configured (clients must make no claim). |
