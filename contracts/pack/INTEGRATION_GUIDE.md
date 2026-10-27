# INTEGRATION_GUIDE — how the website, the app and the dashboard connect to the backend (2026-10-10)

```
 Flutter app ─┐                     ┌─ commerce-api  (:4000)  accounts, cart, quotes, orders, admin API
 Website ─────┼─►  ONE API ORIGIN ──┤
 Dashboard ───┘   (edge / gateway)  └─ experience-api (:4001) public cacheable reads: products, settings, bundles, media
                                         │
                                    PostgreSQL ◄── workers (email, expiry, outbox)
```

Locally the "edge" is `scripts/dev-gateway.ts` on **:8080**; in production it is `infrastructure/prod/Caddyfile`.
Both route the same read paths to experience-api and everything else to commerce-api.

## Run it locally
1. Backend (Docker Desktop on): `powershell -ExecutionPolicy Bypass -File scripts/dev-stack.ps1 -Reset` (in `backend/`).
2. Local test switches (stock 0 / checkout OFF after a reset, like production):
   `docker exec jimmywax-backend-postgres-1 psql -U postgres -d jimmywax_dev -c "update inventory_positions set on_hand = 40" -c "update store_settings set checkout_enabled=true, checkout_policy_confirmed=true"`
3. Website: `npm run dev` in `jimmy_nd _wax_website` (uses `VITE_API_ORIGIN`, default `http://localhost:8080`). If port 5173 is taken Vite picks 5174; both are in the dev CORS list.
4. App: `API_ORIGIN` in `.env.local.json` (see the app's `docs/LOCAL_BACKEND.md`).
5. Demo sign-in everywhere: phone **9800000001**, code **123456**; delivery PIN **743287**.

## What each client uses
| Capability | Website | App | Endpoint(s) |
|---|---|---|---|
| Catalogue, prices, stock | live | live | `GET /v1/products`, `/v1/store-settings` |
| Delivery-area check | live | live (was silently failing before; endpoint now exists) | `GET /v1/serviceability/{pin}` |
| Guest cart → account merge | live | local cart synced on sign-in | `/v1/guest-cart*`, `/v1/cart*`, `/v1/cart/merge` |
| Sign-in | phone code + email | phone code + email | `/v1/auth/*` |
| Addresses, quote, COD order | live | live | `/v1/addresses`, `/v1/checkout/quotes`, `/v1/orders` |
| Coupons | live (checkout) | live (review step) | `/v1/cart/coupon` |
| Orders list / detail / cancel / tracking | live | latest order only | `/v1/orders*` |
| Orders paused notice | banner + disabled buttons | message on place-order | `ordersPaused`, `pauseMessage` in store settings |
| Force / nudge app update | n/a | live | `GET /v1/app/version-check` (build with `--dart-define=APP_VERSION=x.y.z`) |
| Studio-controlled home design | live (adapter) | fetched; home screen drawing pending | `GET /v1/experience/{app|web}` |

## Rules both clients follow
* Prices, stock, shipping, COD fee, GST and coupon discounts are **computed by the server**; clients only display them.
* Orders use an idempotency key per quote, so a retry can never create a second order.
* The website keeps the refresh token in `localStorage` (readable by scripts on that origin): never add third-party scripts to the checkout.
* Production: set `VITE_API_ORIGIN` (website), `API_ORIGIN` https (app), and `CORS_ORIGINS` (backend) to the real site origin.

## Reading the published design (website and app)
```
GET /v1/experience/web   (or /app)
x-jw-client: web/<version>; caps=<comma-separated block types this build can draw>      (app: app/1.4.0+22; platform=android; caps=...)
if-none-match: <last ETag>      -> 304 with no body when nothing changed; otherwise 200 + the new ETag
```
* Cache about 60 s (`Cache-Control: public, max-age=60, stale-while-revalidate=300`, `Vary: X-JW-Client`). Block types missing from `caps` are held back by the server, so an old build never receives a block it cannot draw (see `diagnostics.heldBack`).
* `enabled:false` is the kill switch: render the built-in design. Any failure (network, 5xx, a schema you do not understand) also means: render the built-in design.
* Product rails and grids arrive resolved: `pages.<key>.blocks[].resolved.productIds` (ordered) and `resolved.outOfStockIds`. Sold-out products stay in the list so you can show a sold-out card, but rule-fed rails never lead with them. Fetch product details with `GET /v1/products?ids=a,b,c`.
* `{{store.*}}` and `{{brand.name}}` are already substituted in copy. Prices are never typed into content.
* Media: `media.<mediaId>` has `kind`, `url` (relative: prepend the API origin), `variants`, `alt`, `poster` and `bundledKey`. When the app ships that picture inside the binary (`bundledKey`) it shows its bundled copy. Only approved media is served: an unapproved file answers 404.
* Pages: website `home, shop, product, ritual, story` plus `custom:<slug>` and `product:<slug>` (a product template overrides `product` for that slug); app `home, category, product, cart`. Web pages carry `seo`; product pages carry `nativeSections` (which built-in sections to show).
* Drafts: website `?jw_preview=<token>` calls `GET /v1/experience/web/preview?token=` (never cached, noindex); app debug build `--dart-define=EXPERIENCE_PREVIEW_TOKEN=...`. A draft shows only media that is already approved.
* App version gate: `GET /v1/app/version-check?platform=android|ios&version=x.y.z` returns `status` (ok, update_available or force_update), `message` and `storeUrl`. Treat any failure as ok.
* Store state: `GET /v1/store-settings` (`checkoutOpen`, `ordersPaused`, `pauseMessage`, support contacts).
* CORS: the website origin(s) must be listed in `CORS_ORIGINS` (https in production); admin routes are called by the dashboard server only.

## What changed for the operator console in 1.4.0
See `contracts/api/CHANGELOG.md`. The breaking ones: issuing an invoice is `POST` (GET only reads), media archive/restore, category edit/order and collection delete need their revision stamps, and the public media URL serves approved media only (preview drafts through `GET /v1/admin/media-files/{sha}/{file}`).

## Not connected yet (honest list)
* **Studio rendering** is live in the website adapter and fetched by the app; the app's `HomeScreen` still needs to draw the published bundle (see the app repo).
* **Online payments** (Razorpay): built into the website (hosted-checkout redirect) and the app (signed link in the system browser); verified against Razorpay's test API up to the hosted page, not yet with a completed test payment or a real webhook (runbook section 10). Both clients show "Pay online" only when `GET /v1/store-settings` says `onlinePaymentsEnabled`. **SMS** is not configured; email/demo sign-in only. The refund path has never run against the provider.
* **Shiprocket** is mock-tested only; run the sandbox checklist in `docs/build/PRODUCTION_RUNBOOK.md` before setting `SHIPPING_PROVIDER=shiprocket`.
