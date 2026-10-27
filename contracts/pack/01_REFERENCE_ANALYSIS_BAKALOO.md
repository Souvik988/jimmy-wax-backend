# 01 — Reference analysis: the Bakaloo dashboard

> Part of the Jimmy & Wax dashboard prompt package. Read `00_MASTER_PROMPT.md` first.
> Purpose: tell you exactly what the reference dashboard can do, which parts we replicate, which we re-design, and which we skip.
> **Owner decision (2026-10-05): Jimmy & Wax has no B2B. Everything B2B/“audience” in the reference is excluded** (see §6).

## 0. Provenance and honesty about coverage

* Source: `https://github.com/shotlin085/bakaloo-dashboard` (public, “Client project, grocery dashboard”), shallow-cloned at commit `4c6433d` (2026-10-05). Use it as a **behavioural reference**. Re-implement; do not copy-paste wholesale (it has defects, §5, and a different domain).
* Size: 113 `page.tsx` routes, 232 components, 64 API services, 66 hooks, 55 type files, ≈134k lines of TS/TSX, 69 unit-test files + 9 Playwright specs.
* Stack: Next.js 14.2 (App Router), React 18, TypeScript, Tailwind 3 + shadcn/ui (Radix, “new-york”), TanStack Query 5, Zustand 5, Axios, Recharts 3, @dnd-kit, react-hook-form + zod 4, Socket.IO client, Leaflet, sonner, next-themes, vitest + Testing Library + fast-check, Playwright + axe.
* Its own docs are **stale**: `DASHBOARD_GUIDE.md` describes Phase 1 only; `TESTER_GUIDE.md` lists 19 pages. The code has since grown to 113 routes. Trust the code, not the guides.

**What was analysed in depth (read line by line):** the Theme/Section builder (`src/app/(dashboard)/themes/builder/page.tsx`, `src/components/builder/*`, `src/types/theme.types.ts`, `src/services/{themes,theme-tabs,sections}.service.ts`, hooks `useBuilderAutosave`/`useBuilderHistory`), banners, nav buttons, branding, app-version, store-status, feature-gating (`features.service.ts`), RBAC (`lib/permissions.ts`), the API client and middleware (`lib/api.ts`, `middleware.ts`), the sidebar (`components/layout/Sidebar.tsx`), and the type files for fees, legal pages, cart milestones, first-time offers, customer segments, area segments, purchase limits, tutorials, delivery calendar, product suggestions.
**What was classified from names/types/guides only (not read in depth):** WhatsApp CRM (12 pages), POS/fulfilment board, procurement, HQ/shops/store-scoped pages, orders/products/customers page internals beyond what the Tester Guide documents, analytics internals. Where this file says something about them it is from the guide or the file names. **If you need more depth on any of these, read the code in the clone before replicating** — do not rely on this summary.

## 1. What the dashboard is, structurally

* Three-layer pattern: `page → hook (TanStack Query) → service (Axios) → API`. Shadcn primitives in `components/ui`, feature components in `components/<feature>`, Zustand for auth/sidebar/notifications/shop-context.
* Layout: collapsible 260 px sidebar (72 px collapsed), 64 px header (global search / command palette, connection indicator, theme toggle, notification bell, user menu), mobile sheet navigation.
* Role-aware menu: sections are hidden unless the user’s permissions allow them (`lib/permissions.ts`: route guards + menu permissions + role default sets).
* Real-time: Socket.IO events (`new-order`, `low-stock`, `stock-out`, `dashboard:rider_locations`), toast + notification store + query invalidation, a notification sound for new orders (`lib/orderSound.ts`).
* Quality bar visible in the repo: skeletons everywhere, empty states, error boundary, request-id surfacing on errors, submit cooldown after HTTP 429 (`lib/submit-cooldown.ts`), dirty-tracking with sticky save bar on settings, drawers for detail views and dialogs for forms, debounced search (300 ms), CSV export on every list, consistent badge colours, relative timestamps, dark mode, keyboard-shortcuts sheet.

## 2. Capability inventory and decisions

Legend — **KEEP**: replicate the behaviour. **ADAPT**: replicate the idea, change the model for Jimmy & Wax. **REPLACE**: reference feature exists but we solve it differently. **LATER**: valid, not at launch. **DROP**: does not apply (reason given). IDs (`UI-…`, `OPS-…`, …) are used by the **parity matrix** you must maintain (`docs/build/PARITY_MATRIX.md`).
Tiers: **P0** launch-critical · **P1** soon after launch · **P2** later.

