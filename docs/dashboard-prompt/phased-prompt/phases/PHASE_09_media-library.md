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
