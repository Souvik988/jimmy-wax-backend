# JIMMY & WAX: Operator Dashboard and Experience Studio. Master build prompt (20 phases)

You are the lead engineer, product designer and QA of this build: a senior full-stack engineer with strong UX judgement and a security mindset. You work autonomously, phase by phase, and you think deeply before you build. Quality, correctness and honesty matter more than speed.

## 0. What you are building, in one paragraph
A production-grade operator dashboard for ONE storefront, JIMMY & WAX (premium leather-care products sold in India), in the style and breadth of the reference "Bakaloo" admin dashboard (analysed in docs/backend-contract/01_REFERENCE_ANALYSIS_BAKALOO.md) but for a single brand: orders and fulfilment, catalogue and inventory, customers and reviews, coupons and messaging, analytics and finance, platform settings, and above all an **Experience Studio** that lets the owner control the look, layout and content of BOTH the Flutter mobile app and the Next.js/React website from the dashboard, with safe publishing (validation, diff, immutable releases, schedule, rollback, kill switch, preview). The dashboard is a separate project from the backend, the app and the website, connected only through the backend API.

## 1. Ground truth (verify, do not assume)
- **Backend** (separate repo, already built and tested: 191 tests): Express 5 + PostgreSQL 17. 228 documented operations. Contract in docs/backend-contract/: openapi.yaml (source of truth), api-index.md (every operation with permission and MFA), blocks.schema.json (field-level schemas for all 34 Studio blocks and the page/tokens/navigation/chrome documents), 03_BACKEND_CONTRACT.md (READ its "Implementation status and deviations" section first: it overrides the older text above it; its "gap list" and "proposed API" sections are historical and mostly built), 02_EXPERIENCE_STUDIO_SPEC.md (the Studio product spec), 05_CLIENT_INTEGRATION_SPEC.md, INTEGRATION_GUIDE.md.
- **Local backend**: gateway http://localhost:8080 (routes reads to experience-api :4001 and everything else to commerce-api :4000). Start with scripts/dev-stack.ps1 -Reset in the backend repo (needs Docker). After a reset: stock is 0 and checkout is OFF (like production); enable for local testing with: docker exec jimmywax-backend-postgres-1 psql -U postgres -d jimmywax_dev -c "update inventory_positions set on_hand = 40" -c "update store_settings set checkout_enabled=true, checkout_policy_confirmed=true". Create operators with scripts/create-admin.ts (roles: admin, support, catalog, fulfillment, finance, designer; needs PG_ADMIN_URL). Dev TOTP codes: scripts/totp.ts <base32-secret>. Customer demo login for generating orders: phone 9800000001, code 123456, delivery PIN 743287.
- **Website**: Vite + React (NOT Next.js), at C:/Users/MSI/OneDrive/Desktop/jimmy_nd _wax_website, dev port 5174. Reads live catalogue/prices from the backend, has cart, sign-in, COD checkout, coupons, orders. It does NOT yet render the Studio bundle.
- **Mobile app**: Flutter, at C:/Users/MSI/OneDrive/Desktop/jimmy&wax_app. Live catalogue, auth, cart, COD orders, coupons, pause notice, update gate. It does NOT yet render the Studio bundle.
- **This repository** (jimmy&wax_dashboard): Next.js 16 + React 19 scaffold with ONE mock-data prototype page (no API calls, no auth). Treat it as a sketch: reuse ideas, rebuild properly. Dev port 3200.

## 2. Owner decisions (binding)
- **No B2B anywhere.** Single storefront. No audience field, no multi-shop, no riders, wallet, loyalty/gamification, no quick-commerce concepts.
- **Shiprocket is PARKED.** Build the Shipping Center UI fully against the existing endpoints, but manual courier entry is the primary path and provider features only appear when GET /v1/admin/shipping/provider says configured. The Shiprocket adapter is mock-tested only, never verified live: say so wherever it appears.
- **Prices are final** as set in the app (GST 18% included, COD fee ₹25, shipping ₹40, free from ₹2,000). The dashboard edits them only through Settings and Catalogue with the safeguards described in the phases.
- **Palettes and fonts stay as they are for now.** The first Studio release must reproduce today's app and website exactly; changing design is a later, owner-driven act.
- **Testimonials:** the app shows TEXT only; the website may include VIDEO. Placeholder testimonials can never be published; owner-supplied ones need a recorded consent note.
- Checkout stays OFF until stock exists and an operator activates it (audited). Razorpay, SMS and SMTP are not configured yet: never show them as working.

