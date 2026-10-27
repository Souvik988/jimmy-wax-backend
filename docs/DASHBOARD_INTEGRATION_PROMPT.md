# SESSION PROMPT: BACKEND (`jimmy&wax_backend`)

You are the **backend** session. You own the API contract the other three projects consume. Goal: make the backend fully match what the dashboard, website and app need, document every change in the contract, close the open requests, and make it production-deployable.

## 0. Who you are and the situation
You are a Claude Code session working on ONE of four connected projects for **JIMMY & WAX**, a leather-care shop in India (prices in integer paise, GST-inclusive 18%, COD + prepaid). Another session built the operator **dashboard** and it is about 95% finished; your job is to make *your* project match it so the whole system works end to end. Do not rebuild the dashboard. If you believe the dashboard or the contract is wrong, say so with evidence instead of silently working around it.

| Project | Path | Stack | Local port |
|---|---|---|---|
| Dashboard (admin console; a Next.js BFF that holds the operator session and forwards to the backend) | `C:\Users\MSI\OneDrive\Desktop\jimmy&wax_dashboard` | Next.js 16, React 19 | 3200 |
| Backend (commerce API, experience API, workers, gateway) | `C:\Users\MSI\OneDrive\Desktop\jimmy&wax_backend\backend` | Express 5, PostgreSQL 17, pnpm workspace | gateway 8080 → commerce 4000, experience 4001 |
| Website (storefront) | `C:\Users\MSI\OneDrive\Desktop\jimmy_nd _wax_website` | Vite + React | 5174 |
| Mobile app | `C:\Users\MSI\OneDrive\Desktop\jimmy&wax_app` | Flutter | n/a |

### How the pieces fit
Operators use the dashboard. In its **Experience Studio** they edit *draft documents* per channel (`app` or `web`): a shared **design system** (colours, type, motion), per-channel **token overrides**, **navigation**, **chrome** (header/splash/footer/help/brand slots) and **pages** made of typed **blocks** (21 website blocks, 13 app blocks). A **release** is an immutable snapshot of the drafts; publishing flips a live pointer, rollback publishes an older snapshot again, and a per-channel **kill switch** makes clients fall back to their built-in design. Clients read the published result from the public API:
- `GET /v1/experience/web` and `GET /v1/experience/app`, with header `x-jw-client: <web|app>/<version>[+build]; platform=<android|ios|web>; caps=<comma-separated block types this build can draw>` (the server **holds back** block types the client does not list). Responses carry an `ETag`; send `If-None-Match`; cache ~60 s.
- Drafts: `GET /v1/experience/<channel>/preview?token=<short-lived token>` (the dashboard issues the token; never cache it; the website uses `?jw_preview=<token>` on any page URL; the app uses a debug-only `--dart-define=EXPERIENCE_PREVIEW_TOKEN=...`).
- Bundle shape (see `jimmy&wax_dashboard/docs/backend-contract/openapi.yaml` and `blocks.schema.json`): `{ schemaVersion, channel, enabled, release:{number,label,publishedAt}, tokens, navigation, chrome, pages:{<key>:{blocks:[{id,type,props,resolved?}],seo?,nativeSections?}}, media:{<mediaId>:{kind,url,alt,poster?,bundledKey?}}, content:{testimonials,careGuides,...,announcements}, generatedAt }`. `enabled:false` means "use the built-in design". Product lists are resolved server-side (`resolved.productIds`). `{{store.*}}` variables are substituted by the server.
- Page keys: website `home, shop, product, ritual, story`, plus `custom:<slug>` and `product:<slug>` templates; app `home, category, product, cart`.

### Source of truth for the contract (read these first, read-only unless you are the backend session)
`jimmy&wax_dashboard/docs/backend-contract/`: `openapi.yaml`, `api-index.md`, `blocks.schema.json` (all block prop schemas, `colorRoles`, `brandSlots`, `Action`, `MediaRef`, `VisibilityRules`, `BlockStyle`, `Seo`), `doc-schemas.json` (design system / token overrides / navigation / chrome JSON Schemas generated from the backend validators), `INTEGRATION_GUIDE.md`, `05_CLIENT_INTEGRATION_SPEC.md`, `02_EXPERIENCE_STUDIO_SPEC.md`, `CHANGELOG.md`. Also read `jimmy&wax_dashboard/AGENTS.md`, `docs/build/DASH_NEXT_ACTION.md`, `docs/build/BACKEND_REQUESTS.md`, `docs/build/RELEASE_READINESS.md`.

