# PHASE 02 of 20: Design system, tokens, application shell and component library

> Ritual reminder: Re-ground, then Think at 100x (written), then Challenge the plan, then Build in slices, then Verify with evidence, then Reflect and hand off. The thinking file for this phase is docs/build/phase-02-thinking.md.

## Mission
Build the visual and interaction foundation every later screen reuses: a premium dark-walnut / brass / ivory operator UI that matches the Jimmy & Wax brand, plus the shell (navigation, command palette, layout) and a tested component library.

## Read first
- docs/backend-contract/01_REFERENCE_ANALYSIS_BAKALOO.md section 4 (cross-cutting UX patterns to replicate) and section 5 (anti-patterns to avoid)
- The website tokens file C:/Users/MSI/OneDrive/Desktop/jimmy_nd _wax_website/src/styles/tokens.css and design-system/jimmy-wax/MASTER.md (if you can read them) for the palette and type
- 02_EXPERIENCE_STUDIO_SPEC.md section 3 (the Design System the STUDIO edits is different from the dashboard's own UI theme: do not conflate them)

## Think about before building (answer each in your thinking file)
- What is the operator's day like? List the 12 most frequent tasks and make sure the shell makes each one at most 2 clicks or one keystroke away.
- Which components will be used 50+ times (table, filters, form fields, drawer, dialog, toast, badge, empty state, skeleton, stat card, date range, money input, id chip)? Define their props and states before coding.
- Dark-only or light + dark? Operators work long hours; decide with contrast numbers (WCAG AA minimum, AAA for body text where feasible) and document.
- Density: a dense data table must still be readable. Define 3 row heights and when each is used.
- What would make this feel like a premium product rather than an admin template (motion restraint, typography, spacing rhythm, iconography)? What would make it feel cheap?
- Accessibility first: focus order, focus rings, landmark structure, reduced motion, keyboard shortcuts that do not collide with screen readers.

## Scope: what to build
- Tokens as CSS variables (colour roles, spacing 4px scale, radii, shadows, z-scale, motion durations/easings, type scale) in one file; both a dashboard theme and a documented way to add a light theme later.
- Fonts: Playfair Display for display headings only, Inter for UI; load via next/font with swap; tabular numerals for money and counts.
- Components (each with stories or a living /dev/components page, unit tests, and accessibility tests): Button (variants, loading), IconButton, Input, Textarea, Select, Combobox, MultiSelect, Checkbox, Switch, RadioGroup, Money input (paise-safe), Date and DateRange picker (IST), Tabs, Dialog, Drawer, Popover, Tooltip, Toast, Badge/StatusPill, Avatar, Card, StatCard, Skeleton, EmptyState, ErrorState, Pagination (cursor), DataTable (sorting, column visibility, row selection, sticky header, density, virtualisation threshold), FilterBar (chips, saved views), CopyableId, JsonViewer, ConfirmDialog (typed confirmation for destructive actions), ReasonDialog (3-300 chars, required by the backend for sensitive actions), StepUpDialog placeholder (completed in phase 3).
- App shell: collapsible sidebar grouped by area (Overview, Orders & Fulfilment, Catalogue, Studio, Customers, Marketing, Insights, Settings), top bar (global search stub, store status pill, environment badge, user menu), breadcrumbs, responsive behaviour (sidebar becomes a drawer under 1024px), command palette (Ctrl/Cmd+K) with registered commands and recent items, and a global "toast + undo" pattern.
- Navigation is data-driven and permission-aware: each item declares the permission(s) needed (phase 3 fills this in); items the role cannot use are hidden, and deep links to them show a proper "not allowed" state, never a blank page.
- A /dev/components page (dev-only) that renders every component in every state for visual review.

## Backend operations used
- None.

## Experience requirements
- Empty, loading, error, offline and permission-denied states are designed ONCE here and reused: copy that tells the operator what happened and what to do next, with a request id on errors.
- Motion: 160-240ms for micro-interactions, 240-360ms for panels, none for table updates; honour prefers-reduced-motion everywhere.
- Every interactive element is at least 36px tall on desktop and 44px on touch; visible focus ring (2px brass) on all.

## Edge cases and failure modes you must handle
- Very long product names, 10-digit order totals, RTL-looking mixed text, emoji in names: components must not break.
- Browser zoom 200%, Windows high-contrast mode, keyboard-only use.
- Hydration mismatches from dates (always render IST via an explicit formatter, never toLocale* defaults).

## Acceptance criteria (each needs evidence)
- Every listed component exists with unit tests; axe reports zero serious/critical violations on /dev/components.
- The shell passes keyboard-only navigation (tab order, skip link, palette open/close, escape behaviour).
- Money and date formatting helpers are unit-tested (paise to ₹ with en-IN grouping, IST dates, relative times).
- Lighthouse accessibility >= 95 on the shell page.

## Verification
- Screenshot /dev/components at 375, 768 and 1440 px.
- Run axe via Playwright and attach the report.
- Record a short keyboard-only walkthrough script and run it as an e2e test.

## Handoff to the next phase (write these down)
- Component inventory with props summary.
- Tokens table.
- Any component you deferred and why.

## How to run this phase (mandatory ritual: do not skip or compress any step)

### Step 1: Re-ground (no code yet)
- Read every file in "Read first" above. Re-read the "Ground rules" in 00_PASTE_THIS_FIRST.md and the Handoff notes of the previous phase in docs/build/DASH_PROGRESS.md.
- List, in docs/build/phase-02-thinking.md, the exact backend operations this phase uses, each verified to exist in docs/backend-contract/api-index.md. For any operation whose request/response is only typed as "object" in openapi.yaml, call it on the running backend and record the real shape.

### Step 2: Think at 100x depth (write it down; thinking that is not written does not count)
Create docs/build/phase-02-thinking.md and fill ALL of these sections with specific, non-generic content:
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
