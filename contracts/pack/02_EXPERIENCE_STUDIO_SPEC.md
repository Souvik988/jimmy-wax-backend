# 02 — Experience Studio specification

> Part of the Jimmy & Wax dashboard prompt package. This is the feature that matters most: **the owner changes how the mobile app and the website look and what they say — separately, but connected — without a developer and without breaking anything.**
> Single storefront, **no B2B / no audience dimension** (owner decision 2026-10-05).
> Facts below were read from the three codebases on 2026-10-05; anything I did not verify is labelled **(verify)**.

## 1. Purpose, users, principles

**Users**
* **Owner / brand lead** — non-technical; wants to change colours, banners, copy, product storytelling, navigation, seasonal looks, on **both** the app and the website, fast and safely.
* **Designer / content editor** (new role `designer`) — edits drafts; may publish only if granted `experience:publish`.
* **Admin** — everything, including emergency kill switch and rollback.

**Principles (each one must be testable)**
1. **Safe by construction.** Typed blocks, validation, guard-rails, preview, atomic publish, instant rollback, kill switch. A bad edit must be *impossible to publish* or *one click to undo*.
2. **One source of truth for facts.** Prices, MRP, stock, shipping fee, free-shipping threshold, COD fee, GST mode, delivery estimate come from the catalogue/settings via **variables and bindings** — never typed into copy.
3. **Separate but connected.** The app and the website have their own layouts and chrome, but share one Design System, one Content Library and one Release process (§2).
4. **Honest preview.** The preview is the real client wherever possible; where it is an approximation, say so on screen.
5. **Brand truth.** The owner’s own rules are enforced: product pack-shots come from original photography; no invented ratings/reviews; no unsupported claims; generated media goes through an approval gate (§7.1).
6. **Progressive capability.** New block types need new client builds; the server never sends a client a block it cannot render (capability negotiation, §11).
7. **Fast.** Edit → preview < 150 ms; autosave without blocking; publish payload < 256 KB gzip.

## 2. Concepts and the “separate but connected” model

| Concept | Meaning |
|---|---|
| **Channel** | `app` (Flutter customer app) or `web` (the marketing/commerce website). |
| **Design System** | Tokens (colour roles, type, spacing, radius, elevation, motion, component styles, surfaces) + Brand assets. Has a **shared base** and a **per-channel override** layer. |
| **Content Library** | Media, collections, care guides, stories (reels), journal notes, testimonials, FAQs, announcements — shared by both channels. Policies already exist in the backend (`content_pages`). |
| **Document** | A JSON document edited in the Studio: `tokens` overrides, `navigation`, `chrome`, and `pages/{key}` (an ordered list of **blocks**). |
| **Block** | A typed, versioned unit of layout with props, optional style overrides and visibility rules (§4, §6). |
| **Draft workspace** | The editable state per channel. Autosaved on the server with revisions. |
| **Release** | An immutable snapshot of a channel’s documents **plus the resolved content they reference**. Publishing flips the channel’s active pointer. Rollback publishes an older snapshot as a new release. |
| **Campaign overlay** | A scheduled seasonal skin (token overrides + announcement + optional extra hero slide) applied by the server while its window is open. |

**How the two channels stay connected (all required)**
1. **Linked tokens.** Every token in a channel is `inherit` (follows the shared base) or `override`. The UI shows a chain icon; “Unify” converts an override back to inherit. After seeding, the two palettes **differ** (see §3.2) — the Consistency panel shows exactly where and offers one-click unify.
2. **Shared entities by reference.** A block references `careGuide:ritual`, `collection:best-sellers`, `story:*`, `media:*`. Editing the entity changes **both** channels at their next release. Every entity shows an **Impact** list (“used by App › Home › Care ritual; Web › Home › Ritual steps”).
3. **Copy-as-equivalent.** “Copy to Web/App” converts a block to its closest equivalent (table below) and states what was lost. The copy is independent afterwards (no live sync).
4. **Release bundle.** One action can publish app and web together under one release label, and roll back together or separately.
5. **Campaigns span both.** A campaign has an app overlay and a web overlay and one schedule.
6. **Consistency panel.** Lists token divergences (ΔE for colours, font differences), broken links, copy that differs between channels where it is expected to match (brand tagline), and entities with zero usage.

| App block | Closest web block | Lost in conversion |
|---|---|---|
| `app.hero_carousel` | `web.hero_film` (first slide) or `web.image` | carousel, text-in-image flag |
| `app.product_rail` | `web.product_grid` | horizontal scroll, “see all” |
| `app.care_ritual` | `web.ritual_steps` | tabs → stacked steps |
| `app.benefits_row` | `web.standards_grid` | circular photo style |
| `app.testimonials` | `web.testimonials` | swipe carousel |
| `app.announcement_bar`, `app.rich_text`, `app.faq`, `app.spacer` | same-named web blocks | — |

## 3. Design System

### 3.1 Token model (TypeScript; implement as zod 4 schemas; version with `schemaVersion`)

```ts
type Hex = `#${string}`;                      // #RRGGBB or #RRGGBBAA, validated
type MediaId = string;

type ColorRole =
  | 'bg.deep' | 'bg.base' | 'bg.raised' | 'bg.elevated' | 'bg.overlay'
  | 'text.primary' | 'text.secondary' | 'text.muted' | 'text.onAccent'
  | 'border.subtle' | 'border.strong'
  | 'accent.primary' | 'accent.hover' | 'accent.pressed' | 'accent.soft'
  | 'focus.ring'
  | 'state.success' | 'state.warning' | 'state.error' | 'state.info';