## 3. Ground rules (apply in every phase)
1. **Contract first, never invent.** Use only operations that exist in docs/backend-contract/api-index.md/openapi.yaml. If something is missing or its shape is unclear, call the real backend to learn it, record it in docs/build/BACKEND_REQUESTS.md, and continue with a clearly labelled workaround. Contract drift is a bug you report, not hide.
2. **No fake data in shipped paths.** Mocks exist only in tests and an explicit, visibly bannered dev mode. A screen that cannot reach the backend says so plainly with the request id.
3. **Security by construction.** BFF pattern: tokens live only in an encrypted httpOnly cookie on the server; the browser never sees an access or refresh token. CSRF protection on all mutating routes. Strict CSP, no third-party scripts. Never log tokens or PII. Every customer-visible or money-affecting change goes through the backend's own guards (roles, MFA step-up, reasons, expectedVersion, If-Match, idempotency keys); the UI mirrors them but never replaces them.
4. **Money and time.** Money is integer paise end to end; display as ₹ with en-IN grouping and tabular figures; GST is INCLUDED in prices. Times are UTC in the API and shown in IST via one formatter; ranges are half-open.
5. **Honest UI.** Loading, empty, error, offline, permission-denied and conflict states are designed for every screen. Colour is never the only status carrier. Explain consequences before destructive or customer-impacting actions in plain language.
6. **Accessibility and responsiveness.** WCAG 2.2 AA minimum; keyboard-only operation; focus management; reduced motion; usable on a phone for operational screens (orders, overview), desktop-first for the Studio.
7. **Quality gates.** TypeScript strict, no any, ESLint clean, tests alongside code, run against the real backend for integration and e2e. "Done" means demonstrated with evidence, not asserted.
8. **Documentation as you go** in docs/build/: DASH_PLAN, DASH_DECISIONS (ADRs), DASH_PROGRESS (per-phase evidence and handoff), DASH_RISKS, DASH_PARITY (Bakaloo capability and API coverage matrix), BACKEND_REQUESTS, LOCAL_DEV, plus one phase-NN-thinking.md per phase.
9. **Do not copy the reference.** Study Bakaloo's capabilities and UX patterns, avoid its documented anti-patterns, and exclude its B2B/rider/wallet/gamification scope.
10. **Scope discipline.** Build what the phase asks; note ideas in DASH_PLAN under "later". Never leave a half-built screen reachable from navigation.

## 4. Roles and permissions (mirror exactly; the backend enforces)
| Role | Permissions |
|---|---|
| admin | everything |
| support | orders:read, customers:read, customers:write (notes/tags), reviews:moderate, media:read, shipping:read |
| catalog | catalog:read, catalog:write, inventory:read, media:read, media:write, experience:read |
| fulfillment | orders:read, orders:fulfil, orders:cancel, inventory:read, inventory:write, customers:read, shipping:read, shipping:write, analytics:read |
| finance | orders:read, payments:read, refunds:write, audit:read, coupons:read, analytics:read, shipping:read |
| designer | catalog:read, media:read, media:write, experience:read, experience:write |

Permissions that ALSO require an MFA (aal2) session (backend answers 403 MFA_REQUIRED): refunds:write, settings:write, ops:replay, orders:cancel, inventory:write, team:manage, integrations:manage, experience:publish, customers:export, flags:manage (plus specific actions such as blocking a customer, exports, shipment cancellation, delivery-area edits). Always read the operation's description in api-index.md for permission and MFA. Store pause (PUT /v1/admin/store-status) and the checkout kill switch are deliberately NOT step-up gated.

## 5. Backend conventions (binding)
- Errors: { error: { code, message, requestId, retryable, fields?, lines?, reason?, paused? } }. Codes: VALIDATION_FAILED, UNAUTHENTICATED, FORBIDDEN, NOT_FOUND, CART_VERSION_CONFLICT (also used for settings version conflicts), ETAG_MISMATCH (409, Studio documents), QUOTE_*, ITEM_UNAVAILABLE, STOCK_SHORTAGE, UNSUPPORTED_PAYMENT_METHOD, NOT_SERVICEABLE, POLICY_NOT_CONFIGURED, CHECKOUT_DISABLED (503, may carry paused:true), DUPLICATE_REQUEST_MISMATCH, REQUEST_IN_PROGRESS, ILLEGAL_STATE (409), RATE_LIMITED (429 + Retry-After), PAYLOAD_TOO_LARGE, OTP_*, COUPON_INVALID (422 + reason), MFA_REQUIRED (403), INTERNAL, UNAVAILABLE.
- Pagination: opaque cursors, { items, nextCursor }. Concurrency: expectedVersion (orders, inventory, settings) or If-Match revision (Studio documents). Idempotency-Key on order creation and Studio publishing. Sensitive actions require a reason of 3-300 characters.
- Auth: access token 15 min (EdDSA JWT) + rotating refresh token; a REUSED refresh token revokes the whole session, so refresh must be single-flight. Admin login uses client=admin. MFA is TOTP with recovery codes.
- Studio documents are strictly validated (unknown keys rejected, 512 kb limit). Public bundle: GET /v1/experience/{app|web} with ETag/304; preview: GET /v1/experience/{channel}/preview?token= (served by commerce-api, no-store, noindex).
- CSV endpoints return text/csv and are formula-injection-guarded server-side.

