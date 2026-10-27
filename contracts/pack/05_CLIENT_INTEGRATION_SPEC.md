# 05 — Client integration: what the website and the Flutter app must change

> Part of the Jimmy & Wax dashboard prompt package. A dashboard can only change what the clients are built to read. **Today neither client reads any remote experience configuration.** This file defines the small, additive, fallback-safe changes each client needs so the Experience Studio “integrates flawlessly”.
> **Do not edit the app or website repos from the dashboard session unless the owner explicitly approves a client work package.** These are separate, reviewable changes (each client is large and has its own tests).

## 0. Observed state of the clients (read 2026-10-05)

### Website — `C:\Users\MSI\OneDrive\Desktop\jimmy_nd _wax_website`
* Vite + React (`react: latest`), TypeScript, `motion` v13, `lenis`; **no router library** (hand-written `pushState` in `src/App.tsx`); routes `/`, `/shop`, `/shop/:id`, `/ritual`, `/story`.
* **All content is hard-coded in components**; products in `src/data/products.ts` (3 products, website-local ids `twinkle-shine-bottle|refill|care-kit`, prices ₹499/₹349/₹1,299 labelled “Proposed launch price”); cart in `localStorage` (`jimmy-wax-cart-v1`); **no API calls at all**; no checkout (by design: “disabled rather than inventing commerce facts”).
* Design tokens in `src/styles/tokens.css` (CSS variables); effects: arrival veil, grain overlay, custom cursor, smooth scroll (Lenis, capped).
* Media in `public/media/...` (webp/jpg + many mp4 loops/films).
* Client-rendered SPA ⇒ weak SEO/social-card story for CMS-managed pages (see W5).

### Flutter app — `C:\Users\MSI\OneDrive\Desktop\jimmy&wax_app`
* Navigator-based, one very large `lib/main.dart` (≈209 KB) plus feature folders; repository pattern (`StoreRepository` → `ApiStoreRepository`, already switched from Supabase to the new backend; 50 tests passing as of 2026-10-03).
* **Home is hard-coded** in `HomeScreen`/`HeroBanner`/`BenefitsRow`/`CareRitualSection`/`TestimonialSection`; art is **bundled** under `assets/runtime/*`.
* Theme: `lib/core/theme/{app_colors,app_theme,app_radius,app_spacing}.dart` — `AppColors.*` used **373 times in 16 files**, with **41 `const` sites** that capture colours.
* Location via **Ola Maps** (`lib/core/location/*`); maximum storefront width 520 px; has a `web/` target and a recorded successful release web build (2026-10-05).
* Observed housekeeping issues (report, don’t silently fix): `pubspec.yaml` still lists `supabase_flutter 2.18.0` although no Dart code imports it (only a stale comment in `lib/core/data/catalog.dart` mentions Supabase); the benefits row uses 9-px labels; testimonial stories are owner-supplied **design-reference data, not verified reviews** (the app’s own docs say so).

## 1. Website work package (W1–W8)

