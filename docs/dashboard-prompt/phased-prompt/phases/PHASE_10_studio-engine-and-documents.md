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
