# PHASE 20 of 20: Hardening, quality gates and release readiness

> Ritual reminder: Re-ground, then Think at 100x (written), then Challenge the plan, then Build in slices, then Verify with evidence, then Reflect and hand off. The thinking file for this phase is docs/build/phase-20-thinking.md.

## Mission
Prove the dashboard is safe, fast, accessible and maintainable, close every open gap honestly, and leave the owner with a runbook and a verified acceptance report.

## Read first
- docs/build/DASH_PARITY.md, DASH_RISKS.md, BACKEND_REQUESTS.md (all of them: every open row needs a resolution or an explicit deferral)
- docs/backend-contract/INTEGRATION_GUIDE.md "Not connected yet"
- The acceptance checklist you started in phase 1

## Think about before building (answer each in your thinking file)
- Run a pre-mortem on the entire product: list 25 ways it could embarrass or harm the business within the first month (wrong price published, leaked PII, locked-out admin, bad release, slow list, lost draft, silent failure). For each, point to the control that prevents or limits it, or fix it now.
- Security review like an attacker: authentication, session, CSRF, XSS (every field that renders user/customer content), SSRF (any URL fetch by the BFF), file upload, IDOR (ids in URLs: the backend enforces, but confirm the BFF never widens access), clickjacking, dependency risk, secrets in the repo, logging of PII.
- Performance: budgets per page (LCP, INP, bundle size), the worst offenders (tables with 10k rows, Studio with 40 blocks, media grid), and profiles that prove they are met.
- Accessibility: a real audit (axe, keyboard-only, screen-reader spot checks on the 10 most important flows, zoom 200%, reduced motion).
- What does a new developer need to be productive in one hour? What does an operator need to be productive in one day?

## Scope: what to build
- Security hardening pass with a written report docs/build/DASH_SECURITY_REVIEW.md (findings, severity, fixes, residual risk); CSP tightened with no unsafe-inline; dependency audit; secrets scan; logging review (no PII/tokens).
- Performance pass with measured numbers; code-splitting for the Studio; virtualisation where needed; image optimisation.
- Accessibility pass with fixes; document known issues honestly.
- Test pyramid report: unit, component, integration, e2e (per role), visual regression for the Studio renderers; flake triage; CI-equivalent "pnpm verify:all" including e2e against the real local backend.
- Close the parity matrix: every Bakaloo capability row is delivered, adapted, or dropped with a reason; every backend operation family has a screen or an explicit "API-only" note.
- Resolve or formally defer every BACKEND_REQUESTS item; produce the final request list for the backend session.
- Documentation: operator handbook (task-based, with screenshots) in docs/handbook/, developer guide, deployment guide (environment variables, BFF secrets, reverse proxy, CSP, health checks), and a runbook (publish rollback, kill switch, pause orders, locked-out admin recovery, backend outage behaviour).
- Final acceptance report docs/build/DASH_FINAL_REPORT.md: what was built per phase with evidence, test results, what is verified vs mocked, known issues, owner decisions still open, and the exact next steps (client wiring for Flutter and website, Shiprocket live verification, Razorpay/SMS/SMTP setup).

## Backend operations used
- No new endpoints. Re-run the contract sync check and the all-blocks round-trip.

## Experience requirements
- A final end-to-end walkthrough recorded as a script a human can follow in 20 minutes covering: sign in, pause/resume orders, process an order, create a product, create and use a coupon, edit and publish a Studio change, roll back, check analytics, manage the team.

## Edge cases and failure modes you must handle
- Backend outage during publish, expired session mid-form, browser refresh during an upload, two admins racing on everything, clock drift, very slow connections.

## Acceptance criteria (each needs evidence)
- All earlier acceptance criteria still pass in one clean run (full e2e, all roles).
- Zero serious/critical axe violations on the 20 main pages; Lighthouse performance and accessibility meet the stated budgets or each miss is documented with a plan.
- Security review has no open high/critical findings.
- The owner can follow the 20-minute walkthrough unaided.
- DASH_FINAL_REPORT.md is complete and honest.

## Verification
- Run the full suite twice from a clean checkout and a fresh database; attach logs.
- Perform the 20-minute walkthrough as a different persona than the author would (the owner) and note every point of confusion; fix them.

## Handoff to the next phase (write these down)
- Release notes.
- The list of owner decisions and inputs still needed (Shiprocket account, SMS/SMTP/Razorpay, storage/CDN, domain/hosting, testimonial consent, legal copy).

## How to run this phase (mandatory ritual: do not skip or compress any step)

### Step 1: Re-ground (no code yet)
- Read every file in "Read first" above. Re-read the "Ground rules" in 00_PASTE_THIS_FIRST.md and the Handoff notes of the previous phase in docs/build/DASH_PROGRESS.md.
- List, in docs/build/phase-20-thinking.md, the exact backend operations this phase uses, each verified to exist in docs/backend-contract/api-index.md. For any operation whose request/response is only typed as "object" in openapi.yaml, call it on the running backend and record the real shape.

### Step 2: Think at 100x depth (write it down; thinking that is not written does not count)
Create docs/build/phase-20-thinking.md and fill ALL of these sections with specific, non-generic content:
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
