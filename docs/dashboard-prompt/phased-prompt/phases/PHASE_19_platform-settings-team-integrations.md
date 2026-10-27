# PHASE 19 of 20: Platform: store settings, policies, team and roles, integrations and security

> Ritual reminder: Re-ground, then Think at 100x (written), then Challenge the plan, then Build in slices, then Verify with evidence, then Reflect and hand off. The thinking file for this phase is docs/build/phase-19-thinking.md.

## Mission
Everything an owner configures once and an admin maintains: store facts, shipping and COD rules, GST/seller details, policy pages, delivery areas, team members and invitations, integration status, feature flags (reuse), and personal security.

## Read first
- api-index: admin/settings, admin/content, admin/team, admin/sessions, admin/integrations, admin/shipping/pins, admin/flags
- Settings semantics: pricing-affecting changes bump rules_version and invalidate open quotes; settings use expectedVersion + reason + MFA; brand name, support email/phone are public facts used by clients and Studio variables

## Think about before building (answer each in your thinking file)
- Settings are the highest-leverage and highest-risk screen. For each field: who may change it, what breaks if wrong (quotes stale, invoices wrong, COD disabled), and how the UI previews the customer impact (a mini checkout summary using sample products).
- GST: rate bps, inclusive flag, seller legal name, GSTIN (format validated), state, address, invoice prefix: what must exist before invoices can be issued? Surface the readiness checks next to the fields that fix them.
- Policies (Terms, Privacy, Refund/Return, Shipping, care guide): versioned drafts, publish step, public API serves only published versions. Design a content editor with history, diff, publish, and a preview that matches the public page style; legal wording is the owner's, the dashboard never invents it.
- Team management: roles, invitations (72h token via email: sender may be unconfigured in dev: show the token flow honestly), disabling members, resetting MFA (MFA + audit), session visibility. How do you stop the last admin from locking themselves out?
- Integrations: show Razorpay, SMS, SMTP, shipping, storage, maps as configured/not configured with the last test result; "Test" never fakes success. What does the operator do next for each (link to a setup checklist in docs)?

## Scope: what to build
- Store settings form (grouped: store facts, shipping and free-shipping threshold, COD (enabled, limit, fee), GST and seller details, returns window, delivery estimate, brand/support info) with diff-before-save, reason, step-up, expectedVersion conflict handling, readiness panel (reuses phase 5), and a customer-impact preview.
- Delivery areas (PIN prefixes) editor with bulk paste and a tester (reuse phase 7 component).
- Policies and guides: list, editor with markdown, versions, publish (GET/PUT /v1/admin/content/{slug}, POST .../publish).
- Team: list members and pending invites, invite (POST /v1/admin/team/invite), revoke invite, change role/disable (PATCH /v1/admin/team/{id}), reset MFA (POST .../reset-mfa), all MFA-gated; session list for the current user and revoke.
- Integrations page (GET /v1/admin/integrations, POST /v1/admin/integrations/{name}/test): cards with state, last check, test button, setup guidance links; clearly marks Shiprocket as parked/not verified.
- Feature flags and app versions screens link from here (built in phase 17).
- Account security page finishing touches from phase 3.

## Backend operations used
- GET /v1/admin/settings, PATCH /v1/admin/settings; GET|PUT /v1/admin/shipping/pins; GET /v1/admin/content, GET|PUT /v1/admin/content/{slug}, POST /v1/admin/content/{slug}/publish; GET /v1/admin/team, POST /v1/admin/team/invite, DELETE /v1/admin/team/invites/{id}, PATCH /v1/admin/team/{id}, POST /v1/admin/team/{id}/reset-mfa; GET /v1/admin/integrations, POST /v1/admin/integrations/{name}/test.

## Experience requirements
- Dangerous settings (disable COD, change GST rate) use a two-step confirmation that states the customer impact.
- Settings never autosave: explicit review and save.

## Edge cases and failure modes you must handle
- Changing GST rate while quotes are open (they go stale: say so), clearing the seller GSTIN (invoices refuse), setting a free-shipping threshold below the shipping fee, disabling the last admin or changing your own role (backend/UI both refuse), invitation to an existing email, SMTP unconfigured when inviting.

## Acceptance criteria (each needs evidence)
- Settings round-trip with conflict handling; a changed shipping fee appears on the customer API within the cache window (verify) and invalidates an open quote (verify).
- Policies publish flow: draft not visible publicly, published visible (curl).
- Team: invite, accept (using the dev token), role-restricted login, disable, reset MFA; last-admin protection tested.
- Integrations page tells the truth for the local environment (nothing falsely green).

## Verification
- e2e for settings + policies + team; screenshots; curl evidence for public effects.

## Handoff to the next phase (write these down)
- Settings field table with impacts.
- Policy content ownership note for the owner.

## How to run this phase (mandatory ritual: do not skip or compress any step)

### Step 1: Re-ground (no code yet)
- Read every file in "Read first" above. Re-read the "Ground rules" in 00_PASTE_THIS_FIRST.md and the Handoff notes of the previous phase in docs/build/DASH_PROGRESS.md.
- List, in docs/build/phase-19-thinking.md, the exact backend operations this phase uses, each verified to exist in docs/backend-contract/api-index.md. For any operation whose request/response is only typed as "object" in openapi.yaml, call it on the running backend and record the real shape.

### Step 2: Think at 100x depth (write it down; thinking that is not written does not count)
Create docs/build/phase-19-thinking.md and fill ALL of these sections with specific, non-generic content:
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
