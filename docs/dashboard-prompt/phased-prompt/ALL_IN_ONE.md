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


---

# PHASE 01 of 20: Orientation, audit, decisions and repository foundations

> Ritual reminder: Re-ground, then Think at 100x (written), then Challenge the plan, then Build in slices, then Verify with evidence, then Reflect and hand off. The thinking file for this phase is docs/build/phase-01-thinking.md.

## Mission
Understand everything that exists before writing a feature: the backend contract, the two clients, the Bakaloo reference analysis, the current dashboard scaffold. Decide the stack and conventions once, in writing, and make the repository ready for 19 more phases.

## Read first
- 00_PASTE_THIS_FIRST.md (this prompt) and docs/backend-contract/INTEGRATION_GUIDE.md
- docs/backend-contract/03_BACKEND_CONTRACT.md (read the "Implementation status and deviations" section FIRST: it overrides the rest of that file)
- docs/backend-contract/api-index.md and openapi.yaml (the source of truth for operations)
- docs/backend-contract/01_REFERENCE_ANALYSIS_BAKALOO.md and 02_EXPERIENCE_STUDIO_SPEC.md (skim now, study again when you reach the Studio phases)
- The existing scaffold: package.json, src/app/*, docs/build/DASH_*.md (it is a single mock-data prototype page: judge whether to keep any of it)

## Think about before building (answer each in your thinking file)
- What are the five biggest ways this project could fail (scope, security, contract drift, Studio complexity, quality)? What in the repo structure prevents each?
- Which parts of the existing scaffold are worth keeping (tokens, shell idea, command palette) and which must be rebuilt properly? Justify with evidence from the code.
- Stack choices: server-state library, table library, form library, UI primitives, styling approach, test tools, API type generation. For each, list 2 options, the trade-off for a 20-phase build by one agent, and pick one. Record as ADRs.
- How will the dashboard talk to the backend so tokens never reach the browser (BFF)? What are the exact trust boundaries?
- How will you keep the dashboard honest against backend drift (contract tests, generated types, a nightly "spec vs api-index" diff)?
- What does "done" mean for the whole project? Draft the final acceptance checklist now (you will extend it every phase).

## Scope: what to build
- Create or confirm the repository layout: src/app (routes), src/features/<area>, src/components (design system), src/lib (api, auth, utils), src/server (BFF helpers), tests/ (unit, e2e), docs/build (DASH_PLAN, DASH_DECISIONS, DASH_PROGRESS, DASH_RISKS, DASH_PARITY, BACKEND_REQUESTS).
- Pin the stack with ADRs in docs/build/DASH_DECISIONS.md. Recommended defaults (override only with a written reason): Next.js (App Router) + React + TypeScript strict; TanStack Query for server state; TanStack Table for tables; react-hook-form + zod for forms; Radix UI primitives wrapped in your own components; Tailwind CSS with design tokens as CSS variables; openapi-typescript for generated API types; Vitest + Testing Library; Playwright + axe for e2e and accessibility.
- Generate API types from docs/backend-contract/openapi.yaml into src/lib/api/generated and add a script that fails CI when the spec file changes without regenerating.
- Wire tooling: strict tsconfig, ESLint (no-explicit-any as error), Prettier, Vitest, Playwright, a pre-commit or CI-equivalent script "pnpm verify" = typecheck + lint + unit tests + build.
- Create the parity matrix docs/build/DASH_PARITY.md: one row per Bakaloo capability from 01_REFERENCE_ANALYSIS (adopt / adapt / drop + reason + phase that delivers it) and one row per backend operation family from api-index.md (which screen uses it, which phase).
- Write docs/build/DASH_PLAN.md: the 20 phases with your own estimates, dependencies, and the order you will actually build (you may reorder phases 5-9 if you can justify it; never reorder 1-4 or the Studio phases 10-15).
- Start the real backend locally (see INTEGRATION_GUIDE.md), create operator accounts for every role (scripts/create-admin.ts in the backend repo, roles admin, support, catalog, fulfillment, finance, designer) and record how to repeat this in docs/build/LOCAL_DEV.md.

## Backend operations used
- GET /healthz and /readyz on commerce-api (reachability check only).
- No feature endpoints yet; confirm by calling GET /v1/store-settings through the gateway that the backend is up.

## Experience requirements
- None yet beyond a "Connected to backend / Backend unreachable" indicator in the existing prototype shell, driven by a real call, replacing the "Mock API" label.

## Edge cases and failure modes you must handle
- Backend not running: the dashboard must say so plainly, not show fake data.
- Port clashes on a developer machine (the website uses 5174, the dashboard 3200, the gateway 8080, commerce-api 4000, experience-api 4001).
- Spec drift: the openapi.yaml you were given is a snapshot; document the version you built against.

## Acceptance criteria (each needs evidence)
- docs/build has DASH_PLAN, DASH_DECISIONS (>= 8 ADRs), DASH_PARITY, DASH_RISKS (>= 10 risks with mitigations), BACKEND_REQUESTS (empty list is fine), LOCAL_DEV.
- "pnpm verify" passes on a clean clone.
- Generated API types compile and a trivial typed call (store settings) works through the BFF stub.
- The prototype page no longer claims "Mock API" anywhere it is not actually mocked.

## Verification
- Run pnpm install, pnpm verify, pnpm dev; open http://localhost:3200 and screenshot the connected indicator.
- Stop the backend and confirm the unreachable state; start it again and confirm recovery without a reload.

## Handoff to the next phase (write these down)
- List every ADR with its one-line decision.
- List every contract mismatch you already noticed.
- State the exact local-dev commands that worked.

## How to run this phase (mandatory ritual: do not skip or compress any step)

### Step 1: Re-ground (no code yet)
- Read every file in "Read first" above. Re-read the "Ground rules" in 00_PASTE_THIS_FIRST.md and the Handoff notes of the previous phase in docs/build/DASH_PROGRESS.md.
- List, in docs/build/phase-01-thinking.md, the exact backend operations this phase uses, each verified to exist in docs/backend-contract/api-index.md. For any operation whose request/response is only typed as "object" in openapi.yaml, call it on the running backend and record the real shape.

### Step 2: Think at 100x depth (write it down; thinking that is not written does not count)
Create docs/build/phase-01-thinking.md and fill ALL of these sections with specific, non-generic content:
1. **Users and jobs**: each role that touches this phase, the 5 jobs they do most, and what "fast and safe" means for each.
2. **State and data flow**: every state machine and data flow involved (draw as text diagrams), including loading, empty, error, offline, permission-denied, conflict and stale states.
3. **Deep-think questions**: answer every question under "Think about before building" in this file, with the decision you took and the alternative you rejected and why.
4. **Pre-mortem**: 10 realistic ways this phase fails in production (wrong data shown, double submit, leaked PII, lost draft, slow list, race condition, misleading number, role bypass, contract drift, accessibility failure) and the specific control for each.
5. **Security and privacy**: threats and mitigations for the data this phase handles.
6. **Performance and accessibility budgets**: numbers (for example list render under 100 ms for 50 rows, keyboard path for every action).
7. **Test plan**: unit, component, integration (real backend), e2e per role, visual where relevant; list the test names before writing them.
8. **Slices**: the build order as vertical slices, each independently demonstrable.

### Step 3: Challenge your own plan
Re-read your thinking file as a skeptical senior reviewer. Find at least 5 weaknesses (missed state, hidden coupling, unclear ownership of data, unproven assumption about the backend) and fix the plan. Write "Review findings and changes" at the end of the thinking file.

### Step 4: Build slice by slice
- Implement one slice at a time; after each slice run typecheck, lint, unit tests, and exercise it in the browser against the REAL local backend. Commit small, with messages that say what and why.
- Follow the component library, tokens, API layer, form kit and permission helpers from earlier phases. Do not duplicate them; improve them if they fall short and note it in DASH_DECISIONS.md.
- If the backend lacks something (an endpoint, a filter, a field), do NOT invent it and do NOT fake it in shipped code: record it in docs/build/BACKEND_REQUESTS.md with the proposed shape and a workaround, then continue.

### Step 5: Verify with evidence
Run everything under "Verification" below. Evidence means real outputs: test logs, screenshots at 375/768/1440 px, curl or network traces, audit-log entries. Claims without evidence are not accepted. Test every role listed in the permission matrix that can or cannot do things in this phase, including the negative cases.

### Step 6: Reflect and hand off
- Update docs/build/DASH_PROGRESS.md (what was built, evidence links, what is verified vs not), DASH_DECISIONS.md (new ADRs), DASH_RISKS.md, DASH_PARITY.md, BACKEND_REQUESTS.md.
- Write the Handoff section for the next phase (what it must know) at the end of the thinking file and in DASH_PROGRESS.md.
- Tick every acceptance criterion below with the evidence that proves it. If any criterion fails, fix it before moving on; if it cannot be fixed, record it honestly as a known issue with an owner decision needed.
- Print the **Phase report** (format in 00_PASTE_THIS_FIRST.md) and then begin the next phase's Step 1. Stop and ask the owner ONLY when a genuine owner decision is needed (batch your questions with defaults).


---

# PHASE 02 of 20: Design system, tokens, application shell and component library

> Ritual reminder: Re-ground, then Think at 100x (written), then Challenge the plan, then Build in slices, then Verify with evidence, then Reflect and hand off. The thinking file for this phase is docs/build/phase-02-thinking.md.

## Mission
Build the visual and interaction foundation every later screen reuses: a premium dark-walnut / brass / ivory operator UI that matches the Jimmy & Wax brand, plus the shell (navigation, command palette, layout) and a tested component library.

## Read first
- docs/backend-contract/01_REFERENCE_ANALYSIS_BAKALOO.md section 4 (cross-cutting UX patterns to replicate) and section 5 (anti-patterns to avoid)
- The website tokens file C:/Users/MSI/OneDrive/Desktop/jimmy_nd _wax_website/src/styles/tokens.css and design-system/jimmy-wax/MASTER.md (if you can read them) for the palette and type
- 02_EXPERIENCE_STUDIO_SPEC.md section 3 (the Design System the STUDIO edits is different from the dashboard's own UI theme: do not conflate them)

## Think about before building (answer each in your thinking file)
- What is the operator's day like? List the 12 most frequent tasks and make sure the shell makes each one at most 2 clicks or one keystroke away.
- Which components will be used 50+ times (table, filters, form fields, drawer, dialog, toast, badge, empty state, skeleton, stat card, date range, money input, id chip)? Define their props and states before coding.
- Dark-only or light + dark? Operators work long hours; decide with contrast numbers (WCAG AA minimum, AAA for body text where feasible) and document.
- Density: a dense data table must still be readable. Define 3 row heights and when each is used.
- What would make this feel like a premium product rather than an admin template (motion restraint, typography, spacing rhythm, iconography)? What would make it feel cheap?
- Accessibility first: focus order, focus rings, landmark structure, reduced motion, keyboard shortcuts that do not collide with screen readers.

## Scope: what to build
- Tokens as CSS variables (colour roles, spacing 4px scale, radii, shadows, z-scale, motion durations/easings, type scale) in one file; both a dashboard theme and a documented way to add a light theme later.
- Fonts: Playfair Display for display headings only, Inter for UI; load via next/font with swap; tabular numerals for money and counts.
- Components (each with stories or a living /dev/components page, unit tests, and accessibility tests): Button (variants, loading), IconButton, Input, Textarea, Select, Combobox, MultiSelect, Checkbox, Switch, RadioGroup, Money input (paise-safe), Date and DateRange picker (IST), Tabs, Dialog, Drawer, Popover, Tooltip, Toast, Badge/StatusPill, Avatar, Card, StatCard, Skeleton, EmptyState, ErrorState, Pagination (cursor), DataTable (sorting, column visibility, row selection, sticky header, density, virtualisation threshold), FilterBar (chips, saved views), CopyableId, JsonViewer, ConfirmDialog (typed confirmation for destructive actions), ReasonDialog (3-300 chars, required by the backend for sensitive actions), StepUpDialog placeholder (completed in phase 3).
- App shell: collapsible sidebar grouped by area (Overview, Orders & Fulfilment, Catalogue, Studio, Customers, Marketing, Insights, Settings), top bar (global search stub, store status pill, environment badge, user menu), breadcrumbs, responsive behaviour (sidebar becomes a drawer under 1024px), command palette (Ctrl/Cmd+K) with registered commands and recent items, and a global "toast + undo" pattern.
- Navigation is data-driven and permission-aware: each item declares the permission(s) needed (phase 3 fills this in); items the role cannot use are hidden, and deep links to them show a proper "not allowed" state, never a blank page.
- A /dev/components page (dev-only) that renders every component in every state for visual review.

## Backend operations used
- None.

## Experience requirements
- Empty, loading, error, offline and permission-denied states are designed ONCE here and reused: copy that tells the operator what happened and what to do next, with a request id on errors.
- Motion: 160-240ms for micro-interactions, 240-360ms for panels, none for table updates; honour prefers-reduced-motion everywhere.
- Every interactive element is at least 36px tall on desktop and 44px on touch; visible focus ring (2px brass) on all.

## Edge cases and failure modes you must handle
- Very long product names, 10-digit order totals, RTL-looking mixed text, emoji in names: components must not break.
- Browser zoom 200%, Windows high-contrast mode, keyboard-only use.
- Hydration mismatches from dates (always render IST via an explicit formatter, never toLocale* defaults).

## Acceptance criteria (each needs evidence)
- Every listed component exists with unit tests; axe reports zero serious/critical violations on /dev/components.
- The shell passes keyboard-only navigation (tab order, skip link, palette open/close, escape behaviour).
- Money and date formatting helpers are unit-tested (paise to ₹ with en-IN grouping, IST dates, relative times).
- Lighthouse accessibility >= 95 on the shell page.

## Verification
- Screenshot /dev/components at 375, 768 and 1440 px.
- Run axe via Playwright and attach the report.
- Record a short keyboard-only walkthrough script and run it as an e2e test.

## Handoff to the next phase (write these down)
- Component inventory with props summary.
- Tokens table.
- Any component you deferred and why.

## How to run this phase (mandatory ritual: do not skip or compress any step)

### Step 1: Re-ground (no code yet)
- Read every file in "Read first" above. Re-read the "Ground rules" in 00_PASTE_THIS_FIRST.md and the Handoff notes of the previous phase in docs/build/DASH_PROGRESS.md.
- List, in docs/build/phase-02-thinking.md, the exact backend operations this phase uses, each verified to exist in docs/backend-contract/api-index.md. For any operation whose request/response is only typed as "object" in openapi.yaml, call it on the running backend and record the real shape.

### Step 2: Think at 100x depth (write it down; thinking that is not written does not count)
Create docs/build/phase-02-thinking.md and fill ALL of these sections with specific, non-generic content:
1. **Users and jobs**: each role that touches this phase, the 5 jobs they do most, and what "fast and safe" means for each.
2. **State and data flow**: every state machine and data flow involved (draw as text diagrams), including loading, empty, error, offline, permission-denied, conflict and stale states.
3. **Deep-think questions**: answer every question under "Think about before building" in this file, with the decision you took and the alternative you rejected and why.
4. **Pre-mortem**: 10 realistic ways this phase fails in production (wrong data shown, double submit, leaked PII, lost draft, slow list, race condition, misleading number, role bypass, contract drift, accessibility failure) and the specific control for each.
5. **Security and privacy**: threats and mitigations for the data this phase handles.
6. **Performance and accessibility budgets**: numbers (for example list render under 100 ms for 50 rows, keyboard path for every action).
7. **Test plan**: unit, component, integration (real backend), e2e per role, visual where relevant; list the test names before writing them.
8. **Slices**: the build order as vertical slices, each independently demonstrable.

### Step 3: Challenge your own plan
Re-read your thinking file as a skeptical senior reviewer. Find at least 5 weaknesses (missed state, hidden coupling, unclear ownership of data, unproven assumption about the backend) and fix the plan. Write "Review findings and changes" at the end of the thinking file.

### Step 4: Build slice by slice
- Implement one slice at a time; after each slice run typecheck, lint, unit tests, and exercise it in the browser against the REAL local backend. Commit small, with messages that say what and why.
- Follow the component library, tokens, API layer, form kit and permission helpers from earlier phases. Do not duplicate them; improve them if they fall short and note it in DASH_DECISIONS.md.
- If the backend lacks something (an endpoint, a filter, a field), do NOT invent it and do NOT fake it in shipped code: record it in docs/build/BACKEND_REQUESTS.md with the proposed shape and a workaround, then continue.

### Step 5: Verify with evidence
Run everything under "Verification" below. Evidence means real outputs: test logs, screenshots at 375/768/1440 px, curl or network traces, audit-log entries. Claims without evidence are not accepted. Test every role listed in the permission matrix that can or cannot do things in this phase, including the negative cases.

### Step 6: Reflect and hand off
- Update docs/build/DASH_PROGRESS.md (what was built, evidence links, what is verified vs not), DASH_DECISIONS.md (new ADRs), DASH_RISKS.md, DASH_PARITY.md, BACKEND_REQUESTS.md.
- Write the Handoff section for the next phase (what it must know) at the end of the thinking file and in DASH_PROGRESS.md.
- Tick every acceptance criterion below with the evidence that proves it. If any criterion fails, fix it before moving on; if it cannot be fixed, record it honestly as a known issue with an owner decision needed.
- Print the **Phase report** (format in 00_PASTE_THIS_FIRST.md) and then begin the next phase's Step 1. Stop and ask the owner ONLY when a genuine owner decision is needed (batch your questions with defaults).


---

# PHASE 03 of 20: Authentication, sessions, MFA step-up and role-based access (BFF)

> Ritual reminder: Re-ground, then Think at 100x (written), then Challenge the plan, then Build in slices, then Verify with evidence, then Reflect and hand off. The thinking file for this phase is docs/build/phase-03-thinking.md.

## Mission
Operators sign in securely. Tokens never touch browser JavaScript. Every screen and button respects the backend's role and step-up rules, and the UI explains refusals instead of failing silently.

## Read first
- docs/backend-contract/03_BACKEND_CONTRACT.md sections 1, 6 and "Implementation status"
- openapi.yaml: /v1/auth/login, /refresh, /logout, /mfa/enroll, /mfa/verify, /mfa/recovery-codes, /invite/accept, /v1/admin/me, /v1/admin/sessions
- The role/permission matrix in 00_PASTE_THIS_FIRST.md

## Think about before building (answer each in your thinking file)
- Draw the full session state machine: signed-out, signed-in without MFA enrolled, enrolled but aal1, aal2, step-up required, refresh failing, revoked elsewhere, invited-not-accepted. Write each transition and what the user sees.
- BFF design: httpOnly + Secure + SameSite=Strict cookie holding an encrypted session (access token, refresh token, role, mfa flag, expiry). How do you refresh once under concurrent requests without a race? How do you prevent CSRF on mutating routes (double-submit token or Origin check)?
- The backend replays-protects refresh tokens: a reused refresh token revokes the whole session. What in your BFF could accidentally reuse one (parallel tabs, retries) and how do you make it impossible (single-flight refresh keyed by session)?
- Step-up: the API answers 403 MFA_REQUIRED for sensitive actions. Design a global interceptor that opens the step-up dialog, completes /mfa/verify, replaces tokens, and RETRIES the original request exactly once, with no double-submission of non-idempotent calls.
- What is the minimum information the client needs about the user (id, email, role, permissions, mfa state)? What must never be sent to the client?
- Threats: session fixation, token theft via XSS, open redirects after login, clickjacking, brute force (backend locks after 5 failures for 15 minutes: how do you present a 429/locked state kindly), enumeration.

## Scope: what to build
- BFF route handlers under src/app/api/auth/*: login (client=admin), logout, session (returns the safe user object), refresh single-flight, mfa enroll (returns otpauth URI and secret once), mfa verify, recovery-code use, recovery-code rotation, invite accept.
- A server-side API proxy (src/server/api.ts) used by every feature: attaches the bearer token, refreshes once on 401, maps backend errors to a typed ApiError, forwards Idempotency-Key and If-Match, never exposes tokens.
- Pages: /login (email + password, MFA code step, recovery-code option), /login/enroll (QR code from the otpauth URI, secret shown once, code confirmation, then show recovery codes ONCE with download/copy and an "I saved them" gate), /invite (accept invitation: token + new password), /account/security (change password, rotate recovery codes, MFA status, active sessions list with revoke).
- Permission model in code: the 6 roles and their permission sets mirrored from the backend matrix as a typed constant, plus a runtime source of truth (GET /v1/admin/me returns role; the effective permissions are derived from the matrix; backend still enforces). Helpers: can(permission), <Can>, route guards (server-side in layouts), nav filtering.
- Global StepUpDialog: TOTP input, recovery-code fallback, clear errors, success resumes the original action.
- Idle timeout UX (warn at 25 minutes of inactivity, sign out at 30; the backend token is 15 minutes with rotation, so the BFF refresh keeps working sessions alive).
- Security headers via next.config (CSP with nonces, frame-ancestors none, referrer-policy, permissions-policy) and a documented allowlist; no third-party scripts.

## Backend operations used
- POST /v1/auth/login {email,password,client:"admin"}; POST /v1/auth/refresh; POST /v1/auth/logout; POST /v1/auth/mfa/enroll; POST /v1/auth/mfa/verify (accepts a TOTP code or a recoveryCode); POST /v1/auth/mfa/recovery-codes; POST /v1/auth/invite/accept; POST /v1/auth/password/change.
- GET /v1/admin/me; GET /v1/admin/sessions; DELETE /v1/admin/sessions/{id}.
- Error codes to handle: UNAUTHENTICATED, FORBIDDEN, MFA_REQUIRED, RATE_LIMITED (Retry-After), VALIDATION_FAILED (fields).

## Experience requirements
- Login never reveals whether an email exists; show the backend's generic message.
- Locked account (429) shows a countdown from Retry-After.
- Disabled staff and customers get the same generic refusal; a customer account that signs in to the admin gets a clear "not an operator account" only if the backend says so, otherwise generic.
- The user menu shows role and MFA status; a banner nags (not blocks) operators without MFA enrolled when ADMIN_REQUIRE_MFA is true.

## Edge cases and failure modes you must handle
- Two tabs refreshing at once; a refresh that fails with a network error must not log the operator out (only a definitive 401 from refresh does).
- The operator opens a deep link while signed out: after login return to it (validate the target is same-origin and relative).
- System clock skew on TOTP (tell the operator to check device time on repeated code failures).
- Session revoked from another device while a form has unsaved changes: keep the draft in memory, show a re-login dialog, restore.

## Acceptance criteria (each needs evidence)
- Tokens are never present in JS-readable storage, URLs or logs (test by scanning the page, storage and network responses).
- Each role sees exactly its navigation; direct URL access to a forbidden area shows the not-allowed state and the BFF refuses the call.
- A step-up-gated action (for example saving store settings) triggers the dialog and completes after verification without losing the form.
- Unit tests for the session state machine; e2e tests for login, enrolment, step-up, logout, revoke-other-session, forced re-login.
- CSRF test: a cross-origin POST to a mutating BFF route is rejected.

## Verification
- Run the e2e suite against the REAL backend with operators of every role.
- Inspect the Network tab and cookies and attach the evidence.
- Run a manual XSS probe (inject a script tag in a displayed field later in other phases and confirm CSP blocks inline execution).

## Handoff to the next phase (write these down)
- The exact BFF contract (routes, cookie names, error shape) other phases must use.
- The permission matrix constant and how to add a permission.
- Known gaps (for example password reset for operators if the backend lacks it).

## How to run this phase (mandatory ritual: do not skip or compress any step)

### Step 1: Re-ground (no code yet)
- Read every file in "Read first" above. Re-read the "Ground rules" in 00_PASTE_THIS_FIRST.md and the Handoff notes of the previous phase in docs/build/DASH_PROGRESS.md.
- List, in docs/build/phase-03-thinking.md, the exact backend operations this phase uses, each verified to exist in docs/backend-contract/api-index.md. For any operation whose request/response is only typed as "object" in openapi.yaml, call it on the running backend and record the real shape.

### Step 2: Think at 100x depth (write it down; thinking that is not written does not count)
Create docs/build/phase-03-thinking.md and fill ALL of these sections with specific, non-generic content:
1. **Users and jobs**: each role that touches this phase, the 5 jobs they do most, and what "fast and safe" means for each.
2. **State and data flow**: every state machine and data flow involved (draw as text diagrams), including loading, empty, error, offline, permission-denied, conflict and stale states.
3. **Deep-think questions**: answer every question under "Think about before building" in this file, with the decision you took and the alternative you rejected and why.
4. **Pre-mortem**: 10 realistic ways this phase fails in production (wrong data shown, double submit, leaked PII, lost draft, slow list, race condition, misleading number, role bypass, contract drift, accessibility failure) and the specific control for each.
5. **Security and privacy**: threats and mitigations for the data this phase handles.
6. **Performance and accessibility budgets**: numbers (for example list render under 100 ms for 50 rows, keyboard path for every action).
7. **Test plan**: unit, component, integration (real backend), e2e per role, visual where relevant; list the test names before writing them.
8. **Slices**: the build order as vertical slices, each independently demonstrable.

### Step 3: Challenge your own plan
Re-read your thinking file as a skeptical senior reviewer. Find at least 5 weaknesses (missed state, hidden coupling, unclear ownership of data, unproven assumption about the backend) and fix the plan. Write "Review findings and changes" at the end of the thinking file.

### Step 4: Build slice by slice
- Implement one slice at a time; after each slice run typecheck, lint, unit tests, and exercise it in the browser against the REAL local backend. Commit small, with messages that say what and why.
- Follow the component library, tokens, API layer, form kit and permission helpers from earlier phases. Do not duplicate them; improve them if they fall short and note it in DASH_DECISIONS.md.
- If the backend lacks something (an endpoint, a filter, a field), do NOT invent it and do NOT fake it in shipped code: record it in docs/build/BACKEND_REQUESTS.md with the proposed shape and a workaround, then continue.

### Step 5: Verify with evidence
Run everything under "Verification" below. Evidence means real outputs: test logs, screenshots at 375/768/1440 px, curl or network traces, audit-log entries. Claims without evidence are not accepted. Test every role listed in the permission matrix that can or cannot do things in this phase, including the negative cases.

### Step 6: Reflect and hand off
- Update docs/build/DASH_PROGRESS.md (what was built, evidence links, what is verified vs not), DASH_DECISIONS.md (new ADRs), DASH_RISKS.md, DASH_PARITY.md, BACKEND_REQUESTS.md.
- Write the Handoff section for the next phase (what it must know) at the end of the thinking file and in DASH_PROGRESS.md.
- Tick every acceptance criterion below with the evidence that proves it. If any criterion fails, fix it before moving on; if it cannot be fixed, record it honestly as a known issue with an owner decision needed.
- Print the **Phase report** (format in 00_PASTE_THIS_FIRST.md) and then begin the next phase's Step 1. Stop and ask the owner ONLY when a genuine owner decision is needed (batch your questions with defaults).


---

# PHASE 04 of 20: Typed API layer, data fetching, tables, filters, forms and error handling

> Ritual reminder: Re-ground, then Think at 100x (written), then Challenge the plan, then Build in slices, then Verify with evidence, then Reflect and hand off. The thinking file for this phase is docs/build/phase-04-thinking.md.

## Mission
Make every later screen cheap and uniform: one way to fetch, paginate, filter, mutate, handle conflicts and errors, export CSV, and validate forms. This is the engine room; do it thoroughly.

## Read first
- 03_BACKEND_CONTRACT.md section 1 (conventions) and the error code list in openapi.yaml (ErrorCode)
- api-index.md (skim all groups to see the shape of the API)

## Think about before building (answer each in your thinking file)
- Catalogue every convention the backend uses (cursor pagination, ETag/If-Match, expectedVersion, Idempotency-Key, reason fields, CSV downloads, multipart/binary uploads) and design one abstraction for each.
- There are THREE different optimistic-concurrency mechanisms: (a) If-Match with a document revision on Studio documents (conflict = 409 ETAG_MISMATCH with the server copy), (b) expectedVersion in the body for orders, inventory and settings (conflict = 409, settings uses CART_VERSION_CONFLICT), (c) none. Design a ConflictDialog that shows "someone else changed this", diff, and merge or reload choices. When is it safe to auto-retry?
- Query key design and cache invalidation: after a mutation, which lists and details must refresh? Define a central invalidation map per resource.
- How do you show partial failures (bulk actions where some rows fail)?
- Error taxonomy: which errors are shown inline on a field, as a toast, as a blocking page, or silently retried (retryable=true on 5xx and network)? Define the mapping table once.
- Performance: request waterfalls, prefetching on row hover, stale-while-revalidate windows per resource type, debounce on search, aborting superseded requests.

## Scope: what to build
- Typed client wrapper over the generated types: apiGet/apiPost/apiPut/apiPatch/apiDelete via the BFF; cursor-paginated hooks (useInfiniteList) that expose items, hasMore, loadMore, total-if-known; mutation helper with automatic Idempotency-Key for create/publish actions and automatic reason prompt for endpoints that require one.
- ApiError class: status, code, message, requestId, retryable, fields (map path to message), lines, reason, paused. Field errors map onto react-hook-form fields automatically.
- DataTable integration: URL-synced filters/sort/search (shareable links), saved views per user (localStorage with versioning; server-side later if the backend adds it), column visibility, density, row selection with a sticky bulk-action bar, CSV export button wired to the endpoints that stream CSV (blob download with a filename), empty and error states.
- Form kit: schema-first forms (zod) with dirty tracking, leave-page guard, autosave drafts (localStorage) for long forms, unsaved-changes banner, keyboard submit, disabled-while-saving, and inline server field errors.
- ConflictDialog and the three concurrency flows (If-Match, expectedVersion, none) with tests against a mocked server.
- Upload helper for media (progress, cancel, retry) used in phase 9.
- Test utilities: MSW handlers generated from the OpenAPI examples plus a recorded-fixture mechanism; Playwright helper to sign in as a role against the real backend.

## Backend operations used
- No new feature endpoints. Exercise with: GET /v1/admin/orders (cursor list), GET /v1/admin/customers, GET /v1/admin/exports/orders.csv (CSV + MFA), PUT /v1/admin/store-status (reason-less, not step-up), PATCH /v1/admin/settings (expectedVersion + reason + step-up).

## Experience requirements
- A single, consistent pattern for "this action needs a reason" and "this action needs MFA".
- Never leave a button spinning forever: timeouts surface a retry with the request id.
- Long operations (CSV import, bulk jobs) show progress and survive navigation.

## Edge cases and failure modes you must handle
- Cursor invalidation when filters change mid-scroll; deleted rows while paginating; a mutation response that omits fields the list shows; very large exports (stream, do not buffer in memory unnecessarily).
- Double-clicks and double-submits: every mutation button disables, and creates are idempotent where the backend supports keys.
- Clock differences between the browser and server when showing "x minutes ago".

## Acceptance criteria (each needs evidence)
- Each convention has a unit test and at least one integration test against the real backend.
- A reference "Orders (read-only)" screen built ONLY with the engine (list, filters, URL state, CSV export) proves the abstractions; it will be extended in phase 6.
- Conflict flows demonstrated with a deliberately stale update (two browser contexts).
- No feature code in later phases needs to call fetch directly (lint rule forbids it).

## Verification
- Run unit + integration + e2e; paste the output.
- Demonstrate a 409 on settings and on a Studio document (document endpoints arrive in phase 10: use the test double now and re-verify then).

## Handoff to the next phase (write these down)
- A one-page "how to add a new resource" recipe with a code sample.
- The invalidation map.
- Known limitations.

## How to run this phase (mandatory ritual: do not skip or compress any step)

### Step 1: Re-ground (no code yet)
- Read every file in "Read first" above. Re-read the "Ground rules" in 00_PASTE_THIS_FIRST.md and the Handoff notes of the previous phase in docs/build/DASH_PROGRESS.md.
- List, in docs/build/phase-04-thinking.md, the exact backend operations this phase uses, each verified to exist in docs/backend-contract/api-index.md. For any operation whose request/response is only typed as "object" in openapi.yaml, call it on the running backend and record the real shape.

### Step 2: Think at 100x depth (write it down; thinking that is not written does not count)
Create docs/build/phase-04-thinking.md and fill ALL of these sections with specific, non-generic content:
1. **Users and jobs**: each role that touches this phase, the 5 jobs they do most, and what "fast and safe" means for each.
2. **State and data flow**: every state machine and data flow involved (draw as text diagrams), including loading, empty, error, offline, permission-denied, conflict and stale states.
3. **Deep-think questions**: answer every question under "Think about before building" in this file, with the decision you took and the alternative you rejected and why.
4. **Pre-mortem**: 10 realistic ways this phase fails in production (wrong data shown, double submit, leaked PII, lost draft, slow list, race condition, misleading number, role bypass, contract drift, accessibility failure) and the specific control for each.
5. **Security and privacy**: threats and mitigations for the data this phase handles.
6. **Performance and accessibility budgets**: numbers (for example list render under 100 ms for 50 rows, keyboard path for every action).
7. **Test plan**: unit, component, integration (real backend), e2e per role, visual where relevant; list the test names before writing them.
8. **Slices**: the build order as vertical slices, each independently demonstrable.

### Step 3: Challenge your own plan
Re-read your thinking file as a skeptical senior reviewer. Find at least 5 weaknesses (missed state, hidden coupling, unclear ownership of data, unproven assumption about the backend) and fix the plan. Write "Review findings and changes" at the end of the thinking file.

### Step 4: Build slice by slice
- Implement one slice at a time; after each slice run typecheck, lint, unit tests, and exercise it in the browser against the REAL local backend. Commit small, with messages that say what and why.
- Follow the component library, tokens, API layer, form kit and permission helpers from earlier phases. Do not duplicate them; improve them if they fall short and note it in DASH_DECISIONS.md.
- If the backend lacks something (an endpoint, a filter, a field), do NOT invent it and do NOT fake it in shipped code: record it in docs/build/BACKEND_REQUESTS.md with the proposed shape and a workaround, then continue.

### Step 5: Verify with evidence
Run everything under "Verification" below. Evidence means real outputs: test logs, screenshots at 375/768/1440 px, curl or network traces, audit-log entries. Claims without evidence are not accepted. Test every role listed in the permission matrix that can or cannot do things in this phase, including the negative cases.

### Step 6: Reflect and hand off
- Update docs/build/DASH_PROGRESS.md (what was built, evidence links, what is verified vs not), DASH_DECISIONS.md (new ADRs), DASH_RISKS.md, DASH_PARITY.md, BACKEND_REQUESTS.md.
- Write the Handoff section for the next phase (what it must know) at the end of the thinking file and in DASH_PROGRESS.md.
- Tick every acceptance criterion below with the evidence that proves it. If any criterion fails, fix it before moving on; if it cannot be fixed, record it honestly as a known issue with an owner decision needed.
- Print the **Phase report** (format in 00_PASTE_THIS_FIRST.md) and then begin the next phase's Step 1. Stop and ask the owner ONLY when a genuine owner decision is needed (batch your questions with defaults).


---

# PHASE 05 of 20: Overview dashboard, system health, alerts and store controls

> Ritual reminder: Re-ground, then Think at 100x (written), then Challenge the plan, then Build in slices, then Verify with evidence, then Reflect and hand off. The thinking file for this phase is docs/build/phase-05-thinking.md.

## Mission
The operator's home: today at a glance, what needs attention, whether the system is healthy, and the emergency controls (pause orders, checkout kill switch).

## Read first
- api-index: admin/dashboard, admin/health, admin/store-status, admin/checkout, admin/ops, admin/audit
- 03_BACKEND_CONTRACT.md "Implementation status" (store pause behaviour)

## Think about before building (answer each in your thinking file)
- What are the 5 numbers and 5 queues an owner checks first thing in the morning and last thing at night? Which are actionable (clickable to a filtered list) vs informational?
- What could mislead the operator? (A cached number, a timezone boundary, an order counted in two places.) Define each metric precisely and show its definition on hover.
- Emergency controls must be fast and safe: pause orders is NOT step-up gated by design; checkout activation IS and needs prerequisites. Design confirmations that are quick for pause and deliberate for activation.
- What does the page do when parts of the API fail? Each widget must fail independently.

## Scope: what to build
- Overview page: KPI row (orders today, revenue today with definition, average order value, pending fulfilment, low-stock count, open returns, dead-lettered events), sales sparkline (analytics/sales), operator queues (orders to confirm, to pack, COD awaiting, returns to review, reviews to moderate, media to approve, testimonials needing consent) each linking to a pre-filtered list.
- Health panel from GET /v1/admin/health: outbox dead/pending, email failed/pending, shipping events, stuck shipment requests, low stock, alerts[]; plus integrations summary (GET /v1/admin/integrations) with honest states (configured, last check, "no safe live probe").
- Store status control: show checkoutOpen, pause state and message; one-click Pause (message input, optional) and Resume via PUT /v1/admin/store-status; show who/when from the audit trail.
- Checkout readiness checklist and activation: readiness checks from GET /v1/admin/settings (readiness.checks), explanation of each failing check, Activate button (reason + step-up) via POST /v1/admin/checkout/activate, and the kill switch POST /v1/admin/checkout/disable (fast, not step-up).
- Recent activity feed from GET /v1/admin/audit (last 20 events, human-readable).
- Auto-refresh every 60s with a visible "updated x ago" and manual refresh.

## Backend operations used
- GET /v1/admin/dashboard; GET /v1/admin/health; GET /v1/admin/store-status; PUT /v1/admin/store-status; GET /v1/admin/settings; POST /v1/admin/checkout/activate; POST /v1/admin/checkout/disable; GET /v1/admin/integrations; GET /v1/admin/audit; GET /v1/admin/analytics/sales.

## Experience requirements
- A calm, scannable layout; the paused banner is impossible to miss across the whole app while orders are paused (global top banner from this phase on).
- Colour is never the only carrier of status (icons + text).

## Edge cases and failure modes you must handle
- Fresh database: every number is zero and queues empty: show friendly first-run guidance (stock, PIN list, GST details, policies, activation) as an onboarding checklist.
- Roles without analytics:read see a reduced overview (support sees queues only).
- Pause message longer than 300 characters; pause while another operator resumes (last write wins, show the latest state).

## Acceptance criteria (each needs evidence)
- Every widget has loading, empty, error and permission states and fails independently (test by blocking one endpoint).
- Pause and resume work against the real backend; the customer-facing GET /v1/store-settings reflects it (verify with curl through the gateway).
- Activation refuses with the backend's failing readiness reasons shown verbatim.
- Role matrix test: each role's overview contains only permitted widgets.

## Verification
- Run the stack, pause orders from the dashboard, confirm the website checkout shows the paused banner (if the website is running on 5174) and the quote endpoint refuses with paused:true.
- Screenshot the overview in a fresh database and in a populated one (use the backend dev seed).

## Handoff to the next phase (write these down)
- Metric definitions table.
- Global banner mechanism other phases reuse.

## How to run this phase (mandatory ritual: do not skip or compress any step)

### Step 1: Re-ground (no code yet)
- Read every file in "Read first" above. Re-read the "Ground rules" in 00_PASTE_THIS_FIRST.md and the Handoff notes of the previous phase in docs/build/DASH_PROGRESS.md.
- List, in docs/build/phase-05-thinking.md, the exact backend operations this phase uses, each verified to exist in docs/backend-contract/api-index.md. For any operation whose request/response is only typed as "object" in openapi.yaml, call it on the running backend and record the real shape.

### Step 2: Think at 100x depth (write it down; thinking that is not written does not count)
Create docs/build/phase-05-thinking.md and fill ALL of these sections with specific, non-generic content:
1. **Users and jobs**: each role that touches this phase, the 5 jobs they do most, and what "fast and safe" means for each.
2. **State and data flow**: every state machine and data flow involved (draw as text diagrams), including loading, empty, error, offline, permission-denied, conflict and stale states.
3. **Deep-think questions**: answer every question under "Think about before building" in this file, with the decision you took and the alternative you rejected and why.
4. **Pre-mortem**: 10 realistic ways this phase fails in production (wrong data shown, double submit, leaked PII, lost draft, slow list, race condition, misleading number, role bypass, contract drift, accessibility failure) and the specific control for each.
5. **Security and privacy**: threats and mitigations for the data this phase handles.
6. **Performance and accessibility budgets**: numbers (for example list render under 100 ms for 50 rows, keyboard path for every action).
7. **Test plan**: unit, component, integration (real backend), e2e per role, visual where relevant; list the test names before writing them.
8. **Slices**: the build order as vertical slices, each independently demonstrable.

### Step 3: Challenge your own plan
Re-read your thinking file as a skeptical senior reviewer. Find at least 5 weaknesses (missed state, hidden coupling, unclear ownership of data, unproven assumption about the backend) and fix the plan. Write "Review findings and changes" at the end of the thinking file.

### Step 4: Build slice by slice
- Implement one slice at a time; after each slice run typecheck, lint, unit tests, and exercise it in the browser against the REAL local backend. Commit small, with messages that say what and why.
- Follow the component library, tokens, API layer, form kit and permission helpers from earlier phases. Do not duplicate them; improve them if they fall short and note it in DASH_DECISIONS.md.
- If the backend lacks something (an endpoint, a filter, a field), do NOT invent it and do NOT fake it in shipped code: record it in docs/build/BACKEND_REQUESTS.md with the proposed shape and a workaround, then continue.

### Step 5: Verify with evidence
Run everything under "Verification" below. Evidence means real outputs: test logs, screenshots at 375/768/1440 px, curl or network traces, audit-log entries. Claims without evidence are not accepted. Test every role listed in the permission matrix that can or cannot do things in this phase, including the negative cases.

### Step 6: Reflect and hand off
- Update docs/build/DASH_PROGRESS.md (what was built, evidence links, what is verified vs not), DASH_DECISIONS.md (new ADRs), DASH_RISKS.md, DASH_PARITY.md, BACKEND_REQUESTS.md.
- Write the Handoff section for the next phase (what it must know) at the end of the thinking file and in DASH_PROGRESS.md.
- Tick every acceptance criterion below with the evidence that proves it. If any criterion fails, fix it before moving on; if it cannot be fixed, record it honestly as a known issue with an owner decision needed.
- Print the **Phase report** (format in 00_PASTE_THIS_FIRST.md) and then begin the next phase's Step 1. Stop and ask the owner ONLY when a genuine owner decision is needed (batch your questions with defaults).


---

# PHASE 06 of 20: Orders: list, detail, lifecycle, notes, exports, packing and customer communication

> Ritual reminder: Re-ground, then Think at 100x (written), then Challenge the plan, then Build in slices, then Verify with evidence, then Reflect and hand off. The thinking file for this phase is docs/build/phase-06-thinking.md.

## Mission
The workhorse module. Operators find any order in seconds, understand its entire story, and move it through its lifecycle with the right guard rails.

## Read first
- api-index: admin/orders, admin/exports, admin/refunds, admin/dashboard
- The order status machine in 03_BACKEND_CONTRACT.md and the legal transitions in openapi (adminOrderStatus)
- The money model: prices are GST-inclusive; COD fee; shipping; coupon discount allocated per line; totals reconcile

## Think about before building (answer each in your thinking file)
- Draw the order lifecycle (pending_payment, placed, confirmed, processing, shipped, out_for_delivery, delivered, cancelled, returned, expired) with who can perform each transition (role), what it needs (expectedVersion, reason, MFA), and what side effects the backend performs (stock, emails, refunds). The UI must only offer legal transitions.
- What does support need to see vs fulfilment vs finance? The backend redacts customer address for support: how do you present redaction gracefully (and the audited reveal flow)?
- Search and filtering that operators actually use: order number prefix, phone suffix, email, status, payment method, date range, coupon code, state/PIN. Which are server-side (check the endpoint's query params in openapi) and which can't be offered yet (record in BACKEND_REQUESTS)?
- How to present an order that is partly returned, refunded, or has a coupon so the totals still reconcile visually (line discount, shipping discount, COD fee, GST included).
- Failure modes: two operators moving the same order (expectedVersion conflict), order cancelled by the customer while you look at it, a stale list.

## Scope: what to build
- Orders list with the engine from phase 4: filters, URL state, saved views ("To confirm", "To pack", "COD pending", "Cancelled last 7 days"), bulk selection (bulk status move only if the API supports it; otherwise omit), CSV export of the filtered range (GET /v1/admin/exports/orders.csv, MFA).
- Order detail page: header (number, status pill, payment, placed at IST), items table with per-line coupon share, totals breakdown with GST included line, customer card (masked for support, with the audited "Reveal" action that requires a reason), delivery address, timeline (status history, shipments, refunds, notes, emails queued), invoice link (POST/GET invoice endpoints), packing slip (GET /v1/admin/orders/{id}/packing-slip rendered as a printable page with print CSS).
- Lifecycle actions: Confirm, Start processing, Cancel (reason + MFA; if online-paid it queues a refund: say so), mark delivered/failed as the API allows; each shows exactly what will happen; optimistic update is NOT used for money or stock changes (wait for the server).
- Internal notes (GET/POST /v1/admin/orders/{id}/notes) with author and role; notes are never shown to customers: label them clearly.
- Resend confirmation email (POST /v1/admin/orders/{id}/resend-confirmation) with feedback; email outbox state for the order if visible.
- Refund requests: from the order, request a refund (finance/admin) and show refund state (requested, processing, processed, failed) with amounts; processing a refund needs finance + MFA (POST /v1/admin/refunds/{id}/process).
- Print and export helpers: printable packing slip, order summary PDF is NOT required (browser print is enough).

## Backend operations used
- GET /v1/admin/orders (+ filters), GET /v1/admin/orders/{id}, POST /v1/admin/orders/{id}/status {to, expectedVersion, reason?}, POST /v1/admin/orders/{id}/cancel, GET/POST /v1/admin/orders/{id}/notes, GET /v1/admin/orders/{id}/packing-slip, POST /v1/admin/orders/{id}/resend-confirmation, GET /v1/admin/orders/{id}/invoice, GET /v1/admin/refunds, POST /v1/admin/refunds/{id}/process, GET /v1/admin/exports/orders.csv, POST /v1/admin/customers/{id}/reveal.
- Read the exact request/response fields from openapi.yaml; where bodies are typed only as object, inspect real responses from the running backend and record the shape in docs/build/DASH_DECISIONS.md and BACKEND_REQUESTS.md.

## Experience requirements
- The list is the fastest page in the product: keyboard navigation (j/k, enter), instant search feel (debounced, aborted), sticky filters, total counts where available.
- Status pills use text + icon + colour; a legend is available.
- Money is always shown as ₹ with en-IN grouping and tabular figures; the order total line shows "includes ₹X GST".
- Mobile layout: the list becomes cards; the detail page is usable on a phone (operators check orders on the go).

## Edge cases and failure modes you must handle
- COD orders: payment status cod_due vs cod_collected, COD fee line; online orders: pending_payment with a payment window; expired orders.
- Orders placed before GST existed (no tax breakdown): invoice unavailable: show the backend's reason.
- A coupon-discounted order with free shipping: shipping line shows waived; a returned order shows net refund.
- Very large result sets: never load everything; export streams.
- Concurrent edit: expectedVersion mismatch shows ConflictDialog with the latest order.

## Acceptance criteria (each needs evidence)
- An operator can find an order by number, open it, confirm, process, and (with fulfilment from phase 7) ship it; each transition respects roles and MFA.
- Totals on the detail page equal the backend totals to the paisa for: plain COD, coupon, free-shipping coupon, online-paid, partially returned orders (test with fixtures created through the real API).
- Support role never sees unmasked contact data unless it uses Reveal (which is audited: verify the audit entry appears).
- Print stylesheet produces a clean packing slip (screenshot in print emulation).
- Playwright e2e: place an order via the website API or curl, then operate it in the dashboard end to end.

## Verification
- Create orders via the customer API (see INTEGRATION_GUIDE: demo login 9800000001 / 123456, PIN 743287) and drive them through the lifecycle in the UI as three different roles.
- Run the role-matrix e2e and the conflict e2e.

## Handoff to the next phase (write these down)
- Order DTO field table you derived.
- Filters the backend lacked (BACKEND_REQUESTS).
- Reusable OrderStatusPill / MoneyBreakdown components.

## How to run this phase (mandatory ritual: do not skip or compress any step)

### Step 1: Re-ground (no code yet)
- Read every file in "Read first" above. Re-read the "Ground rules" in 00_PASTE_THIS_FIRST.md and the Handoff notes of the previous phase in docs/build/DASH_PROGRESS.md.
- List, in docs/build/phase-06-thinking.md, the exact backend operations this phase uses, each verified to exist in docs/backend-contract/api-index.md. For any operation whose request/response is only typed as "object" in openapi.yaml, call it on the running backend and record the real shape.

### Step 2: Think at 100x depth (write it down; thinking that is not written does not count)
Create docs/build/phase-06-thinking.md and fill ALL of these sections with specific, non-generic content:
1. **Users and jobs**: each role that touches this phase, the 5 jobs they do most, and what "fast and safe" means for each.
2. **State and data flow**: every state machine and data flow involved (draw as text diagrams), including loading, empty, error, offline, permission-denied, conflict and stale states.
3. **Deep-think questions**: answer every question under "Think about before building" in this file, with the decision you took and the alternative you rejected and why.
4. **Pre-mortem**: 10 realistic ways this phase fails in production (wrong data shown, double submit, leaked PII, lost draft, slow list, race condition, misleading number, role bypass, contract drift, accessibility failure) and the specific control for each.
5. **Security and privacy**: threats and mitigations for the data this phase handles.
6. **Performance and accessibility budgets**: numbers (for example list render under 100 ms for 50 rows, keyboard path for every action).
7. **Test plan**: unit, component, integration (real backend), e2e per role, visual where relevant; list the test names before writing them.
8. **Slices**: the build order as vertical slices, each independently demonstrable.

### Step 3: Challenge your own plan
Re-read your thinking file as a skeptical senior reviewer. Find at least 5 weaknesses (missed state, hidden coupling, unclear ownership of data, unproven assumption about the backend) and fix the plan. Write "Review findings and changes" at the end of the thinking file.

### Step 4: Build slice by slice
- Implement one slice at a time; after each slice run typecheck, lint, unit tests, and exercise it in the browser against the REAL local backend. Commit small, with messages that say what and why.
- Follow the component library, tokens, API layer, form kit and permission helpers from earlier phases. Do not duplicate them; improve them if they fall short and note it in DASH_DECISIONS.md.
- If the backend lacks something (an endpoint, a filter, a field), do NOT invent it and do NOT fake it in shipped code: record it in docs/build/BACKEND_REQUESTS.md with the proposed shape and a workaround, then continue.

### Step 5: Verify with evidence
Run everything under "Verification" below. Evidence means real outputs: test logs, screenshots at 375/768/1440 px, curl or network traces, audit-log entries. Claims without evidence are not accepted. Test every role listed in the permission matrix that can or cannot do things in this phase, including the negative cases.

### Step 6: Reflect and hand off
- Update docs/build/DASH_PROGRESS.md (what was built, evidence links, what is verified vs not), DASH_DECISIONS.md (new ADRs), DASH_RISKS.md, DASH_PARITY.md, BACKEND_REQUESTS.md.
- Write the Handoff section for the next phase (what it must know) at the end of the thinking file and in DASH_PROGRESS.md.
- Tick every acceptance criterion below with the evidence that proves it. If any criterion fails, fix it before moving on; if it cannot be fixed, record it honestly as a known issue with an owner decision needed.
- Print the **Phase report** (format in 00_PASTE_THIS_FIRST.md) and then begin the next phase's Step 1. Stop and ask the owner ONLY when a genuine owner decision is needed (batch your questions with defaults).


---

# PHASE 07 of 20: Fulfilment, shipments (manual-first, provider-ready), returns and refunds

> Ritual reminder: Re-ground, then Think at 100x (written), then Challenge the plan, then Build in slices, then Verify with evidence, then Reflect and hand off. The thinking file for this phase is docs/build/phase-07-thinking.md.

## Mission
Pack, ship, track and take back. Shiprocket is PARKED by the owner: build the complete Shipping Center UI against the existing endpoints but make the manual courier flow the primary path and keep every provider-specific control behind the provider-configured flag.

## Read first
- api-index: admin/shipments, admin/shipping, admin/returns, admin/refunds
- 04_SHIPROCKET_SPEC.md (design intent only; the backend implemented it behind a provider boundary and it is mock-tested, NOT verified against the live service)
- The order status rule: shipping an order requires status processing

## Think about before building (answer each in your thinking file)
- Two worlds exist: (1) MANUAL: the operator enters courier + tracking number + optional URL and later adds tracking events by hand; (2) PROVIDER: the backend plans, creates provider orders, assigns AWBs, schedules pickup, receives webhooks, and reconciles. Which UI is common to both, and which is only for the provider world? Design so that switching SHIPPING_PROVIDER from none to shiprocket later reveals features without redesign.
- GET /v1/admin/shipping/provider tells you provider name, configured, reachable, wallet balance and pickup locations. How should the page look and behave when provider = manual?
- The shipment state machine and exception queue (NDR, RTO, stuck, unmapped statuses): even in manual mode the operator records events; define which statuses exist and the legal transitions.
- Returns: who decides, when stock is restocked (on receipt, once), how refunds are queued for online-paid orders, partial returns, the return window setting.
- What would cause a double shipment or a lost update, and what UI prevents it (disable after click, idempotent reference, status checks)?

## Scope: what to build
- Fulfilment queue ("Ready to ship" = processing orders), with package details (weight/dimensions from the catalogue, editable with a reason when overriding) and COD amount to collect; in manual mode the primary action is "Add shipment" (courier, tracking number, optional https tracking URL).
- Shipment detail: status, courier, tracking, event timeline, add event (manual), label link when present (GET /v1/admin/shipments/{id}/label), cancel shipment (MFA) where allowed.
- Shipments list with filters (status, courier, exception, stuck, search) and an overview strip (GET /v1/admin/shipments/overview): counts by status, exceptions, stuck.
- Provider mode UI (rendered only when configured=true; otherwise a clear "Shiprocket is not connected: shipments are entered manually" card): plan options (POST /v1/admin/orders/{id}/shipments/plan), Ship (POST /v1/admin/orders/{id}/ship with courier strategy), bulk shipping jobs (POST /v1/admin/shipments/bulk, poll GET /v1/admin/shipments/bulk/{jobId}), manifests (POST /v1/admin/shipments/manifest), wallet balance and pickup locations, serviceability check (POST /v1/admin/shipping/serviceability/check), shipping settings (GET/PUT /v1/admin/shipping/settings).
- Merchant delivery areas: PIN prefix list management (GET/PUT /v1/admin/shipping/pins, MFA) with a PIN tester.
- Returns: list, detail, decide (approve/decline + note), receive (restock once; shows queued refund), with the return window and policy visible.
- Refunds: list and processing for finance (shared with phase 6 screens).

## Backend operations used
- GET /v1/admin/shipping/provider, /ready, /settings, PUT /settings, /pickup-locations, /pins, PUT /pins, POST /serviceability/check.
- POST /v1/admin/orders/{id}/shipments (manual) and GET /v1/admin/orders/{id}/shipments; POST /v1/admin/shipments/{id}/events (manual events); GET /v1/admin/shipments, /overview, /{id}, POST /{id}/cancel, GET /{id}/label.
- POST /v1/admin/orders/{id}/shipments/plan, POST /v1/admin/orders/{id}/ship, POST /v1/admin/shipments/bulk, GET /v1/admin/shipments/bulk/{jobId}, POST /v1/admin/shipments/manifest.
- GET /v1/admin/returns; POST /v1/admin/returns/{id}/decide; POST /v1/admin/returns/{id}/receive.

## Experience requirements
- Never present provider features as working when they are mock-tested only: add a small "Not yet verified against the live courier" note in the provider settings area.
- Bulk operations show per-order results; a failure never blocks the rest.
- Printing: labels open in a new tab through the API proxy (never expose storage URLs).

## Edge cases and failure modes you must handle
- Shipping an order that is not processing (blocked with the backend reason); unserviceable PIN; wallet low (resumable); provider timeout after accept (the backend resumes by reference: show "in progress, safe to retry").
- Duplicate tracking numbers for the same courier (backend rejects; show the field error).
- RTO and NDR events never auto-cancel or refund orders: the UI explains that finance/support decide.

## Acceptance criteria (each needs evidence)
- Manual flow end to end: order processing, add shipment, add events through delivered, the customer API shows the tracking (verify with the customer endpoint).
- With SHIPPING_PROVIDER=fake (dev only; set it in the local backend env) the provider flow works end to end including webhooks simulated by the backend dev helpers or tests: demonstrate and record how.
- Returns flow: request a return as a customer (API), decide and receive in the dashboard, see stock restocked once and a refund queued for an online-paid test order.
- Role matrix verified: fulfilment ships; support only reads; finance processes refunds.

## Verification
- Run the manual flow with a real browser; screenshot each state.
- Run the provider flow against the fake provider and clearly label the evidence as "fake provider, not Shiprocket".

## Handoff to the next phase (write these down)
- What is verified vs mocked.
- The checklist to run when real Shiprocket credentials exist.

## How to run this phase (mandatory ritual: do not skip or compress any step)

### Step 1: Re-ground (no code yet)
- Read every file in "Read first" above. Re-read the "Ground rules" in 00_PASTE_THIS_FIRST.md and the Handoff notes of the previous phase in docs/build/DASH_PROGRESS.md.
- List, in docs/build/phase-07-thinking.md, the exact backend operations this phase uses, each verified to exist in docs/backend-contract/api-index.md. For any operation whose request/response is only typed as "object" in openapi.yaml, call it on the running backend and record the real shape.

### Step 2: Think at 100x depth (write it down; thinking that is not written does not count)
Create docs/build/phase-07-thinking.md and fill ALL of these sections with specific, non-generic content:
1. **Users and jobs**: each role that touches this phase, the 5 jobs they do most, and what "fast and safe" means for each.
2. **State and data flow**: every state machine and data flow involved (draw as text diagrams), including loading, empty, error, offline, permission-denied, conflict and stale states.
3. **Deep-think questions**: answer every question under "Think about before building" in this file, with the decision you took and the alternative you rejected and why.
4. **Pre-mortem**: 10 realistic ways this phase fails in production (wrong data shown, double submit, leaked PII, lost draft, slow list, race condition, misleading number, role bypass, contract drift, accessibility failure) and the specific control for each.
5. **Security and privacy**: threats and mitigations for the data this phase handles.
6. **Performance and accessibility budgets**: numbers (for example list render under 100 ms for 50 rows, keyboard path for every action).
7. **Test plan**: unit, component, integration (real backend), e2e per role, visual where relevant; list the test names before writing them.
8. **Slices**: the build order as vertical slices, each independently demonstrable.

### Step 3: Challenge your own plan
Re-read your thinking file as a skeptical senior reviewer. Find at least 5 weaknesses (missed state, hidden coupling, unclear ownership of data, unproven assumption about the backend) and fix the plan. Write "Review findings and changes" at the end of the thinking file.

### Step 4: Build slice by slice
- Implement one slice at a time; after each slice run typecheck, lint, unit tests, and exercise it in the browser against the REAL local backend. Commit small, with messages that say what and why.
- Follow the component library, tokens, API layer, form kit and permission helpers from earlier phases. Do not duplicate them; improve them if they fall short and note it in DASH_DECISIONS.md.
- If the backend lacks something (an endpoint, a filter, a field), do NOT invent it and do NOT fake it in shipped code: record it in docs/build/BACKEND_REQUESTS.md with the proposed shape and a workaround, then continue.

### Step 5: Verify with evidence
Run everything under "Verification" below. Evidence means real outputs: test logs, screenshots at 375/768/1440 px, curl or network traces, audit-log entries. Claims without evidence are not accepted. Test every role listed in the permission matrix that can or cannot do things in this phase, including the negative cases.

### Step 6: Reflect and hand off
- Update docs/build/DASH_PROGRESS.md (what was built, evidence links, what is verified vs not), DASH_DECISIONS.md (new ADRs), DASH_RISKS.md, DASH_PARITY.md, BACKEND_REQUESTS.md.
- Write the Handoff section for the next phase (what it must know) at the end of the thinking file and in DASH_PROGRESS.md.
- Tick every acceptance criterion below with the evidence that proves it. If any criterion fails, fix it before moving on; if it cannot be fixed, record it honestly as a known issue with an owner decision needed.
- Print the **Phase report** (format in 00_PASTE_THIS_FIRST.md) and then begin the next phase's Step 1. Stop and ask the owner ONLY when a genuine owner decision is needed (batch your questions with defaults).


---

# PHASE 08 of 20: Catalogue, pricing and inventory

> Ritual reminder: Re-ground, then Think at 100x (written), then Challenge the plan, then Build in slices, then Verify with evidence, then Reflect and hand off. The thinking file for this phase is docs/build/phase-08-thinking.md.

## Mission
Operators manage what is sold: products, variants (shipping attributes, HSN), categories, collections, tags and SEO, prices, stock, CSV import/export, with safe workflows and a full audit trail.

## Read first
- api-index: admin/products, admin/categories, admin/collections, admin/catalog, admin/inventory, admin/media
- The data rules: price paise integers, compare-at price, HSN 4-8 digits, weight/dimensions, archive vs delete, stock ledger is append-only, reserved stock cannot be adjusted below

## Think about before building (answer each in your thinking file)
- The catalogue is the base of the whole business: what mistakes are expensive (wrong price live, stock set to 0 by accident, a product archived while in carts)? Design the confirmations and previews that prevent each.
- Price changes bump the backend rules version and invalidate open quotes. What should the operator be told before saving?
- Product media currently reference bundled app asset paths and optionally library media: how do you present and edit both honestly?
- CSV import is all-or-nothing with dry-run: design the review UX (row errors, diffs, counts, downloadable error report) and the formula-injection safeguards on export.
- Inventory adjustments: reason required, expectedVersion, MFA; low-stock thresholds; what does "reserved" mean to an operator (online orders in payment window)?

## Scope: what to build
- Products list (search, category, active/archived, low stock, tags) and a product editor in sections: basics (name, subtitle, description, key benefits, suitable surfaces, box contents), category, tags, SEO title/description with counters and a search-result preview, variants (title, SKU unique, price, compare-at with percent-off preview, active, weight grams, L/W/H mm, HSN, barcode, cost price visible to admin/finance only), media attachments (reorder), status (active/archived), version/audit history panel.
- Actions: create, duplicate, archive/restore, add variant; every save shows a diff of what changes, and price changes show "open checkout quotes become stale".
- Categories: CRUD, drag reorder (PUT /v1/admin/categories/order), image, description; delete only when empty (show backend refusal).
- Collections: manual (ordered product picker) and rule-based (tag/category rules per schema), preview of resolved products, visibility, SEO.
- CSV: export (GET /v1/admin/catalog/export) and import (POST /v1/admin/catalog/import?dryRun=true then commit) with a step wizard and error report.
- Inventory: stock table (on hand, reserved, available, threshold), adjust (delta + reason + expectedVersion + MFA), ledger view per variant (append-only movements), low-stock queue, bulk stock take via CSV if the API supports it (otherwise record a request).

## Backend operations used
- GET/POST /v1/admin/products; GET/PATCH /v1/admin/products/{id}; PUT /v1/admin/products/{id}/media; POST /v1/admin/products/{id}/variants|archive|restore|duplicate; categories and collections CRUD + PUT /v1/admin/categories/order; GET /v1/admin/catalog/export; POST /v1/admin/catalog/import; inventory endpoints under /v1/admin/inventory and /v1/admin/catalog/variants (read exact paths from api-index).

## Experience requirements
- Autosave drafts of long forms locally; explicit Save; leave-page guard.
- Slug/id fields are immutable after creation and explained.
- Field-level server validation errors appear inline.

## Edge cases and failure modes you must handle
- Editing a product that has live orders (order snapshots are immutable: say so), archiving a product that is in carts (cart shows unavailable), duplicate SKU, negative or absurd prices, compare-at below price.
- Importing a 5,000-row CSV with 3 bad rows (nothing is applied; show them).
- Stock adjustments racing with checkout (expectedVersion conflict).

## Acceptance criteria (each needs evidence)
- Create a product with two variants, set stock, see it on the customer API (GET /v1/products) and in the website; archive it; restore it.
- CSV round-trip: export, edit a price, dry-run import shows exactly one change, commit, verify via the API.
- Every mutation appears in the audit log with before/after.
- Role matrix: catalog edits; support/finance read; fulfilment adjusts inventory only if the matrix says so.

## Verification
- Playwright flows for create/edit/archive/CSV/inventory adjust against the real backend; screenshots of the diff-before-save dialog.

## Handoff to the next phase (write these down)
- Field tables for product, variant, collection rules.
- Any missing endpoint (record in BACKEND_REQUESTS).

## How to run this phase (mandatory ritual: do not skip or compress any step)

### Step 1: Re-ground (no code yet)
- Read every file in "Read first" above. Re-read the "Ground rules" in 00_PASTE_THIS_FIRST.md and the Handoff notes of the previous phase in docs/build/DASH_PROGRESS.md.
- List, in docs/build/phase-08-thinking.md, the exact backend operations this phase uses, each verified to exist in docs/backend-contract/api-index.md. For any operation whose request/response is only typed as "object" in openapi.yaml, call it on the running backend and record the real shape.

### Step 2: Think at 100x depth (write it down; thinking that is not written does not count)
Create docs/build/phase-08-thinking.md and fill ALL of these sections with specific, non-generic content:
1. **Users and jobs**: each role that touches this phase, the 5 jobs they do most, and what "fast and safe" means for each.
2. **State and data flow**: every state machine and data flow involved (draw as text diagrams), including loading, empty, error, offline, permission-denied, conflict and stale states.
3. **Deep-think questions**: answer every question under "Think about before building" in this file, with the decision you took and the alternative you rejected and why.
4. **Pre-mortem**: 10 realistic ways this phase fails in production (wrong data shown, double submit, leaked PII, lost draft, slow list, race condition, misleading number, role bypass, contract drift, accessibility failure) and the specific control for each.
5. **Security and privacy**: threats and mitigations for the data this phase handles.
6. **Performance and accessibility budgets**: numbers (for example list render under 100 ms for 50 rows, keyboard path for every action).
7. **Test plan**: unit, component, integration (real backend), e2e per role, visual where relevant; list the test names before writing them.
8. **Slices**: the build order as vertical slices, each independently demonstrable.

### Step 3: Challenge your own plan
Re-read your thinking file as a skeptical senior reviewer. Find at least 5 weaknesses (missed state, hidden coupling, unclear ownership of data, unproven assumption about the backend) and fix the plan. Write "Review findings and changes" at the end of the thinking file.

### Step 4: Build slice by slice
- Implement one slice at a time; after each slice run typecheck, lint, unit tests, and exercise it in the browser against the REAL local backend. Commit small, with messages that say what and why.
- Follow the component library, tokens, API layer, form kit and permission helpers from earlier phases. Do not duplicate them; improve them if they fall short and note it in DASH_DECISIONS.md.
- If the backend lacks something (an endpoint, a filter, a field), do NOT invent it and do NOT fake it in shipped code: record it in docs/build/BACKEND_REQUESTS.md with the proposed shape and a workaround, then continue.

### Step 5: Verify with evidence
Run everything under "Verification" below. Evidence means real outputs: test logs, screenshots at 375/768/1440 px, curl or network traces, audit-log entries. Claims without evidence are not accepted. Test every role listed in the permission matrix that can or cannot do things in this phase, including the negative cases.

### Step 6: Reflect and hand off
- Update docs/build/DASH_PROGRESS.md (what was built, evidence links, what is verified vs not), DASH_DECISIONS.md (new ADRs), DASH_RISKS.md, DASH_PARITY.md, BACKEND_REQUESTS.md.
- Write the Handoff section for the next phase (what it must know) at the end of the thinking file and in DASH_PROGRESS.md.
- Tick every acceptance criterion below with the evidence that proves it. If any criterion fails, fix it before moving on; if it cannot be fixed, record it honestly as a known issue with an owner decision needed.
- Print the **Phase report** (format in 00_PASTE_THIS_FIRST.md) and then begin the next phase's Step 1. Stop and ask the owner ONLY when a genuine owner decision is needed (batch your questions with defaults).


---

# PHASE 09 of 20: Media library: upload, provenance, approval, usage and bundled assets

> Ritual reminder: Re-ground, then Think at 100x (written), then Challenge the plan, then Build in slices, then Verify with evidence, then Reflect and hand off. The thinking file for this phase is docs/build/phase-09-thinking.md.

## Mission
One governed place for every image, video and font the Studio and catalogue use, with provenance (who owns the rights) and approval before anything can be published.

## Read first
- api-index: admin/media
- 02_EXPERIENCE_STUDIO_SPEC.md section 5 (shared building blocks) on MediaRef
- Media rules: content-addressed storage (sha256), images converted to WebP variants, mp4/webm stored as-is (no video probing: width/height/duration may be null), fonts stored as-is, provenance and approval required before use, "bundled_key" links a library item to an asset shipped inside the app binary

## Think about before building (answer each in your thinking file)
- A mistake here is a legal or brand risk (unlicensed photo, a customer's face without consent). What gates make the safe path the easy path (approval state machine, provenance fields, usage tracking, refusal to archive in-use media)?
- Large uploads from a phone or laptop: chunking? Limits? What does the backend accept (see the openapi request body and the JSON body limits) and how do you handle a refusal gracefully?
- The app can only display images that are either bundled in the binary (bundled_key) or fetched from /v1/media/{sha}/{file}. How do you explain "bundled" vs "uploaded" to a non-technical operator?
- Accessibility: alt text is mandatory for images; how do you make that the path of least resistance?
- How will you show video honestly when duration and dimensions are unknown?

## Scope: what to build
- Library grid and list views with filters (type, approval state, provenance, tag, in use / unused, archived), search, multi-select, usage badges.
- Upload flow (drag-drop, paste, multi-file) with progress, per-file errors, type sniffing feedback, required fields (alt text, provenance type + note, rights holder), then "Submit for approval".
- Detail drawer: preview (image zoom, video player, font specimen), metadata edit (PATCH), approve/reject (permission-gated, with reason on reject), archive/restore, "Where used" (GET /v1/admin/media/{id}/usage with links to the documents/entities), copy public URL, replace file is NOT supported (content-addressed): explain and offer "upload new + swap in usage".
- Approval queue view for reviewers; dashboard queue count (feeds phase 5).
- Bundled assets mapping tool: list media with bundled_key, and a guide for linking an uploaded item to an asset path in the app (admin-only action if the API supports PATCH of bundled_key; otherwise record in BACKEND_REQUESTS).

## Backend operations used
- POST /v1/admin/media (multipart or binary per openapi), GET /v1/admin/media, GET/PATCH /v1/admin/media/{id}, POST /v1/admin/media/{id}/approve|reject|archive|restore, GET /v1/admin/media/{id}/usage.

## Experience requirements
- Thumbnails load lazily; the grid is virtualised past 200 items.
- A mandatory alt-text field with a "decorative" explicit toggle.
- Rejected items stay visible with the reason.

## Edge cases and failure modes you must handle
- Duplicate upload of the same bytes (content-addressed: show "already in library"), huge files, wrong MIME, SVG (treat as untrusted: the backend decides; show its refusal), corrupt images, concurrent approve by two reviewers.
- Archiving media that is in use is refused: show where it is used.

## Acceptance criteria (each needs evidence)
- Upload an image and a video; both appear; approve; they are served publicly from /v1/media/... with correct headers (verify with curl: immutable cache, Range support for video).
- Usage list is correct after a Studio document references the media (verify again in phase 12/13).
- Axe clean; keyboard-only upload and approve works.

## Verification
- Playwright upload/approve/archive-refusal flows against the real backend with real files from the app and website asset folders.

## Handoff to the next phase (write these down)
- MediaPicker component API (used by every Studio editor).
- The provenance vocabulary.

## How to run this phase (mandatory ritual: do not skip or compress any step)

### Step 1: Re-ground (no code yet)
- Read every file in "Read first" above. Re-read the "Ground rules" in 00_PASTE_THIS_FIRST.md and the Handoff notes of the previous phase in docs/build/DASH_PROGRESS.md.
- List, in docs/build/phase-09-thinking.md, the exact backend operations this phase uses, each verified to exist in docs/backend-contract/api-index.md. For any operation whose request/response is only typed as "object" in openapi.yaml, call it on the running backend and record the real shape.

### Step 2: Think at 100x depth (write it down; thinking that is not written does not count)
Create docs/build/phase-09-thinking.md and fill ALL of these sections with specific, non-generic content:
1. **Users and jobs**: each role that touches this phase, the 5 jobs they do most, and what "fast and safe" means for each.
2. **State and data flow**: every state machine and data flow involved (draw as text diagrams), including loading, empty, error, offline, permission-denied, conflict and stale states.
3. **Deep-think questions**: answer every question under "Think about before building" in this file, with the decision you took and the alternative you rejected and why.
4. **Pre-mortem**: 10 realistic ways this phase fails in production (wrong data shown, double submit, leaked PII, lost draft, slow list, race condition, misleading number, role bypass, contract drift, accessibility failure) and the specific control for each.
5. **Security and privacy**: threats and mitigations for the data this phase handles.
6. **Performance and accessibility budgets**: numbers (for example list render under 100 ms for 50 rows, keyboard path for every action).
7. **Test plan**: unit, component, integration (real backend), e2e per role, visual where relevant; list the test names before writing them.
8. **Slices**: the build order as vertical slices, each independently demonstrable.

### Step 3: Challenge your own plan
Re-read your thinking file as a skeptical senior reviewer. Find at least 5 weaknesses (missed state, hidden coupling, unclear ownership of data, unproven assumption about the backend) and fix the plan. Write "Review findings and changes" at the end of the thinking file.

### Step 4: Build slice by slice
- Implement one slice at a time; after each slice run typecheck, lint, unit tests, and exercise it in the browser against the REAL local backend. Commit small, with messages that say what and why.
- Follow the component library, tokens, API layer, form kit and permission helpers from earlier phases. Do not duplicate them; improve them if they fall short and note it in DASH_DECISIONS.md.
- If the backend lacks something (an endpoint, a filter, a field), do NOT invent it and do NOT fake it in shipped code: record it in docs/build/BACKEND_REQUESTS.md with the proposed shape and a workaround, then continue.

### Step 5: Verify with evidence
Run everything under "Verification" below. Evidence means real outputs: test logs, screenshots at 375/768/1440 px, curl or network traces, audit-log entries. Claims without evidence are not accepted. Test every role listed in the permission matrix that can or cannot do things in this phase, including the negative cases.

### Step 6: Reflect and hand off
- Update docs/build/DASH_PROGRESS.md (what was built, evidence links, what is verified vs not), DASH_DECISIONS.md (new ADRs), DASH_RISKS.md, DASH_PARITY.md, BACKEND_REQUESTS.md.
- Write the Handoff section for the next phase (what it must know) at the end of the thinking file and in DASH_PROGRESS.md.
- Tick every acceptance criterion below with the evidence that proves it. If any criterion fails, fix it before moving on; if it cannot be fixed, record it honestly as a known issue with an owner decision needed.
- Print the **Phase report** (format in 00_PASTE_THIS_FIRST.md) and then begin the next phase's Step 1. Stop and ask the owner ONLY when a genuine owner decision is needed (batch your questions with defaults).


---

# PHASE 10 of 20: Experience Studio I: workspace, document model and the schema-driven editor engine

> Ritual reminder: Re-ground, then Think at 100x (written), then Challenge the plan, then Build in slices, then Verify with evidence, then Reflect and hand off. The thinking file for this phase is docs/build/phase-10-thinking.md.

## Mission
Build the core of the "control everything" promise: a workspace for the two channels (app and website), a document list with revisions, and a generic editor engine that renders forms and live validation from the backend's block schemas, so every block type gets an editor without bespoke code for each field.

## Read first
- docs/backend-contract/02_EXPERIENCE_STUDIO_SPEC.md IN FULL (it is long: it is the product spec)
- docs/backend-contract/blocks.schema.json (generated from the real backend validators: 34 block types, page/tokens/navigation/chrome documents, Action, MediaRef, VisibilityRules, BlockStyle, Seo)
- api-index: admin/experience/*, admin/content-library/*
- 03_BACKEND_CONTRACT.md "Implementation status" (preview, overrides, testimonials by id)
- 01_REFERENCE_ANALYSIS_BAKALOO.md section 3 (builder mechanics to replicate and what changes)

## Think about before building (answer each in your thinking file)
- Restate the model in your own words: channels (app, web), shared documents, kinds (tokens, navigation, chrome, page), keys, revisions with If-Match, draft vs released, immutable releases, scheduled activation, kill switch, preview tokens, campaigns, variables {{store.*}}, content-library entities referenced by id. Draw the data flow from "operator edits" to "customer app renders".
- Schema-driven editing: how do you render a form from JSON Schema (OpenAPI 3.0 dialect) with discriminated unions (Action), arrays with min/max, optional objects, enums, string length limits, regex patterns (hex colours), nested objects, and refinements the schema cannot express (for example ritual_steps needs guideId XOR steps)? Where must you hand-write editors, and where can the engine handle it? Decide a plugin point for custom field widgets (MediaRef picker, Action picker, Colour role picker, Product source picker, Rich text, ID generator).
- The backend validates strictly (unknown keys are rejected) and returns field paths on errors. How do you map error paths to the right nested field, including array indexes?
- Concurrency and collaboration: two designers editing the same page. If-Match, presence (PUT /presence heartbeat), conflict UX, draft recovery. What happens when a block type is removed from the schema in a future backend version? (Unknown block rendering and "needs migration" state.)
- Undo/redo and autosave: autosave is a server write creating a revision on every save: how often is sane? Local undo stack with server saves debounced and explicit "Save revision" semantics: decide and document.
- What are the performance limits (30 app blocks, 40 web blocks per page, 512kb JSON limit)? How do you keep the editor fast with 40 blocks?

## Scope: what to build
- Studio shell under /studio with a channel switcher (App | Website) that always makes it unmistakable which channel you are editing, and a left tree: Design (tokens), Navigation, Chrome, Pages (home, category, product, cart for app; home, shop, product, ritual, story for web), Content library, Releases, Campaigns.
- Document list per channel (GET /v1/admin/experience/{channel}/docs) with status (draft differs from released?), last editor, revision count, validation badge (errors/warnings) and quick actions.
- Generic Document editor page: load (GET .../docs/{kind}/{key}), edit, save with If-Match (PUT), delete where allowed, revision history (GET .../revisions) with view and restore-as-new-draft, dirty tracking, conflict dialog (server copy returned on 409 ETAG_MISMATCH).
- THE ENGINE (src/features/studio/engine): a schema-to-form renderer with the plugin registry; field-level help text; path-aware error display; a JSON view tab (read/write) for power users with schema validation; copy/paste of blocks as JSON; import/export of a document as a file.
- Block list editor primitive: add (palette filtered by channel and page rules), reorder (drag + keyboard), duplicate, delete with undo, visibility toggle, per-block visibility rules (schedule, platform, signed-in) and BlockStyle (spacing, background role, radius) via the engine, block id management (stable ids; never regenerate on duplicate).
- Validation panel (POST /v1/admin/experience/{channel}/validate): runs on demand and debounced after saves; lists errors and warnings with click-to-focus on the offending block/field.
- Presence: PUT/GET /v1/admin/experience/{channel}/presence heartbeat every 20s; show who else is here; warn before overwriting.
- Variables helper: GET /v1/admin/experience/variables powers an insert-variable control in every text field that supports {{store.*}} with a live preview of the substituted value.
- Feature flags per block type from capabilities: some blocks are held back from older app builds ("minBuild"): surface this in the palette.

## Backend operations used
- GET /v1/admin/experience/state; GET /v1/admin/experience/variables; GET /v1/admin/experience/{channel}/docs; GET|PUT|DELETE /v1/admin/experience/{channel}/docs/{kind}/{key} (If-Match required on PUT); GET .../revisions; POST /v1/admin/experience/{channel}/validate; GET /v1/admin/experience/{channel}/diff; PUT|GET /v1/admin/experience/{channel}/presence.
- Permissions: experience:read (view), experience:write (edit drafts), experience:publish (releases, MFA). Designer and admin edit; catalog and finance read; others cannot open the Studio.

## Experience requirements
- The editor must feel like a design tool, not a form dump: a three-pane layout (structure tree / canvas or preview / inspector) arrives in phases 12-13; in THIS phase the centre pane is a structured form + JSON, designed so the preview can be slotted in.
- Inline help for every field comes from the schema description plus a curated copy file you maintain (docs/build/studio-field-help.md).
- Never lose work: unsaved draft persisted locally per document and per user, restored with a banner.

## Edge cases and failure modes you must handle
- Saving a document that exceeds 512kb or has an unknown block type (clear field errors); a document edited in two tabs; revisions list with 200 entries; restoring a revision created under an older schema version; deleting a document that a release references (backend refuses).
- Large schemas: lazy render collapsed sections; keep typing latency under 16ms (profile it).
- Text fields with markdown (rich_text): allow only the supported subset and show a live safe preview.

## Acceptance criteria (each needs evidence)
- Every one of the 34 block types can be added, edited via the engine, saved and read back unchanged against the REAL backend (automated: a test iterates over blocks.schema.json, builds a minimal valid instance via your engine, saves it, validates, deletes).
- Server field errors land on the right nested field for at least 20 deliberately invalid payloads.
- Conflict flow works across two browser contexts; presence shows the other editor.
- Typing latency budget met on a 40-block page (performance test with a trace).
- Palette respects channel and page rules (app templates allow only the narrower block set).

## Verification
- Run the automated all-blocks round-trip test and paste results.
- Record screenshots of the studio shell for both channels.

## Handoff to the next phase (write these down)
- Plugin registry API and the list of custom widgets built.
- The error-path mapping algorithm.
- Schema features the engine does not support yet and the fallbacks.

## How to run this phase (mandatory ritual: do not skip or compress any step)

### Step 1: Re-ground (no code yet)
- Read every file in "Read first" above. Re-read the "Ground rules" in 00_PASTE_THIS_FIRST.md and the Handoff notes of the previous phase in docs/build/DASH_PROGRESS.md.
- List, in docs/build/phase-10-thinking.md, the exact backend operations this phase uses, each verified to exist in docs/backend-contract/api-index.md. For any operation whose request/response is only typed as "object" in openapi.yaml, call it on the running backend and record the real shape.

### Step 2: Think at 100x depth (write it down; thinking that is not written does not count)
Create docs/build/phase-10-thinking.md and fill ALL of these sections with specific, non-generic content:
1. **Users and jobs**: each role that touches this phase, the 5 jobs they do most, and what "fast and safe" means for each.
2. **State and data flow**: every state machine and data flow involved (draw as text diagrams), including loading, empty, error, offline, permission-denied, conflict and stale states.
3. **Deep-think questions**: answer every question under "Think about before building" in this file, with the decision you took and the alternative you rejected and why.
4. **Pre-mortem**: 10 realistic ways this phase fails in production (wrong data shown, double submit, leaked PII, lost draft, slow list, race condition, misleading number, role bypass, contract drift, accessibility failure) and the specific control for each.
5. **Security and privacy**: threats and mitigations for the data this phase handles.
6. **Performance and accessibility budgets**: numbers (for example list render under 100 ms for 50 rows, keyboard path for every action).
7. **Test plan**: unit, component, integration (real backend), e2e per role, visual where relevant; list the test names before writing them.
8. **Slices**: the build order as vertical slices, each independently demonstrable.

### Step 3: Challenge your own plan
Re-read your thinking file as a skeptical senior reviewer. Find at least 5 weaknesses (missed state, hidden coupling, unclear ownership of data, unproven assumption about the backend) and fix the plan. Write "Review findings and changes" at the end of the thinking file.

### Step 4: Build slice by slice
- Implement one slice at a time; after each slice run typecheck, lint, unit tests, and exercise it in the browser against the REAL local backend. Commit small, with messages that say what and why.
- Follow the component library, tokens, API layer, form kit and permission helpers from earlier phases. Do not duplicate them; improve them if they fall short and note it in DASH_DECISIONS.md.
- If the backend lacks something (an endpoint, a filter, a field), do NOT invent it and do NOT fake it in shipped code: record it in docs/build/BACKEND_REQUESTS.md with the proposed shape and a workaround, then continue.

### Step 5: Verify with evidence
Run everything under "Verification" below. Evidence means real outputs: test logs, screenshots at 375/768/1440 px, curl or network traces, audit-log entries. Claims without evidence are not accepted. Test every role listed in the permission matrix that can or cannot do things in this phase, including the negative cases.

### Step 6: Reflect and hand off
- Update docs/build/DASH_PROGRESS.md (what was built, evidence links, what is verified vs not), DASH_DECISIONS.md (new ADRs), DASH_RISKS.md, DASH_PARITY.md, BACKEND_REQUESTS.md.
- Write the Handoff section for the next phase (what it must know) at the end of the thinking file and in DASH_PROGRESS.md.
- Tick every acceptance criterion below with the evidence that proves it. If any criterion fails, fix it before moving on; if it cannot be fixed, record it honestly as a known issue with an owner decision needed.
- Print the **Phase report** (format in 00_PASTE_THIS_FIRST.md) and then begin the next phase's Step 1. Stop and ask the owner ONLY when a genuine owner decision is needed (batch your questions with defaults).


---

# PHASE 11 of 20: Experience Studio II: design system tokens, navigation and app/web chrome

> Ritual reminder: Re-ground, then Think at 100x (written), then Challenge the plan, then Build in slices, then Verify with evidence, then Reflect and hand off. The thinking file for this phase is docs/build/phase-11-thinking.md.

## Mission
Let the operator control the visual language and the frame of each channel: colours, typography, shape, spacing, navigation items, header/footer/tab bar, brand slots, with instant visual feedback and guard rails against unreadable or off-brand results.

## Read first
- 02_EXPERIENCE_STUDIO_SPEC.md section 3 (Design System) and section 4/5
- blocks.schema.json: docs.tokens, docs.navigation, docs.chrome, colorRoles, brandSlots
- 03_BACKEND_CONTRACT.md "Implementation status": override tokens are stored as {overrides: ...} and must be a subset of base

## Think about before building (answer each in your thinking file)
- Tokens are semantic roles, never raw per-component colours. What guard rails stop an operator from making the app unreadable (contrast checks computed from the same colour utilities the backend validation uses, minimum touch targets, font-size floors)? Where does the backend validate (and return warnings) vs where must the UI pre-empt?
- Palettes and fonts must STAY AS THEY ARE for now (owner decision): the first release reproduces today's look exactly. How do you present the editor so that the current values are the defaults and "Reset to released" is always one click?
- Fonts: only licensed fonts the library holds (font media items). How do you let the operator choose heading/body fonts without breaking the brand, and how do clients download them (media)?
- Navigation: app tab bar (3-5 items with icons and screens) vs web header links (routes/anchors). Which icons are allowed (enum) and how do you preview them?
- Chrome: header, footer, tab bar, brand slots (logo, splash, empty-state art): which are media refs? How do you show the effect on the real layout?
- Override docs: what are they for (campaign or seasonal overrides as a subset of base) and how do you make the subset rule obvious (only overridden keys are listed; "inherit" is the default)?

## Scope: what to build
- Design system editor for tokens/base (and tokens/override per channel where the schema allows): colour roles with a colour picker + hex input, derived contrast ratios (text on surface, on brand, on card) with AA/AAA badges and a computed "fix suggestion", typography (families from font library, scale, weights, line heights), shape (radii by role), spacing scale, elevation, motion durations, control sizes; each group has a live specimen panel.
- A "tokens diff vs released" view and one-click reset per group; "Compare with baseline" (the seeded first release).
- Navigation editor: app tab bar and web header/footer links, with drag reorder, label, icon (enum), Action picker (screen/route/page/url/tel/mailto/whatsapp/product/collection/category/anchor) with validation and a link checker (internal targets exist, external URLs https).
- Chrome editor: header style, footer content blocks (links, contact, social), announcement defaults, brand slots with MediaPicker (logo, wordmark, splash, empty-state art), legal links.
- Action picker widget (shared with all blocks): resolves human names (product names, collection titles) from the catalogue APIs so operators never type ids.
- Colour and font utilities module (contrast, APCA optional) with unit tests, mirroring the backend color.ts semantics: read the backend contract notes and test against known pairs.

## Backend operations used
- GET|PUT /v1/admin/experience/{channel}/docs/tokens/{base|override}, /docs/navigation/main, /docs/chrome/main (shared docs use channel "shared" where the schema says so: confirm in api-index), validation via POST .../validate, media via the library (phase 9).

## Experience requirements
- A dense but calm inspector; colour changes preview instantly in the specimen and (from phases 12-13) in the live preview.
- Warnings explain the consequence ("Body text on cards is 3.9:1; below AA 4.5:1") and offer fixes.
- Keyboard-accessible colour picking (hex field first, then picker).

## Edge cases and failure modes you must handle
- Transparent/alpha hex values, colours with insufficient contrast but allowed as decoration, deleting a font that tokens reference, nav item pointing to a deleted product/collection, duplicate nav ids, too many tab items.
- Override document that tries to set keys not present in base (backend refuses): the UI prevents it.

## Acceptance criteria (each needs evidence)
- Editing tokens, navigation and chrome round-trips through the backend; the validate endpoint's warnings appear in the UI.
- Contrast utility matches backend results on a fixture set of 30 colour pairs (test).
- Reset-to-released and compare-with-baseline work.
- Action picker produces only valid Actions for the channel (app screens vs web routes).

## Verification
- Screenshots of the editor and specimen; run the contrast fixture test; run the all-blocks round trip again (nothing regressed).

## Handoff to the next phase (write these down)
- Action picker and MediaPicker API.
- Which token groups the clients actually honour today (check docs/backend-contract/05_CLIENT_INTEGRATION_SPEC.md; note anything the clients do not yet read).

## How to run this phase (mandatory ritual: do not skip or compress any step)

### Step 1: Re-ground (no code yet)
- Read every file in "Read first" above. Re-read the "Ground rules" in 00_PASTE_THIS_FIRST.md and the Handoff notes of the previous phase in docs/build/DASH_PROGRESS.md.
- List, in docs/build/phase-11-thinking.md, the exact backend operations this phase uses, each verified to exist in docs/backend-contract/api-index.md. For any operation whose request/response is only typed as "object" in openapi.yaml, call it on the running backend and record the real shape.

### Step 2: Think at 100x depth (write it down; thinking that is not written does not count)
Create docs/build/phase-11-thinking.md and fill ALL of these sections with specific, non-generic content:
1. **Users and jobs**: each role that touches this phase, the 5 jobs they do most, and what "fast and safe" means for each.
2. **State and data flow**: every state machine and data flow involved (draw as text diagrams), including loading, empty, error, offline, permission-denied, conflict and stale states.
3. **Deep-think questions**: answer every question under "Think about before building" in this file, with the decision you took and the alternative you rejected and why.
4. **Pre-mortem**: 10 realistic ways this phase fails in production (wrong data shown, double submit, leaked PII, lost draft, slow list, race condition, misleading number, role bypass, contract drift, accessibility failure) and the specific control for each.
5. **Security and privacy**: threats and mitigations for the data this phase handles.
6. **Performance and accessibility budgets**: numbers (for example list render under 100 ms for 50 rows, keyboard path for every action).
7. **Test plan**: unit, component, integration (real backend), e2e per role, visual where relevant; list the test names before writing them.
8. **Slices**: the build order as vertical slices, each independently demonstrable.

### Step 3: Challenge your own plan
Re-read your thinking file as a skeptical senior reviewer. Find at least 5 weaknesses (missed state, hidden coupling, unclear ownership of data, unproven assumption about the backend) and fix the plan. Write "Review findings and changes" at the end of the thinking file.

### Step 4: Build slice by slice
- Implement one slice at a time; after each slice run typecheck, lint, unit tests, and exercise it in the browser against the REAL local backend. Commit small, with messages that say what and why.
- Follow the component library, tokens, API layer, form kit and permission helpers from earlier phases. Do not duplicate them; improve them if they fall short and note it in DASH_DECISIONS.md.
- If the backend lacks something (an endpoint, a filter, a field), do NOT invent it and do NOT fake it in shipped code: record it in docs/build/BACKEND_REQUESTS.md with the proposed shape and a workaround, then continue.

### Step 5: Verify with evidence
Run everything under "Verification" below. Evidence means real outputs: test logs, screenshots at 375/768/1440 px, curl or network traces, audit-log entries. Claims without evidence are not accepted. Test every role listed in the permission matrix that can or cannot do things in this phase, including the negative cases.

### Step 6: Reflect and hand off
- Update docs/build/DASH_PROGRESS.md (what was built, evidence links, what is verified vs not), DASH_DECISIONS.md (new ADRs), DASH_RISKS.md, DASH_PARITY.md, BACKEND_REQUESTS.md.
- Write the Handoff section for the next phase (what it must know) at the end of the thinking file and in DASH_PROGRESS.md.
- Tick every acceptance criterion below with the evidence that proves it. If any criterion fails, fix it before moving on; if it cannot be fixed, record it honestly as a known issue with an owner decision needed.
- Print the **Phase report** (format in 00_PASTE_THIS_FIRST.md) and then begin the next phase's Step 1. Stop and ask the owner ONLY when a genuine owner decision is needed (batch your questions with defaults).


---

# PHASE 12 of 20: Experience Studio III: app page builder with a faithful phone preview

> Ritual reminder: Re-ground, then Think at 100x (written), then Challenge the plan, then Build in slices, then Verify with evidence, then Reflect and hand off. The thinking file for this phase is docs/build/phase-12-thinking.md.

## Mission
Compose the mobile app's Home, Category, Product and Cart pages from the app block library, see them rendered like the Flutter app, and validate before publishing.

## Read first
- 02_EXPERIENCE_STUDIO_SPEC.md section 6 (block libraries: app), section 8 (authoring UX), section 10 (preview architecture)
- The Flutter app screens for fidelity reference: C:/Users/MSI/OneDrive/Desktop/jimmy&wax_app/lib/main.dart (HomeScreen, HeroBanner, CategoriesScreen, TestimonialSection), lib/core/theme/*, docs/UI_INVENTORY.md
- blocks.schema.json: all app.* blocks, nativeSections for native pages
- 03_BACKEND_CONTRACT.md "Implementation status" (preview is served by commerce-api: GET /v1/experience/{channel}/preview?token=)

## Think about before building (answer each in your thinking file)
- The app is native Flutter. The dashboard cannot embed it. What is the preview strategy? Options: (A) a React re-implementation of each app block that reads the same tokens and bundle JSON (fidelity badge, side-by-side with real device screenshots for acceptance), (B) screenshots from a Flutter web build, (C) later: Flutter web embedded in an iframe fed by a preview token. Decide, with the trade-offs, and design the preview as a pluggable "Renderer" so you can swap later.
- Which blocks are the home page today? Map each current Flutter section (hero carousel, category shortcuts, product rails, benefits, testimonial section, care ritual, promo cards, announcement) to a block, and list anything on the real home that the block library cannot express (record in BACKEND_REQUESTS).
- Native pages (cart, product detail) are not freely composable: nativeSections let the operator toggle and reorder native sections only. How do you present "fixed vs editable" so the operator is never surprised?
- Data-driven blocks (product rails by collection/category/manual/bestsellers/newest; testimonials from verified reviews or curated ids): the preview needs live data: which public endpoints supply it (GET /v1/products, /v1/collections/{slug}/products)?
- Device realism: 360x800 and 390x844 frames, safe areas, dark theme only, large text scale, offline/empty catalogue, slow network skeletons.

## Scope: what to build
- Three-pane builder: structure tree (blocks with visibility icons, errors), centre phone preview (device frame switcher, text scale, scroll position sync with selection), inspector (the phase-10 engine) plus a block palette drawer.
- React renderers for every app block (hero_carousel with autoplay settings, category_shortcuts rings, product_rail, benefits_row, testimonials, care_ritual, promo_cards, announcement_bar, banner, rich_text, faq, trust_strip, spacer), all driven by tokens (from the tokens doc) and real media URLs from the library; a "bundled asset" resolver that shows the app's asset images when media has a bundled_key (the dashboard has copies under a configured assets folder or placeholder boxes with the key name).
- Selection sync: click a block in the preview to select it in the tree and inspector and vice versa; drag to reorder in either; inline text editing for headline fields (optional: do last).
- Native sections toggles for product/cart pages (key, visible, order) with explanation.
- Per-block visibility preview: simulate time (schedule), platform, signed-in state with a "Preview as" control.
- Preview with live backend data: product rails call the public read API through the BFF; campaigns overlay (phase 15) toggles.
- Live validation overlay (errors on the offending block in the preview).
- Preview token generation (POST .../preview-tokens) to produce a link/QR the app's preview build can open (dev builds only); list and revoke tokens (DELETE /v1/admin/experience/preview-tokens/{id}).

## Backend operations used
- Everything from phase 10 + POST /v1/admin/experience/{channel}/preview-tokens, DELETE /v1/admin/experience/preview-tokens/{id}, GET /v1/products and collections endpoints (public, via BFF) for live data, GET /v1/admin/content-library/{entity} for testimonials/guides by id.

## Experience requirements
- Preview updates within 100ms of an edit (render from local draft state, not after a save).
- A fidelity banner states which blocks are approximations until real-device screenshots confirm them.
- Mobile-friendly builder is NOT required (a notice appears under 1024px) but all non-Studio pages remain responsive.

## Edge cases and failure modes you must handle
- Missing or unapproved media (placeholder with a clear warning), deleted collection/product in a rail (rail hides that product, warning shows), hero text over bright images (contrast warning when textInImage is true), 8 slides with very long headlines, RTL strings, empty testimonials (placeholders block publishing: show why), unknown future block types (render a labelled stub).
- Very large pages (30 blocks) scrolling performance in the preview.

## Acceptance criteria (each needs evidence)
- The app home page can be recreated from blocks so that, side by side with a real-device/emulator screenshot of the current app home, a reviewer rates the preview "recognisably the same layout" (store both images in docs/qa).
- All app blocks render with realistic data and with missing data without crashing (unit + visual tests).
- Select/reorder/duplicate/delete flows are keyboard accessible.
- Validation errors/warnings appear on the preview and tree.
- Preview token flow works: create, copy, revoke; the commerce-api preview endpoint returns the draft with no-store/noindex headers (curl evidence).

## Verification
- Capture the side-by-side fidelity screenshots; run the all-blocks render tests; run the preview-token curl checks.

## Handoff to the next phase (write these down)
- Renderer interface and the list of approximated blocks.
- Gaps between the real app home and the block library (BACKEND_REQUESTS).

## How to run this phase (mandatory ritual: do not skip or compress any step)

### Step 1: Re-ground (no code yet)
- Read every file in "Read first" above. Re-read the "Ground rules" in 00_PASTE_THIS_FIRST.md and the Handoff notes of the previous phase in docs/build/DASH_PROGRESS.md.
- List, in docs/build/phase-12-thinking.md, the exact backend operations this phase uses, each verified to exist in docs/backend-contract/api-index.md. For any operation whose request/response is only typed as "object" in openapi.yaml, call it on the running backend and record the real shape.

### Step 2: Think at 100x depth (write it down; thinking that is not written does not count)
Create docs/build/phase-12-thinking.md and fill ALL of these sections with specific, non-generic content:
1. **Users and jobs**: each role that touches this phase, the 5 jobs they do most, and what "fast and safe" means for each.
2. **State and data flow**: every state machine and data flow involved (draw as text diagrams), including loading, empty, error, offline, permission-denied, conflict and stale states.
3. **Deep-think questions**: answer every question under "Think about before building" in this file, with the decision you took and the alternative you rejected and why.
4. **Pre-mortem**: 10 realistic ways this phase fails in production (wrong data shown, double submit, leaked PII, lost draft, slow list, race condition, misleading number, role bypass, contract drift, accessibility failure) and the specific control for each.
5. **Security and privacy**: threats and mitigations for the data this phase handles.
6. **Performance and accessibility budgets**: numbers (for example list render under 100 ms for 50 rows, keyboard path for every action).
7. **Test plan**: unit, component, integration (real backend), e2e per role, visual where relevant; list the test names before writing them.
8. **Slices**: the build order as vertical slices, each independently demonstrable.

### Step 3: Challenge your own plan
Re-read your thinking file as a skeptical senior reviewer. Find at least 5 weaknesses (missed state, hidden coupling, unclear ownership of data, unproven assumption about the backend) and fix the plan. Write "Review findings and changes" at the end of the thinking file.

### Step 4: Build slice by slice
- Implement one slice at a time; after each slice run typecheck, lint, unit tests, and exercise it in the browser against the REAL local backend. Commit small, with messages that say what and why.
- Follow the component library, tokens, API layer, form kit and permission helpers from earlier phases. Do not duplicate them; improve them if they fall short and note it in DASH_DECISIONS.md.
- If the backend lacks something (an endpoint, a filter, a field), do NOT invent it and do NOT fake it in shipped code: record it in docs/build/BACKEND_REQUESTS.md with the proposed shape and a workaround, then continue.

### Step 5: Verify with evidence
Run everything under "Verification" below. Evidence means real outputs: test logs, screenshots at 375/768/1440 px, curl or network traces, audit-log entries. Claims without evidence are not accepted. Test every role listed in the permission matrix that can or cannot do things in this phase, including the negative cases.

### Step 6: Reflect and hand off
- Update docs/build/DASH_PROGRESS.md (what was built, evidence links, what is verified vs not), DASH_DECISIONS.md (new ADRs), DASH_RISKS.md, DASH_PARITY.md, BACKEND_REQUESTS.md.
- Write the Handoff section for the next phase (what it must know) at the end of the thinking file and in DASH_PROGRESS.md.
- Tick every acceptance criterion below with the evidence that proves it. If any criterion fails, fix it before moving on; if it cannot be fixed, record it honestly as a known issue with an owner decision needed.
- Print the **Phase report** (format in 00_PASTE_THIS_FIRST.md) and then begin the next phase's Step 1. Stop and ask the owner ONLY when a genuine owner decision is needed (batch your questions with defaults).


---

# PHASE 13 of 20: Experience Studio IV: website page builder, SEO and product page template

> Ritual reminder: Re-ground, then Think at 100x (written), then Challenge the plan, then Build in slices, then Verify with evidence, then Reflect and hand off. The thinking file for this phase is docs/build/phase-13-thinking.md.

## Mission
Compose the website's Home, Shop, Product, Ritual and Story pages from the web block library (cinematic films, marquee, collection grid, ritual steps, testimonials with video, journal stack, promo film, closing CTA) with a desktop/tablet/mobile preview and SEO control.

## Read first
- 02_EXPERIENCE_STUDIO_SPEC.md section 6 (web blocks), section 8-10
- The website: C:/Users/MSI/OneDrive/Desktop/jimmy_nd _wax_website/src/pages/*.tsx and src/components/* (HeroScrub, ScrubFilm, JournalBlock, StoriesBlock, PromoBlock, RitualBlock), src/styles/*.css
- blocks.schema.json: all web.* blocks, seo, PDP_SECTIONS

## Think about before building (answer each in your thinking file)
- Map every section of today's website home to a web block (hero_film, marquee, chapter_mark, collection_grid, ritual_steps, scrub_film/atelier_film, standards_grid, evidence_rail, reels_rail (stories), journal_stack, promo_film, testimonials, closing_cta). What cannot be expressed? (Record it.)
- Preview fidelity: the website is a real web app, so the best preview is the website itself. Today the website does NOT yet consume the bundle. Plan: (1) preview with dashboard-side React renderers that mirror the website's components and CSS tokens now; (2) design the iframe mode (website reads ?preview=token) as the target and specify it in docs/build/WEB_PREVIEW_IFRAME_SPEC.md for the website repo. What are the security implications of rendering the real site in an iframe from the dashboard (frame-ancestors, token in URL, noindex)?
- Film blocks: large video media with desktop/mobile/poster variants. How do you help the operator pick compatible assets and warn about weight (file size budgets, poster mandatory, muted autoplay rules, reduced-motion fallback)?
- SEO per page and per product: title length, description length, canonical, social image, structured data hints; uniqueness across pages (backend enforces title uniqueness on web docs). How do you show the Google-style preview and the duplicate-title conflict?
- Product page template (PDP_SECTIONS: gallery, description, key_benefits, suitable_surfaces, box_contents, info_card, delivery_estimate, reviews, related, pairings): order and visibility per channel, not free composition.
- Testimonials with video are allowed on web only: how is that enforced and explained in the editor?

## Scope: what to build
- The same three-pane builder as phase 12 for web pages with device switching (1440, 1024, 768, 375), scroll-synced selection, and React renderers for all web blocks (using the website's CSS tokens: copy only tokens and layout CSS into a scoped package, never import the website app).
- SEO panel per page (title, description with counters, canonical, social image via MediaPicker, robots flag if in schema) with a SERP preview and a duplicate-title checker.
- Product page template editor (PDP sections order/visibility) with a preview using a real product from the catalogue (selectable) and live availability/price (from the public API).
- Film/video block helpers: asset requirement checklist (poster present, mp4/webm, size budget warning, mobile variant present), and a "reduced motion" preview toggle.
- Link checker across the page (internal routes/anchors exist; external https).
- Web preview tokens and the iframe spec document for the website team.

## Backend operations used
- Same document/validation/preview-token endpoints as phase 12 with channel=web; media library; catalogue public reads; content-library entities for journal notes, stories (reels), testimonials, FAQ groups.

## Experience requirements
- Cinematic blocks preview as poster images by default with an explicit "play" to avoid melting the dashboard; reduced-motion respected.
- A "Publish checklist" sidebar summarises blockers for this page (errors, unapproved media, placeholder testimonials, missing alt, duplicate SEO titles).

## Edge cases and failure modes you must handle
- Missing posters, huge videos, deleted referenced stories/notes/testimonials (by id), blocks that exceed max-per-page (palette disables with the reason), pages with zero blocks, duplicate anchors/ids, link to a route that does not exist.
- Testimonial with video referenced from an APP page (backend validation error: show it clearly).

## Acceptance criteria (each needs evidence)
- The website home, shop, product, ritual and story pages can be composed from blocks and previewed with recognisable fidelity (side-by-side screenshots in docs/qa).
- SEO validation and duplicate-title detection work against the backend.
- PDP template edits persist and reload.
- The iframe preview spec exists and is reviewed against the security checklist.

## Verification
- Fidelity screenshots at 4 widths; e2e compose-a-page flow; accessibility checks on the builder UI itself.

## Handoff to the next phase (write these down)
- Renderer coverage table (block to renderer to fidelity rating).
- Open BACKEND_REQUESTS for web blocks.

## How to run this phase (mandatory ritual: do not skip or compress any step)

### Step 1: Re-ground (no code yet)
- Read every file in "Read first" above. Re-read the "Ground rules" in 00_PASTE_THIS_FIRST.md and the Handoff notes of the previous phase in docs/build/DASH_PROGRESS.md.
- List, in docs/build/phase-13-thinking.md, the exact backend operations this phase uses, each verified to exist in docs/backend-contract/api-index.md. For any operation whose request/response is only typed as "object" in openapi.yaml, call it on the running backend and record the real shape.

### Step 2: Think at 100x depth (write it down; thinking that is not written does not count)
Create docs/build/phase-13-thinking.md and fill ALL of these sections with specific, non-generic content:
1. **Users and jobs**: each role that touches this phase, the 5 jobs they do most, and what "fast and safe" means for each.
2. **State and data flow**: every state machine and data flow involved (draw as text diagrams), including loading, empty, error, offline, permission-denied, conflict and stale states.
3. **Deep-think questions**: answer every question under "Think about before building" in this file, with the decision you took and the alternative you rejected and why.
4. **Pre-mortem**: 10 realistic ways this phase fails in production (wrong data shown, double submit, leaked PII, lost draft, slow list, race condition, misleading number, role bypass, contract drift, accessibility failure) and the specific control for each.
5. **Security and privacy**: threats and mitigations for the data this phase handles.
6. **Performance and accessibility budgets**: numbers (for example list render under 100 ms for 50 rows, keyboard path for every action).
7. **Test plan**: unit, component, integration (real backend), e2e per role, visual where relevant; list the test names before writing them.
8. **Slices**: the build order as vertical slices, each independently demonstrable.

### Step 3: Challenge your own plan
Re-read your thinking file as a skeptical senior reviewer. Find at least 5 weaknesses (missed state, hidden coupling, unclear ownership of data, unproven assumption about the backend) and fix the plan. Write "Review findings and changes" at the end of the thinking file.

### Step 4: Build slice by slice
- Implement one slice at a time; after each slice run typecheck, lint, unit tests, and exercise it in the browser against the REAL local backend. Commit small, with messages that say what and why.
- Follow the component library, tokens, API layer, form kit and permission helpers from earlier phases. Do not duplicate them; improve them if they fall short and note it in DASH_DECISIONS.md.
- If the backend lacks something (an endpoint, a filter, a field), do NOT invent it and do NOT fake it in shipped code: record it in docs/build/BACKEND_REQUESTS.md with the proposed shape and a workaround, then continue.

### Step 5: Verify with evidence
Run everything under "Verification" below. Evidence means real outputs: test logs, screenshots at 375/768/1440 px, curl or network traces, audit-log entries. Claims without evidence are not accepted. Test every role listed in the permission matrix that can or cannot do things in this phase, including the negative cases.

### Step 6: Reflect and hand off
- Update docs/build/DASH_PROGRESS.md (what was built, evidence links, what is verified vs not), DASH_DECISIONS.md (new ADRs), DASH_RISKS.md, DASH_PARITY.md, BACKEND_REQUESTS.md.
- Write the Handoff section for the next phase (what it must know) at the end of the thinking file and in DASH_PROGRESS.md.
- Tick every acceptance criterion below with the evidence that proves it. If any criterion fails, fix it before moving on; if it cannot be fixed, record it honestly as a known issue with an owner decision needed.
- Print the **Phase report** (format in 00_PASTE_THIS_FIRST.md) and then begin the next phase's Step 1. Stop and ask the owner ONLY when a genuine owner decision is needed (batch your questions with defaults).


---

# PHASE 14 of 20: Experience Studio V: content library (testimonials, stories, journal, care guides, FAQ, announcements)

> Ritual reminder: Re-ground, then Think at 100x (written), then Challenge the plan, then Build in slices, then Verify with evidence, then Reflect and hand off. The thinking file for this phase is docs/build/phase-14-thinking.md.

## Mission
Manage the reusable content that blocks reference by id, with consent and provenance rules for testimonials so nothing unverified or unauthorised can go live.

## Read first
- 02_EXPERIENCE_STUDIO_SPEC.md section 7 (content library)
- api-index: admin/content-library/{entity} and the entity schemas in openapi/blocks.schema.json docs
- 03_BACKEND_CONTRACT.md "Implementation status" (testimonials referenced by id; app text-only, web may include video)

## Think about before building (answer each in your thinking file)
- Testimonials are the highest-risk content: source (placeholder, owner_supplied, verified_review), consent record, channels allowed, video only on web, poster/alt requirements. Which states block publishing? Design the UI so a placeholder can never be published by accident and so consent capture is a deliberate, recorded act.
- The owner's current app testimonials are design-reference text: they must be recorded as owner_supplied with a consent note, or stay placeholder. How does the operator convert a placeholder? What do you show on the dashboard overview as a to-do?
- Which entities support multi-language? (None: English only.) Which entities are referenced by blocks and therefore cannot be deleted while in use? How do you surface "used in" and block deletion with an explanation?
- Editorial workflow: draft/approved/archived per entity, last editor, who approved. Does the backend model approval for these entities? Read the schema, do not invent.
- Rich text: markdown subset, sanitised preview, line limits per field.

## Scope: what to build
- Entity workspaces: Testimonials, Stories (reels), Journal notes, Care guides (steps with images), FAQ groups (questions/answers), Announcements (bar content with schedule and tone).
- Each entity: list (search/filter/status/usage), create/edit forms generated by the engine with entity-specific custom widgets (care-guide step editor with images, FAQ sortable list, story/reel video + poster, testimonial consent panel), duplicate, archive, delete (blocked when in use).
- Testimonial specifics: source selector with consequences, consent capture (who consented, how, date, note, optional document upload), channel checkboxes (app/web), media (video only for web with poster), verified-review link (when mode=verified_reviews the app block pulls reviews: link to the reviews moderation phase), preview of how it renders in each channel.
- "Used in" panel for every entity with deep links to the documents/blocks; "Needs attention" queue (placeholders, missing consent, missing alt/poster).
- Import helper: paste testimonial text and attach consent in one step.

## Backend operations used
- GET|POST /v1/admin/content-library/{entity}; GET|PATCH|DELETE /v1/admin/content-library/{entity}/{id}; media library; usage information as exposed by the API (if usage is not provided per entity, compute it client-side by scanning documents and record a BACKEND_REQUEST).

## Experience requirements
- The consent panel is explicit and plain-language; a green "publishable" state exists only when all conditions hold.
- Empty states teach: what each entity is for and where it appears (with a tiny preview).

## Edge cases and failure modes you must handle
- Deleting an entity referenced by a released document (refused), changing a testimonial after release (it changes only after the next release if the bundle is built at publish: confirm the backend semantics and explain), video referenced for app, very long quotes, consent withdrawn (archive + warning that live releases still contain it until republished: provide a one-click "republish without" flow).

## Acceptance criteria (each needs evidence)
- All six entity types CRUD against the real backend.
- A placeholder testimonial in a page makes validation fail with a clear message in the Studio; converting it to owner_supplied with consent makes it pass.
- Withdrawn-consent flow documented and working.
- Used-in lists correct.

## Verification
- Playwright flows for each entity; evidence of the placeholder-blocks-publish behaviour.

## Handoff to the next phase (write these down)
- Entity field tables.
- Consent policy text for the owner to review.

## How to run this phase (mandatory ritual: do not skip or compress any step)

### Step 1: Re-ground (no code yet)
- Read every file in "Read first" above. Re-read the "Ground rules" in 00_PASTE_THIS_FIRST.md and the Handoff notes of the previous phase in docs/build/DASH_PROGRESS.md.
- List, in docs/build/phase-14-thinking.md, the exact backend operations this phase uses, each verified to exist in docs/backend-contract/api-index.md. For any operation whose request/response is only typed as "object" in openapi.yaml, call it on the running backend and record the real shape.

### Step 2: Think at 100x depth (write it down; thinking that is not written does not count)
Create docs/build/phase-14-thinking.md and fill ALL of these sections with specific, non-generic content:
1. **Users and jobs**: each role that touches this phase, the 5 jobs they do most, and what "fast and safe" means for each.
2. **State and data flow**: every state machine and data flow involved (draw as text diagrams), including loading, empty, error, offline, permission-denied, conflict and stale states.
3. **Deep-think questions**: answer every question under "Think about before building" in this file, with the decision you took and the alternative you rejected and why.
4. **Pre-mortem**: 10 realistic ways this phase fails in production (wrong data shown, double submit, leaked PII, lost draft, slow list, race condition, misleading number, role bypass, contract drift, accessibility failure) and the specific control for each.
5. **Security and privacy**: threats and mitigations for the data this phase handles.
6. **Performance and accessibility budgets**: numbers (for example list render under 100 ms for 50 rows, keyboard path for every action).
7. **Test plan**: unit, component, integration (real backend), e2e per role, visual where relevant; list the test names before writing them.
8. **Slices**: the build order as vertical slices, each independently demonstrable.

### Step 3: Challenge your own plan
Re-read your thinking file as a skeptical senior reviewer. Find at least 5 weaknesses (missed state, hidden coupling, unclear ownership of data, unproven assumption about the backend) and fix the plan. Write "Review findings and changes" at the end of the thinking file.

### Step 4: Build slice by slice
- Implement one slice at a time; after each slice run typecheck, lint, unit tests, and exercise it in the browser against the REAL local backend. Commit small, with messages that say what and why.
- Follow the component library, tokens, API layer, form kit and permission helpers from earlier phases. Do not duplicate them; improve them if they fall short and note it in DASH_DECISIONS.md.
- If the backend lacks something (an endpoint, a filter, a field), do NOT invent it and do NOT fake it in shipped code: record it in docs/build/BACKEND_REQUESTS.md with the proposed shape and a workaround, then continue.

### Step 5: Verify with evidence
Run everything under "Verification" below. Evidence means real outputs: test logs, screenshots at 375/768/1440 px, curl or network traces, audit-log entries. Claims without evidence are not accepted. Test every role listed in the permission matrix that can or cannot do things in this phase, including the negative cases.

### Step 6: Reflect and hand off
- Update docs/build/DASH_PROGRESS.md (what was built, evidence links, what is verified vs not), DASH_DECISIONS.md (new ADRs), DASH_RISKS.md, DASH_PARITY.md, BACKEND_REQUESTS.md.
- Write the Handoff section for the next phase (what it must know) at the end of the thinking file and in DASH_PROGRESS.md.
- Tick every acceptance criterion below with the evidence that proves it. If any criterion fails, fix it before moving on; if it cannot be fixed, record it honestly as a known issue with an owner decision needed.
- Print the **Phase report** (format in 00_PASTE_THIS_FIRST.md) and then begin the next phase's Step 1. Stop and ask the owner ONLY when a genuine owner decision is needed (batch your questions with defaults).


---

# PHASE 15 of 20: Experience Studio VI: validation gate, diff, releases, scheduling, rollback, kill switch, campaigns and the baseline seed

> Ritual reminder: Re-ground, then Think at 100x (written), then Challenge the plan, then Build in slices, then Verify with evidence, then Reflect and hand off. The thinking file for this phase is docs/build/phase-15-thinking.md.

## Mission
Make publishing safe and reversible. Operators see exactly what will change, publish atomically for one or both channels, schedule, roll back instantly, and cut a channel back to the bundled design with a kill switch. Also seed the baseline so the first release reproduces today's look.

## Read first
- 02_EXPERIENCE_STUDIO_SPEC.md sections 9 (publishing), 11 (client consumption contract), 12 (seed content), 13 (acceptance)
- api-index: admin/experience/releases, campaigns, kill, diff, validate, preview-tokens
- 03_BACKEND_CONTRACT.md "Implementation status"

## Think about before building (answer each in your thinking file)
- A bad publish is the worst day of the project: what are ALL the safeguards (blocking validation, diff review, typed confirmation for production, MFA step-up, idempotency key, scheduling, instant rollback, kill switch, immutable releases)? Walk through each failure scenario and confirm a safeguard exists in the UI.
- Scheduled activation: view v_exp_effective picks the effective release by time. How do you present timeline state: current, scheduled next, history? How do you handle replacing a scheduled release (needs confirmation) and cancelling?
- Campaigns: time-boxed overrides (for example Diwali banner) layered on the released bundle. What can a campaign override (read the schema) and how do you present precedence and overlap?
- Both channels in one release: separate vs combined publish; partial failure semantics (atomic per release: confirm in the contract).
- The baseline seed: the first release must reproduce today's app and website so nothing visibly changes on day one. Who builds it? You, with a repeatable tool that uses the admin API (not direct SQL): upload the existing images/videos to the media library with correct provenance, create the tokens/navigation/chrome/page documents mirroring the current clients, run validation, publish as release 1 for BOTH channels with the clients still hard-coded (the clients will adopt the bundle in the client-wiring phase). What risks does seeding introduce (media rights, alt text quality) and how do you review them?

## Scope: what to build
- Publish wizard: choose channels, run validation (blocking errors, acknowledged warnings), diff against the live release (GET .../diff: per document and per block, readable), notes, schedule (now or at a future IST time), typed confirmation, MFA step-up, Idempotency-Key, success state with the release id and a link to the live bundle (GET /v1/experience/{channel}).
- Releases page: timeline of releases per channel (status: live, scheduled, superseded, rolled back), release detail (documents included, validation snapshot, who/when/notes), Roll back (POST .../releases/{id}/rollback with reason) and Cancel scheduled (POST .../cancel).
- Kill switch per channel (POST /v1/admin/experience/{channel}/kill) with a persistent red state indicator across the Studio and overview when a channel is killed; instructions on what clients do (fall back to bundled design).
- Campaigns: list/create/edit (GET|POST|PUT /v1/admin/experience/campaigns) with schedule, channel, overrides editor (engine), conflict detection with other campaigns and a calendar view.
- Preview tokens manager (create with expiry/scope, list, revoke).
- Baseline seed tool: scripts/seed-baseline-experience.ts (runs against the API with an operator login, idempotent, dry-run mode) plus docs/build/BASELINE_SEED.md listing every asset uploaded, its provenance, alt text, and a reviewer checklist; then publish release 1.
- Client-wiring brief: produce docs/build/CLIENT_WIRING_BRIEF.md for the Flutter and website teams from 05_CLIENT_INTEGRATION_SPEC.md and your real bundle samples (JSON), including capability headers, ETag/304, fallbacks, and the acceptance tests each client must pass.

## Backend operations used
- POST /v1/admin/experience/releases (idempotent), GET /v1/admin/experience/releases, GET /v1/admin/experience/releases/{id}, POST .../rollback, POST .../cancel, GET /v1/admin/experience/{channel}/diff, POST /v1/admin/experience/{channel}/kill, GET|POST|PUT /v1/admin/experience/campaigns, preview tokens, GET /v1/experience/{channel} (public bundle, ETag).

## Experience requirements
- The publish button is intentionally deliberate; rollback is intentionally fast.
- Diff is human-first (what the customer sees changes) with a raw JSON tab.
- A global "Live now" panel shows per channel: release id, published by/at, ETag, scheduled next.

## Edge cases and failure modes you must handle
- Publishing with an unapproved media asset or placeholder testimonial (blocked); publishing while another operator edits (presence warning); scheduling in the past; two scheduled releases; rollback to a release whose media was archived; kill switch on both channels; campaign overlapping a release schedule; idempotent retry after a network drop (same key returns the same release).

## Acceptance criteria (each needs evidence)
- Release 1 (baseline) is live for both channels and GET /v1/experience/app and /web return the expected bundles with ETags (304 on repeat).
- Rollback, schedule, cancel and kill switch each demonstrated against the real backend with audit entries.
- A validation failure blocks publishing and links to the fix.
- The baseline seed is repeatable on a fresh database (run it twice: no duplicates).
- CLIENT_WIRING_BRIEF.md reviewed against the current Flutter and website code for feasibility.

## Verification
- Record the full publish, schedule, rollback and kill sequence with screenshots and curl evidence of the public bundle after each step.

## Handoff to the next phase (write these down)
- Bundle samples for both channels.
- The exact acceptance tests the clients must pass.
- Anything the backend should change (BACKEND_REQUESTS).

## How to run this phase (mandatory ritual: do not skip or compress any step)

### Step 1: Re-ground (no code yet)
- Read every file in "Read first" above. Re-read the "Ground rules" in 00_PASTE_THIS_FIRST.md and the Handoff notes of the previous phase in docs/build/DASH_PROGRESS.md.
- List, in docs/build/phase-15-thinking.md, the exact backend operations this phase uses, each verified to exist in docs/backend-contract/api-index.md. For any operation whose request/response is only typed as "object" in openapi.yaml, call it on the running backend and record the real shape.

### Step 2: Think at 100x depth (write it down; thinking that is not written does not count)
Create docs/build/phase-15-thinking.md and fill ALL of these sections with specific, non-generic content:
1. **Users and jobs**: each role that touches this phase, the 5 jobs they do most, and what "fast and safe" means for each.
2. **State and data flow**: every state machine and data flow involved (draw as text diagrams), including loading, empty, error, offline, permission-denied, conflict and stale states.
3. **Deep-think questions**: answer every question under "Think about before building" in this file, with the decision you took and the alternative you rejected and why.
4. **Pre-mortem**: 10 realistic ways this phase fails in production (wrong data shown, double submit, leaked PII, lost draft, slow list, race condition, misleading number, role bypass, contract drift, accessibility failure) and the specific control for each.
5. **Security and privacy**: threats and mitigations for the data this phase handles.
6. **Performance and accessibility budgets**: numbers (for example list render under 100 ms for 50 rows, keyboard path for every action).
7. **Test plan**: unit, component, integration (real backend), e2e per role, visual where relevant; list the test names before writing them.
8. **Slices**: the build order as vertical slices, each independently demonstrable.

### Step 3: Challenge your own plan
Re-read your thinking file as a skeptical senior reviewer. Find at least 5 weaknesses (missed state, hidden coupling, unclear ownership of data, unproven assumption about the backend) and fix the plan. Write "Review findings and changes" at the end of the thinking file.

### Step 4: Build slice by slice
- Implement one slice at a time; after each slice run typecheck, lint, unit tests, and exercise it in the browser against the REAL local backend. Commit small, with messages that say what and why.
- Follow the component library, tokens, API layer, form kit and permission helpers from earlier phases. Do not duplicate them; improve them if they fall short and note it in DASH_DECISIONS.md.
- If the backend lacks something (an endpoint, a filter, a field), do NOT invent it and do NOT fake it in shipped code: record it in docs/build/BACKEND_REQUESTS.md with the proposed shape and a workaround, then continue.

### Step 5: Verify with evidence
Run everything under "Verification" below. Evidence means real outputs: test logs, screenshots at 375/768/1440 px, curl or network traces, audit-log entries. Claims without evidence are not accepted. Test every role listed in the permission matrix that can or cannot do things in this phase, including the negative cases.

### Step 6: Reflect and hand off
- Update docs/build/DASH_PROGRESS.md (what was built, evidence links, what is verified vs not), DASH_DECISIONS.md (new ADRs), DASH_RISKS.md, DASH_PARITY.md, BACKEND_REQUESTS.md.
- Write the Handoff section for the next phase (what it must know) at the end of the thinking file and in DASH_PROGRESS.md.
- Tick every acceptance criterion below with the evidence that proves it. If any criterion fails, fix it before moving on; if it cannot be fixed, record it honestly as a known issue with an owner decision needed.
- Print the **Phase report** (format in 00_PASTE_THIS_FIRST.md) and then begin the next phase's Step 1. Stop and ask the owner ONLY when a genuine owner decision is needed (batch your questions with defaults).


---

# PHASE 16 of 20: Customers, reviews moderation and support tools

> Ritual reminder: Re-ground, then Think at 100x (written), then Challenge the plan, then Build in slices, then Verify with evidence, then Reflect and hand off. The thinking file for this phase is docs/build/phase-16-thinking.md.

## Mission
Know the customers and look after them without over-exposing personal data: masked lists, audited reveal, notes and tags, blocking with MFA, reviews and review-photo moderation.

## Read first
- api-index: admin/customers, admin/exports, admin/reviews, admin/review-media
- Privacy rules: customer contact masked by default, reveal needs a reason and is audited, exports are MFA + audited, support role is read-mostly

## Think about before building (answer each in your thinking file)
- Data minimisation: what does each role truly need? Design the information hierarchy (name, masked contact, orders count, lifetime spend, last order, tags, notes) and what "Reveal" shows and logs.
- Blocking a customer: what happens (account disabled, sessions revoked, existing orders unaffected)? How do you prevent mistakes (reason required, MFA, confirmation, reversible)?
- Support workflows: "customer says order not received" and "customer wants to cancel": which screens link together (customer to orders to shipment to notes)?
- Reviews: only verified purchasers can review; photos are sanitised and quarantined until approved; rejecting hides the review and photos. What does the moderator need to decide quickly (product, rating, text, photo thumbnail via the proxy, purchase verification)?
- Abuse of the admin by an insider: what does the UI make visible (the audit trail on the customer page showing who revealed/exported)?

## Scope: what to build
- Customers list (search by name/email/phone fragment, tag, blocked filter) with masked fields, orders count, spend, last order; detail page with orders, addresses count, notes (editable), tags, blocked status, audit of reveals/exports for this customer.
- Reveal flow (POST /v1/admin/customers/{id}/reveal with reason) showing contact + addresses in a temporary panel that auto-hides after 60s.
- Notes/tags edit (PATCH /v1/admin/customers/{id}), Block/Unblock (POST .../block, MFA, reason), customers CSV export (GET /v1/admin/exports/customers.csv, MFA, formula-safe: confirm and show an explanatory note).
- Reviews queue (GET /v1/admin/reviews), moderate (POST .../moderate approve/reject with reason), review photo moderation (GET /v1/admin/review-media/{id}/image through the proxy, POST .../moderate), links to product and order; counters feed the overview.
- Customer-facing communication helpers: resend order confirmation (phase 6 reuse) and a link to message templates (phase 17).

## Backend operations used
- GET /v1/admin/customers, GET /v1/admin/customers/{id}, POST /v1/admin/customers/{id}/reveal, PATCH /v1/admin/customers/{id}, POST /v1/admin/customers/{id}/block, GET /v1/admin/exports/customers.csv; GET /v1/admin/reviews, POST /v1/admin/reviews/{id}/moderate, GET /v1/admin/review-media/{id}/image, POST /v1/admin/review-media/{id}/moderate.

## Experience requirements
- Sensitive fields are visually distinct; copy-to-clipboard of revealed data is allowed but logged client-side only as a UI affordance (the audit is server-side).
- Moderation is keyboard-driven (a/r keys with confirmation for reject).

## Edge cases and failure modes you must handle
- Customers with deleted/anonymised accounts (hidden), blocked customer with an active order, search matching thousands of rows, review photos that fail to load, a review edited after approval.
- Staff accounts never appear in the customer list (backend rule): do not try to show them.

## Acceptance criteria (each needs evidence)
- Support, fulfilment and admin roles tested for exactly their capabilities.
- Reveal creates an audit entry (verify through the audit screen); export creates one too.
- Block disables sign-in (verify with the customer login API) and unblock restores it.
- Review moderation changes what the public API returns (verify GET /v1/products/{id}/reviews).

## Verification
- e2e: customer places an order via API, support looks them up and reveals, admin blocks them, customer login fails, admin unblocks.

## Handoff to the next phase (write these down)
- Customer DTO fields.
- Audit event names used.

## How to run this phase (mandatory ritual: do not skip or compress any step)

### Step 1: Re-ground (no code yet)
- Read every file in "Read first" above. Re-read the "Ground rules" in 00_PASTE_THIS_FIRST.md and the Handoff notes of the previous phase in docs/build/DASH_PROGRESS.md.
- List, in docs/build/phase-16-thinking.md, the exact backend operations this phase uses, each verified to exist in docs/backend-contract/api-index.md. For any operation whose request/response is only typed as "object" in openapi.yaml, call it on the running backend and record the real shape.

### Step 2: Think at 100x depth (write it down; thinking that is not written does not count)
Create docs/build/phase-16-thinking.md and fill ALL of these sections with specific, non-generic content:
1. **Users and jobs**: each role that touches this phase, the 5 jobs they do most, and what "fast and safe" means for each.
2. **State and data flow**: every state machine and data flow involved (draw as text diagrams), including loading, empty, error, offline, permission-denied, conflict and stale states.
3. **Deep-think questions**: answer every question under "Think about before building" in this file, with the decision you took and the alternative you rejected and why.
4. **Pre-mortem**: 10 realistic ways this phase fails in production (wrong data shown, double submit, leaked PII, lost draft, slow list, race condition, misleading number, role bypass, contract drift, accessibility failure) and the specific control for each.
5. **Security and privacy**: threats and mitigations for the data this phase handles.
6. **Performance and accessibility budgets**: numbers (for example list render under 100 ms for 50 rows, keyboard path for every action).
7. **Test plan**: unit, component, integration (real backend), e2e per role, visual where relevant; list the test names before writing them.
8. **Slices**: the build order as vertical slices, each independently demonstrable.

### Step 3: Challenge your own plan
Re-read your thinking file as a skeptical senior reviewer. Find at least 5 weaknesses (missed state, hidden coupling, unclear ownership of data, unproven assumption about the backend) and fix the plan. Write "Review findings and changes" at the end of the thinking file.

### Step 4: Build slice by slice
- Implement one slice at a time; after each slice run typecheck, lint, unit tests, and exercise it in the browser against the REAL local backend. Commit small, with messages that say what and why.
- Follow the component library, tokens, API layer, form kit and permission helpers from earlier phases. Do not duplicate them; improve them if they fall short and note it in DASH_DECISIONS.md.
- If the backend lacks something (an endpoint, a filter, a field), do NOT invent it and do NOT fake it in shipped code: record it in docs/build/BACKEND_REQUESTS.md with the proposed shape and a workaround, then continue.

### Step 5: Verify with evidence
Run everything under "Verification" below. Evidence means real outputs: test logs, screenshots at 375/768/1440 px, curl or network traces, audit-log entries. Claims without evidence are not accepted. Test every role listed in the permission matrix that can or cannot do things in this phase, including the negative cases.

### Step 6: Reflect and hand off
- Update docs/build/DASH_PROGRESS.md (what was built, evidence links, what is verified vs not), DASH_DECISIONS.md (new ADRs), DASH_RISKS.md, DASH_PARITY.md, BACKEND_REQUESTS.md.
- Write the Handoff section for the next phase (what it must know) at the end of the thinking file and in DASH_PROGRESS.md.
- Tick every acceptance criterion below with the evidence that proves it. If any criterion fails, fix it before moving on; if it cannot be fixed, record it honestly as a known issue with an owner decision needed.
- Print the **Phase report** (format in 00_PASTE_THIS_FIRST.md) and then begin the next phase's Step 1. Stop and ask the owner ONLY when a genuine owner decision is needed (batch your questions with defaults).


---

# PHASE 17 of 20: Marketing: coupons, message templates, outbox, app update prompts and announcements

> Ritual reminder: Re-ground, then Think at 100x (written), then Challenge the plan, then Build in slices, then Verify with evidence, then Reflect and hand off. The thinking file for this phase is docs/build/phase-17-thinking.md.

## Mission
Run promotions and customer communication with guard rails: build and monitor coupons, reword transactional emails safely, see delivery state, and control the app's update prompts.

## Read first
- api-index: admin/coupons, admin/message-templates, admin/outbox, admin/app-versions, admin/flags
- Coupon rules in 03_BACKEND_CONTRACT.md "Implementation status": per-line allocation, GST on discounted amounts, pre-discount free-shipping and COD limit, redemption released on cancel/expiry, type and value frozen after the first redemption
- Message templates: only non-token templates are editable; placeholders are validated per template

## Think about before building (answer each in your thinking file)
- A coupon is money leaving the business: what mistakes are costly (100% off, no limit, no end date, stacking)? Which guard rails does the UI add on top of the backend (typical-range warnings, required end date or explicit "no expiry", per-customer limit default 1, projected cost estimator)?
- Show the operator exactly what a coupon does with a worked example computed from real products (subtotal, discount, GST effect, shipping effect) before saving; the numbers must come from the same formulas as the backend (percentage rounds down, caps apply, scope limits the base).
- Coupon analytics: redemptions, discount given, revenue influenced: define each metric and its caveats (cancelled orders release redemptions).
- Message templates: a bad template can send nonsense to every customer. How do you preview (sample data), validate placeholders, test-send to yourself, reset to default, and see which version is live?
- App versions: min supported vs latest, per platform; what does force_update do to customers (blocks the app!)? Design a confirmation that says exactly that and offers a staged approach.
- Feature flags: key rules, rollout percent determinism, who can change them (MFA).

## Scope: what to build
- Coupons: list with status chips (live, scheduled, expired, exhausted, inactive) and stats; create/edit wizard (type percentage/flat/free_shipping, value, min order, max discount, window, total and per-customer limits, first-order-only, product scope picker, active), worked-example simulator, deactivate (POST .../deactivate), detail page with recent redemptions and analytics (GET /v1/admin/coupons/analytics), duplicate coupon helper.
- Customer-facing copy hints: where the coupon box appears in the app and website checkout and the exact error reasons customers see (unknown, expired, not_started, min_order, not_applicable, fully_redeemed, already_used, first_order_only, shipping_already_free).
- Message templates: list of editable templates with variables per template, editor with live preview using sample data, test-send (POST .../test with send flag; works only if an email sender is configured: show the honest sender state), reset to default (DELETE), audit trail.
- Email outbox viewer (GET /v1/admin/outbox/emails): template, status, created; filter by status; explain that recipients/payloads are intentionally not visible.
- App versions: GET/PUT /v1/admin/app-versions/{platform} with a safety wizard for raising the minimum version.
- Feature flags: GET /v1/admin/flags, PUT/DELETE /v1/admin/flags/{key} with rollout slider and a dry explanation of determinism.
- Announcements are in the Studio content library (phase 14): link them here and show currently active ones.

## Backend operations used
- Coupons: GET/POST /v1/admin/coupons, GET /v1/admin/coupons/{id}, PATCH /v1/admin/coupons/{id}, POST /v1/admin/coupons/{id}/deactivate, GET /v1/admin/coupons/analytics.
- GET /v1/admin/message-templates, PUT|DELETE /v1/admin/message-templates/{key}, POST /v1/admin/message-templates/{key}/test, GET /v1/admin/outbox/emails.
- GET /v1/admin/app-versions, PUT /v1/admin/app-versions/{platform}, GET /v1/admin/flags, PUT|DELETE /v1/admin/flags/{key}.

## Experience requirements
- Coupon codes are uppercase, 3-32 characters (letters, digits, - _): format as you type with the rules shown.
- Every destructive or customer-impacting change shows an impact sentence in plain language.

## Edge cases and failure modes you must handle
- Editing type/value of a redeemed coupon (backend refuses: explain and offer "create a new coupon"), coupon whose scope products were archived, concurrent redemptions hitting a total limit, free-shipping coupon when shipping is already free, template placeholder not allowed for that template, sender not configured, min version higher than latest (backend refuses).

## Acceptance criteria (each needs evidence)
- Create the three coupon types; use each from the website checkout (running locally) and confirm totals match the simulator to the paisa.
- Worked-example simulator has unit tests against fixtures derived from the backend tests (percentage cap, flat larger than subtotal, scoped base, free shipping).
- Template edit changes the preview and (with an email sender configured or the console sender) the outgoing email; reset works.
- Raising the minimum app version shows the safety wizard; the public GET /v1/app/version-check reflects it.

## Verification
- e2e: create coupon, apply on the website checkout, verify order discount and the redemption count; cancel the order; verify the redemption is released.

## Handoff to the next phase (write these down)
- Coupon DTO table and reason code list.
- Template variable table.

## How to run this phase (mandatory ritual: do not skip or compress any step)

### Step 1: Re-ground (no code yet)
- Read every file in "Read first" above. Re-read the "Ground rules" in 00_PASTE_THIS_FIRST.md and the Handoff notes of the previous phase in docs/build/DASH_PROGRESS.md.
- List, in docs/build/phase-17-thinking.md, the exact backend operations this phase uses, each verified to exist in docs/backend-contract/api-index.md. For any operation whose request/response is only typed as "object" in openapi.yaml, call it on the running backend and record the real shape.

### Step 2: Think at 100x depth (write it down; thinking that is not written does not count)
Create docs/build/phase-17-thinking.md and fill ALL of these sections with specific, non-generic content:
1. **Users and jobs**: each role that touches this phase, the 5 jobs they do most, and what "fast and safe" means for each.
2. **State and data flow**: every state machine and data flow involved (draw as text diagrams), including loading, empty, error, offline, permission-denied, conflict and stale states.
3. **Deep-think questions**: answer every question under "Think about before building" in this file, with the decision you took and the alternative you rejected and why.
4. **Pre-mortem**: 10 realistic ways this phase fails in production (wrong data shown, double submit, leaked PII, lost draft, slow list, race condition, misleading number, role bypass, contract drift, accessibility failure) and the specific control for each.
5. **Security and privacy**: threats and mitigations for the data this phase handles.
6. **Performance and accessibility budgets**: numbers (for example list render under 100 ms for 50 rows, keyboard path for every action).
7. **Test plan**: unit, component, integration (real backend), e2e per role, visual where relevant; list the test names before writing them.
8. **Slices**: the build order as vertical slices, each independently demonstrable.

### Step 3: Challenge your own plan
Re-read your thinking file as a skeptical senior reviewer. Find at least 5 weaknesses (missed state, hidden coupling, unclear ownership of data, unproven assumption about the backend) and fix the plan. Write "Review findings and changes" at the end of the thinking file.

### Step 4: Build slice by slice
- Implement one slice at a time; after each slice run typecheck, lint, unit tests, and exercise it in the browser against the REAL local backend. Commit small, with messages that say what and why.
- Follow the component library, tokens, API layer, form kit and permission helpers from earlier phases. Do not duplicate them; improve them if they fall short and note it in DASH_DECISIONS.md.
- If the backend lacks something (an endpoint, a filter, a field), do NOT invent it and do NOT fake it in shipped code: record it in docs/build/BACKEND_REQUESTS.md with the proposed shape and a workaround, then continue.

### Step 5: Verify with evidence
Run everything under "Verification" below. Evidence means real outputs: test logs, screenshots at 375/768/1440 px, curl or network traces, audit-log entries. Claims without evidence are not accepted. Test every role listed in the permission matrix that can or cannot do things in this phase, including the negative cases.

### Step 6: Reflect and hand off
- Update docs/build/DASH_PROGRESS.md (what was built, evidence links, what is verified vs not), DASH_DECISIONS.md (new ADRs), DASH_RISKS.md, DASH_PARITY.md, BACKEND_REQUESTS.md.
- Write the Handoff section for the next phase (what it must know) at the end of the thinking file and in DASH_PROGRESS.md.
- Tick every acceptance criterion below with the evidence that proves it. If any criterion fails, fix it before moving on; if it cannot be fixed, record it honestly as a known issue with an owner decision needed.
- Print the **Phase report** (format in 00_PASTE_THIS_FIRST.md) and then begin the next phase's Step 1. Stop and ask the owner ONLY when a genuine owner decision is needed (batch your questions with defaults).


---

# PHASE 18 of 20: Analytics, finance, GST, audit log and operations queues

> Ritual reminder: Re-ground, then Think at 100x (written), then Challenge the plan, then Build in slices, then Verify with evidence, then Reflect and hand off. The thinking file for this phase is docs/build/phase-18-thinking.md.

## Mission
Give the owner and finance the truth: sales and product performance with precise definitions, GST summaries that match invoices, payments and refunds, a searchable audit trail, and visibility/control of background queues.

## Read first
- api-index: admin/analytics, admin/audit, admin/ops, admin/refunds, admin/dashboard
- definitions returned by the analytics endpoints (they carry their own definitions: show them)
- Invoice rules: consecutive invoice numbers per financial year, intra-state CGST+SGST, seller GST details required

## Think about before building (answer each in your thinking file)
- Every number must have a definition on screen and tie out to something auditable. For each report, state the formula, the included statuses, the timezone (IST day boundaries), and how it reconciles with the orders list and the GST totals.
- Finance workflows: month-end GST summary, refund reconciliation, COD remittance awareness (the backend tracks COD due/collected: what is missing for reconciliation and what should be requested?).
- Charts: which chart type for which question; accessible alternatives (tables) for every chart; colour-blind safe palette.
- Audit log UX: an investigator needs filters (actor, action, resource, date), diffs of before/after, and export. What are the risks of showing before/after JSON (PII)? Which fields must be masked in the viewer?
- Operations queues: dead-lettered outbox events and replay (MFA), failed emails, stuck shipment requests: what does an operator do for each and what are the dangers of replay?

## Scope: what to build
- Analytics pages: Sales (series by day/week/month, AOV, payment method split, discounts), Products (units, revenue after coupon share), Customers (new vs returning, signups, top customers), Shipping, Returns (return rate definition), Geo (state/city), GST (monthly taxable value and tax) each with date-range presets, comparison to previous period, CSV export (format=csv), definitions drawer, and tie-out hints.
- Finance workspace: payments list/status, refunds (queue, process with MFA), invoices lookup by order number/invoice number, GST report with a reconciliation check against the sum of invoice taxes (compute client-side from invoices where the API allows and flag differences).
- Audit log viewer (GET /v1/admin/audit): filters, expandable before/after with PII-safe rendering, link to the resource, CSV export if the API provides it (else record a request).
- Ops: outbox viewer (dead/pending) with replay (POST /v1/admin/ops/outbox/{id}/replay, reason + MFA), email failures, shipping events, health history; alert rules explanation; a runbook link panel (docs/build/OPERATIONS_RUNBOOK.md content rendered).
- Scheduled report email is NOT required.

## Backend operations used
- GET /v1/admin/analytics/{sales|products|customers|shipping|returns|geo|gst} (from, to, bucket, format=csv), GET /v1/admin/audit, GET /v1/admin/ops/outbox, POST /v1/admin/ops/outbox/{id}/replay, GET /v1/admin/refunds, POST /v1/admin/refunds/{id}/process, GET /v1/admin/health, GET /v1/admin/orders/{id}/invoice.

## Experience requirements
- Date ranges are IST and half-open; show the exact range used.
- Charts have data tables and keyboard focus; empty ranges say so.
- Large CSV exports download without freezing the tab.

## Edge cases and failure modes you must handle
- Ranges over 400 days are refused by the backend: pre-empt in the picker; orders with no tax breakdown are excluded from GST (explain); returned orders excluded from sales (explain); timezone edge at midnight IST; zero-data ranges.

## Acceptance criteria (each needs evidence)
- Sales totals on screen equal the sum of the orders list for the same filters (automated tie-out test using seeded orders).
- GST totals equal the sum of invoice taxes for the period in a test dataset.
- Audit entries appear for actions performed in earlier phases (reveal, export, pause, publish, coupon create).
- Replay of a dead-lettered event works and requires MFA.

## Verification
- Generate a dataset through the customer API, then run tie-out e2e tests; screenshot charts and tables.

## Handoff to the next phase (write these down)
- Metric definitions (final).
- Finance gaps (COD remittance etc.) for BACKEND_REQUESTS.

## How to run this phase (mandatory ritual: do not skip or compress any step)

### Step 1: Re-ground (no code yet)
- Read every file in "Read first" above. Re-read the "Ground rules" in 00_PASTE_THIS_FIRST.md and the Handoff notes of the previous phase in docs/build/DASH_PROGRESS.md.
- List, in docs/build/phase-18-thinking.md, the exact backend operations this phase uses, each verified to exist in docs/backend-contract/api-index.md. For any operation whose request/response is only typed as "object" in openapi.yaml, call it on the running backend and record the real shape.

### Step 2: Think at 100x depth (write it down; thinking that is not written does not count)
Create docs/build/phase-18-thinking.md and fill ALL of these sections with specific, non-generic content:
1. **Users and jobs**: each role that touches this phase, the 5 jobs they do most, and what "fast and safe" means for each.
2. **State and data flow**: every state machine and data flow involved (draw as text diagrams), including loading, empty, error, offline, permission-denied, conflict and stale states.
3. **Deep-think questions**: answer every question under "Think about before building" in this file, with the decision you took and the alternative you rejected and why.
4. **Pre-mortem**: 10 realistic ways this phase fails in production (wrong data shown, double submit, leaked PII, lost draft, slow list, race condition, misleading number, role bypass, contract drift, accessibility failure) and the specific control for each.
5. **Security and privacy**: threats and mitigations for the data this phase handles.
6. **Performance and accessibility budgets**: numbers (for example list render under 100 ms for 50 rows, keyboard path for every action).
7. **Test plan**: unit, component, integration (real backend), e2e per role, visual where relevant; list the test names before writing them.
8. **Slices**: the build order as vertical slices, each independently demonstrable.

### Step 3: Challenge your own plan
Re-read your thinking file as a skeptical senior reviewer. Find at least 5 weaknesses (missed state, hidden coupling, unclear ownership of data, unproven assumption about the backend) and fix the plan. Write "Review findings and changes" at the end of the thinking file.

### Step 4: Build slice by slice
- Implement one slice at a time; after each slice run typecheck, lint, unit tests, and exercise it in the browser against the REAL local backend. Commit small, with messages that say what and why.
- Follow the component library, tokens, API layer, form kit and permission helpers from earlier phases. Do not duplicate them; improve them if they fall short and note it in DASH_DECISIONS.md.
- If the backend lacks something (an endpoint, a filter, a field), do NOT invent it and do NOT fake it in shipped code: record it in docs/build/BACKEND_REQUESTS.md with the proposed shape and a workaround, then continue.

### Step 5: Verify with evidence
Run everything under "Verification" below. Evidence means real outputs: test logs, screenshots at 375/768/1440 px, curl or network traces, audit-log entries. Claims without evidence are not accepted. Test every role listed in the permission matrix that can or cannot do things in this phase, including the negative cases.

### Step 6: Reflect and hand off
- Update docs/build/DASH_PROGRESS.md (what was built, evidence links, what is verified vs not), DASH_DECISIONS.md (new ADRs), DASH_RISKS.md, DASH_PARITY.md, BACKEND_REQUESTS.md.
- Write the Handoff section for the next phase (what it must know) at the end of the thinking file and in DASH_PROGRESS.md.
- Tick every acceptance criterion below with the evidence that proves it. If any criterion fails, fix it before moving on; if it cannot be fixed, record it honestly as a known issue with an owner decision needed.
- Print the **Phase report** (format in 00_PASTE_THIS_FIRST.md) and then begin the next phase's Step 1. Stop and ask the owner ONLY when a genuine owner decision is needed (batch your questions with defaults).


---

# PHASE 19 of 20: Platform: store settings, policies, team and roles, integrations and security

> Ritual reminder: Re-ground, then Think at 100x (written), then Challenge the plan, then Build in slices, then Verify with evidence, then Reflect and hand off. The thinking file for this phase is docs/build/phase-19-thinking.md.

## Mission
Everything an owner configures once and an admin maintains: store facts, shipping and COD rules, GST/seller details, policy pages, delivery areas, team members and invitations, integration status, feature flags (reuse), and personal security.

## Read first
- api-index: admin/settings, admin/content, admin/team, admin/sessions, admin/integrations, admin/shipping/pins, admin/flags
- Settings semantics: pricing-affecting changes bump rules_version and invalidate open quotes; settings use expectedVersion + reason + MFA; brand name, support email/phone are public facts used by clients and Studio variables

## Think about before building (answer each in your thinking file)
- Settings are the highest-leverage and highest-risk screen. For each field: who may change it, what breaks if wrong (quotes stale, invoices wrong, COD disabled), and how the UI previews the customer impact (a mini checkout summary using sample products).
- GST: rate bps, inclusive flag, seller legal name, GSTIN (format validated), state, address, invoice prefix: what must exist before invoices can be issued? Surface the readiness checks next to the fields that fix them.
- Policies (Terms, Privacy, Refund/Return, Shipping, care guide): versioned drafts, publish step, public API serves only published versions. Design a content editor with history, diff, publish, and a preview that matches the public page style; legal wording is the owner's, the dashboard never invents it.
- Team management: roles, invitations (72h token via email: sender may be unconfigured in dev: show the token flow honestly), disabling members, resetting MFA (MFA + audit), session visibility. How do you stop the last admin from locking themselves out?
- Integrations: show Razorpay, SMS, SMTP, shipping, storage, maps as configured/not configured with the last test result; "Test" never fakes success. What does the operator do next for each (link to a setup checklist in docs)?

## Scope: what to build
- Store settings form (grouped: store facts, shipping and free-shipping threshold, COD (enabled, limit, fee), GST and seller details, returns window, delivery estimate, brand/support info) with diff-before-save, reason, step-up, expectedVersion conflict handling, readiness panel (reuses phase 5), and a customer-impact preview.
- Delivery areas (PIN prefixes) editor with bulk paste and a tester (reuse phase 7 component).
- Policies and guides: list, editor with markdown, versions, publish (GET/PUT /v1/admin/content/{slug}, POST .../publish).
- Team: list members and pending invites, invite (POST /v1/admin/team/invite), revoke invite, change role/disable (PATCH /v1/admin/team/{id}), reset MFA (POST .../reset-mfa), all MFA-gated; session list for the current user and revoke.
- Integrations page (GET /v1/admin/integrations, POST /v1/admin/integrations/{name}/test): cards with state, last check, test button, setup guidance links; clearly marks Shiprocket as parked/not verified.
- Feature flags and app versions screens link from here (built in phase 17).
- Account security page finishing touches from phase 3.

## Backend operations used
- GET /v1/admin/settings, PATCH /v1/admin/settings; GET|PUT /v1/admin/shipping/pins; GET /v1/admin/content, GET|PUT /v1/admin/content/{slug}, POST /v1/admin/content/{slug}/publish; GET /v1/admin/team, POST /v1/admin/team/invite, DELETE /v1/admin/team/invites/{id}, PATCH /v1/admin/team/{id}, POST /v1/admin/team/{id}/reset-mfa; GET /v1/admin/integrations, POST /v1/admin/integrations/{name}/test.

## Experience requirements
- Dangerous settings (disable COD, change GST rate) use a two-step confirmation that states the customer impact.
- Settings never autosave: explicit review and save.

## Edge cases and failure modes you must handle
- Changing GST rate while quotes are open (they go stale: say so), clearing the seller GSTIN (invoices refuse), setting a free-shipping threshold below the shipping fee, disabling the last admin or changing your own role (backend/UI both refuse), invitation to an existing email, SMTP unconfigured when inviting.

## Acceptance criteria (each needs evidence)
- Settings round-trip with conflict handling; a changed shipping fee appears on the customer API within the cache window (verify) and invalidates an open quote (verify).
- Policies publish flow: draft not visible publicly, published visible (curl).
- Team: invite, accept (using the dev token), role-restricted login, disable, reset MFA; last-admin protection tested.
- Integrations page tells the truth for the local environment (nothing falsely green).

## Verification
- e2e for settings + policies + team; screenshots; curl evidence for public effects.

## Handoff to the next phase (write these down)
- Settings field table with impacts.
- Policy content ownership note for the owner.

## How to run this phase (mandatory ritual: do not skip or compress any step)

### Step 1: Re-ground (no code yet)
- Read every file in "Read first" above. Re-read the "Ground rules" in 00_PASTE_THIS_FIRST.md and the Handoff notes of the previous phase in docs/build/DASH_PROGRESS.md.
- List, in docs/build/phase-19-thinking.md, the exact backend operations this phase uses, each verified to exist in docs/backend-contract/api-index.md. For any operation whose request/response is only typed as "object" in openapi.yaml, call it on the running backend and record the real shape.

### Step 2: Think at 100x depth (write it down; thinking that is not written does not count)
Create docs/build/phase-19-thinking.md and fill ALL of these sections with specific, non-generic content:
1. **Users and jobs**: each role that touches this phase, the 5 jobs they do most, and what "fast and safe" means for each.
2. **State and data flow**: every state machine and data flow involved (draw as text diagrams), including loading, empty, error, offline, permission-denied, conflict and stale states.
3. **Deep-think questions**: answer every question under "Think about before building" in this file, with the decision you took and the alternative you rejected and why.
4. **Pre-mortem**: 10 realistic ways this phase fails in production (wrong data shown, double submit, leaked PII, lost draft, slow list, race condition, misleading number, role bypass, contract drift, accessibility failure) and the specific control for each.
5. **Security and privacy**: threats and mitigations for the data this phase handles.
6. **Performance and accessibility budgets**: numbers (for example list render under 100 ms for 50 rows, keyboard path for every action).
7. **Test plan**: unit, component, integration (real backend), e2e per role, visual where relevant; list the test names before writing them.
8. **Slices**: the build order as vertical slices, each independently demonstrable.

### Step 3: Challenge your own plan
Re-read your thinking file as a skeptical senior reviewer. Find at least 5 weaknesses (missed state, hidden coupling, unclear ownership of data, unproven assumption about the backend) and fix the plan. Write "Review findings and changes" at the end of the thinking file.

### Step 4: Build slice by slice
- Implement one slice at a time; after each slice run typecheck, lint, unit tests, and exercise it in the browser against the REAL local backend. Commit small, with messages that say what and why.
- Follow the component library, tokens, API layer, form kit and permission helpers from earlier phases. Do not duplicate them; improve them if they fall short and note it in DASH_DECISIONS.md.
- If the backend lacks something (an endpoint, a filter, a field), do NOT invent it and do NOT fake it in shipped code: record it in docs/build/BACKEND_REQUESTS.md with the proposed shape and a workaround, then continue.

### Step 5: Verify with evidence
Run everything under "Verification" below. Evidence means real outputs: test logs, screenshots at 375/768/1440 px, curl or network traces, audit-log entries. Claims without evidence are not accepted. Test every role listed in the permission matrix that can or cannot do things in this phase, including the negative cases.

### Step 6: Reflect and hand off
- Update docs/build/DASH_PROGRESS.md (what was built, evidence links, what is verified vs not), DASH_DECISIONS.md (new ADRs), DASH_RISKS.md, DASH_PARITY.md, BACKEND_REQUESTS.md.
- Write the Handoff section for the next phase (what it must know) at the end of the thinking file and in DASH_PROGRESS.md.
- Tick every acceptance criterion below with the evidence that proves it. If any criterion fails, fix it before moving on; if it cannot be fixed, record it honestly as a known issue with an owner decision needed.
- Print the **Phase report** (format in 00_PASTE_THIS_FIRST.md) and then begin the next phase's Step 1. Stop and ask the owner ONLY when a genuine owner decision is needed (batch your questions with defaults).


---

# PHASE 20 of 20: Hardening, quality gates and release readiness

> Ritual reminder: Re-ground, then Think at 100x (written), then Challenge the plan, then Build in slices, then Verify with evidence, then Reflect and hand off. The thinking file for this phase is docs/build/phase-20-thinking.md.

## Mission
Prove the dashboard is safe, fast, accessible and maintainable, close every open gap honestly, and leave the owner with a runbook and a verified acceptance report.

## Read first
- docs/build/DASH_PARITY.md, DASH_RISKS.md, BACKEND_REQUESTS.md (all of them: every open row needs a resolution or an explicit deferral)
- docs/backend-contract/INTEGRATION_GUIDE.md "Not connected yet"
- The acceptance checklist you started in phase 1

## Think about before building (answer each in your thinking file)
- Run a pre-mortem on the entire product: list 25 ways it could embarrass or harm the business within the first month (wrong price published, leaked PII, locked-out admin, bad release, slow list, lost draft, silent failure). For each, point to the control that prevents or limits it, or fix it now.
- Security review like an attacker: authentication, session, CSRF, XSS (every field that renders user/customer content), SSRF (any URL fetch by the BFF), file upload, IDOR (ids in URLs: the backend enforces, but confirm the BFF never widens access), clickjacking, dependency risk, secrets in the repo, logging of PII.
- Performance: budgets per page (LCP, INP, bundle size), the worst offenders (tables with 10k rows, Studio with 40 blocks, media grid), and profiles that prove they are met.
- Accessibility: a real audit (axe, keyboard-only, screen-reader spot checks on the 10 most important flows, zoom 200%, reduced motion).
- What does a new developer need to be productive in one hour? What does an operator need to be productive in one day?

## Scope: what to build
- Security hardening pass with a written report docs/build/DASH_SECURITY_REVIEW.md (findings, severity, fixes, residual risk); CSP tightened with no unsafe-inline; dependency audit; secrets scan; logging review (no PII/tokens).
- Performance pass with measured numbers; code-splitting for the Studio; virtualisation where needed; image optimisation.
- Accessibility pass with fixes; document known issues honestly.
- Test pyramid report: unit, component, integration, e2e (per role), visual regression for the Studio renderers; flake triage; CI-equivalent "pnpm verify:all" including e2e against the real local backend.
- Close the parity matrix: every Bakaloo capability row is delivered, adapted, or dropped with a reason; every backend operation family has a screen or an explicit "API-only" note.
- Resolve or formally defer every BACKEND_REQUESTS item; produce the final request list for the backend session.
- Documentation: operator handbook (task-based, with screenshots) in docs/handbook/, developer guide, deployment guide (environment variables, BFF secrets, reverse proxy, CSP, health checks), and a runbook (publish rollback, kill switch, pause orders, locked-out admin recovery, backend outage behaviour).
- Final acceptance report docs/build/DASH_FINAL_REPORT.md: what was built per phase with evidence, test results, what is verified vs mocked, known issues, owner decisions still open, and the exact next steps (client wiring for Flutter and website, Shiprocket live verification, Razorpay/SMS/SMTP setup).

## Backend operations used
- No new endpoints. Re-run the contract sync check and the all-blocks round-trip.

## Experience requirements
- A final end-to-end walkthrough recorded as a script a human can follow in 20 minutes covering: sign in, pause/resume orders, process an order, create a product, create and use a coupon, edit and publish a Studio change, roll back, check analytics, manage the team.

## Edge cases and failure modes you must handle
- Backend outage during publish, expired session mid-form, browser refresh during an upload, two admins racing on everything, clock drift, very slow connections.

## Acceptance criteria (each needs evidence)
- All earlier acceptance criteria still pass in one clean run (full e2e, all roles).
- Zero serious/critical axe violations on the 20 main pages; Lighthouse performance and accessibility meet the stated budgets or each miss is documented with a plan.
- Security review has no open high/critical findings.
- The owner can follow the 20-minute walkthrough unaided.
- DASH_FINAL_REPORT.md is complete and honest.

## Verification
- Run the full suite twice from a clean checkout and a fresh database; attach logs.
- Perform the 20-minute walkthrough as a different persona than the author would (the owner) and note every point of confusion; fix them.

## Handoff to the next phase (write these down)
- Release notes.
- The list of owner decisions and inputs still needed (Shiprocket account, SMS/SMTP/Razorpay, storage/CDN, domain/hosting, testimonial consent, legal copy).

## How to run this phase (mandatory ritual: do not skip or compress any step)

### Step 1: Re-ground (no code yet)
- Read every file in "Read first" above. Re-read the "Ground rules" in 00_PASTE_THIS_FIRST.md and the Handoff notes of the previous phase in docs/build/DASH_PROGRESS.md.
- List, in docs/build/phase-20-thinking.md, the exact backend operations this phase uses, each verified to exist in docs/backend-contract/api-index.md. For any operation whose request/response is only typed as "object" in openapi.yaml, call it on the running backend and record the real shape.

### Step 2: Think at 100x depth (write it down; thinking that is not written does not count)
Create docs/build/phase-20-thinking.md and fill ALL of these sections with specific, non-generic content:
1. **Users and jobs**: each role that touches this phase, the 5 jobs they do most, and what "fast and safe" means for each.
2. **State and data flow**: every state machine and data flow involved (draw as text diagrams), including loading, empty, error, offline, permission-denied, conflict and stale states.
3. **Deep-think questions**: answer every question under "Think about before building" in this file, with the decision you took and the alternative you rejected and why.
4. **Pre-mortem**: 10 realistic ways this phase fails in production (wrong data shown, double submit, leaked PII, lost draft, slow list, race condition, misleading number, role bypass, contract drift, accessibility failure) and the specific control for each.
5. **Security and privacy**: threats and mitigations for the data this phase handles.
6. **Performance and accessibility budgets**: numbers (for example list render under 100 ms for 50 rows, keyboard path for every action).
7. **Test plan**: unit, component, integration (real backend), e2e per role, visual where relevant; list the test names before writing them.
8. **Slices**: the build order as vertical slices, each independently demonstrable.

### Step 3: Challenge your own plan
Re-read your thinking file as a skeptical senior reviewer. Find at least 5 weaknesses (missed state, hidden coupling, unclear ownership of data, unproven assumption about the backend) and fix the plan. Write "Review findings and changes" at the end of the thinking file.

### Step 4: Build slice by slice
- Implement one slice at a time; after each slice run typecheck, lint, unit tests, and exercise it in the browser against the REAL local backend. Commit small, with messages that say what and why.
- Follow the component library, tokens, API layer, form kit and permission helpers from earlier phases. Do not duplicate them; improve them if they fall short and note it in DASH_DECISIONS.md.
- If the backend lacks something (an endpoint, a filter, a field), do NOT invent it and do NOT fake it in shipped code: record it in docs/build/BACKEND_REQUESTS.md with the proposed shape and a workaround, then continue.

### Step 5: Verify with evidence
Run everything under "Verification" below. Evidence means real outputs: test logs, screenshots at 375/768/1440 px, curl or network traces, audit-log entries. Claims without evidence are not accepted. Test every role listed in the permission matrix that can or cannot do things in this phase, including the negative cases.

### Step 6: Reflect and hand off
- Update docs/build/DASH_PROGRESS.md (what was built, evidence links, what is verified vs not), DASH_DECISIONS.md (new ADRs), DASH_RISKS.md, DASH_PARITY.md, BACKEND_REQUESTS.md.
- Write the Handoff section for the next phase (what it must know) at the end of the thinking file and in DASH_PROGRESS.md.
- Tick every acceptance criterion below with the evidence that proves it. If any criterion fails, fix it before moving on; if it cannot be fixed, record it honestly as a known issue with an owner decision needed.
- Print the **Phase report** (format in 00_PASTE_THIS_FIRST.md) and then begin the next phase's Step 1. Stop and ask the owner ONLY when a genuine owner decision is needed (batch your questions with defaults).
