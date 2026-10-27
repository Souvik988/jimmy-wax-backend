# MIGRATION_PLAN — ADR-001 (revised 2026-10-03): leave Supabase; one checkout authority

**Decision (owner, 2026-10-03):** Supabase is not used. The platform is **plain PostgreSQL + our own identity service + Express**. Supersedes the earlier "retain Supabase Auth" plan and the cutover scripts.

## What changed
| Concern | Before (Supabase) | Now |
|---|---|---|
| Database | Supabase-managed PG + PostgREST Data API | Any PostgreSQL ≥ 15 (tested on 17). No PostgREST: **no client talks to the database directly.** |
| Identity | Supabase Auth (GoTrue) | Own service in `commerce-api` (`/v1/auth/*`): scrypt passwords, Ed25519 JWT access tokens (15 min), rotating refresh tokens with reuse detection, email verification/reset by emailed code, operator TOTP MFA |
| Storage | Supabase Storage buckets | `ObjectStorage` interface; `LocalDiskStorage` today, S3-compatible adapter can implement the same 3 methods |
| Checkout | Insert-trigger (`finalize_new_order`) | Express transaction only. Legacy triggers/RPCs dropped by migration `20261003000100_retire_legacy_checkout.sql` |
| Cutover | Scripted, with rollback | **Not needed**: no deployed clients/orders depended on the trigger path (checkout was never enabled). One forward migration chain from an empty database. |

## Migration chain (`db/migrations`, applied in order, forward-only)
1. `20261001000000_platform_bootstrap` — roles (legacy `anon/authenticated/service_role` kept **inert**, NOLOGIN, privileges revoked later) + our `auth` schema. (The schema is still named `auth` because the retained baseline references `auth.users`; it is **our** table.)
2. `20261001084352_jimmy_wax_commerce_core` — original baseline, unchanged.
3. `20261002100000/101000/102000` — transactional core, admin surface, read models.
4. `20261003000000_own_identity_and_commerce_v2` — identity tables, GST/COD fee, shipping, returns, invoices, review media, devices, content, email outbox; revokes every legacy Data-API grant.
5. `20261003000100_retire_legacy_checkout` — drops legacy triggers/RPCs; `checkout_authority` can only be `express`.
6. `20261003000200_confirmed_commerce_policy` — owner-confirmed values (below).
`db/seed.sql` is the reference catalogue (prices/MRP confirmed by the owner). **Inventory is 0 and checkout is OFF** until an operator enters counts and activates it in the console.

## What was migrated from Supabase (2026-10-03)
There is no hosted Supabase project in this workspace (no URL, database password or service-role key — correct and secure), so
there are **no live customers, orders or payments to copy**. The only Supabase-era *data* that exists is the schema and the
seeded catalogue, and both are already carried over: the original baseline migration is applied unchanged and `db/seed.sql`
is the same four products/variants/media (prices as in the app). The local Supabase stack from `docs/LOCAL_BACKEND.md` is
therefore **not needed** and is not used.
If a hosted Supabase project with real users appears later, retrieve its credentials from the Supabase Dashboard yourself
(never paste a service-role key or DB password into chat or the Flutter app) and run a one-off import (users: `id`, `email`,
`encrypted_password` bcrypt hash → add a verify-then-rehash path on first login; orders/addresses are plain tables).

## Existing Supabase data
Checkout never ran in production and the app was not released with customers, so **nothing is migrated**. If a hosted Supabase project does hold real users: their passwords are bcrypt hashes in `auth.users.encrypted_password`; a one-off importer could copy `id/email/hash` and add a bcrypt-verify-then-rehash path on first login. Not built — say so if you need it.

## Actor propagation (unchanged, still tested)
App role `jw_api_login` (member of `jw_commerce_api`; no superuser/BYPASSRLS). The verified user id is bound **inside each transaction** (`set_config(..., is_local=true)`) and RLS policies compare against it; admin writes additionally require `app.admin_role` bound after the `admin_users` check. Proven: pool of 2 connections, 60 interleaved requests, 6 users → no leakage. Honest limit: these settings are application-set → defence in depth against app bugs, not against arbitrary SQL as the app role.

## Owner-confirmed commerce policy (2026-10-02/03)
* Prices/MRP: as in the customer app — ₹299/399, ₹499/599, ₹799/999, ₹399/499 (selling/MRP).
* Shipping ₹40, free from ₹2,000; delivery estimate "3–5 business days".
* **GST 18%** — modelled as **included in the listed price** (Indian MRP is tax-inclusive by law). Invoices show taxable value + GST; the customer total never changes because of GST. One console setting flips this to "added on top" if your CA says otherwise.
* **COD handling fee ₹25** per COD order (not charged for online payment); GST at 18% is contained in the fee and in shipping.
* COD order limit: **none** (the old seed value of ₹2,000 was a placeholder, not from the app). Set one in the console if you want it.
* Still needed from the owner: stock counts, serviceable PIN list, GSTIN/legal name/state/address, return window, policy texts (see BACKEND_OWNER_INPUTS.md).
