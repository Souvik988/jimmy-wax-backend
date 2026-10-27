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
