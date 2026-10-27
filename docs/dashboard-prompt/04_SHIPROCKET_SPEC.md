# 04 — Shipping with Shiprocket: integration and dashboard specification

> Part of the Jimmy & Wax dashboard prompt package. The owner will use **Shiprocket** for delivery (no riders, no quick-commerce). The **provider integration lives in the backend** (workers + API); the **dashboard is the operator UI**. Nothing here is implemented yet — today shipments are *manual* (courier + tracking number typed in).

## 0. What is verified and what is not (read first)

**Verified from Shiprocket’s own support article “Shiprocket API Document Helpsheet” (page last modified 2021-09-06; retrieved 2026-10-05 from a cached copy dated 2026-10-04 — re-check it is still current):**
* Base URL `https://apiv2.shiprocket.in`.
* Create an **API user** in the Shiprocket panel (Settings → API → Configure → Create an API User); its email must be different from the account’s registered email. Use the API user’s credentials — not the panel login.
* `POST /v1/external/auth/login` → token; **valid 240 hours (10 days)**, then must be regenerated; sent as `Authorization: Bearer <token>` on every call.
* Documented flow: `GET /v1/external/courier/serviceability/` (couriers + charges) → `POST /v1/external/orders/create/adhoc` (returns Shiprocket order id + shipment id) → `POST /v1/external/courier/assign/awb` (returns `awb_code` + courier) → `POST /v1/external/courier/generate/pickup` → `POST /v1/external/manifests/generate` → `POST /v1/external/manifests/print` (PDF URL) → `POST /v1/external/courier/generate/label` (PDF URL) → `POST /v1/external/orders/print/invoice` (PDF URL) → `GET /v1/external/courier/track/awb/{awb_code}`.
* A tracking webhook can be configured; a third-party integration page shows a sample payload with: `awb, courier_name, current_status, current_status_id, shipment_status, shipment_status_id, current_timestamp` (format `"DD MM YYYY HH:mm:ss"`), `order_id, sr_order_id, awb_assigned_date, pickup_scheduled_date, etd, scans[{date,status,activity,location,"sr-status","sr-status-label"}], is_return, channel_id, pod_status, pod`. Sample statuses seen: `MANIFEST GENERATED (5)`, `PICKED UP (42)`, `SHIPPED (6)`, `IN TRANSIT (18)`.

**NOT verified (the official docs site `apidocs.shiprocket.in` returned HTTP 502 when I tried; the following is from general knowledge and MUST be confirmed against the live docs / a real account before coding):** order cancel, shipment/AWB cancel, return-order creation, pickup-location list/add, NDR list/action endpoints, wallet-balance endpoint, exact serviceability query parameters, tracking-by-order, the webhook authentication mechanism (header/token), webhook timezone, rate limits, whether duplicate `order_id`s are rejected or duplicated, COD/`sub_total` semantics with shipping/COD fees, the full status-id list, whether a sandbox exists. **Create a verification checklist `docs/build/SHIPROCKET_VERIFICATION.md` and tick items only with evidence (docs link + a real/fixture response).**

## 1. Architecture (backend; the dashboard consumes it)