## 0b. Rules for every session
- **Secrets**: never write passwords, API keys, tokens or session secrets into code, tests, docs, commits or chat. Use environment variables / the host's secret manager. Placeholders look like `<VALUE>`; the owner fills them in.
- **No destructive actions without asking the owner**: no database reset (`dev-stack.ps1 -Reset`), no force-push, no deleting data, no publishing a Studio release to production.
- Prefer small, tested changes. After every change run that project's typecheck, lint and tests and report failures honestly (including what you could not verify).
- Money is integer paise; text is UTF-8; dates are ISO-8601 with offset; India Standard Time for display.
- **Contract changes** are made only by the backend session. Website/app sessions that need a change write a precise request (endpoint, example request/response, why) into `jimmy&wax_dashboard/docs/build/BACKEND_REQUESTS.md` style and continue with a safe fallback.
- Local machine notes: ~7 GB RAM (run one heavy process at a time); Postgres host port is **55432** (54422 is Windows-reserved); Git Bash mangles heredocs and `/v1/...` paths (use PowerShell + the file tools); folder names containing `&` break some tools (use a junction, e.g. `New-Item -ItemType Junction -Path C:\jwapp2 -Target '<path>'`).
- Start the local stack (never with `-Reset`): `docker start jimmywax-backend-postgres-1`; then in the backend folder `$env:PG_HOST_PORT='55432'; powershell -File scripts\dev-stack.ps1`; dashboard `powershell -File tools\start-dev-local.ps1 -Clean` (from the dashboard folder); website `npx vite --port 5174 --host 127.0.0.1`.
- Dashboard live tests you can re-run to prove nothing broke (from the dashboard folder; each creates and later disables a disposable admin): `powershell -File tools\run-live-spec.ps1 tests/e2e/<spec>`; relevant specs: `studio-publish.local.spec.ts`, `studio-to-website.local.spec.ts`, `studio-preview-live.local.spec.ts`, `studio-finance-live.local.spec.ts`, `guarded-writes-live.local.spec.ts`, `catalog-writes-live.local.spec.ts`, `admin-writes-live.local.spec.ts`; roles: `powershell -File tools\run-role-matrix.ps1`.

## 0c. Production configuration names (values are the owner's; never commit them)
| Where | Name | Meaning |
|---|---|---|
| Dashboard | `BACKEND_ORIGIN`, `DASHBOARD_PUBLIC_ORIGIN`, `DASHBOARD_SESSION_SECRET`, `DASHBOARD_STOREFRONT_ORIGIN`, `DASHBOARD_HOST`, `ACME_EMAIL` (leave `DASHBOARD_COOKIE_SECURE` unset) | see `deploy/README.md` there |
| Backend | `DATABASE_URL` (per service role), `PORT`, `CORS_ORIGINS`, `ADMIN_REQUIRE_MFA=true`, `STORAGE_DIR` or object storage settings, SMTP settings, `SHIPPING_PROVIDER` (`none` until Shiprocket) with `SHIPROCKET_EMAIL`, `SHIPROCKET_PASSWORD`, `SHIPROCKET_WEBHOOK_TOKEN`, optional `SHIPROCKET_BASE_URL`, payment provider keys when online payments are enabled, `FEATURE_CHECKOUT`, `FEATURE_COD`, `FEATURE_ONLINE_PAYMENTS` | see `packages/config/src/index.ts` |
| Website | `VITE_API_ORIGIN=https://<api-domain>` | public API origin |
| App | `--dart-define=API_ORIGIN=https://<api-domain>` (https required outside development), `APP_ENV=production` | `EXPERIENCE_PREVIEW_TOKEN` is debug-only |


