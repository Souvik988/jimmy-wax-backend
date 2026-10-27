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
