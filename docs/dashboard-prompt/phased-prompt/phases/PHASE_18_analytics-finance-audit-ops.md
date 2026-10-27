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
