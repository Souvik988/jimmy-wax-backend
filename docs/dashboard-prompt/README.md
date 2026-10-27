# Jimmy & Wax dashboard — prompt package (2026-10-05)

A complete brief for building the **operator dashboard + Experience Studio** as a **separate project**, integrated with the existing backend, the Flutter app and the website.

| File | What it is |
|---|---|
| `00_MASTER_PROMPT.md` | **The prompt to paste.** Role, rules, scope, architecture, security, UX standards, phases D0–D9 with exit evidence, owner questions, first actions, report format. |
| `01_REFERENCE_ANALYSIS_BAKALOO.md` | What the Bakaloo dashboard actually does (113 routes analysed by structure; theme/section builder, banners, nav, branding, versions, RBAC read in depth), with a keep / adapt / replace / later / drop decision and an ID per capability (the parity checklist), plus the defects not to copy. **B2B is excluded.** |
| `02_EXPERIENCE_STUDIO_SPEC.md` | The heart: shared Design System + per-channel overrides, App Builder, Website Builder, content library, blocks, validation rules, releases/rollback/kill switch, preview architecture, client contract, seed content, acceptance tests. |
| `03_BACKEND_CONTRACT.md` | What exists in the backend **today** (verified), what is **missing** (proposed endpoints/tables/permissions), backend phases B8–B13, mock rules. |
| `04_SHIPROCKET_SPEC.md` | Shiprocket integration + Shipping Center UI. Separates what was verified from official docs from what must still be verified. |
| `05_CLIENT_INTEGRATION_SPEC.md` | The additive, fallback-safe changes the website (W1–W8) and the app (A1–A9) need so the Studio can actually change them. |

## How to use
1. Create an empty folder `jimmy-wax-dashboard` and copy this whole folder into it as `docs/spec/`.
2. Open Claude Code there; add the three repos as working directories (backend, app, website — paths are in the master prompt).
3. Paste: *“Read `docs/spec/00_MASTER_PROMPT.md` and execute it. Read every file it references before writing code.”*

## Decisions made on your behalf (tell me to change any)
* **No B2B anywhere**; single storefront; no multi-shop, riders, wallet, gamification, WhatsApp CRM.
* New **Next.js 16** app on **:3200**, **BFF** session (no tokens in the browser), supersedes the minimal console in `backend/apps/admin`.
* The Studio edits **typed blocks and tokens**, never raw HTML/CSS/JS; publishing is **atomic with rollback and a kill switch**.
* **Facts (prices, shipping, COD fee, GST) are variables**, never typed into copy.
* The app and website palettes are different today; the Studio surfaces that and lets you unify.
* Testimonials in the app are design-reference data → the Studio **blocks publishing them as real** unless sourced and consented.
* Preview: real website + Flutter-web preview where feasible, with an honest fallback label.

## Honest caveats
* The backend does **not** yet have most endpoints the Studio, catalogue/media, customers, coupons, analytics or Shiprocket modules need. They are proposals in `03`/`04`; implementing them is backend phases **B8–B13**. Until then the dashboard builds against a mock and cannot be marked “verified” for those modules.
* **Neither client reads remote configuration today.** Changing the app/website from the dashboard needs the client packages in `05` (the app’s colour theming in particular is a real refactor: 373 `AppColors` usages, 41 `const` sites).
* Reference analysis depth: builder, banners, nav, branding, versions, flags, RBAC, API client, sidebar, and many type files were read in detail; WhatsApp CRM, POS, procurement, HQ and most list-page internals were classified from names/guides only (stated in file 01 §0).
* Shiprocket: only the helpsheet-documented flow and a third-party webhook sample are verified; their API docs site returned HTTP 502 when checked. Everything else is in a verification checklist.
* Nothing here has been built or run yet. This package is a plan with evidence-backed facts, not a result.