interface DesignSystemBase {
  schemaVersion: 1;
  color: {
    roles: Record<ColorRole, Hex>;
    palette: Record<string, Hex>;                          // named brand colours: ink, walnut, leather, gold, kraft, ivory, navy, silver, mist…
    gradients: Record<string, { angle: number; stops: { at: number; color: Hex }[] }>;
  };
  type: {
    families: { display: FontRef; body: FontRef; mono?: FontRef };   // max 2 + mono
    scale: Record<'hero' | 'h1' | 'h2' | 'h3' | 'body' | 'small' | 'label',
      { size: number; lineHeight: number; weight: number; tracking: number; minSize?: number; maxSize?: number }>;
  };
  space: { unit: 4; steps: number[] };                     // e.g. 4,8,12,16,24,32,56,80,120,160
  radius: { frame: number; card: number; control: number; large: number; hero: number; pill: 999 };
  elevation: { raised: ShadowDef; overlay: ShadowDef };
  motion: {
    durations: { fast: number; medium: number; slow: number };       // ms, 100–800
    easings: { standard: Bezier; emphasis: Bezier; curtain: Bezier };
    intensity: 'calm' | 'standard' | 'cinematic';                    // web preset; app maps to page-transition style
    // reduced-motion is NOT a token: clients must always honour the OS setting.
  };
  components: {
    button:   { minHeight: number; shape: 'pill' | 'rounded'; variants: Record<'primary' | 'secondary' | 'ghost', ButtonStyle> };
    card:     { radius: 'card' | 'large'; border: boolean; elevation: 'none' | 'raised' };
    input:    { minHeight: number; radius: 'control'; labelStyle: 'persistent' };
    chip:     { radius: 'pill' | 'control' };
    bottomNav:{ style: 'plain' | 'pill'; activeColor: ColorRole; background: ColorRole; backgroundOpacity: number }; // app
    header:   { background: ColorRole | 'transparent'; blurOnScroll: boolean };
    imageFrame:{ radius: 'frame' | 'card' };
  };
  surfaces: {
    backdrop: { kind: 'image' | 'solid' | 'gradient'; image?: MediaId; tint: Hex; tintOpacity: number };   // app: SurfaceBackdrop (leather photo + warm tint)
    grain:    { enabled: boolean; opacity: number };                                                         // web grain overlay
  };
}

type TokenOverride<T> = { mode: 'inherit' } | { mode: 'override'; value: T };
// A channel override is a deep-partial of DesignSystemBase where each leaf is TokenOverride.
interface CampaignOverlay { campaignId: string; tokens: DeepPartial<DesignSystemBase>; }

// Resolution: resolve(base, channelOverride, activeCampaignOverlay?) → ResolvedTokens  (pure, deterministic, unit-tested)
```

### 3.2 Seed values (what exists today — **verify against source before seeding**)

The two clients currently use **different** palettes. Seed each channel with its own current values as **overrides**, then let the owner unify.

| Role (proposed mapping — confirm) | App today (`lib/core/theme/app_colors.dart`) | Web today (`src/styles/tokens.css`) |
|---|---|---|
| `bg.deep` | `espresso #0B0806` | `--ink #14110E` |
| `bg.base` | `night #120C08` | `--ink-2 #1C1815` |
| `bg.raised` | `surface #18120E` | `--espresso #211C17` |
| `bg.elevated` | `elevated #211811` / `softSurface #2A1E15` | `--walnut #2A1711` |
| `text.primary` | `text #FFF9F1` | `--ivory #F4E9D5` |
| `text.secondary` | `muted #B9ADA0` | `--ivory-dim #D3C4B4` |
| `text.muted` | `subtle #81776D` | `--mist #B2AAA2` |
| `accent.primary` | `gold #E7B54A` | `--gold-soft #E0AD54` (solid buttons) / `--gold #C99534` (kickers) |
| `accent.hover` | `warmGold #F5C968` | `--gold-bright #F3C45B` |
| `accent.soft` | `champagne #F6D98B` | — |
| `focus.ring` | — (Material default) | `--gold-bright #F3C45B` |
| `border.subtle` / `strong` | gold at α .65 on hero frame (ad hoc) | `rgba(244,233,213,.13)` / `.26` |
| `state.success` / `error` | `#62B86A` / `#E65050` | not defined |
| palette extras | `cognac #8A431F`, `mahogany #4A1F12`, `cream #FFF6E8` | `leather #6E301D`, `navy #10234B`, `kraft #B77A36`, `silver #C5C9C8` |

Other current values: web fonts `Playfair Display` (display) + `Inter` (body) in `tokens.css` while `design-system/jimmy-wax/MASTER.md` says `Manrope` — **a drift the owner must resolve**; app uses `Georgia` for display and the platform sans for UI. Web radii 4/10/999; web motion 180/300/560 ms with `cubic-bezier(.16,1,.3,1)`, `(.33,1,.68,1)`, `(.76,0,.24,1)`; app page transitions are cross-fades over a leather backdrop.
**Existing accessibility defects the guard-rails will surface (do not hide them):** the app’s benefits-row labels use `fontSize: 9`; verify contrast of `muted`/`subtle` text on the leather backdrop.

### 3.3 How tokens reach the clients
* **Flutter:** an `AppTokens` object (InheritedWidget/`ThemeExtension`) built from the bundle; `ThemeData` (colorScheme, navigationBarTheme, textTheme) derived from it; `AppColors`/`AppRadius`/`AppSpacing` become *accessors* with the current constants as defaults. **Measured coupling today:** 373 `AppColors.*` usages in 16 files and 41 `const` widgets that capture them — runtime theming requires removing `const` on those paths. Plan it as an incremental migration (`05_CLIENT_INTEGRATION_SPEC.md`); do **not** promise OTA colour changes until it ships.
* **Web:** CSS custom properties generated from tokens and injected into `:root` (emit the existing names as aliases — `--ink`, `--gold`, `--ivory`, … — so current CSS keeps working), fonts via `@font-face` from the CDN with `font-display: swap`, `color-scheme: dark`.
* **Build-time only (cannot change over the air):** app icon, native launch screen, Android adaptive icon, iOS asset catalogue, bundled font files, native permissions. The Studio must label these slots “needs a new app release”.