### 2.1 UI-control machinery (the heart of this project)

| ID | Reference capability (verified in code) | Decision | Jimmy & Wax equivalent | Tier |
|---|---|---|---|---|
| UI-01 | **Themes**: named theme records with `theme_data` (top bar, store selector, category tabs, search zone, banner animation, fee strip, seasonal mosaic, bank offers, meta), status `draft/active/scheduled/archived`, schedule + expiry, A/B variant + split %, version history + rollback, one active per (tab, variant) | **REPLACE** | **Design System** (shared tokens + per-channel overrides) with **Campaign Theme overlays** (scheduled seasonal skins). No A/B in v1. Versioned through Releases (UI-14). | P0 |
| UI-02 | **Theme Tabs**: store-keyed home tabs with label, image, text colour, order, default flag, per-tab merchandising config | **DROP** | Jimmy & Wax has one storefront, one home. The idea “several pages, each with its own layout” survives as **Pages** (home, category landing, product template, web pages). | — |
| UI-03 | **Section Builder**: 3-panel editor (sections list + tabs, live mobile preview, library & property panel) | **ADAPT** | **App Builder** and **Website Builder** (same editor shell, two canvases). Studio spec §8. | P0 |
| UI-04 | Section library: 13 section types, cards grouped (header/hero/offers/products/categories/content/seasonal), tags, per-type max, “use case” blurbs, data-source hints; several library cards share one `type` with different `defaultConfig` (layout variants) | **ADAPT** | Block Library for each channel (see `02_EXPERIENCE_STUDIO_SPEC.md` §6). | P0 |
| UI-05 | Drag from library into preview **insertion slots**; reorder in list and in preview; move up/down; duplicate; hide/show; delete | **KEEP** | Same, with keyboard alternatives (dnd-kit KeyboardSensor) and ARIA live announcements. | P0 |
| UI-06 | Click-to-select in the preview (sections **and “chrome regions”**: top bar, search bar, category tabs, bottom nav, store chips) | **ADAPT** | Click-to-select blocks **and global chrome** (app: bottom tabs, header, splash; web: nav, footer, announcement bar, arrival veil). | P0 |
| UI-07 | Property editor with **Style** and **Data** tabs; per-type editors; colour/gradient/image pickers with upload; sliders; animation picker; card-shape picker | **KEEP** | Schema-driven property panels generated from the block’s zod schema + hand-tuned widgets for rich blocks. | P0 |
| UI-08 | **Data binding** to catalogue: source `category \| tag \| manual`, category/product pickers, limit | **ADAPT** | Source = `collection \| category \| manual \| bestsellers \| newest`; **Collections** are first-class (manual or rule-based). | P0 |
| UI-09 | **LinkPicker**: link target = none / product / category / URL, stored as the path vocabulary the mobile app already understands (`/product/:id`, `/categories/:id/products`); mosaic tiles add `tab`, `app_page`, `external_url` | **ADAPT** | One **Action** model shared by both channels (product, collection, category, page, app screen from an allow-list, web route, external URL, tel/mail, none). Studio spec §5. | P0 |
| UI-10 | **Seasonal Mosaic**: 5 layout variants, hero + mini tiles, per-tile gradient/image/fit/badge/action, recommended upload sizes per slot derived from the app’s layout maths | **ADAPT** | Keep the “recommended size per slot” idea for **every** image slot (app and web), computed from the client’s real layout. | P1 |
| UI-11 | **Style presets** per section type and **page presets** (7 full-page skins: “apply style only” vs “replace layout”) | **ADAPT** | Token presets (brand-safe palettes) + **Starter layouts** (e.g. “Festival”, “Launch”, “Minimal”). Must go through the guard-rails (contrast etc.). | P1 |
| UI-12 | **Undo/redo** (Ctrl/Cmd+Z, Shift for redo) over local section state | **KEEP** | Same; history is per document, bounded (100 steps). | P0 |
| UI-13 | **Autosave** to `localStorage` every 3 s with a “restore draft?” prompt | **REPLACE** | **Server-side draft autosave** with optimistic concurrency (Studio spec §9). `localStorage` may mirror it as a crash buffer only. | P0 |
| UI-14 | **Publish flow**: Save Draft / Push Live / Schedule; status Draft/Live/Scheduled; version number; timeline bar; **publish checklist** (errors block, warnings allowed, info) | **ADAPT** | **Releases**: validate → preview → publish (or schedule) → rollback; checklist rules extended (contrast, alt text, claims, price literals, testimonial source, missing bindings). Atomic (Studio spec §9). | P0 |
| UI-15 | Section versions: list, rollback, schedule a layout, cancel schedule | **ADAPT** | Release history with human-readable diffs, rollback = new release, scheduled releases, cancel. | P0 |
| UI-16 | **Banners**: type (carousel/popup/announcement), image, link, schedule, active, order (drag), trigger (`ALWAYS`/`STORE_CLOSED`), placement (HOME/PROFILE), declared pixel size + **aspect-ratio mismatch warning (>8 %)**, segment targeting | **ADAPT** | Banners become **blocks** (hero carousel, banner, announcement bar, popup) inside Pages, plus a **Banner library** view for quick edits. Keep: schedule, order, declared sizes + mismatch warning, “store paused” trigger. Drop: audience; segment targeting is P2. | P0/P1 |
| UI-17 | **Nav & Menu Buttons**: one configurable 5th bottom-nav slot **or** unlimited Profile-menu buttons; 37 preset icons or custom images (active/inactive), accent colour, destination (app route / category / product / webview), schedule, order, `pass_identity` | **ADAPT** | **Navigation**: app bottom tabs (3–5, label/icon/visibility), Profile menu items, web header links, footer columns. **Do not copy `pass_identity`** (its name suggests it forwards the user’s identity to the destination; I did not verify its semantics — not needed here). No webview destinations at launch. | P0 |
| UI-18 | **App Branding**: splash image + logo editable without a release, bundled default as fallback | **ADAPT** | Brand assets in the Design System (logo, mark, splash, favicon, OG image, mascot scenes). Native launch screen and app icon **cannot** change over the air (say so in the UI). | P0 |
| UI-19 | **App Version** (per platform): min supported build, latest build/name, update message, store URL → force/soft update | **KEEP** | Same. | P1 |
| UI-20 | **Store status**: manual override + weekly schedule + “we’re closed” banner image | **ADAPT** | **Store status / pause orders** (maintenance, holiday): single switch + message + optional banner; shown in app and web. Weekly hours not needed. | P1 |
| UI-21 | **Legal pages** (terms/privacy/about; HTML) | **ADAPT** | Policies & pages as **Markdown**, versioned, publish-gated (backend `content_pages` already exists). Never raw HTML. | P1 |
| UI-22 | **Tutorials** (YouTube videos, ordered, language tag) | **ADAPT** | **Care guides** and **Stories** (own video files; no YouTube dependency). | P1 |
| UI-23 | **Feature gating** (`/developer`, `features.service.ts`): modules are “released” globally or granted per user | **ADAPT** | Simplified **Labs / feature flags** page (admin only) to ship dashboard modules and client features gradually. | P2 |
| UI-24 | Preview is a **React re-implementation** of the Flutter widgets (`MobilePreviewFrame`, `previews/*`) | **ADAPT** | Prefer a **true-fidelity preview** (Flutter-web build in preview mode and the real website in preview mode, both fed by postMessage). React replicas only as fallback. Studio spec §10. | P0 |

