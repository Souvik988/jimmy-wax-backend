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