### 3.4 Guard-rails (validated in the UI instantly and again on the server)
* Contrast (WCAG 2.2 AA): `text.primary`/`text.secondary` on `bg.base`/`bg.raised`/`bg.elevated` ≥ 4.5:1; `text.onAccent` on `accent.primary` ≥ 4.5:1; `focus.ring` against adjacent colours ≥ 3:1; state colours as text ≥ 4.5:1.
* Type: web body ≥ 16 px; app body ≥ 14 sp; any label ≥ 11 sp/px; ≤ 2 font families (+ mono); fonts must be uploaded files with a licence record (woff2 for web; ttf/otf for the app).
* Targets: interactive minimum 44 × 44.
* Motion: durations 100–800 ms; reduced-motion respected always (not editable).
* Palette discipline: gradients may only use palette colours; arbitrary hex allowed in `custom` slots with a warning.
* **Brand lock:** a configurable set of tokens (logo colours, `accent.primary`) can be locked so only `admin` (with MFA) may change them.
* Brand rules shown as guidance (not auto-enforced): no generic blue/purple SaaS gradients, no glassmorphism, no neon; warm key-light photography; product label legibility (taken from the website’s `design-system/jimmy-wax/MASTER.md`).

### 3.5 Brand assets (Design System › Brand)
Slots (each: media reference, recommended size, alt text, build-time vs OTA flag):
* Wordmark (SVG), mark “W” (SVG), favicon set, OG/share image (1200×630), app icon master 1024 (**build-time**), native splash (**build-time**).
* **In-app splash image** (full-bleed product photograph; today `assets/runtime/products/jimmy_wax_splash_scene_v01.jpg`) and **brand surface backdrop** (`assets/runtime/backgrounds/jimmy_wax_brand_surface_v01.jpg`, order-success bokeh).
* **Mascot scenes** (named slots): `welcome`, `otp`, `signed_in`, `order_placed`, `empty_cart`, `empty_orders`, `cheer`.
* **State art** (named slots): `empty_cart`, `empty_wishlist`, `no_orders`, `generic_error`, `no_connection`, `tracking_pending`.
* **Category experience art:** all-products banner, browse hero, per-category art, empty state (today `assets/runtime/category_experience/*`).
Each slot ships with a bundled default in the client; a published override replaces it and a missing/failed download falls back to the bundled one.

### 3.6 Campaign overlays
`Campaign { id, name, window{startAt,endAt (IST)}, app?: { tokens, announcement?, extraHeroSlide? }, web?: { tokens, announcement?, heroHeadlineOverride? } }`. Overlays are part of the release; the API applies those whose window contains *now* (resolved at request time, cacheable per minute). The Studio shows a calendar of windows with overlap detection (overlap = error).

## 4. Documents and the workspace model

```ts
interface DocEnvelope<K extends string, B> {
  id: string; channel: 'app' | 'web' | 'shared'; kind: K; key: string;   // key = page key or fixed name
  rev: number; etag: string; updatedAt: string; updatedBy: string; body: B;
}
// kinds: 'tokens' | 'navigation' | 'chrome' | 'page'
// keys:  app pages  → 'home' | 'category' | 'product' | 'cart'
//        web pages  → 'home' | 'shop' | 'product' | 'ritual' | 'story' | `custom:${slug}` | `product:${productId}` (P1)

interface PageDoc { schemaVersion: 1; title?: string; seo?: Seo /* web only */; blocks: Block[] }

interface Block<T extends BlockType = BlockType> {
  id: string;                    // ULID, stable across edits (enables 3-way merge)
  type: T;                       // 'app.hero_carousel' | 'web.hero_film' | …
  visible: boolean;
  rules?: VisibilityRules;       // §5.4
  style?: BlockStyle;            // token-based only: no raw CSS
  props: PropsOf<T>;             // zod schema per type
  requires?: { minAppBuild?: number; minWebSchema?: number };   // set by the system from the type, not user-editable
}
interface BlockStyle {
  background?: { token: ColorRole } | { palette: string } | { hex: Hex };   // hex only with warning + contrast check
  padding?: 'none' | 'sm' | 'md' | 'lg' | 'xl';
  width?: 'contained' | 'full';
  align?: 'start' | 'center';
  radius?: 'none' | 'frame' | 'card' | 'large';
  divider?: boolean;
  anchorId?: string;             // web: in-page anchor (lowercase, [a-z0-9-])
}
```

Limits (single constants module, **never duplicated** — the reference drifted): app page ≤ 30 blocks, web page ≤ 40; per-type maxima listed in §6; document ≤ 200 KB JSON.

## 5. Shared building blocks

### 5.1 Action (one vocabulary for both channels)
```ts
type Action =
  | { type: 'none' }
  | { type: 'product'; productId: string }
  | { type: 'collection'; slug: string }
  | { type: 'category'; categoryId: string }
  | { type: 'page'; pageKey: string }                           // web custom page or policy slug
  | { type: 'screen'; screen: AppScreen }                       // app only: 'home'|'categories'|'cart'|'orders'|'profile'|'wishlist'|'search'|'addresses'|'care_guide'|'help'|'about'
  | { type: 'route'; path: '/' | '/shop' | '/ritual' | '/story' }  // web only
  | { type: 'anchor'; id: string }                              // web in-page
  | { type: 'url'; url: string; newTab?: boolean }              // https only; blocked-scheme list; rel="noopener noreferrer"
  | { type: 'tel' | 'mailto' | 'whatsapp'; value: string };
```
Client mapping (today): app routes are `Navigator` pushes; the app’s docs say deep-link routes `/orders/{id}` and `/products/{id}` arrive with `go_router`; the website uses its own `pushState` router with `/shop/<id>` — ids there are **website-local** and must be replaced by backend ids/slugs (see §12). The picker searches live catalogue data (debounced, ≥ 2 chars) and shows inactive/out-of-stock targets with a warning.