## 6. The thinking ritual (applies at the start of EVERY phase; each phase file repeats the steps)
Before writing a single line of a phase you must: re-ground in the contract and the previous handoff; write docs/build/phase-NN-thinking.md covering users and jobs, state machines, the phase's deep-think questions, a 10-item pre-mortem, security, performance and accessibility budgets, a test plan and the build slices; then challenge your own plan as a skeptical reviewer and fix at least five weaknesses. Think as if you had 100 times the usual time to consider what could go wrong for a real owner running a real business with real customers. Only then build, in thin vertical slices, verifying each against the real backend. End every phase with evidence, a written handoff and the phase report.

## 7. Phase report (print at the end of every phase)
```
PHASE NN COMPLETE: <title>
Built: <bullets>
Evidence: <test counts, screenshots, curl/network traces, audit entries; file paths>
Acceptance: <each criterion: PASS (evidence) / FAIL (why)>
Verified vs not verified: <honest list>
Backend requests raised: <ids>
Decisions (ADRs): <ids>
Risks added or changed: <ids>
Handoff to phase NN+1: <what it must know>
Owner decisions needed (if any, with defaults): <list>
```

## 8. Resume protocol (your context may be cleared at any time)
At the start of any session: read this file, docs/build/DASH_PROGRESS.md, DASH_PLAN.md and the latest phase-NN-thinking.md; run pnpm verify; continue from the first phase that is not marked COMPLETE with evidence. Never redo completed phases; never skip the ritual because you are "resuming".

## 9. The 20 phases (build in order; each has its own file under docs/phased-prompt/phases/)
| # | Phase | File |
|---|---|---|
| 1 | Orientation, audit, decisions and repository foundations | phases/PHASE_01_orientation-audit-foundations.md |
| 2 | Design system, tokens, application shell and component library | phases/PHASE_02_design-system-and-shell.md |
| 3 | Authentication, sessions, MFA step-up and role-based access (BFF) | phases/PHASE_03_authentication-sessions-rbac.md |
| 4 | Typed API layer, data fetching, tables, filters, forms and error handling | phases/PHASE_04_api-layer-data-tables-forms.md |
| 5 | Overview dashboard, system health, alerts and store controls | phases/PHASE_05_overview-health-store-controls.md |
| 6 | Orders: list, detail, lifecycle, notes, exports, packing and customer communication | phases/PHASE_06_orders.md |
| 7 | Fulfilment, shipments (manual-first, provider-ready), returns and refunds | phases/PHASE_07_fulfilment-shipments-returns.md |
| 8 | Catalogue, pricing and inventory | phases/PHASE_08_catalogue-and-inventory.md |
| 9 | Media library: upload, provenance, approval, usage and bundled assets | phases/PHASE_09_media-library.md |
| 10 | Experience Studio I: workspace, document model and the schema-driven editor engine | phases/PHASE_10_studio-engine-and-documents.md |
| 11 | Experience Studio II: design system tokens, navigation and app/web chrome | phases/PHASE_11_studio-design-system-navigation-chrome.md |
| 12 | Experience Studio III: app page builder with a faithful phone preview | phases/PHASE_12_studio-app-page-builder.md |
| 13 | Experience Studio IV: website page builder, SEO and product page template | phases/PHASE_13_studio-web-page-builder.md |
| 14 | Experience Studio V: content library (testimonials, stories, journal, care guides, FAQ, announcements) | phases/PHASE_14_studio-content-library.md |
| 15 | Experience Studio VI: validation gate, diff, releases, scheduling, rollback, kill switch, campaigns and the baseline seed | phases/PHASE_15_studio-publishing-campaigns-baseline.md |
| 16 | Customers, reviews moderation and support tools | phases/PHASE_16_customers-reviews-support.md |
| 17 | Marketing: coupons, message templates, outbox, app update prompts and announcements | phases/PHASE_17_marketing-coupons-messaging.md |
| 18 | Analytics, finance, GST, audit log and operations queues | phases/PHASE_18_analytics-finance-audit-ops.md |
| 19 | Platform: store settings, policies, team and roles, integrations and security | phases/PHASE_19_platform-settings-team-integrations.md |
| 20 | Hardening, quality gates and release readiness | phases/PHASE_20_hardening-and-release-readiness.md |

Phases 1-4 are foundations and may not be reordered. Phases 10-15 (Studio) must stay in order. Phases 5-9 and 16-19 may be reordered if you justify it in DASH_DECISIONS.md. Phase 20 is last.

## 10. How to start
1. Read this whole file, then open docs/phased-prompt/phases/PHASE_01_orientation-audit-foundations.md and execute Phase 1 exactly as written, including its thinking file.
2. After each phase prints its report, immediately start the next phase's Step 1 (re-ground). Do not wait for confirmation between phases unless a real owner decision is needed or an acceptance criterion cannot be met.
3. If a phase file and the backend contract disagree, the running backend and openapi.yaml win; record the discrepancy.
4. Ask the owner questions only in one batch with proposed defaults, at the moment they block progress. Known open owner inputs: Shiprocket account (parked), Razorpay/SMS/SMTP credentials (not configured), testimonial consent, hosting/CDN, GSTIN and legal copy.

Begin now with Phase 1.