| ID | Work | Notes / acceptance |
|---|---|---|
| **W1** | **API data layer.** `VITE_API_ORIGIN`; fetch `/v1/products`, `/v1/categories`, `/v1/store-settings`; map to the UI `Product`; keep today’s `products.ts` as `defaults/` fallback. Website-only product fields (`sequence`, `format`, `ritual`, `story[]`, `motion`, `imageAlt`) move into per-product Studio content (`product:{id}` page docs) — they do **not** belong in the commerce tables. | Prices/stock always from the API. Ids change from website-local to backend ids/slugs: write a one-time mapping and update `localStorage` cart migration. **Blocked by owner question Q1 (which catalogue is real).** |
| **W2** | **Experience provider + block registry.** Fetch `/v1/experience/web` (ETag), cache last-known-good in `localStorage` (versioned), render `pages.home` etc. through a registry `web.* → component`. Extract each component’s inline data into props: `ScrubHero` (already prop-driven), `RitualBlock` (steps, film beats, “ritual-after”), `StoryBlock` (standards, evidence rail, atelier film), `StoriesBlock` (7 reels), `JournalBlock` (3 notes + finale, featured products), `PromoBlock`, closing note, `Footer`, `Nav`/`HomeNav`. | With **defaults** loaded from a bundled `defaults/experience.web.json`, the rendered page must be pixel-identical to today (screenshot diff at 375/768/1024/1440). Unknown/invalid blocks are skipped, never crash. |
| **W3** | **Token injection.** Apply `tokens` as CSS custom properties on `:root` **before first paint** (inline script in `index.html` reading the cached tokens), keep `tokens.css` as the default, keep legacy names as aliases. Fonts via `@font-face` + `font-display: swap`. | No flash of default theme on repeat visits; reduced-motion and focus styles unaffected. |
| **W4** | **Preview mode.** Separate preview origin; `?jw_preview=<token>&embed=1` fetches the **draft** bundle; postMessage bridge per Studio spec §10 (origin allow-list, nonce, schema-validated messages, `data-jw-block` attributes, `jw:rendered` reports). `X-Robots-Tag: noindex`. | Works inside the Studio iframe; never on the production origin. |
| **W5** | **SEO / rendering decision.** A client-rendered SPA cannot give crawlers/social scrapers per-page titles, descriptions and OG images reliably. Options: (a) **prerender key routes on every release** (webhook → build → deploy static HTML), (b) migrate the site to an SSR framework, (c) accept the limitation for launch. **Recommend (a) or (b) if organic search matters — owner question Q6.** | Whatever is chosen, the Studio’s per-page SEO fields must reach the HTML the crawler sees. |
| **W6** | **Commerce hooks (optional, later).** Move the care-list from `localStorage` to the API guest cart (`/v1/guest-carts`) and link out to the app/checkout when web checkout exists. | Out of the dashboard’s scope; listed so the data model stays compatible. |
| **W7** | **Media delivery.** All media from the CDN origin with posters, `preload="metadata"`, mobile variants, lazy loading; CSP `img-src/media-src` allow-lists. | Budgets enforced by Studio validation (`media.too_large`, `perf.many_videos`). |
| **W8** | **Copy truth.** Replace the footer/closing text “Prices shown are proposed launch prices pending approval” by variables or remove once the owner confirms pricing; keep “no unsupported claims”. | Owner-approved wording only. |

## 2. Flutter app work package (A1–A9)

| ID | Work | Notes / acceptance |
|---|---|---|
| **A1** | **`ExperienceRepository`**: `GET /v1/experience/app` with `If-None-Match`, `X-JW-Client: app/<ver>+<build>; caps=…`; disk cache (last-known-good, versioned); parse with a tolerant parser (skip bad blocks); refresh on launch/resume/15 min; **bundled defaults** `assets/defaults/experience.app.json` (generated from the seed); kill-switch (`enabled:false`) ⇒ defaults. | Offline first run shows today’s home. No blank screens. `release.number` monotonic. |
| **A2** | **`AppTokens` migration.** Introduce a `ThemeExtension`/`InheritedWidget` fed by the bundle; turn `AppColors`/`AppRadius`/`AppSpacing` into accessors defaulting to today’s constants; remove `const` where it blocks runtime values (41 sites); build `ThemeData` from tokens and rebuild at the root when tokens change. | **Golden tests before/after** with default tokens must be identical. Do not announce OTA theming until this is merged and verified. Native splash/app icon stay build-time. |
| **A3** | **Data-driven Home.** Split `HomeScreen` into a `BlockList` + registry for `app.*` blocks; give each existing widget (`HeroBanner`, `CategoryShortcut` row, product rail, `BenefitsRow`, `TestimonialSection`, `CareRitualSection`, announcement/banner/rich-text/faq/trust-strip/spacer) a props model. Fix known a11y defect (9-px labels) when touching them. | Defaults reproduce today’s Home exactly (golden at 360/390/412). Per-block error boundary. |
| **A4** | **Navigation/chrome from config**: bottom tabs (labels/icons/visibility; Cart and Profile mandatory), header (deliver-to badge, search placeholder), profile menu items, help/FAQ, global announcement, store-paused message, empty-state & mascot art mapping, in-app splash image (downloaded and used from the **next** launch; first paint always bundled). | Actions limited to the allow-listed `Action` vocabulary; unknown actions are inert and logged. |
| **A5** | **Media loading** with disk cache, bundled fallback per slot, honouring data-saver; use content-addressed URLs and the resolved variant widths. | New dependency choice recorded in an ADR; no remote code or fonts without bundled fallback. |
| **A6** | **Preview flavor (web)**: `--dart-define=PREVIEW=true` build with a fake user-data repository, no location/secure-storage dependency, the postMessage bridge via JS interop, and a `PreviewSelectable` wrapper that outlines blocks and reports selection. QR/deep-link preview **only in internal builds**. | Spike result and decision recorded (Studio spec §10 gate). |
| **A7** | **Version & capability**: send the client header; support app-version control (`/v1/app/version-check`) for soft/force update; new block types must declare `requires.minAppBuild`. | Old builds keep working after the Studio adds new blocks. |
| **A8** | **Tests**: block widget tests, golden tests, shared **contract fixture corpus**, malformed-bundle, offline/first-run, kill-switch, monotonic-release, and a11y checks. | Part of the app’s existing `flutter analyze` + `flutter test` gate. |
| **A9** | **Housekeeping (separate change):** remove the unused `supabase_flutter` dependency; update stale docs/comments. | Only after confirming nothing imports it. |

