# FINAL_INTEGRATION_REPORT (2026-10-05)

## Verified in this repo (evidence, not claims)
| Check | Result |
|---|---|
| Backend tests (real PostgreSQL 17, `vitest --no-file-parallelism`) | **125 passed / 11 files** |
| Contract parity (`pnpm contract:check`) | spec sha256 `686bb51b0803f0b137dda95df005f82f63edad1835fbff517e2e0fa82d1dd9c9`; 98 documented = 98 served |
| Flutter `flutter analyze` / `flutter test` | 0 errors / 50 passed (2026-10-03) |
| Flutter ↔ backend live end-to-end (real `ApiStoreRepository`, gateway :8080) | demo OTP sign-in, catalogue, settings, addresses (PIN 743287 ok, outside rejected), cart/wishlist sync, COD order **2 × ₹299 + ₹40 + ₹25 COD fee = ₹663**, session restore, history, sign-out |
| Android debug APK | built, `C:\jw_build\build\app\outputs\flutter-apk\app-debug.apk` (186 MB). **Installed/run on a device: not done.** |

## What was migrated from Supabase
Nothing live exists (no hosted project/credentials). Schema (baseline migration, unchanged) and seeded catalogue carried over;
identity, storage and checkout were re-implemented in this backend. The Flutter app no longer depends on Supabase.

## Owner-supplied settings in effect
Demo phone **9800000001** / code **123456** (fixed code, no SMS; off in production unless `AUTH_DEMO_ENABLED=true`),
PIN **743287**, GST 18% included, COD fee ₹25, shipping ₹40 / free from ₹2,000, app prices/MRP.
Ola Maps key: stored only in the Flutter app's ignored `.env.local.json`; **no map code exists yet** (nothing uses it).

## NOT verified / not done
* App screens on a real device or emulator; push; maps; online payment (Razorpay unverified, no credentials); SMS to real numbers
  (no provider — non-demo numbers get `OTP_UNAVAILABLE`, app falls back to email); real email (no SMTP, messages only logged).
* Capacity at the stated scale: no evidence beyond local runs (see CAPACITY_REPORT.md). Deploy artifacts and CI were never executed.
* Backend repo has no commits yet.
* Checkout is **OFF** in a fresh database until stock is entered and the operator activates it (audited button).

## Known test-order note
`otp.test.ts › first service area` re-inserts PIN 743287 because other suites clear the table; the migration seed itself is
proven by running that file alone on a fresh database.

## 2026-10-06 addendum — operator-console backend (B8–B13)
* Backend tests: **190 passed / 16 files**; contract parity **227/227** (OpenAPI 1.2.0-draft.1, sha256 `95740d1125c702e155eb3c9e9f1aef7cea90f659bb384cf8a74cdf0256bafeb8`). All projects typecheck clean.
* **Mocked, not live:** Shiprocket (adapter built from the verified auth/order/AWB/pickup flow; every other endpoint unverified; no NDR actions or reverse pickup); Razorpay, SMS, SMTP remain unconfigured. The integrations page reports honestly ("no safe live probe") instead of a green tick.
* **Not built:** video dimension/duration probing (no ffmpeg; mp4/webm are stored as-is), per-block A/B tests, riders/wallet/B2B (owner decision).
* **Flutter / website:** neither calls `/v1/cart/coupon`, `/v1/app/version-check` or `/v1/experience/{channel}` yet; the new fields (`couponCode`, per-line `discountPaise`, `ordersPaused`) are additive.
* **Testimonials:** the app shows text only; the web may carry video. Entries copied from design references stay `placeholder` and block publishing until recorded as `owner_supplied` with a consent note, or replaced by verified reviews.
