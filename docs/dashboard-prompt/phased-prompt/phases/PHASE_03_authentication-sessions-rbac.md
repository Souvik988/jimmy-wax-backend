# PHASE 03 of 20: Authentication, sessions, MFA step-up and role-based access (BFF)

> Ritual reminder: Re-ground, then Think at 100x (written), then Challenge the plan, then Build in slices, then Verify with evidence, then Reflect and hand off. The thinking file for this phase is docs/build/phase-03-thinking.md.

## Mission
Operators sign in securely. Tokens never touch browser JavaScript. Every screen and button respects the backend's role and step-up rules, and the UI explains refusals instead of failing silently.

## Read first
- docs/backend-contract/03_BACKEND_CONTRACT.md sections 1, 6 and "Implementation status"
- openapi.yaml: /v1/auth/login, /refresh, /logout, /mfa/enroll, /mfa/verify, /mfa/recovery-codes, /invite/accept, /v1/admin/me, /v1/admin/sessions
- The role/permission matrix in 00_PASTE_THIS_FIRST.md

## Think about before building (answer each in your thinking file)
- Draw the full session state machine: signed-out, signed-in without MFA enrolled, enrolled but aal1, aal2, step-up required, refresh failing, revoked elsewhere, invited-not-accepted. Write each transition and what the user sees.
- BFF design: httpOnly + Secure + SameSite=Strict cookie holding an encrypted session (access token, refresh token, role, mfa flag, expiry). How do you refresh once under concurrent requests without a race? How do you prevent CSRF on mutating routes (double-submit token or Origin check)?
- The backend replays-protects refresh tokens: a reused refresh token revokes the whole session. What in your BFF could accidentally reuse one (parallel tabs, retries) and how do you make it impossible (single-flight refresh keyed by session)?
- Step-up: the API answers 403 MFA_REQUIRED for sensitive actions. Design a global interceptor that opens the step-up dialog, completes /mfa/verify, replaces tokens, and RETRIES the original request exactly once, with no double-submission of non-idempotent calls.
- What is the minimum information the client needs about the user (id, email, role, permissions, mfa state)? What must never be sent to the client?
- Threats: session fixation, token theft via XSS, open redirects after login, clickjacking, brute force (backend locks after 5 failures for 15 minutes: how do you present a 429/locked state kindly), enumeration.

## Scope: what to build
- BFF route handlers under src/app/api/auth/*: login (client=admin), logout, session (returns the safe user object), refresh single-flight, mfa enroll (returns otpauth URI and secret once), mfa verify, recovery-code use, recovery-code rotation, invite accept.
- A server-side API proxy (src/server/api.ts) used by every feature: attaches the bearer token, refreshes once on 401, maps backend errors to a typed ApiError, forwards Idempotency-Key and If-Match, never exposes tokens.
- Pages: /login (email + password, MFA code step, recovery-code option), /login/enroll (QR code from the otpauth URI, secret shown once, code confirmation, then show recovery codes ONCE with download/copy and an "I saved them" gate), /invite (accept invitation: token + new password), /account/security (change password, rotate recovery codes, MFA status, active sessions list with revoke).
- Permission model in code: the 6 roles and their permission sets mirrored from the backend matrix as a typed constant, plus a runtime source of truth (GET /v1/admin/me returns role; the effective permissions are derived from the matrix; backend still enforces). Helpers: can(permission), <Can>, route guards (server-side in layouts), nav filtering.
- Global StepUpDialog: TOTP input, recovery-code fallback, clear errors, success resumes the original action.
- Idle timeout UX (warn at 25 minutes of inactivity, sign out at 30; the backend token is 15 minutes with rotation, so the BFF refresh keeps working sessions alive).
- Security headers via next.config (CSP with nonces, frame-ancestors none, referrer-policy, permissions-policy) and a documented allowlist; no third-party scripts.

## Backend operations used
- POST /v1/auth/login {email,password,client:"admin"}; POST /v1/auth/refresh; POST /v1/auth/logout; POST /v1/auth/mfa/enroll; POST /v1/auth/mfa/verify (accepts a TOTP code or a recoveryCode); POST /v1/auth/mfa/recovery-codes; POST /v1/auth/invite/accept; POST /v1/auth/password/change.
- GET /v1/admin/me; GET /v1/admin/sessions; DELETE /v1/admin/sessions/{id}.
- Error codes to handle: UNAUTHENTICATED, FORBIDDEN, MFA_REQUIRED, RATE_LIMITED (Retry-After), VALIDATION_FAILED (fields).

## Experience requirements
- Login never reveals whether an email exists; show the backend's generic message.
- Locked account (429) shows a countdown from Retry-After.
- Disabled staff and customers get the same generic refusal; a customer account that signs in to the admin gets a clear "not an operator account" only if the backend says so, otherwise generic.
- The user menu shows role and MFA status; a banner nags (not blocks) operators without MFA enrolled when ADMIN_REQUIRE_MFA is true.

## Edge cases and failure modes you must handle
- Two tabs refreshing at once; a refresh that fails with a network error must not log the operator out (only a definitive 401 from refresh does).
- The operator opens a deep link while signed out: after login return to it (validate the target is same-origin and relative).
- System clock skew on TOTP (tell the operator to check device time on repeated code failures).
- Session revoked from another device while a form has unsaved changes: keep the draft in memory, show a re-login dialog, restore.

## Acceptance criteria (each needs evidence)
- Tokens are never present in JS-readable storage, URLs or logs (test by scanning the page, storage and network responses).
- Each role sees exactly its navigation; direct URL access to a forbidden area shows the not-allowed state and the BFF refuses the call.
- A step-up-gated action (for example saving store settings) triggers the dialog and completes after verification without losing the form.
- Unit tests for the session state machine; e2e tests for login, enrolment, step-up, logout, revoke-other-session, forced re-login.
- CSRF test: a cross-origin POST to a mutating BFF route is rejected.

## Verification
- Run the e2e suite against the REAL backend with operators of every role.
- Inspect the Network tab and cookies and attach the evidence.
- Run a manual XSS probe (inject a script tag in a displayed field later in other phases and confirm CSP blocks inline execution).

## Handoff to the next phase (write these down)
- The exact BFF contract (routes, cookie names, error shape) other phases must use.
- The permission matrix constant and how to add a permission.
- Known gaps (for example password reset for operators if the backend lacks it).

## How to run this phase (mandatory ritual: do not skip or compress any step)

### Step 1: Re-ground (no code yet)
- Read every file in "Read first" above. Re-read the "Ground rules" in 00_PASTE_THIS_FIRST.md and the Handoff notes of the previous phase in docs/build/DASH_PROGRESS.md.
- List, in docs/build/phase-03-thinking.md, the exact backend operations this phase uses, each verified to exist in docs/backend-contract/api-index.md. For any operation whose request/response is only typed as "object" in openapi.yaml, call it on the running backend and record the real shape.

### Step 2: Think at 100x depth (write it down; thinking that is not written does not count)
Create docs/build/phase-03-thinking.md and fill ALL of these sections with specific, non-generic content:
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
