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