## 1. What already exists (do not redo; review and keep)
Express 5 + PostgreSQL 17 monorepo (`apps/commerce-api`, `apps/experience-api`, `apps/workers`, `packages/*`; gateway script `scripts/dev-gateway.ts`; start script `scripts/dev-stack.ps1`). Roles: admin, support, catalog, fulfillment, finance, designer, each with permission strings (`catalog:write`, `shipping:write`, `experience:publish`, ...). Admin writes that matter need MFA step-up when `ADMIN_REQUIRE_MFA=true`.

**Changes made by the dashboard sessions that you must review, keep, and document in the contract:**
1. Guarded writes (reason 3-300 chars + version): `POST /v1/admin/products/:id/archive|restore` (`expectedVersion`, `reason`); catalogue CSV import commit (`previewHash`, `reason`, stale/replay refusal); variant PATCH extensions (metadata, thresholds, price change invalidates quotes); `PUT /v1/admin/shipping/settings` (`expectedUpdatedAt`, `reason`; the response includes `updatedAt`); `PUT /v1/admin/shipping/pins` (`expectedEtag`, `reason`; `GET` returns `etag`).
2. New in the latest round: `POST /v1/admin/experience/:channel/docs/:kind/:key/discard-draft` (`If-Match` + `{reason}`; returns the draft to the live version as a new revision; `ILLEGAL_STATE` if never published) in `adminB9Routes.ts` and `packages/commerce-domain/src/experience/docs.ts`; `GET /v1/admin/analytics/gstr1?month=YYYY-MM&format=json|csv&table=b2cs|hsn` in `adminB11Routes.ts` and `packages/commerce-domain/src/gstr1.ts` (GSTR-1 tables 7 and 12 working paper); product duplicate now picks the first free `-copy`, `-copy-2`, ... id and a collision-free SKU (`catalogue.ts`, `duplicateProduct`); `packages/commerce-domain/scripts/gen-doc-schemas.ts` generates `doc-schemas.json`.
3. Tests added: `b9.test.ts` (discard-draft), `b8.test.ts` (duplicate twice), `b11.test.ts` (GSTR-1 reconciles with orders), `packages/commerce-domain/test/unit/gstr1.test.ts`.

## 2. Tasks (in this order)
**B1. Contract hygiene (blocking for everyone).** Add every operation and field in section 1 to `openapi.yaml`, `api-index.md` and `CHANGELOG.md` (bump the contract version), regenerate `doc-schemas.json` (`pnpm exec tsx packages/commerce-domain/scripts/gen-doc-schemas.ts <outfile>` from the `packages/commerce-domain` folder), and copy the contract files into `jimmy&wax_dashboard/docs/backend-contract/`. Then in the dashboard run `pnpm contract:generate`, update `contract.lock.json` through the tool in `tools/contract/`, and run `pnpm verify` there. Do this as one coordinated change and tell the owner the dashboard needs a commit.

**B2. Close open requests.** Read `jimmy&wax_dashboard/docs/build/BACKEND_REQUESTS.md` fully; each `open` row is yours. Priority:
 a. Content-library entity schemas (care guides, stories, journal, testimonials, FAQ groups, announcements): publish JSON Schemas generated from the validators next to `doc-schemas.json` (extend `gen-doc-schemas.ts`) so the dashboard can replace its hand mirrors (`src/features/studio/library-schemas.ts`).
 b. Per-slot image requirements: extend the `blocks.schema.json` generation so every image prop carries `x-slot: { minWidth, minHeight?, aspect? }` (agree the numbers with the owner or designer; for example website hero at least 1920 px wide). The dashboard currently only gives generic warnings.
 c. DASH-BR-048: return the `ETag` header through the gateway for document GETs. DASH-BR-049: document or raise the admin write rate limit (429 during bulk Studio edits).
 d. Media safety (DASH-BR-038/042): the public content-addressed media GET must refuse pending or rejected media; document that approve/reject is admin-only.
 e. HSN: invoices omit HSN (`hsnIncluded: false`); once variants carry `hsnCode` (the dashboard edits it), print it on invoices (GSTR-1 table 12 already uses it).
 f. Every other `open` row in BACKEND_REQUESTS.md (shipping provider shape drift, invoice issue blocked by a missing GST profile, order DTO fields for reveal and allocations, refund process capability, and so on).

