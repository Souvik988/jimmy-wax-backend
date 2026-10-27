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