### 5.2 Variables (facts in copy)
`{{store.shippingFee}}`, `{{store.freeShippingThreshold}}`, `{{store.codFee}}`, `{{store.deliveryEstimate}}`, `{{store.gstRate}}`, `{{store.supportEmail}}`, `{{store.supportPhone}}`, `{{brand.name}}`. Resolved **server-side at request time** from `store_settings`/profile (money formatted as `₹40`, Indian grouping). Unknown variable ⇒ error. Copy containing a currency literal (`₹\s?\d`, `Rs\.?\s?\d`) ⇒ warning “use a variable”. This guarantees the app, the website and checkout can never disagree on shipping/COD/GST wording.

### 5.3 MediaRef
```ts
interface MediaRef { mediaId: MediaId; alt?: string; decorative?: boolean; focal?: { x: number; y: number }; fit?: 'cover' | 'contain' }
// Resolved in bundles to: { url, width, height, blurhash?, alt, variants: {w: number; url: string}[], bundledFallback?: string }
```
`alt` is required unless `decorative`. Media URLs are **content-addressed** (hash in the path) so a release snapshot is immutable even if the asset is later replaced.

### 5.4 Visibility rules
```ts
interface VisibilityRules {
  schedule?: { startAt?: string; endAt?: string };              // ISO, IST in the UI
  platforms?: ('ios' | 'android' | 'web')[];
  appBuild?: { min?: number; max?: number };
  auth?: 'any' | 'signed_out' | 'signed_in';
  storePaused?: 'any' | 'only_when_paused' | 'hide_when_paused';
}
```
No business-type/“audience” field exists. Segments (VIP etc.) are P2 and, if added, are customer segments — never B2B.

## 6. Block libraries

### 6.1 App blocks (`app.*`) — P0 unless stated

| Type | Props (essentials) | Limits | Notes |
|---|---|---|---|
| `app.hero_carousel` | `slides[{id, image: MediaRef, headline?, subhead?, textInImage: boolean, action: Action, a11yLabel}]`, `aspectRatio` (default `3:2`), `autoplay{enabled, intervalMs ≥ 3000}`, `dots: boolean`, `frame{radius token, border colour token}` | 1–8 slides; ≤ 2 per page | Today: 4 slides, 3:2, gold hairline frame, art carries its own headline (`textInImage: true`). If `textInImage` is false, the client overlays text with a scrim — check contrast. |
| `app.category_shortcuts` | `items[{icon: MediaRef, label, action}]`, `ringStyle: 'gold_ring'\|'plain'`, `columns: 3–5` | 3–5 items | Today: Polish, Care Kits, Accessories, Gift Pack, all open the Categories tab. |
| `app.product_rail` | `title`, `seeAll: Action?`, `source: {kind: 'collection'\|'category'\|'manual'\|'bestsellers'\|'newest', ref?, productIds?}`, `limit ≤ 24`, `card: 'standard'\|'compact'` | ≤ 6 per page | Today: “Best Sellers”, first 3 products. Empty/sparse (<3) ⇒ warning. |
| `app.benefits_row` | `title?`, `items[{image: MediaRef, label}]` | 3–5 items | Today: 4 round photo benefits. Label ≥ 11 sp enforced. |
| `app.testimonials` | `mode: 'verified_reviews'\|'curated'`, `items[{avatar?, name, city?, quote, rating, source: 'verified_review'\|'owner_supplied'\|'placeholder', consent?}]`, `heroImage?: MediaRef` | ≤ 8 | **`placeholder` cannot be published** (today’s app stories are “design-reference data rather than verified reviews” — per its own docs). `owner_supplied` requires a recorded consent note. |
| `app.care_ritual` | `guide: careGuideRef`, `cta: Action`, `secondaryCta?: Action` | 1 | Today: Clean / Apply / Buff + “Shop care” and the four-step guide. |
| `app.promo_cards` | `cards[{image: MediaRef, headline?, ctaLabel, action}]` | ≤ 6 | A `PromoCard` widget exists; today’s Home does not render it (**verify**). |
| `app.announcement_bar` | `text`, `action?`, `tone: 'info'\|'promo'\|'warning'`, `dismissible` | ≤ 1 visible | Variables allowed. |
| `app.banner` | `image: MediaRef`, `action`, `aspectRatio`, `radius` | ≤ 10 | Single image banner. |
| `app.rich_text` | `markdown` (sanitised subset) | ≤ 10 | |
| `app.faq` | `items[{q, aMarkdown}]` or `faqGroup` ref | ≤ 3 | |
| `app.trust_strip` | `items[{icon: preset, label}]` | 3–4 | Labels may use variables (“Free shipping over {{store.freeShippingThreshold}}”). |
| `app.spacer` | `height` 8–64 | ≤ 10 | |
| `app.video_banner`, `app.popup`, `app.countdown` | — | — | **P1/P2**, need new client code. |

**App pages**
* `home` — any block above.
* `category` (landing template for the existing “category experience”) — `banner`, `rich_text`, `product_rail`, `faq`; category art/names come from the catalogue.
* `product` (PDP template) — the Studio controls **order and visibility of native sections** (gallery, description, key benefits, suitable surfaces, box contents, product info card, delivery estimate, reviews, related products, “frequently bought together/care-kit pairings”) and may add `rich_text`/`banner`/`faq`/`trust_strip`. Product data itself is edited in the Catalogue module.
* `cart` — optional `announcement_bar`, `trust_strip`, upsell `product_rail`.