### 2.2 Commerce operations

| ID | Reference capability | Decision | Jimmy & Wax equivalent | Tier |
|---|---|---|---|---|
| OPS-01 | Dashboard: period tabs, KPI cards with sparklines, revenue chart, category donut, orders-by-hour, top products, recent orders, low-stock alerts, pending actions, live rider map | **ADAPT** | KPIs derived from real rows (backend `/v1/admin/dashboard` returns definitions with figures), revenue/orders trend, top products, low stock, pending actions (orders to ship, returns to decide, refunds queued, outbox dead-letters), release/Studio status card. **Drop** rider map, orders-by-hour (only if data supports it), category donut only if >3 categories. | P0 |
| OPS-02 | Orders list: status tabs with counts, search, advanced filters (payment, date, amount, area/PIN), bulk actions (status, assign, print packing slips), export CSV, detail drawer, tax invoice / packing slip | **KEEP** | Orders list + detail (timeline, items, address snapshot, payment, shipments, returns, invoice). Bulk: ship (Shiprocket), print labels/packing slips, export. “Assign rider” is **dropped**. | P0 |
| OPS-03 | Manual order wizard (customer → products → address → payment → coupon → confirm) | **LATER** | Phone/WhatsApp orders; needs backend support. | P2 |
| OPS-04 | Refund requests, wallet credit/bulk credit | **ADAPT** | **Returns & refunds** (backend has returns/refunds with over-cap guards). **No wallet.** | P0 |
| OPS-05 | Products: table/grid, inline stock edit, filters, duplicate, bulk activate/deactivate/delete, CSV import/export, product form (variants, SEO, nutrition, tags…) | **ADAPT** | Products with variants, price/MRP, stock (via inventory movements, not inline overwrite), media, benefits, suitable surfaces, box contents, SEO, shipping attributes (weight/dimensions/HSN — needed for Shiprocket and invoices). Drop food fields. | P0 |
| OPS-06 | Product **families** | **LATER** | Only if variants multiply. | P2 |
| OPS-07 | Categories tree with drag-reorder, images, active toggle | **KEEP** | Categories (flat or 2-level) with images; **Collections** added. | P0 |
| OPS-08 | Inventory + movements ledger | **ADAPT** | Inventory page (on-hand, reserved, available), adjust with reason + expected version (backend supports), movements ledger, low-stock threshold. | P0 |
| OPS-09 | Customers: summary cards, search, segments (VIP/churned), block/unblock, profile drawer, export | **ADAPT** | Customers list/detail (orders, addresses, notes), block/unblock, export, deletion/export requests (privacy). Segments LATER. | P1 |
| OPS-10 | Reviews: product selector, rating distribution, reply, approve/reject/delete | **ADAPT** | Moderation queue incl. **photo moderation** (backend has quarantined review media). | P1 |
| OPS-11 | Riders, area segments, live map, rider payouts | **DROP** | Delivery is Shiprocket couriers. | — |
| OPS-12 | Fulfilment board (`/pos`) | **REPLACE** | **Shipping Center** (`04_SHIPROCKET_SPEC.md`). | P0 |
| OPS-13 | Abandoned carts | **LATER** | Needs recovery messaging. | P2 |
| OPS-14 | Activity log (diff view old→new) | **KEEP** | Audit log (backend `audit_log` is append-only with before/after). | P0 |
| OPS-15 | Customer activity timeline | **LATER** | Needs event tracking. | P2 |

