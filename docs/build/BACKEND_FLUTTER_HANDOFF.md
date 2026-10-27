# BACKEND ↔ FLUTTER — integration status (2026-10-03)

**The Flutter app is now connected to this backend and no longer uses Supabase.** Contract: `contracts/api/openapi.yaml`
v1.1.0-draft.1 (98 operations; `pnpm contract:check` prints the sha256). Flutter work was done directly in
`C:\Users\MSI\OneDrive\Desktop\jimmy&wax_app` at the owner's request (a pre-change copy of `lib/`, `test/`, `tool/`,
`pubspec.*` is in `C:\Users\MSI\OneDrive\Desktop\jimmy-wax-app-backup-20261003-before-api-switch`; that project is not under git).

## What changed in the app
| File | Change |
|---|---|
| `lib/core/data/api_client.dart` (new) | HTTP client: bearer + single-flight refresh (refresh tokens rotate), refresh token in Keystore/Keychain (`flutter_secure_storage`), error mapping (`offline` for reads, `uncertain` for writes), idempotency-key generator |
| `lib/core/data/api_store_repository.dart` (new) | Implements the existing `StoreRepository` on the REST API: catalogue (paged), settings, cart/wishlist/address sync, email + **phone-OTP** sign-in, quote → idempotent order (same key on retry), reviews (+ photo upload) |
| `lib/core/data/store_repository.dart` | Supabase repository removed; `StoreSettings` gained `codFeePaise`, `gstRateBps`, `taxInclusive`, `codFeeFor()` |
| `lib/app/config/app_config.dart`, `lib/main.dart` | Supabase config removed; `API_ORIGIN` selects the API; secure session restore at start; checkout summary shows **Cash on Delivery fee** and "Inclusive of 18% GST"; password rule 10+ chars (server rule); readable error messages |
| `lib/core/errors/api_failure.dart` | Understands the backend error envelope (UPPER_SNAKE codes, `requestId`, `lines`, `Retry-After`) + `describeError()` |
| `pubspec.yaml` | `supabase_flutter` removed; `http`, `flutter_secure_storage` added |
| `android/app/src/debug/AndroidManifest.xml` | cleartext http allowed for DEBUG builds only (local backend); release needs https |
| `.env.local.json`, `docs/LOCAL_BACKEND.md` | local run instructions |

## Verified
* `flutter analyze`: 0 errors (12 infos; 11 pre-existing style lints).
* `flutter test`: **50 passed** — the original 41 + 9 new repository tests (mocked HTTP: pagination, GST/COD settings, refresh single-flight, session loss, OTP error mapping, order idempotent retry, stock conflict lines, cart diff).
* **Live end-to-end** (`test/live`): the app's real `ApiStoreRepository` against the running backend through the gateway — demo phone OTP login, catalogue, settings, address in PIN 743287 and one outside, server cart/wishlist/preferences round-trip, `NOT_SERVICEABLE` outside the area, **order for 2 × ₹299 = ₹598 + ₹40 + ₹25 COD fee = ₹663**, session restored from the stored refresh token, history, sign-out. Passed.
* Android debug APK build: see FINAL_INTEGRATION_REPORT.md for the result.
* **Not verified**: a real phone/emulator session of the screens (the UI itself was not changed beyond the summary lines), push notifications, maps, online payment, SMS to non-demo numbers.

## Run it
See the app's `docs/LOCAL_BACKEND.md`. Short version: `scripts/dev-stack.ps1 -Reset` in the backend, then
`./tool/flutter.ps1 run --dart-define-from-file=.env.local.json` (`API_ORIGIN=http://10.0.2.2:8080` for the emulator, LAN IP for a phone).
Demo sign-in: **9800000001 / 123456**. Delivery PIN: **743287**.

## Known app-side follow-ups (not blocking)
Online-payment screens and Razorpay SDK (needs credentials), order history list/tracking screens still use the latest order from
`loadUserData` (API has full history, shipments, returns and invoices ready), device-token registration for push, map SDK
(owner to supply), review "verified purchase" error copy (server says "after it has been delivered").