**App chrome (`chrome` doc)**: bottom tabs (3–5; `home`, `categories`, `cart`, `orders`, `profile` + optional one custom slot; each label/icon/visibility; `cart` and `profile` mandatory), header (deliver-to badge visible?, search placeholder text), splash (in-app image, wordmark treatment), profile menu (items with label/icon/action/section; legal links resolve to policy pages), help & support entries (FAQ group, support email/phone/WhatsApp), global announcement, store-paused message, **empty-state and mascot art mapping** (§3.5).

### 6.2 Web blocks (`web.*`) — P0 unless stated
Derived from the current site (`src/pages/Home.tsx`, `src/components/*`). Motion is **preset-based**: the Studio chooses *content, order, parameters and presets*; it does not author arbitrary animation.

| Type | Props (essentials) | Notes (today’s content) |
|---|---|---|
| `web.hero_film` | `kicker`, `headline` (line breaks), `subhead`, `film{desktop: MediaRef(video), mobile: MediaRef(video, 9:16 required), poster: MediaRef}`, `scrubScroll` 1–4, `ctas[{label, action, variant}]` | “Every finish has a final gesture.”; scroll-scrubbed hero film. Poster required; mobile variant required (the design system forbids silently cropping the desktop cut). |
| `web.marquee` | `items[]` (4–12) | “The finishing touch · Leather · Ritual · Light”. |
| `web.chapter_mark` | `index`, `title` | “01 The Collection”… |
| `web.collection_grid` | `kicker`, `headline`, `subhead`, `source` (collection or manual), `cardStyle: 'tilt'\|'plain'`, `hoverFilm: boolean` | Product cards pull name/price/image from the catalogue; hover film is optional media per product. |
| `web.ritual_steps` | `kicker`, `headline`, `subhead`, `guide: careGuideRef` **or** `steps[{n,title,body,image,alt}]` | Brush · Apply · Reveal (shares the Care Guide entity with the app). |
| `web.scrub_film` | `film`, `poster`, `beats[{title, body}]` (2–5) | Scroll-scrubbed ritual film. |
| `web.media_split` | `media (image\|video, poster)`, `kicker`, `headline`, `body`, `cta`, `mediaSide: 'left'\|'right'` | “Made to be used, not displayed.” |
| `web.standards_grid` | `kicker`, `headline`, `subhead`, `items[{n,title,body,image,alt}]` (3–4) | “Material first / Product truth / Light, not noise”. |
| `web.evidence_rail` | `kicker`, `headline`, `items[{image, caption, alt}]` (4–10) | Scroll-driven horizontal rail. |
| `web.atelier_film` | `film`, `poster`, `kicker`, `headlineLines[]` | “Inside the atelier”. |
| `web.reels_rail` | `title?`, `reels: storyRef[]` | 7 vertical reels; plays on hover only; reduced-motion ⇒ grid + click-to-play. |
| `web.journal_stack` | `notes: journalRef[]`, `finale{kicker,title,excerpt,image,alt}` | Each note carries a featured product with working add-to-cart. |
| `web.promo_film` | `kicker`, `headlineLines[]`, `video`, `poster`, `caption` | Narrated promo with controls; never autoplays with sound. |
| `web.closing_cta` | `kicker`, `headlineLines[]`, `ctas[]`, `media`, `caption`, `footnote` | Closing frame. |
| `web.testimonials`, `web.rich_text`, `web.image`, `web.product_grid`, `web.faq`, `web.announcement_bar`, `web.spacer` | as app equivalents | `testimonials` obeys the same source rules. |
| `web.newsletter`, `web.video_gallery`, `web.size_guide` | — | **P2**. |

**Web pages**: `home` (the one-page scroll above, in this order: hero, marquee, collection, ritual, standards+evidence+atelier, stories, journal, promo, closing), `shop`, `product` (template: gallery + purchase panel from catalogue, then story/ritual blocks), `ritual`, `story`, `custom:{slug}` (P1), and policy pages from `/v1/content/*`.
**Web chrome**: nav (brand wordmark/“W” mark, links, cart label — today “Care list”), footer (tagline, link columns, bottom-left/right text — note today’s “Prices shown are proposed launch prices pending approval” must be variable-driven or removed once prices are confirmed), announcement bar, **arrival veil** (enabled, mark, name, subline, duration), effects (`grain`, `cursor`, `smoothScroll` with speed cap), SEO defaults (title template, description, OG image), consent banner copy (P1), analytics IDs (P1), redirects (P1).
**SEO per page**: title, description (50–160 chars), canonical, `noindex`, OG image, structured data toggles (Organization, Product, BreadcrumbList). Titles must be unique.

## 7. Content library

### 7.1 Media
* **Upload & processing (server):** images → WebP/AVIF variants (sharp), EXIF stripped, `blurhash`; videos → H.264 MP4 (+ optional WebM), poster required, mobile 9:16 variant tracked; fonts → woff2/ttf/otf with licence metadata; hash-addressed immutable URLs; antivirus/type sniffing; size caps. (Video transcoding and CDN need backend work — see `03_BACKEND_CONTRACT.md`.)
* **Fields:** `alt` (default), `decorative`, `focal`, `tags`, folder, **`provenance`** (`original_photo | edited_photo | generated | illustration`), **`approval`** (`draft | approved | rejected`, reviewer, note), `role` (e.g. `product_packshot`), usage list (computed).
* **Approval gate (the owner’s “generate → review → add” rule):** only `approved` media can be referenced by a **published** release (error `ref.media_unapproved`). `role: product_packshot` requires provenance `original_photo|edited_photo`. Approving `generated` media requires ticking “does not alter product packaging/label”.
* **Safety:** cannot delete media referenced by any release; “archive” hides it from pickers. Replace-file creates a new content-addressed asset and re-validates drafts that use it.
* **UI:** grid/list, search, tag/folder filters, bulk upload with progress, per-file status (processing/ready/failed), usage drawer, recommended-size hints when picking for a slot, focal-point editor, “find unused”.