## 3. Seed extraction (the first release must equal today)

Write a one-off, reviewed **seed extractor** (in the dashboard repo, `tools/seed/`) — never retype copy by hand:
* **Inputs:** app: `lib/main.dart` (`HomeScreen`, `HeroBanner._HeroCampaign` list, `CategoryShortcut` row, `BenefitsRow`, `CategoriesScreen.entries`), `lib/features/home/care_ritual_section.dart` (`_steps`), `lib/features/home/testimonial_section.dart` (`_ReviewData`), `assets/runtime/**`; web: `src/pages/Home.tsx`, `src/components/{RitualBlock,StoryBlock,StoriesBlock,JournalBlock,PromoBlock,Footer,Nav}.tsx`, `src/data/products.ts`, `public/media/**`, `src/styles/tokens.css`.
* **Outputs:** `seed/media-manifest.json` (path, sha256, bytes, dimensions, mime, alt text from source, proposed provenance), `seed/entities/*.json` (care guide, stories, journal notes, testimonials flagged `placeholder`, FAQ), `seed/app.home.json`, `seed/web.home.json`, `seed/tokens.app.json`, `seed/tokens.web.json`, plus `defaults/experience.{app,web}.json` for the clients.
* **Process:** extract → human review (owner confirms provenance/approval of every asset and wording of every claim) → import via the real admin API → **Release 1** per channel → screenshot comparison against the live app/site → record evidence in `docs/build/SEED_REPORT.md`.
* **Known conflicts to present to the owner, not “fix” silently:** catalogue (website vs backend), palettes/fonts (§3.2 of the Studio spec), claims in copy, placeholder testimonials, 9-px labels.

## 4. Contract fixtures (shared corpus)

The backend repo owns `contracts/experience/fixtures/` (valid/invalid documents, bundles, validation reports, preview/bridge messages). Backend, dashboard, website and app all run the same corpus in CI. A fixture change is a contract change (bump the OpenAPI version, update the lock files).

## 5. Rollout and safety (applies to both clients)

1. Ship the client adapters **disabled by default**; defaults = today’s look.
2. Enable for internal builds; publish **Release 1 = seed**; verify no visual diff.
3. Allow edits; every publish is previewed, validated, reversible; **rollback and kill switch rehearsed** (record the rehearsal).
4. Observe: bundle fetch success, fallback-to-defaults count, skipped-block count (diagnostics endpoint is P2). Alert if skipped blocks > 0 after a release.
5. New block types ship **client first**, then become available in the Studio library for clients that advertise the capability.

## 6. Sequencing across the four workstreams

| Time | Backend (B) | Dashboard (D) | Website (W) | App (A) |
|---|---|---|---|---|
| now | — | D0 foundations, D1 ops core on **existing** endpoints | — | — |
| next | B8 platform + catalogue + media | D2 catalogue/media | W1 (after Q1) | — |
| then | B9 Experience API + fixtures | D3–D6 Studio (mock → live) | W2–W4 | A1–A3, A6 |
| then | B10 Shiprocket | D7 Shipping Center | — | A4, A5, A7 |
| then | B11–B12 | D8 customers/analytics/offers | W5 decision, W7 | A8 |
| last | B13 hardening | D9 hardening + docs | W8 | A9 |
Dependencies are one-way: Studio editing can be built and tested with mocks; **customers see changes only after the matching client package ships** — say this plainly in the Studio UI (“This block requires app build ≥ N”).
