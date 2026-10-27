# PHASE 12 of 20: Experience Studio III: app page builder with a faithful phone preview

> Ritual reminder: Re-ground, then Think at 100x (written), then Challenge the plan, then Build in slices, then Verify with evidence, then Reflect and hand off. The thinking file for this phase is docs/build/phase-12-thinking.md.

## Mission
Compose the mobile app's Home, Category, Product and Cart pages from the app block library, see them rendered like the Flutter app, and validate before publishing.

## Read first
- 02_EXPERIENCE_STUDIO_SPEC.md section 6 (block libraries: app), section 8 (authoring UX), section 10 (preview architecture)
- The Flutter app screens for fidelity reference: C:/Users/MSI/OneDrive/Desktop/jimmy&wax_app/lib/main.dart (HomeScreen, HeroBanner, CategoriesScreen, TestimonialSection), lib/core/theme/*, docs/UI_INVENTORY.md
- blocks.schema.json: all app.* blocks, nativeSections for native pages
- 03_BACKEND_CONTRACT.md "Implementation status" (preview is served by commerce-api: GET /v1/experience/{channel}/preview?token=)

## Think about before building (answer each in your thinking file)
- The app is native Flutter. The dashboard cannot embed it. What is the preview strategy? Options: (A) a React re-implementation of each app block that reads the same tokens and bundle JSON (fidelity badge, side-by-side with real device screenshots for acceptance), (B) screenshots from a Flutter web build, (C) later: Flutter web embedded in an iframe fed by a preview token. Decide, with the trade-offs, and design the preview as a pluggable "Renderer" so you can swap later.
- Which blocks are the home page today? Map each current Flutter section (hero carousel, category shortcuts, product rails, benefits, testimonial section, care ritual, promo cards, announcement) to a block, and list anything on the real home that the block library cannot express (record in BACKEND_REQUESTS).
- Native pages (cart, product detail) are not freely composable: nativeSections let the operator toggle and reorder native sections only. How do you present "fixed vs editable" so the operator is never surprised?
- Data-driven blocks (product rails by collection/category/manual/bestsellers/newest; testimonials from verified reviews or curated ids): the preview needs live data: which public endpoints supply it (GET /v1/products, /v1/collections/{slug}/products)?
- Device realism: 360x800 and 390x844 frames, safe areas, dark theme only, large text scale, offline/empty catalogue, slow network skeletons.

## Scope: what to build
- Three-pane builder: structure tree (blocks with visibility icons, errors), centre phone preview (device frame switcher, text scale, scroll position sync with selection), inspector (the phase-10 engine) plus a block palette drawer.
- React renderers for every app block (hero_carousel with autoplay settings, category_shortcuts rings, product_rail, benefits_row, testimonials, care_ritual, promo_cards, announcement_bar, banner, rich_text, faq, trust_strip, spacer), all driven by tokens (from the tokens doc) and real media URLs from the library; a "bundled asset" resolver that shows the app's asset images when media has a bundled_key (the dashboard has copies under a configured assets folder or placeholder boxes with the key name).
- Selection sync: click a block in the preview to select it in the tree and inspector and vice versa; drag to reorder in either; inline text editing for headline fields (optional: do last).
- Native sections toggles for product/cart pages (key, visible, order) with explanation.
- Per-block visibility preview: simulate time (schedule), platform, signed-in state with a "Preview as" control.
- Preview with live backend data: product rails call the public read API through the BFF; campaigns overlay (phase 15) toggles.
- Live validation overlay (errors on the offending block in the preview).
- Preview token generation (POST .../preview-tokens) to produce a link/QR the app's preview build can open (dev builds only); list and revoke tokens (DELETE /v1/admin/experience/preview-tokens/{id}).

## Backend operations used
- Everything from phase 10 + POST /v1/admin/experience/{channel}/preview-tokens, DELETE /v1/admin/experience/preview-tokens/{id}, GET /v1/products and collections endpoints (public, via BFF) for live data, GET /v1/admin/content-library/{entity} for testimonials/guides by id.

## Experience requirements
- Preview updates within 100ms of an edit (render from local draft state, not after a save).
- A fidelity banner states which blocks are approximations until real-device screenshots confirm them.
- Mobile-friendly builder is NOT required (a notice appears under 1024px) but all non-Studio pages remain responsive.

## Edge cases and failure modes you must handle
- Missing or unapproved media (placeholder with a clear warning), deleted collection/product in a rail (rail hides that product, warning shows), hero text over bright images (contrast warning when textInImage is true), 8 slides with very long headlines, RTL strings, empty testimonials (placeholders block publishing: show why), unknown future block types (render a labelled stub).
- Very large pages (30 blocks) scrolling performance in the preview.

## Acceptance criteria (each needs evidence)
- The app home page can be recreated from blocks so that, side by side with a real-device/emulator screenshot of the current app home, a reviewer rates the preview "recognisably the same layout" (store both images in docs/qa).
- All app blocks render with realistic data and with missing data without crashing (unit + visual tests).
- Select/reorder/duplicate/delete flows are keyboard accessible.
- Validation errors/warnings appear on the preview and tree.
- Preview token flow works: create, copy, revoke; the commerce-api preview endpoint returns the draft with no-store/noindex headers (curl evidence).

## Verification
- Capture the side-by-side fidelity screenshots; run the all-blocks render tests; run the preview-token curl checks.

## Handoff to the next phase (write these down)
- Renderer interface and the list of approximated blocks.
- Gaps between the real app home and the block library (BACKEND_REQUESTS).

## How to run this phase (mandatory ritual: do not skip or compress any step)

### Step 1: Re-ground (no code yet)
- Read every file in "Read first" above. Re-read the "Ground rules" in 00_PASTE_THIS_FIRST.md and the Handoff notes of the previous phase in docs/build/DASH_PROGRESS.md.
- List, in docs/build/phase-12-thinking.md, the exact backend operations this phase uses, each verified to exist in docs/backend-contract/api-index.md. For any operation whose request/response is only typed as "object" in openapi.yaml, call it on the running backend and record the real shape.

### Step 2: Think at 100x depth (write it down; thinking that is not written does not count)
Create docs/build/phase-12-thinking.md and fill ALL of these sections with specific, non-generic content:
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