### 7.2 Entities (shared by both channels)
| Entity | Fields (essentials) | Used by |
|---|---|---|
| **Collection** | slug, name, description, `kind: manual\|smart`, manual ordered `productIds` or rule `{categoryIds?, tags?, inStockOnly?, sort}`, visible | product rails/grids, nav |
| **Care Guide** | key, title, intro, `steps[{label,title,body,image,alt}]` (3–6), cta | `app.care_ritual`, app care-guide screen, `web.ritual_steps` |
| **Story (reel)** | title, line, video, poster, alt, optional product link, order, status | `web.reels_rail`, app (later) |
| **Journal note** | slug, kicker, readMinutes, title, excerpt, image, alt, `bodyMd`, featured product, status, publishedAt | `web.journal_stack`, journal page (P1) |
| **Testimonial** | name, city?, avatar?, quote, rating 1–5, **`source`**, consent `{recordedAt, note}`, status | testimonial blocks |
| **FAQ group** | questions[{q,aMd}] | faq blocks, help screen |
| **Announcement** | text, action, tone, schedule, channels | announcement bars |
| **Policy page** | existing backend `content_pages` (terms, privacy-policy, refund-and-return-policy, shipping-policy, care-guide), Markdown, versioned, published separately | footer/profile links |

**Release semantics:** a release embeds the *resolved* content of every entity it references. Therefore customers see a change only when a release is published (clear UI copy: “Draft content isn’t live until you publish”). Operational facts (prices, stock, shipping/COD/GST settings, product data) are **live** and are labelled “Live” in the UI.

## 8. Authoring UX

**Shell**
* **Top bar:** channel switch `App | Web`; page picker; device picker (App: 360×740, 390×844, 412×915, tablet 768×1024 inside the app’s 520 px shell; Web: 375, 768, 1024, 1440); zoom; undo/redo; save state (“Saved 12:03”, “Saving…”, “Offline — changes kept locally”); **Issues** count (opens panel); **Preview** (share link + QR); **Publish…**.
* **Left:** Layers (block tree with icons, visibility, lock, drag handle, duplicate, delete), plus entries for Navigation, Chrome, Design System.
* **Centre:** canvas (§10) with selection/hover overlays and insertion slots.
* **Right:** tabs **Library | Properties | Issues | Impact**. Properties tabs: Content · Style · Data · Visibility · Accessibility.
* **Bottom:** release timeline (live, scheduled, previous) with quick rollback.
* Below 1024 px wide: show “Use a larger screen to edit layouts” (read-only Layers + Issues are allowed).

