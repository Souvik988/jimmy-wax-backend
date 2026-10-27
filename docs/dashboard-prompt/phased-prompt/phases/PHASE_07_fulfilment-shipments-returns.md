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
