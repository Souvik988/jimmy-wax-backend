# SECURITY_REVIEW (self-assessment, 2026-10-03) — NOT an independent audit

## Verified by automated tests (117 passing, real PostgreSQL 17)
**Identity (own service)**
* scrypt password hashes only; policy (≥10 chars, common-password and email-name checks); duplicate/weak registration rejected.
* Unknown email vs wrong password: identical response and a dummy hash is still computed (no timing/enumeration signal); lockout after 5 failures **persists** (counter commits even though the request fails); locked accounts get 429 even with the right password.
* Refresh tokens rotate; replaying a rotated token revokes the entire session family (theft detection); logout/reset/password-change revoke sessions; password reset is single-use and answers identically for unknown accounts.
* Access tokens: Ed25519, pinned algorithm/issuer/audience, expiry, UUID subject + session id. Rejected in tests: missing, garbage, signed by another key, wrong audience, wrong issuer, expired, `alg=none`.
* Operators: customer accounts cannot use the console; TOTP secret encrypted at rest (AES-256-GCM); a code cannot be replayed; sensitive actions need an `aal2` session; revoked session stops admin routes immediately.
* Account export contains only the caller's data; deletion erases personal data but retains orders (+ immutable address snapshot) and is refused while orders are in progress.
**Authorisation / data isolation**
* IDOR across orders, payments, addresses, returns, invoices, tracking, review photos; nobody can use another customer's quote.
* App DB role sees **zero** customer rows without a bound actor; identity does not leak across pooled connections; least-privilege (no write to invoices/audit; settings updates are no-ops without a verified admin role); experience role is view-only.
* RBAC per role; support sees a redacted address; audit log and invoices are append-only/immutable even for superusers.
**Money / state**: no oversell (100-way race), idempotent orders/refunds/webhooks, raw-body HMAC verification, over-refund impossible, illegal order transitions rejected by the DB, GST/COD totals reconcile.
**Uploads**: type sniffed from bytes (PHP/GIF disguised as images rejected), re-encoded to WebP (EXIF/GPS removed — asserted), size/dimension bounds, private until a moderator approves, approved copy only on the public path.
**Abuse**: body-size 413, malformed JSON 400, bucketed rate limits, per-email login/forgot limits.

## Controls present but not independently verified
Helmet/CSP (dev vs prod), CORS allow-list, trusted-proxy hops, httpOnly+SameSite=Strict encrypted admin cookie, Next.js Origin checks, log redaction, invoice HTML escaping (unit-asserted) with locked-down CSP.

## Open risks
| Sev | Risk |
|---|---|
| High | **Razorpay adapter never run** against a real/sandbox account (order/refund calls, header names). |
| High | **Email is logged, not sent** until SMTP is configured → password-reset/verification cannot reach real users. Reset/verify codes are visible in `email_outbox` payloads until the message is sent (then redacted); the API role cannot read that table (column grants) but DB admins can. |
| High | Not pen-tested; no WAF; `pnpm audit` and gitleaks are in CI YAML but **CI has never run** (repo just `git init`-ed, nothing pushed). |
| Med | Access tokens stay valid until expiry (≤ 15 min customers, 30 min operators) after a customer account is disabled/deleted; operators are checked per request. |
| Med | TOTP reset flow for a lost authenticator is manual (DB/CLI); no recovery codes. |
| Med | Rate-limit store fails **open** if Redis is down (availability over strictness). |
| Med | Local-disk object storage: single host, not CDN-backed; needs an S3 adapter for multi-replica API. |
| Low | `app.*` GUC context is application-set (defence in depth). The `auth` schema tables are readable by the API role (it **is** the auth service). |
| Low | Phone/OTP login, social login, push/SMS: not built. |