**Interaction rules**
* Add by drag from Library to an insertion slot, drop onto a block (insert before), or “Add” (append). Reorder by drag or Alt+↑/↓. Duplicate (Cmd/Ctrl+D), delete (Del, with undo toast), hide/show, multi-select for bulk visibility/delete.
* Click-to-select in the canvas **and** in Layers; hover sync. Chrome regions (bottom tabs, header, nav, footer, announcement) are selectable too.
* Property forms are **generated from the block’s zod schema** with UI hints (`color`, `media`, `action`, `richtext`, `range`, `select`, `list`) plus hand-built editors for rich blocks (hero carousel, mosaic-like grids). Every image slot shows recommended size/ratio and warns on a > 8 % mismatch, shows alt requirement, provenance/approval status.
* **Undo/redo** per document (≥ 100 steps), Cmd/Ctrl+Z / Shift+Z. **Keyboard parity:** everything doable by mouse is doable by keyboard (dnd-kit KeyboardSensor, ARIA live announcements, visible focus, roving tabindex in Layers).
* **Autosave:** debounce 1.5 s → `PUT` with `If-Match`; a local crash buffer mirrors the draft; on reload, if the buffer is newer than the server draft, offer restore.
* **Collaboration (advisory):** presence heartbeat shows who else is editing a page; on `409 ETAG_MISMATCH` the Studio performs a **block-level 3-way merge** (base = last-loaded rev, theirs = server, mine = local, keyed by block `id`). Non-overlapping edits merge silently with a toast; overlapping edits open a per-block “keep mine / take theirs” dialog.
* **Diff view:** “Changes since published” in human terms (“Hero slide 2: image changed; Care ritual: hidden; Accent colour #E0AD54 → #C99534”).
* **Starter layouts:** Studio ships the **seeded current layouts** (§12) and a few presets (Launch, Festival, Minimal). “Replace layout” always asks for confirmation and is undoable.

## 9. Publishing

### 9.1 Validation pipeline (same rules run client-side for instant feedback and server-side as the authority)
`schema → references (media/products/collections/pages exist, active, approved) → policy (limits, a11y, claims, tokens, SEO) → capability (client versions)`. Output: `ValidationReport { errors[], warnings[], infos[] }`; each issue `{ code, docKey, blockId?, path, message, fixHint }`; **errors block publish**.

**Rule catalogue (stable codes; extend, don’t rename)**
* *Errors:* `schema.invalid`, `page.all_hidden`, `page.over_limit`, `block.over_limit`, `ref.media_missing`, `ref.media_unapproved`, `ref.media_processing`, `ref.product_missing`, `ref.product_inactive`, `ref.collection_missing`, `ref.link_invalid`, `ref.link_scheme_blocked`, `a11y.alt_missing`, `a11y.contrast_fail`, `a11y.target_too_small`, `a11y.font_too_small`, `a11y.multiple_h1` (web), `var.unknown`, `testimonial.placeholder`, `testimonial.no_consent`, `token.invalid_hex`, `token.locked_changed`, `video.poster_missing`, `video.mobile_variant_missing`, `seo.title_missing`, `seo.title_duplicate`, `seo.description_length`, `nav.min_tabs`, `nav.required_missing`, `text.too_long`, `capability.requires_newer_client` (blocks that need a newer client are held back, see §11 — reported as error only if the page would be empty).
* *Warnings:* `copy.price_literal`, `copy.claim_unsubstantiated` (configurable word list: certified, guaranteed, 100 %, best, waterproof, dermatologically…), `media.aspect_mismatch`, `media.too_large`, `media.low_resolution`, `binding.rail_empty`, `binding.rail_sparse`, `perf.page_weight`, `perf.many_videos`, `schedule.in_past`, `schedule.overlap`, `link.target_out_of_stock`.
* *Info:* `block.possible_duplicate`, `channel.token_diverged`, `entity.unused`.

### 9.2 Release lifecycle
* Draft docs: `rev` increments on every save; saves use `If-Match`; the server rejects stale writes with `409`.
* **Create release** `{ channels: ['app'|'web'…], label, note, scheduledAt? }` → server validates → on success, in **one transaction** snapshots all documents + resolved entities + resolved media URLs and (if not scheduled) flips the active pointer. Idempotent via `Idempotency-Key`.
* Statuses: `scheduled → live → superseded`; terminal: `cancelled`, `failed`. Scheduled activation is performed by a worker (±60 s) and audited.
* **Rollback** = create a new release from an older snapshot (so history stays linear and the “release number” is monotonic). Requires a reason and MFA.
* **Kill switch** per channel: `enabled=false` ⇒ API returns `{ enabled: false }`; clients use bundled defaults. Admin + MFA, audited, prominent banner in the Studio until cleared by a new release.
* Releases are **immutable**; any attempt to modify one is rejected.
* **Audit events:** `experience.draft.save`, `experience.release.create|schedule|cancel|activate|rollback`, `experience.kill.on|off`, `designsystem.update`, `media.upload|approve|reject|archive`, `content.entity.*`.
* **Permissions:** `experience:read` (view), `experience:write` (edit drafts), `experience:publish` (create release; **MFA required**), `media:write`, kill switch & brand-lock changes = `admin` + MFA.

### 9.3 Release UX
Publish dialog = checklist result, human-readable change summary (diff vs live), target channels (default both), publish now / schedule, optional note. After publishing: “Live” badge, link to the release, **one-click rollback** in the timeline. A failed activation shows the cause and leaves the previous release live.

## 10. Preview architecture (decision gate at D6)

* **Web preview (real site):** the website runs a **preview mode** on a separate origin (`preview.<domain>`, `X-Robots-Tag: noindex`), loaded in an iframe with `?jw_preview=<token>&embed=1`. It fetches the **draft bundle** with the preview token and listens for postMessage updates.
* **App preview (real app):** build the Flutter app’s **web target** in a `preview` flavor (fake user-data repository, no location/secure-storage dependencies), hosted on `preview.<domain>/app`, shown inside a device frame. Same bridge. *Spike first* — the app repo has a `web/` target and its own QA log (`docs/qa/TESTIMONIAL_QA.md`, 2026-10-05) records a successful release Flutter web build and live Home inspection at 390 and 360 px; **verify** it still builds. If the spike is unstable or takes > 3 working days, fall back to **React replicas** of the P0 app blocks and label the canvas **“Approximate preview — verify on a device”**.
* **Bridge protocol (v1, JSON, versioned):** host→frame `jw:hello{nonce}`; frame→host `jw:ready{nonce, client{channel, build, caps}}`; host→frame `jw:doc{pageKey, bundle}` (full) or `jw:patch{ops: JSON Patch[]}` (unsaved edits); frame→host `jw:select{blockId}`, `jw:hover{blockId}`, `jw:rendered{height, unsupported:[{blockId,type}], errors:[{blockId,message}]}`, `jw:navigate{pageKey}`. Origin allow-list on both sides; nonce handshake; messages validated by schema; frame never receives real customer data.
* **Selection overlays:** web blocks carry `data-jw-block="<id>"`; the Flutter preview flavor wraps blocks in a `PreviewSelectable` that draws the outline and reports taps.
* **Tokens & campaigns:** preview can simulate a campaign window (“preview as of <date>”) and **signed-in vs signed-out**, **store paused**, **first-run** states.
* **Share & device test:** short-lived (≤ 24 h) read-only preview links; QR for the website; for the app a QR/deep link works **only in internal/debug builds** (never production). Tokens are scoped to a channel and revocable; preview responses are `no-store`.
* **If the website's preview mode (client package W4) has not shipped when you reach D6,** the web canvas uses simplified, static React replicas of the web blocks (no scroll-scrub or motion) and is labelled **“Approximate preview”** exactly like the app fallback.
* **Honest limits to show:** native splash/icon/fonts, haptics, OS text scaling, and notches are not reproduced by any web preview.

## 11. Client consumption contract (what the app and website must implement)

`GET /v1/experience/{channel}` (public, cacheable) → `ExperienceBundle` or `304`.
* Request headers: `X-JW-Client: app/<semver>+<build>; caps=<csv>` or `web/<buildhash>`; `If-None-Match`.
* Response headers: `ETag`, `Cache-Control: public, max-age=60, stale-while-revalidate=300` (published) / `no-store` (preview).

```ts
interface ExperienceBundle {
  schemaVersion: 1; channel: 'app' | 'web';
  enabled: boolean;                               // false ⇒ kill switch: use bundled defaults
  release: { id: string; number: number; publishedAt: string };
  tokens: ResolvedTokens;                         // shared + channel override + active campaign overlay
  navigation: Navigation; chrome: AppChrome | WebChrome;
  pages: Record<string, PageDoc>;                 // blocks the client cannot render are already filtered out
  content: { careGuides: Record<string, CareGuide>; faqs?: Record<string, FaqGroup>; announcements: Announcement[]; testimonials?: Testimonial[] };
  media: Record<MediaId, ResolvedMedia>;
  variables: Record<string, string>;              // already substituted into text; kept for diagnostics
  minClient: { appBuild?: number; webSchema?: number };
  generatedAt: string;
}
```
Rules:
1. **Capability negotiation.** The server omits blocks whose `requires` exceeds the client and reports `held_back` counts in a diagnostics field; old clients keep working.
2. **Client resilience.** Validate with the generated schema; an invalid **block** is skipped (and logged), an invalid **bundle** falls back to the **last-known-good cache**, then to **bundled defaults** (`defaults/experience.<channel>.json` — generated from the seed so “first release = today’s look”). Never show a blank screen.
3. **Monotonicity.** Apply a bundle only if `release.number ≥` cached, or if `enabled=false`.
4. **Refresh.** App: launch, resume, every 15 min while foregrounded. Web: on load; no polling.
5. **Security.** Content is data, never code: strings are rendered as text; Markdown through an allow-list sanitiser (p, br, strong, em, ul/ol/li, h2–h4, blockquote, hr, a[https|mailto|tel]); URLs allow-listed; media only from the CDN origin; no HTML/CSS/JS in documents; web CSP `img-src/media-src` restricted; preview origin isolated.
6. **Size.** ≤ 256 KB gzip; large lists (journal) paginate via their own endpoints.
7. **Contract tests.** A shared corpus of valid/invalid documents and bundles lives in the backend repo (`contracts/experience/fixtures/*.json`); the backend, the dashboard and both clients run the same corpus in CI.

## 12. Seed content (the first release must reproduce today’s look)

Do **not** hand-retype copy. Write a reviewed one-off **seed extractor** that reads the two source trees and emits `seed/app.home.json`, `seed/web.home.json`, `seed/media-manifest.json` (every referenced file with sha256, dimensions, alt text from the source, provenance `original_photo|generated` to be confirmed by the owner). Then import media, create entities, and create **Release 1** for each channel. Acceptance: screenshots of the seeded Studio preview match the live app/site (visual diff within tolerance).

**App Home today (`lib/main.dart` `HomeScreen`)** — header (deliver-to badge + cart icon), search field, hero carousel (4 slides: *Shine That Lasts*, *Complete Leather Care*, *Restore. Protect. Shine.*, *Premium Care For Every Step*; images `assets/runtime/banners/jimmy_wax_home_hero_*`), category shortcuts (4), “Best Sellers” rail, “Why JIMMY WAX” benefits (4), testimonials (design-reference stories — **placeholder**), care ritual (Clean/Apply/Buff). Other bundled art: promo banners (3), category cards (4), category-experience art, mascot scenes, state art, splash scene, brand surface.
**Web Home today** — see §6.2 order. Media under `public/media/{generated/video/desktop,generated/video/commerce,generated/products,products/story}`; 7 reels; 3 journal notes + finale; 3 products (website-local ids).
**Known content conflicts to surface (not silently fix):**
* Website products (Twinkle Shine bottle ₹499, refill ₹349, care kit ₹1,299, marked “proposed launch price”) **differ** from the backend/app catalogue (Leather Polish ₹299, Polish+Cloth Kit ₹499, Complete Care Kit ₹799, Black Shoe Care ₹399 — owner-confirmed). The Studio must read products from the API; the owner decides the real launch catalogue (open question Q1 in the master prompt).
* Palette and font differences (§3.2).
* Claims in copy (“Cleans · Nourishes · Long-lasting shine · Premium care”, “Premium shine”, “Protects leather”) → will raise `copy.claim_unsubstantiated` until the owner records evidence.

## 13. Acceptance criteria (each needs an automated test or a recorded manual script)
1. Changing `accent.primary` updates the live preview < 1 s; after publish a client with the adapter shows it on its next fetch; rollback restores the previous value.
2. A token pair failing contrast cannot be published; the issue links to the token.
3. Reordering, adding, hiding, duplicating and deleting blocks works with the keyboard alone; screen-reader announcements verified.
4. Missing alt text, unapproved media, a `placeholder` testimonial, an unknown variable, or a non-https URL each block publish with a deep-linked issue.
5. Two editors changing different blocks of one page merge automatically; changing the same block raises the per-block conflict dialog.
6. A published release cannot be modified (API returns an error); rollback creates a new, higher-numbered release.
7. Scheduled release activates within 60 s of its time (fake-clock integration test) and is audited.
8. Kill switch: bundle returns `enabled:false` within the cache TTL; app/web contract tests prove fallback to bundled defaults.
9. Capability negotiation: a client advertising an old build never receives a newer block type.
10. XSS corpus (script tags, `javascript:` URLs, SVG payloads, markdown HTML, oversized strings) never executes in the preview, the Studio, or the clients.
11. Preview tokens expire, are scoped to one channel, are `no-store`, and cannot read production data.
12. Seeded Release 1 visually matches today’s app/site (screenshot diff) and all seeded media is approved with alt text.
13. Variables resolve identically in Studio preview, the bundle, and the clients; changing the shipping fee in Settings changes the text without a release.
14. Zero axe “serious/critical” violations on every Studio route in light and dark; the Studio is fully keyboard operable.
15. Editing latency budget met on the seeded Home page (typing < 50 ms, canvas update < 150 ms) on a mid-range laptop.