**B3. What the website and app need from the public API (verify, fix, document).**
 - `GET /v1/experience/{web,app}`: correct `ETag`/304, `Cache-Control: max-age=60`, honours `x-jw-client` caps (holds back unknown blocks), applies campaigns by time, resolves sources (`resolved.productIds` for product rails and grids, with defined out-of-stock behaviour), substitutes `{{store.*}}`, returns `media` with `url`, `alt`, `poster`, `bundledKey` (the app ships some images) plus `tokens`, `navigation`, `chrome`, `pages`, `content`. Add contract tests with golden JSON.
 - `product:<slug>` and `custom:<slug>` pages and `nativeSections` visibility are served; web pages carry `seo`.
 - A **public app version policy** endpoint (minimum supported, forced update, latest per platform; the dashboard edits these under Settings, Platform, App versions). Verify one exists and is documented; if not, add `GET /v1/app-version?platform=&version=` returning `{ status: 'ok'|'update_available'|'update_required', message, storeUrl }`.
 - CORS: allow the website origin(s) on public routes; admin routes are called server-to-server by the dashboard BFF only.
 - Store pause and checkout flags via `GET /v1/store-settings` for both clients (already present: `checkoutOpen`, `ordersPaused`, `pauseMessage`).

**B4. Production readiness.**
 - Config validation fails fast on unsafe production values (it already refuses `SHIPPING_PROVIDER=fake`); add HTTPS-only origins, required SMTP when invitations are on, no default passwords, secure session settings.
 - Media storage: move from local `STORAGE_DIR` to S3-compatible object storage behind the existing storage interface; keep content-addressed keys; document lifecycle.
 - Email: real SMTP settings, bounce handling; templates are managed from the dashboard (Messaging).
 - Payments: online payments are off (`FEATURE_ONLINE_PAYMENTS=false`); if the owner enables a gateway implement webhooks with signature checks, idempotency and a refund eligibility capability (the dashboard shows refunds read-only until it exists).
 - Shipping: manual mode is verified live. The Shiprocket adapter is mock-tested only: when the owner provides sandbox credentials run `SHIPPING_PROVIDER=shiprocket` against the sandbox, verify plan, ship, label, manifest and webhooks end to end, then document the setup.
 - Observability: structured logs with request ids, `/healthz` and `/readyz`, metrics, alerts on 5xx and auth failures, audit-log retention.
 - Backups: automated Postgres backups and a **restore drill**; migration procedure; no `db-reset` in production; seed data in dev only.
 - Redis containers exist in `infrastructure/local/docker-compose.yml` (host ports 56379/56380 are sometimes Windows-reserved) but the code does not use Redis; either use it deliberately or remove it.
 - Security review: authz on every admin route (the dashboard's role matrix, `tools/role-write-matrix.local.ts`, must stay at 0 mismatches), rate limits, body size limits, upload and SSRF hardening, dependency audit.

**B5. Tests.** Run the whole suite (`$env:PG_HOST_PORT='55432'; pnpm test`; the integration tests create their own `jimmywax_test` database). Add tests for every change. Then, from the dashboard folder, run the live specs and the role matrix listed in section 0b; they must still pass.

## 3. Acceptance (report each as pass or fail with evidence)
1. Contract files, OpenAPI, the dashboard's generated types and `contract.lock.json` agree; `pnpm verify` in the dashboard passes.
2. The backend test suite passes; new tests cover discard-draft, GSTR-1, guarded writes, duplicate and bundle golden files.
3. Dashboard role matrix: 0 mismatches; `studio-publish`, `studio-to-website`, `studio-preview-live`, `studio-finance-live`, `guarded-writes-live`, `catalog-writes-live` and `admin-writes-live` pass.
4. Every `open` request in BACKEND_REQUESTS.md is closed (with the change described) or explicitly deferred with the owner's agreement.
5. A written production runbook (config, secrets, migrations, backups and restore drill, rollback) in `docs/`.