### 2.3 Marketing and growth

| ID | Reference capability | Decision | Jimmy & Wax equivalent | Tier |
|---|---|---|---|---|
| MKT-01 | Coupons: 5 types (percentage, flat, free-delivery, BOGO, cashback), usage limits, dates, analytics drawer | **ADAPT** | Percentage, flat, free-shipping at launch; usage/per-customer limits; dates; analytics. Needs a backend discount engine (GST-correct totals). BOGO/cashback LATER. | P1 |
| MKT-02 | First-time offers, cart milestones, purchase limits, customer segments | **LATER** | Valid growth tools; not needed at launch. | P2 |
| MKT-03 | Spin & Win, Scratch card | **DROP** | Gamification does not fit the premium brand. | — |
| MKT-04 | Notifications: templates (push/SMS/email/in-app) and campaigns (segments, schedule) | **ADAPT** | Transactional **message templates** (email first; SMS/push when providers exist) at P1; marketing campaigns P2 (consent/DLT rules). | P1/P2 |
| MKT-05 | WhatsApp CRM (inbox, templates, campaigns, pipeline, bots…) | **DROP (for now)** | Large, regulated surface. Revisit only if the owner asks. | — |
| MKT-06 | Payment offers (bank offers) | **LATER** | If Razorpay offers are used. | P2 |

### 2.4 Settings, platform, insight

