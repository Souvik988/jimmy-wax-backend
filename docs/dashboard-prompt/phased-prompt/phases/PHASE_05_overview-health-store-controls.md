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
