# PHASE 15 of 20: Experience Studio VI: validation gate, diff, releases, scheduling, rollback, kill switch, campaigns and the baseline seed

> Ritual reminder: Re-ground, then Think at 100x (written), then Challenge the plan, then Build in slices, then Verify with evidence, then Reflect and hand off. The thinking file for this phase is docs/build/phase-15-thinking.md.

## Mission
Make publishing safe and reversible. Operators see exactly what will change, publish atomically for one or both channels, schedule, roll back instantly, and cut a channel back to the bundled design with a kill switch. Also seed the baseline so the first release reproduces today's look.

## Read first
- 02_EXPERIENCE_STUDIO_SPEC.md sections 9 (publishing), 11 (client consumption contract), 12 (seed content), 13 (acceptance)
- api-index: admin/experience/releases, campaigns, kill, diff, validate, preview-tokens
- 03_BACKEND_CONTRACT.md "Implementation status"

## Think about before building (answer each in your thinking file)
- A bad publish is the worst day of the project: what are ALL the safeguards (blocking validation, diff review, typed confirmation for production, MFA step-up, idempotency key, scheduling, instant rollback, kill switch, immutable releases)? Walk through each failure scenario and confirm a safeguard exists in the UI.
- Scheduled activation: view v_exp_effective picks the effective release by time. How do you present timeline state: current, scheduled next, history? How do you handle replacing a scheduled release (needs confirmation) and cancelling?
- Campaigns: time-boxed overrides (for example Diwali banner) layered on the released bundle. What can a campaign override (read the schema) and how do you present precedence and overlap?
- Both channels in one release: separate vs combined publish; partial failure semantics (atomic per release: confirm in the contract).
- The baseline seed: the first release must reproduce today's app and website so nothing visibly changes on day one. Who builds it? You, with a repeatable tool that uses the admin API (not direct SQL): upload the existing images/videos to the media library with correct provenance, create the tokens/navigation/chrome/page documents mirroring the current clients, run validation, publish as release 1 for BOTH channels with the clients still hard-coded (the clients will adopt the bundle in the client-wiring phase). What risks does seeding introduce (media rights, alt text quality) and how do you review them?

## Scope: what to build
- Publish wizard: choose channels, run validation (blocking errors, acknowledged warnings), diff against the live release (GET .../diff: per document and per block, readable), notes, schedule (now or at a future IST time), typed confirmation, MFA step-up, Idempotency-Key, success state with the release id and a link to the live bundle (GET /v1/experience/{channel}).
- Releases page: timeline of releases per channel (status: live, scheduled, superseded, rolled back), release detail (documents included, validation snapshot, who/when/notes), Roll back (POST .../releases/{id}/rollback with reason) and Cancel scheduled (POST .../cancel).
- Kill switch per channel (POST /v1/admin/experience/{channel}/kill) with a persistent red state indicator across the Studio and overview when a channel is killed; instructions on what clients do (fall back to bundled design).
- Campaigns: list/create/edit (GET|POST|PUT /v1/admin/experience/campaigns) with schedule, channel, overrides editor (engine), conflict detection with other campaigns and a calendar view.
- Preview tokens manager (create with expiry/scope, list, revoke).
- Baseline seed tool: scripts/seed-baseline-experience.ts (runs against the API with an operator login, idempotent, dry-run mode) plus docs/build/BASELINE_SEED.md listing every asset uploaded, its provenance, alt text, and a reviewer checklist; then publish release 1.
- Client-wiring brief: produce docs/build/CLIENT_WIRING_BRIEF.md for the Flutter and website teams from 05_CLIENT_INTEGRATION_SPEC.md and your real bundle samples (JSON), including capability headers, ETag/304, fallbacks, and the acceptance tests each client must pass.

## Backend operations used
- POST /v1/admin/experience/releases (idempotent), GET /v1/admin/experience/releases, GET /v1/admin/experience/releases/{id}, POST .../rollback, POST .../cancel, GET /v1/admin/experience/{channel}/diff, POST /v1/admin/experience/{channel}/kill, GET|POST|PUT /v1/admin/experience/campaigns, preview tokens, GET /v1/experience/{channel} (public bundle, ETag).

## Experience requirements
- The publish button is intentionally deliberate; rollback is intentionally fast.
- Diff is human-first (what the customer sees changes) with a raw JSON tab.
- A global "Live now" panel shows per channel: release id, published by/at, ETag, scheduled next.

## Edge cases and failure modes you must handle
- Publishing with an unapproved media asset or placeholder testimonial (blocked); publishing while another operator edits (presence warning); scheduling in the past; two scheduled releases; rollback to a release whose media was archived; kill switch on both channels; campaign overlapping a release schedule; idempotent retry after a network drop (same key returns the same release).

## Acceptance criteria (each needs evidence)
- Release 1 (baseline) is live for both channels and GET /v1/experience/app and /web return the expected bundles with ETags (304 on repeat).
- Rollback, schedule, cancel and kill switch each demonstrated against the real backend with audit entries.
- A validation failure blocks publishing and links to the fix.
- The baseline seed is repeatable on a fresh database (run it twice: no duplicates).
- CLIENT_WIRING_BRIEF.md reviewed against the current Flutter and website code for feasibility.

## Verification
- Record the full publish, schedule, rollback and kill sequence with screenshots and curl evidence of the public bundle after each step.

## Handoff to the next phase (write these down)
- Bundle samples for both channels.
- The exact acceptance tests the clients must pass.
- Anything the backend should change (BACKEND_REQUESTS).

## How to run this phase (mandatory ritual: do not skip or compress any step)

### Step 1: Re-ground (no code yet)
- Read every file in "Read first" above. Re-read the "Ground rules" in 00_PASTE_THIS_FIRST.md and the Handoff notes of the previous phase in docs/build/DASH_PROGRESS.md.
- List, in docs/build/phase-15-thinking.md, the exact backend operations this phase uses, each verified to exist in docs/backend-contract/api-index.md. For any operation whose request/response is only typed as "object" in openapi.yaml, call it on the running backend and record the real shape.

### Step 2: Think at 100x depth (write it down; thinking that is not written does not count)
Create docs/build/phase-15-thinking.md and fill ALL of these sections with specific, non-generic content:
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