| ID | Reference capability | Decision | Jimmy & Wax equivalent | Tier |
|---|---|---|---|---|
| SET-01 | Fee settings (delivery distance fee, handling/platform/small-cart/surge/packaging, **GST exclusive**, quick-delivery surcharge, ETA) | **ADAPT** | Store policy: shipping fee, free-shipping threshold, **COD fee (₹25)**, **GST 18 % included in listed prices** (mode switch exists), delivery estimate text. All other fee types **DROP**. | P0 |
| SET-02 | Payments settings (Razorpay keys, COD/wallet toggles) | **ADAPT** | COD toggle/limit, online payments toggle, payment window, provider **status** (never secret entry). | P0 |
| SET-03 | Serviceability: pincode mapping | **ADAPT** | PIN allow-list (current: 743287) **plus** Shiprocket serviceability check. | P0 |
| SET-04 | Team & roles: members, invite, role cards, **permission matrix**, system roles | **KEEP** | Fixed roles at launch (support, catalog, fulfillment, finance, admin) + new `designer`; custom roles LATER. MFA enforced, session list/revoke. | P0 |
| SET-05 | 2FA enrolment with QR, recovery codes | **ADAPT** | TOTP (backend supports enrol/verify); recovery codes need a backend addition. | P0 |
| SET-06 | Global search / command palette, keyboard shortcuts | **KEEP** | Same. | P1 |
| SET-07 | Analytics: sales, top products, delivery performance, rider comparison, financial summary with payment-method + GST breakdown, period comparison, **cohort retention**, **dead stock**, geographic, PDF/Excel export | **ADAPT** | Sales, products, customers, **shipping performance (courier, NDR/RTO rates, delivery time)**, returns, financial summary (GST), geo by PIN/state; cohorts/dead-stock P2; CSV first, PDF later. | P1 |
| SET-08 | GSTR-1 export | **ADAPT** | GST reports (invoice register, GSTR-1-style export) — valuable in India; needs HSN/seller details. | P2 |
| SET-09 | Business analytics, procurement, bulk catalogue | **LATER / KEEP** | Bulk catalogue import/export P1; procurement DROP. | P1 |

## 3. The UI-control machinery in detail (what to replicate)

### 3.1 Data model of the reference (simplified)
* `Theme { id, name, status, theme_data{ sections{topBar, storeSelector, categoryTabs, searchZone, bannerAnimation, feeStrip, seasonalMosaic, bankOffers}, meta{seasonLabel, statusBarBrightness} }, tab_*, scheduled_at, expires_at, ab_variant, ab_split_percent, audience, version, etag }`.
* `SectionManifest { id, tab_id, section_type (13), sort_order, visible, config: jsonb (untyped), merch_binding{category_ids, product_ids, tags, limit, source}, audience }` and `SectionManifestVersion { snapshot[], status applied|scheduled|expired, ab_* }`.
* Lessons: (1) `config` is an **untyped bag** shared by two codebases — it drifted (legacy keys kept “so older Flutter builds keep rendering”). We type every block with a versioned zod schema. (2) “Chrome” (top bar etc.) and “sections” were two separate stores edited in two different ways. We use one Document model.

### 3.2 Builder UX mechanics worth replicating exactly
1. **Three panels**: left = page/tab picker + ordered section list (visible-count badge, per-row visibility/duplicate/delete/drag handle); centre = device frame with live preview (scale control), selectable regions, insertion-slot lines while dragging; right = Section Library when nothing selected, Property Editor (Style | Data) when a block is selected, Chrome editor when a chrome region is selected.
2. **Library cards add pre-configured variants** of one underlying block type (e.g. “Product Grid — 2 column / 3 column / classic cards”) without new client code.
3. **Insertion** via drag from library to a slot or drop onto a block; click-to-add appends. Hard limits per block type and per page, enforced in one shared constant (the reference drifted: `maxPerTab` 15 vs 50 — never duplicate limit constants).
4. **Selection sync**: hover in list highlights in preview; click in preview selects in list; on narrow screens the editor scrolls into view.
5. **Dirty tracking**: “Draft • vN+1” badge, `beforeunload` warning, discard (with confirm), tab/page switch guard.
6. **Undo/redo stack** across all edits; keyboard shortcuts.
7. **Publish checklist** is a pure function `runPublishChecklist(blocks) → {issues[], canPublish}`; levels `error` (blocks publish), `warning`, `info`; stable issue codes; issues deep-link to the block. Rules seen: empty page, over limit, all hidden, missing title text, **no data binding** (warning), invalid hex colour, banner without image (info), likely duplicate section (info).
8. **Link picker** with debounced product search (≥2 chars), paged results, category list including bundles, “clear selection”.
9. **Recommended asset size and ratio per slot** shown next to each image uploader, computed from the client layout maths.
10. **Timeline bar** showing version history and a scheduled version at a glance.

### 3.3 What changes for Jimmy & Wax (non-negotiable)
* **One storefront, no audience dimension.** No B2B, no store switcher, no tab bar, no multi-shop.
* **Two channels (app, web) over one shared Design System and one shared content library** — “separate but connected” (see the Studio spec §2).
* **Atomic publish** instead of N sequential API calls (Studio spec §9).
* **Typed, versioned blocks** and a **client contract with capability negotiation** instead of an untyped bag.
* **True-fidelity preview** instead of hand-built React replicas where feasible.

