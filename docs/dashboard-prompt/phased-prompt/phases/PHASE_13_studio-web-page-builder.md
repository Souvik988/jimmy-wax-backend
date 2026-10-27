# PHASE 13 of 20: Experience Studio IV: website page builder, SEO and product page template

> Ritual reminder: Re-ground, then Think at 100x (written), then Challenge the plan, then Build in slices, then Verify with evidence, then Reflect and hand off. The thinking file for this phase is docs/build/phase-13-thinking.md.

## Mission
Compose the website's Home, Shop, Product, Ritual and Story pages from the web block library (cinematic films, marquee, collection grid, ritual steps, testimonials with video, journal stack, promo film, closing CTA) with a desktop/tablet/mobile preview and SEO control.

## Read first
- 02_EXPERIENCE_STUDIO_SPEC.md section 6 (web blocks), section 8-10
- The website: C:/Users/MSI/OneDrive/Desktop/jimmy_nd _wax_website/src/pages/*.tsx and src/components/* (HeroScrub, ScrubFilm, JournalBlock, StoriesBlock, PromoBlock, RitualBlock), src/styles/*.css
- blocks.schema.json: all web.* blocks, seo, PDP_SECTIONS

## Think about before building (answer each in your thinking file)
- Map every section of today's website home to a web block (hero_film, marquee, chapter_mark, collection_grid, ritual_steps, scrub_film/atelier_film, standards_grid, evidence_rail, reels_rail (stories), journal_stack, promo_film, testimonials, closing_cta). What cannot be expressed? (Record it.)
- Preview fidelity: the website is a real web app, so the best preview is the website itself. Today the website does NOT yet consume the bundle. Plan: (1) preview with dashboard-side React renderers that mirror the website's components and CSS tokens now; (2) design the iframe mode (website reads ?preview=token) as the target and specify it in docs/build/WEB_PREVIEW_IFRAME_SPEC.md for the website repo. What are the security implications of rendering the real site in an iframe from the dashboard (frame-ancestors, token in URL, noindex)?
- Film blocks: large video media with desktop/mobile/poster variants. How do you help the operator pick compatible assets and warn about weight (file size budgets, poster mandatory, muted autoplay rules, reduced-motion fallback)?
- SEO per page and per product: title length, description length, canonical, social image, structured data hints; uniqueness across pages (backend enforces title uniqueness on web docs). How do you show the Google-style preview and the duplicate-title conflict?
- Product page template (PDP_SECTIONS: gallery, description, key_benefits, suitable_surfaces, box_contents, info_card, delivery_estimate, reviews, related, pairings): order and visibility per channel, not free composition.
- Testimonials with video are allowed on web only: how is that enforced and explained in the editor?

## Scope: what to build
- The same three-pane builder as phase 12 for web pages with device switching (1440, 1024, 768, 375), scroll-synced selection, and React renderers for all web blocks (using the website's CSS tokens: copy only tokens and layout CSS into a scoped package, never import the website app).
- SEO panel per page (title, description with counters, canonical, social image via MediaPicker, robots flag if in schema) with a SERP preview and a duplicate-title checker.
- Product page template editor (PDP sections order/visibility) with a preview using a real product from the catalogue (selectable) and live availability/price (from the public API).
- Film/video block helpers: asset requirement checklist (poster present, mp4/webm, size budget warning, mobile variant present), and a "reduced motion" preview toggle.
- Link checker across the page (internal routes/anchors exist; external https).
- Web preview tokens and the iframe spec document for the website team.

## Backend operations used
- Same document/validation/preview-token endpoints as phase 12 with channel=web; media library; catalogue public reads; content-library entities for journal notes, stories (reels), testimonials, FAQ groups.

## Experience requirements
- Cinematic blocks preview as poster images by default with an explicit "play" to avoid melting the dashboard; reduced-motion respected.
- A "Publish checklist" sidebar summarises blockers for this page (errors, unapproved media, placeholder testimonials, missing alt, duplicate SEO titles).

## Edge cases and failure modes you must handle
- Missing posters, huge videos, deleted referenced stories/notes/testimonials (by id), blocks that exceed max-per-page (palette disables with the reason), pages with zero blocks, duplicate anchors/ids, link to a route that does not exist.
- Testimonial with video referenced from an APP page (backend validation error: show it clearly).

## Acceptance criteria (each needs evidence)
- The website home, shop, product, ritual and story pages can be composed from blocks and previewed with recognisable fidelity (side-by-side screenshots in docs/qa).
- SEO validation and duplicate-title detection work against the backend.
- PDP template edits persist and reload.
- The iframe preview spec exists and is reviewed against the security checklist.

## Verification
- Fidelity screenshots at 4 widths; e2e compose-a-page flow; accessibility checks on the builder UI itself.

## Handoff to the next phase (write these down)
- Renderer coverage table (block to renderer to fidelity rating).
- Open BACKEND_REQUESTS for web blocks.

## How to run this phase (mandatory ritual: do not skip or compress any step)

### Step 1: Re-ground (no code yet)
- Read every file in "Read first" above. Re-read the "Ground rules" in 00_PASTE_THIS_FIRST.md and the Handoff notes of the previous phase in docs/build/DASH_PROGRESS.md.
- List, in docs/build/phase-13-thinking.md, the exact backend operations this phase uses, each verified to exist in docs/backend-contract/api-index.md. For any operation whose request/response is only typed as "object" in openapi.yaml, call it on the running backend and record the real shape.

### Step 2: Think at 100x depth (write it down; thinking that is not written does not count)
Create docs/build/phase-13-thinking.md and fill ALL of these sections with specific, non-generic content:
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
