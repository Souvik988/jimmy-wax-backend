# PHASE 01 of 20: Orientation, audit, decisions and repository foundations

> Ritual reminder: Re-ground, then Think at 100x (written), then Challenge the plan, then Build in slices, then Verify with evidence, then Reflect and hand off. The thinking file for this phase is docs/build/phase-01-thinking.md.

## Mission
Understand everything that exists before writing a feature: the backend contract, the two clients, the Bakaloo reference analysis, the current dashboard scaffold. Decide the stack and conventions once, in writing, and make the repository ready for 19 more phases.

## Read first
- 00_PASTE_THIS_FIRST.md (this prompt) and docs/backend-contract/INTEGRATION_GUIDE.md
- docs/backend-contract/03_BACKEND_CONTRACT.md (read the "Implementation status and deviations" section FIRST: it overrides the rest of that file)
- docs/backend-contract/api-index.md and openapi.yaml (the source of truth for operations)
- docs/backend-contract/01_REFERENCE_ANALYSIS_BAKALOO.md and 02_EXPERIENCE_STUDIO_SPEC.md (skim now, study again when you reach the Studio phases)
- The existing scaffold: package.json, src/app/*, docs/build/DASH_*.md (it is a single mock-data prototype page: judge whether to keep any of it)

## Think about before building (answer each in your thinking file)
- What are the five biggest ways this project could fail (scope, security, contract drift, Studio complexity, quality)? What in the repo structure prevents each?
- Which parts of the existing scaffold are worth keeping (tokens, shell idea, command palette) and which must be rebuilt properly? Justify with evidence from the code.
- Stack choices: server-state library, table library, form library, UI primitives, styling approach, test tools, API type generation. For each, list 2 options, the trade-off for a 20-phase build by one agent, and pick one. Record as ADRs.
- How will the dashboard talk to the backend so tokens never reach the browser (BFF)? What are the exact trust boundaries?
- How will you keep the dashboard honest against backend drift (contract tests, generated types, a nightly "spec vs api-index" diff)?
- What does "done" mean for the whole project? Draft the final acceptance checklist now (you will extend it every phase).

## Scope: what to build
- Create or confirm the repository layout: src/app (routes), src/features/<area>, src/components (design system), src/lib (api, auth, utils), src/server (BFF helpers), tests/ (unit, e2e), docs/build (DASH_PLAN, DASH_DECISIONS, DASH_PROGRESS, DASH_RISKS, DASH_PARITY, BACKEND_REQUESTS).
- Pin the stack with ADRs in docs/build/DASH_DECISIONS.md. Recommended defaults (override only with a written reason): Next.js (App Router) + React + TypeScript strict; TanStack Query for server state; TanStack Table for tables; react-hook-form + zod for forms; Radix UI primitives wrapped in your own components; Tailwind CSS with design tokens as CSS variables; openapi-typescript for generated API types; Vitest + Testing Library; Playwright + axe for e2e and accessibility.
- Generate API types from docs/backend-contract/openapi.yaml into src/lib/api/generated and add a script that fails CI when the spec file changes without regenerating.
- Wire tooling: strict tsconfig, ESLint (no-explicit-any as error), Prettier, Vitest, Playwright, a pre-commit or CI-equivalent script "pnpm verify" = typecheck + lint + unit tests + build.
- Create the parity matrix docs/build/DASH_PARITY.md: one row per Bakaloo capability from 01_REFERENCE_ANALYSIS (adopt / adapt / drop + reason + phase that delivers it) and one row per backend operation family from api-index.md (which screen uses it, which phase).
- Write docs/build/DASH_PLAN.md: the 20 phases with your own estimates, dependencies, and the order you will actually build (you may reorder phases 5-9 if you can justify it; never reorder 1-4 or the Studio phases 10-15).
- Start the real backend locally (see INTEGRATION_GUIDE.md), create operator accounts for every role (scripts/create-admin.ts in the backend repo, roles admin, support, catalog, fulfillment, finance, designer) and record how to repeat this in docs/build/LOCAL_DEV.md.

## Backend operations used
- GET /healthz and /readyz on commerce-api (reachability check only).
- No feature endpoints yet; confirm by calling GET /v1/store-settings through the gateway that the backend is up.

## Experience requirements
- None yet beyond a "Connected to backend / Backend unreachable" indicator in the existing prototype shell, driven by a real call, replacing the "Mock API" label.

## Edge cases and failure modes you must handle
- Backend not running: the dashboard must say so plainly, not show fake data.
- Port clashes on a developer machine (the website uses 5174, the dashboard 3200, the gateway 8080, commerce-api 4000, experience-api 4001).
- Spec drift: the openapi.yaml you were given is a snapshot; document the version you built against.

## Acceptance criteria (each needs evidence)
- docs/build has DASH_PLAN, DASH_DECISIONS (>= 8 ADRs), DASH_PARITY, DASH_RISKS (>= 10 risks with mitigations), BACKEND_REQUESTS (empty list is fine), LOCAL_DEV.
- "pnpm verify" passes on a clean clone.
- Generated API types compile and a trivial typed call (store settings) works through the BFF stub.
- The prototype page no longer claims "Mock API" anywhere it is not actually mocked.

## Verification
- Run pnpm install, pnpm verify, pnpm dev; open http://localhost:3200 and screenshot the connected indicator.
- Stop the backend and confirm the unreachable state; start it again and confirm recovery without a reload.

## Handoff to the next phase (write these down)
- List every ADR with its one-line decision.
- List every contract mismatch you already noticed.
- State the exact local-dev commands that worked.

## How to run this phase (mandatory ritual: do not skip or compress any step)

### Step 1: Re-ground (no code yet)
- Read every file in "Read first" above. Re-read the "Ground rules" in 00_PASTE_THIS_FIRST.md and the Handoff notes of the previous phase in docs/build/DASH_PROGRESS.md.
- List, in docs/build/phase-01-thinking.md, the exact backend operations this phase uses, each verified to exist in docs/backend-contract/api-index.md. For any operation whose request/response is only typed as "object" in openapi.yaml, call it on the running backend and record the real shape.

### Step 2: Think at 100x depth (write it down; thinking that is not written does not count)
Create docs/build/phase-01-thinking.md and fill ALL of these sections with specific, non-generic content:
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
