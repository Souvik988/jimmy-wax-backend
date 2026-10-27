# BACKEND_NEXT_ACTION — resume checkpoint (2026-10-03)

## Where things live
Backend repo: `C:\Users\MSI\OneDrive\Desktop\jimmy&wax_backend` (`git init` done, **no commits yet**). Flutter app (not touched): `…\jimmy&wax_app`. Migrations `db/migrations`; contract `contracts/api`; docs `docs/build`.

## Run / verify
```bash
docker compose -f infrastructure/local/docker-compose.yml up -d   # containers stop when the machine idles; re-run this first
cd backend && pnpm install
NODE_OPTIONS=--max-old-space-size=1536 pnpm exec vitest run --no-file-parallelism   # 117 tests; rebuilds jimmywax_test
pnpm contract:check                                                  # 96/96
```
Low-RAM host: bound Node memory; typecheck one project at a time. Port 3100 is used by something else on this machine → console dev used 3177. Dev DB `jimmywax_dev` has a LOCAL-ONLY operator `owner@jimmywax.dev` / `Shine-Dev-Pass-2026!` (delete the DB when done).

## Next, in order
1. Owner inputs (BACKEND_OWNER_INPUTS.md): stock, PIN list, GSTIN/seller details, SMTP, Razorpay, hosting.
2. First commit + run CI (format, typecheck, contract, tests, audit, gitleaks); build the Docker targets.
3. **Flutter**: replace Supabase with the HTTP API (BACKEND_FLUTTER_HANDOFF.md), test on a device against staging, then write FINAL_INTEGRATION_REPORT.md.
4. Staging deploy with `infrastructure/prod`; verify SMTP and (if enabled) Razorpay sandbox end-to-end; restore drill on managed Postgres with PITR.
5. Real-scale capacity run (k6) → CAPACITY_REPORT.
6. Gaps: S3 storage adapter, HSN codes, TOTP recovery codes, SMS/push, OpenTelemetry, courier API if wanted, importer for any real Supabase users.