* **`ShippingProvider` interface** with `checkServiceability`, `planShipment` (couriers/rates/ETD), `createShipment` (order + AWB + pickup), `cancelShipment`, `getLabel`/`getManifest`, `getTracking`, `createReturn`, `parseWebhook`. Implementations: `ManualProvider` (today’s behaviour, stays as the fallback), `ShiprocketProvider`, `FakeProvider` (dev/tests with scripted scenarios).
* **Credentials** (server env / secret manager only): API-user email + password, webhook secret. Token cached (DB/Redis) with expiry; refresh **single-flight** before day 9 or once on `401`; never log tokens; rotate by redeploy. The dashboard shows only **status** (configured, mode, token age, last success/error, last webhook).
* **Idempotent shipment workflow**: `shipment_requests(order_id, attempt, state: planned→provider_order_created→awb_assigned→pickup_scheduled→label_ready | failed, provider ids, raw responses, error)`. Persist the provider order/shipment id **immediately**; on a timeout, **look the order up by our reference before creating again** (never blindly retry `create/adhoc`). Reference id = `JW-<orderNumber>`; re-ship after cancellation uses a suffix (`-R1`).
* **Webhook receiver** `POST /v1/webhooks/shiprocket`: authenticate (mechanism to verify), store the raw event (`shipping_provider_events` with `dedupe_key = awb|current_status_id|current_timestamp`, unique), acknowledge fast, process in a worker: normalise status → shipment status (+ order status transitions), append `shipment_events (source='provider')`, queue the customer email, update ETD. Handle out-of-order and duplicate events (order by `occurred_at`, monotonic progression with explicit exceptions for NDR/RTO). Unknown statuses are stored, alerted, and displayed raw.
* **Reconciliation job**: every ~30 min poll `track/awb` for active shipments with no event for > 6 h; flag **stuck** after a configurable number of days.
* **Money truth (unit-test it):** for COD the collectable amount sent to the provider must equal the order’s `total_paise` (items − discount + shipping + **₹25 COD fee**, GST included); for online payments send prepaid. Verify how Shiprocket expects shipping/COD fee to be expressed before mapping fields.
* **Item data for the provider:** name, sku, units, selling price (GST-inclusive per our model), tax, **HSN** — taken from the order snapshot/invoice computations, not recomputed ad hoc.
* **Package data:** weight (kg) and dimensions (cm) from variant attributes (`weightGrams`, `lengthMm`, `widthMm`, `heightMm` — new fields, see contract §4.2) with a configurable **default package** when missing (shown as a warning). Couriers bill on the greater of dead and volumetric weight — show both.
* **Pickup location:** must exist in Shiprocket and the name must match; the dashboard picks it from the provider list.
* **Serviceability policy:** `serviceable = owner allow-list (today 743287) AND provider says serviceable (cached per PIN ≤ 24 h)`. If the provider is unreachable, fall back to the allow-list only and surface a banner. Showing the provider’s ETD to customers is **opt-in** (today’s promise is the text “3–5 business days”).
* **Cost control:** shipping consumes the Shiprocket wallet; show the balance if the API exposes it (verify), warn when low, require a confirmation showing the **estimated total** for bulk actions, and require **MFA** for bulk ship above a configurable count and for cancellations.
* **Product-risk check (owner/ops, not a coded fact):** polish may contain solvents. Confirm with Shiprocket/couriers whether Twinkle Shine can ship (surface/air, declarations, packaging) **before** enabling automation.

## 2. Status model

Today `shipments.status ∈ {label_created, in_transit, out_for_delivery, delivered, failed, returned_to_origin}` and orders follow `processing → shipped → out_for_delivery → delivered` (DB-enforced). Backend phase B10 extends shipments (forward-only migration) to at least:

`pending_provider → awb_assigned → pickup_scheduled → picked_up → in_transit → out_for_delivery → delivered`, plus exception states `undelivered_ndr`, `rto_initiated`, `rto_in_transit`, `returned_to_origin`, `cancelled`, `lost`, `damaged`, `failed`, and keep `raw_status`, `raw_status_id`.

Mapping strategy: **normalise by status name (case/space-insensitive) and by id when known; never assume the id table is complete.** Transitions that move the **order**: `picked_up` ⇒ order `shipped`; `out_for_delivery` ⇒ `out_for_delivery`; `delivered` ⇒ `delivered` (and COD marked collectible/collected per policy); `rto_*`/`returned_to_origin` ⇒ order stays `shipped` with an exception flag until ops decides (refund/re-ship) — **do not auto-cancel**.

## 3. Dashboard: Shipping Center (all screens, states and rules)

**3.1 Ready to ship (queue)** — orders `confirmed|processing` that are paid (online) or COD-eligible, not yet shipped. Columns: order, customer, city/PIN, items, computed weight, COD amount (₹ incl. COD fee), age, serviceability badge, readiness warnings (missing weight/HSN/pickup location, address issue). Filters, search, multi-select, saved views, CSV export. Primary action **Ship…**.

**3.2 Ship (single)** — side panel/page: package (weight, L×B×H; edit with required reason when overriding the catalogue), pickup location, **courier options table** (courier, freight, COD charge, ETD, rating, “Recommended: cheapest / fastest / balanced” per the owner’s rule), cost estimate vs **shipping fee charged to the customer** (margin shown to finance/admin), wallet balance, confirm. Result card: AWB, courier, label (print), pickup status. Every failure is actionable (not serviceable → show reason + “mark as manual”; wallet low → link; assign failed → try next courier).

**3.3 Bulk ship** — choose strategy (cheapest / fastest / preferred couriers / manual per order), preview per-order plan and **total estimate**, confirm (MFA above threshold) → server-side job with live progress, per-order result, retry failed, never double-create (idempotent), downloadable labels (merged PDF) and manifest.

**3.4 Shipments** — table: AWB, courier, order, status (with raw status), last scan + location, ETD, age, COD flag; filters (status, courier, date, exception, COD); drawer: timeline of scans, actions (cancel, regenerate label, schedule pickup, copy tracking link), raw payloads (admin only). Cancel requires reason and MFA; show whether the provider accepted.

**3.5 Exceptions** — queues for NDR/undelivered (reason, attempt count, next action: re-attempt, update phone/address, mark RTO), RTO in progress, **stuck**, lost/damaged, pickup missed — each with an owner-set SLA timer and one-click actions that call the provider; every action audited. Notifies the customer only through our own templates (avoid double messaging if Shiprocket also notifies — ask the owner).