## 2026-10-06 — review of B8–B13 (self-assessed, no external test)
* **Authorization:** every admin route sits behind the role→permission map; step-up (aal2) on team, integrations, publish, customer export, flags and settings. Tests assert 403 / MFA_REQUIRED per role (designer, finance, support, fulfilment).
* **PII:** customer lists are masked; unmasking needs a reason and is audited; exports are MFA-gated, audited and formula-injection guarded; the email-outbox viewer cannot read recipients (column grants).
* **Row-level security:** all new tables have RLS. Cross-customer aggregates (coupon usage) use a narrowly scoped SECURITY DEFINER function; coupon redemption is serialised with an advisory lock.
* **Secrets:** integration pages expose booleans and mode only; a test asserts no key/secret strings in responses.
* **Coupons:** unknown and inactive codes return the same error (no enumeration), the cart rate limiter applies, and redemption is re-validated at order time.
* **Open:** Shiprocket token storage/rotation unverified live; the webhook token is a shared secret (no signature offered); media uploads are type-sniffed but not virus-scanned; no external penetration test.

## 2026-10-10 - review for contract 1.4.0 (self-assessed; still no external penetration test)
**Verified by automated tests**
* **Authorisation of every admin operation.** `ops-hardening.test.ts` reads the OpenAPI file, and for each `/v1/admin` operation checks anonymous = 401 and, where a
  role lacks the documented permission, that role = 403. Operations whose description names no permission are either self-service (`/me`, own sessions) or listed with
  their code-level guard in the test. Result: no mismatches. The dashboard role matrix (155 write checks) is the independent second check.
* **Reading never writes.** The invoice GET used to issue an immutable, numbered tax document as a side effect (DASH-BR-008, critical). Issuing is now an explicit POST
  (fulfil + MFA + reason, audited, replay-safe); reads blank the buyer address for roles that cannot fulfil.
* **Public media was readable before approval** (DASH-BR-042). The content-addressed URL now serves only approved, ready, non-archived media; operators preview through an
  authenticated route. Rejected/archived assets stop at the origin (CDN copies cannot be recalled - purge for emergencies).
* **Guarded writes** (stale stamp = 409, reason required, before/after audited): product archive/restore, add-variant, variant edits, CSV commit, shipping settings, PIN list,
  media archive/restore, category edit/reorder, collection delete, invoice issue.
* **Production configuration fails fast** (unit tests, 22 cases): http/wildcard/localhost CORS, development database passwords, MFA off, no trusted proxy hop, missing SMTP,
  local-disk storage without opt-in, http S3/Shiprocket endpoints, demo login with the default OTP, test/fake providers, long-lived admin tokens.
* **SSRF.** The one server-side fetch of a provider-supplied URL (Shiprocket label/manifest) is restricted to https on the provider's hosts, rejects IP literals, localhost,
  single-label and internal names, credentials and non-443 ports, refuses redirects and caps the size at 10 MB (16 unit cases).
* **Metrics** are no longer public: bearer token, or 404 in production without one; Caddy additionally blocks `/metrics`.
* **Email bounces** suppress the address instead of retrying forever; provider callbacks need a shared bearer token (constant-time compare) and the endpoint does not exist without it.
* **Dependencies**: `pnpm audit --prod` was 24 advisories (nodemailer 7, sharp 0.34 and the AWS SDK brought in for S3); after upgrading to nodemailer 10.1.0, sharp 0.35.5 and
  @aws-sdk/client-s3 3.1149.0 it reports none. Remaining: dev-only `vitest`/`tinypool` advisories (test runner; no untrusted input is given to it).

**Closed from the earlier open-risk table**: local-disk-only storage (S3 adapter now exists - not exercised against a real bucket); "email is logged, not sent" (SMTP is supported and
the preflight checks it; still unconfigured by the owner).

**Still open**
| Sev | Risk |
|---|---|
| High | Razorpay and Shiprocket adapters have never run against the real services (sandbox runs need the owner's credentials; checklists in PRODUCTION_RUNBOOK.md). |
| High | No external penetration test, no WAF; CI (`.github/workflows/ci.yml`) has never run because the repository has no commits yet. |
| Med | S3 adapter is unit-tested against a fake client only. |
| Med | `/v1/admin` is reachable on the public API origin if the edge is not restricted to the dashboard host (the Caddyfile comment says so; configuration is per environment). |
| Med | Rate-limit counters fail open if Redis is down; without Redis they are per process. |
| Med | Media uploads are type-sniffed and re-encoded but not virus-scanned. |
| Low | Access tokens stay valid until expiry after a customer is disabled (<= 15 min); operators are checked on every request. |
| Low | `AUTH_TOTP_ENC_KEY` cannot be rotated (no re-encryption tool). |