## 4. Cross-cutting UX patterns to replicate (all tiers)
Command palette (Cmd/Ctrl+K) with entity search; keyboard shortcuts sheet; dark/light/system theme; skeleton loading and empty states on every list; error boundary per route with request-id and “copy details”; submit cooldown after HTTP 429 with visible countdown; dirty-tracking + sticky save bar on settings; drawers for read-mostly detail, dialogs for short forms, full pages for complex editors; debounced search; server-side pagination and filters in the URL; CSV export on lists; consistent badge colours (green active/success, red blocked/error, amber pending, blue info); relative time with absolute tooltip; connection-status indicator and live toasts for new orders (with an optional sound, off by default); responsive down to tablet (the Studio itself is desktop-first; show a clear “use a larger screen” notice below 1024 px rather than a broken editor).

## 5. Anti-patterns and defects observed — do NOT copy

1. **Access token in `localStorage`** and a plain `auth_session=1` cookie used by middleware for route protection (forgeable; XSS-stealable token). → Use an encrypted HTTP-only cookie session via a Next.js BFF (§6 of the master prompt). Never expose API tokens to browser JS.
2. **Client-side-only “viewer” enforcement** (blocks mutations when all permissions end in `.view`). → The server is authoritative; the UI hides/disable controls for UX only.
3. **`eslint.ignoreDuringBuilds: true`** hiding lint errors; stale docs; large untyped `Record<string, unknown>` configs.
4. **Publish = N sequential mutations with a client-side “rollback”** (`persistLayout` deletes, creates, updates, then reorders one request at a time). A failure mid-way leaves the server half-updated while the UI pretends it rolled back. → One atomic `PUT` of the document with `If-Match`, then an atomic publish.
5. **Autosave only in `localStorage`** (lost on another device, invisible to colleagues). → Server drafts + presence.
6. **Immediate global activation** of a theme (“push changes to all users instantly”) with no staged validation, no kill switch. → Validate → preview → publish → rollback, plus an emergency “revert channel to bundled defaults” switch.
7. **Duplicated constants that drift** (section caps 15 vs 50 in two places).
8. **Quick-commerce leakage into generic code** (store keys `zepto/off_zone/super_mall/cafe`, rider-centric models).
9. **Secrets in forms**: settings groups include payment/SMS keys that round-trip through the dashboard. → Secrets live only in server environment/secret manager; the dashboard shows **status** (“configured / last verified / last error”), never values.
10. **GST modelled as exclusive** (added on top). Jimmy & Wax prices are **GST-inclusive** (18 % included; the backend already models this).
11. **`pass_identity` on nav buttons** (by its name it forwards user identity to the destination; semantics not verified). Not needed; excluded.
12. **`Locale = "en"` only** with i18n scaffolding half-used. → Wrap all strings from day one; English only at launch; Hindi/Bengali later.
13. Raw **HTML** legal pages. → Markdown with a sanitising renderer.

## 6. Explicit exclusions (so they are not resurrected)

* **B2B / “audience” (owner decision):** `audience: B2C|B2B|ALL` on themes, tabs, sections, banners, nav buttons; the audience toggle and “Copy B2C ⇄ B2B” in the builder; `/b2b/applications|orders|collections|gst`; payment methods `B2B_CREDIT`/`LEDGER`; B2B GST invoices. **None of these exist in Jimmy & Wax.** Do not add an `audience` column, field, filter or UI control anywhere. (Visibility rules in the Studio spec are about *signed-in vs signed-out* and schedule, not business type.)
* Multi-vendor: `/shops/*`, `/shop-*`, `/store/*`, `/hq/*`, shop switcher, X-Shop-Id header, shop staff/financials/transactions.
* Quick-commerce/rider domain: riders, area segments, live rider map, rider payouts, tip presets, delivery timer, surge/small-cart/handling/packaging fees, ETA-in-minutes, store tabs.
* Wallet/scratch/spin; WhatsApp CRM; procurement; team chat; developer-only gating beyond a simple flags page.

## 7. Parity matrix (you must maintain it)

Create `docs/build/PARITY_MATRIX.md` in the new project with one row per ID in §2 plus any capability you discover in the clone: `ID | decision | Jimmy & Wax feature | tier | status (not started / in progress / done / verified) | evidence (test name, screenshot path, PR) | notes`. A row may be marked **verified** only with evidence you produced (passing test or screenshot from a running build). The final report must quote the matrix totals.