**3.6 Pickups & manifests** — schedule/reschedule pickup, daily manifest print, handover checklist (count of parcels vs manifest).

**3.7 Returns (reverse)** — for approved returns, create a **reverse pickup**; track it; on physical receipt the existing `returns/{id}/receive` restocks once and queues the refund.

**3.8 COD remittances (P1)** — delivered COD shipments, expected remittance, reconciliation against deposits (manual entry/CSV until an API is verified); aging report.

**3.9 Serviceability & rates** — PIN checker (allow-list + provider), rate calculator (PIN, weight, dimensions, COD, declared value).

**3.10 Settings** — pickup location(s), default package, courier preference rules, **auto-ship (OFF by default)**, label format, provider status card (token age, last webhook/lag, failures, wallet balance), webhook health test.

**3.11 Analytics** — courier performance (delivery time, NDR %, RTO %, cost/order, damage/loss), shipping cost vs charged, exceptions aging.

**3.12 Customer-facing effects (so the dashboard shows what customers see):** order detail/timeline in the app (`TrackingScreen`) and on the website reads `GET /v1/orders/{id}/shipments`; emails on shipped/out-for-delivery/delivered/NDR use message templates (contract §4.6).

## 4. Data additions (backend, proposed)
`shipments`: `provider, provider_order_id, provider_shipment_id, awb, courier_id, courier_name, label_url (private), manifest_url, pickup_scheduled_at, etd, charges_paise, cod_amount_paise, weight_grams, dims, ndr_count, rto_state, raw_status, raw_status_id, last_event_at` · `shipment_requests` · `shipping_provider_events` · `shipping_settings` (pickup location, default package, courier rules, auto-ship, thresholds) · `shipment_remittances` (P1). Label/manifest PDFs are **proxied through the API/BFF with a permission check** — do not expose provider URLs to the browser.

## 5. Endpoints (proposed; shapes finalised in OpenAPI by the backend)
`GET /v1/admin/shipping/provider` (status) · `GET|PUT /v1/admin/shipping/settings` · `GET /v1/admin/shipping/pickup-locations` · `POST /v1/admin/shipping/serviceability/check` · `GET /v1/admin/shipping/ready` · `POST /v1/admin/orders/{id}/shipments/plan` · `POST /v1/admin/orders/{id}/shipments` (extended: provider mode) · `POST /v1/admin/shipments/bulk` (+ `GET …/bulk/{jobId}`) · `GET /v1/admin/shipments` · `GET /v1/admin/shipments/{id}` · `POST /v1/admin/shipments/{id}/cancel|pickup` · `GET /v1/admin/shipments/{id}/label` · `POST /v1/admin/shipments/labels` · `POST /v1/admin/shipments/manifest` · `GET /v1/admin/shipments/ndr` · `POST /v1/admin/shipments/{id}/ndr-action` · `POST /v1/admin/returns/{id}/reverse-pickup` · `GET /v1/admin/shipping/cod-remittances` · `POST /v1/webhooks/shiprocket`. Permissions: `shipping:read`, `shipping:write`; MFA per contract §6.

## 6. Tests required (no test may create a real shipment)
* `FakeProvider` scenarios: assign-AWB failure, not serviceable, wallet low, timeout then success (idempotency), duplicate webhook, out-of-order webhooks, NDR loop, RTO, cancel after pickup, unknown status.
* Recorded/sanitised real responses become contract fixtures once the owner’s account exists.
* Guard: a real-provider test runs only with `SHIPROCKET_LIVE=1` **and** an interactive confirmation; staging dry-run = one low-value test order, cancelled immediately, evidence recorded.
* Money-truth tests for COD/prepaid amounts; permission/MFA tests; webhook auth and replay tests; dashboard Playwright flows against the live stack with `FakeProvider`.

## 7. Phasing
S1 provider status + serviceability + settings · S2 single ship + label · S3 webhooks + timeline + order auto-transition · S4 bulk + manifest · S5 NDR/RTO/returns · S6 remittances + analytics. The dashboard builds S1–S6 UI against the mock first; **“verified” requires the live backend with `FakeProvider`, and “production-ready” requires a recorded staging dry-run with the real account.**

## 8. Owner inputs needed (ask only these)
API user created? Pickup address registered in Shiprocket (exact location name)? Wallet funded/limits? Preferred couriers and the default rule (cheapest/fastest)? Default parcel weight/size per product? Shipping-fee policy (flat ₹40 vs freight)? COD remittance expectations and reports? Does Shiprocket also message customers (avoid duplicates)? Dangerous-goods answer for the polish (§1).
