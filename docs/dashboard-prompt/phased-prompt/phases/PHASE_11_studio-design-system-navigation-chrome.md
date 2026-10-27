# PHASE 11 of 20: Experience Studio II: design system tokens, navigation and app/web chrome

> Ritual reminder: Re-ground, then Think at 100x (written), then Challenge the plan, then Build in slices, then Verify with evidence, then Reflect and hand off. The thinking file for this phase is docs/build/phase-11-thinking.md.

## Mission
Let the operator control the visual language and the frame of each channel: colours, typography, shape, spacing, navigation items, header/footer/tab bar, brand slots, with instant visual feedback and guard rails against unreadable or off-brand results.

## Read first
- 02_EXPERIENCE_STUDIO_SPEC.md section 3 (Design System) and section 4/5
- blocks.schema.json: docs.tokens, docs.navigation, docs.chrome, colorRoles, brandSlots
- 03_BACKEND_CONTRACT.md "Implementation status": override tokens are stored as {overrides: ...} and must be a subset of base

## Think about before building (answer each in your thinking file)
- Tokens are semantic roles, never raw per-component colours. What guard rails stop an operator from making the app unreadable (contrast checks computed from the same colour utilities the backend validation uses, minimum touch targets, font-size floors)? Where does the backend validate (and return warnings) vs where must the UI pre-empt?
- Palettes and fonts must STAY AS THEY ARE for now (owner decision): the first release reproduces today's look exactly. How do you present the editor so that the current values are the defaults and "Reset to released" is always one click?
- Fonts: only licensed fonts the library holds (font media items). How do you let the operator choose heading/body fonts without breaking the brand, and how do clients download them (media)?
- Navigation: app tab bar (3-5 items with icons and screens) vs web header links (routes/anchors). Which icons are allowed (enum) and how do you preview them?
- Chrome: header, footer, tab bar, brand slots (logo, splash, empty-state art): which are media refs? How do you show the effect on the real layout?
- Override docs: what are they for (campaign or seasonal overrides as a subset of base) and how do you make the subset rule obvious (only overridden keys are listed; "inherit" is the default)?

## Scope: what to build
- Design system editor for tokens/base (and tokens/override per channel where the schema allows): colour roles with a colour picker + hex input, derived contrast ratios (text on surface, on brand, on card) with AA/AAA badges and a computed "fix suggestion", typography (families from font library, scale, weights, line heights), shape (radii by role), spacing scale, elevation, motion durations, control sizes; each group has a live specimen panel.
- A "tokens diff vs released" view and one-click reset per group; "Compare with baseline" (the seeded first release).
- Navigation editor: app tab bar and web header/footer links, with drag reorder, label, icon (enum), Action picker (screen/route/page/url/tel/mailto/whatsapp/product/collection/category/anchor) with validation and a link checker (internal targets exist, external URLs https).
- Chrome editor: header style, footer content blocks (links, contact, social), announcement defaults, brand slots with MediaPicker (logo, wordmark, splash, empty-state art), legal links.
- Action picker widget (shared with all blocks): resolves human names (product names, collection titles) from the catalogue APIs so operators never type ids.
- Colour and font utilities module (contrast, APCA optional) with unit tests, mirroring the backend color.ts semantics: read the backend contract notes and test against known pairs.

## Backend operations used
- GET|PUT /v1/admin/experience/{channel}/docs/tokens/{base|override}, /docs/navigation/main, /docs/chrome/main (shared docs use channel "shared" where the schema says so: confirm in api-index), validation via POST .../validate, media via the library (phase 9).

## Experience requirements
- A dense but calm inspector; colour changes preview instantly in the specimen and (from phases 12-13) in the live preview.
- Warnings explain the consequence ("Body text on cards is 3.9:1; below AA 4.5:1") and offer fixes.
- Keyboard-accessible colour picking (hex field first, then picker).

## Edge cases and failure modes you must handle
- Transparent/alpha hex values, colours with insufficient contrast but allowed as decoration, deleting a font that tokens reference, nav item pointing to a deleted product/collection, duplicate nav ids, too many tab items.
- Override document that tries to set keys not present in base (backend refuses): the UI prevents it.

## Acceptance criteria (each needs evidence)
- Editing tokens, navigation and chrome round-trips through the backend; the validate endpoint's warnings appear in the UI.
- Contrast utility matches backend results on a fixture set of 30 colour pairs (test).
- Reset-to-released and compare-with-baseline work.
- Action picker produces only valid Actions for the channel (app screens vs web routes).

## Verification
- Screenshots of the editor and specimen; run the contrast fixture test; run the all-blocks round trip again (nothing regressed).

## Handoff to the next phase (write these down)
- Action picker and MediaPicker API.
- Which token groups the clients actually honour today (check docs/backend-contract/05_CLIENT_INTEGRATION_SPEC.md; note anything the clients do not yet read).

## How to run this phase (mandatory ritual: do not skip or compress any step)

### Step 1: Re-ground (no code yet)
- Read every file in "Read first" above. Re-read the "Ground rules" in 00_PASTE_THIS_FIRST.md and the Handoff notes of the previous phase in docs/build/DASH_PROGRESS.md.
- List, in docs/build/phase-11-thinking.md, the exact backend operations this phase uses, each verified to exist in docs/backend-contract/api-index.md. For any operation whose request/response is only typed as "object" in openapi.yaml, call it on the running backend and record the real shape.

### Step 2: Think at 100x depth (write it down; thinking that is not written does not count)
Create docs/build/phase-11-thinking.md and fill ALL of these sections with specific, non-generic content:
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
