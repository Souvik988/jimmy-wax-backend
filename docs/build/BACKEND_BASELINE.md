# BACKEND_BASELINE — B0 audit (2026-10-02)

## What exists (read from `jimmy&wax_app`)
| Area | Finding |
|---|---|
| Backend | Supabase only (Auth, Postgres, PostgREST Data API, Storage). **No Express service exists.** Flutter talks to PostgREST directly via `lib/core/data/store_repository.dart`. |
| Schema | 15 public tables, integer paise, RLS on every table, explicit grants. Seeded 4 products/variants, **stock 0**, `checkout_enabled=false`, `checkout_policy_confirmed=false`. |
| Checkout (legacy) | Client `INSERT INTO orders` → BEFORE trigger `prepare_new_order` (address snapshot) → AFTER trigger `finalize_new_order` (locks variants `FOR UPDATE`, decrements `stock_quantity`, snapshots `order_items`, clears `cart_items`, inserts COD `payment_records`, notification). COD only. Gated by `store_settings`. |
| Identity | `auth.users`; ownership via `auth.uid()`; admin via JWT `app_metadata.role = 'admin'`. |
| Flutter coupling | Reads `products/product_variants/product_media`, `store_settings` columns, `cart_items` via `replace_my_cart` RPC, direct `addresses` upsert/delete, `orders` insert, `reviews` insert + `review-photos` storage. `GET`-style catalog = `products?select=…product_variants(…),product_media(…)` (first variant only). |
| Contract | **None existed** (`contracts/` absent). No `FLUTTER_BACKEND_HANDOFF.md` / `INTEGRATION_MATRIX.md` existed at audit time. |

## Defects / risks found in the baseline (not all fixed — status shown)
| # | Finding | Status |
|---|---|---|
| 1 | Client can `INSERT` orders directly; correctness depends on triggers; no idempotency → a retry after a lost response places a **second order** | Fixed by Express transaction + cutover revoking client inserts |
| 2 | `orders.address_id` FK had no `ON DELETE` rule → deleting a saved address fails (or, if changed to CASCADE, would delete history) | Fixed: nullable, `ON DELETE SET NULL`; snapshot is authoritative |
| 3 | No payment attempts/provider events/refunds/webhook intake/outbox/audit | Added (expand migration) |
| 4 | Admin writes authorised only by JWT claim in RLS; no audit trail, no MFA, no optimistic concurrency | Admin API with RBAC table, step-up, audit, versions |
| 5 | `users update own notifications` grants UPDATE on the whole row (a user could rewrite title/body of their own notification) | **Open** (low); cutover revokes direct writes only on cart/orders/variants — notifications still direct. Move to API in next pass. |
| 6 | `reviews.photo_path` is client-chosen text | Open (review pipeline is B4, not built) |
| 7 | Cart is a delete-all/insert RPC (`replace_my_cart`) → lost updates across devices; no version | Replaced by versioned `carts`/`cart_lines` |
| 8 | Inventory is a mutable counter with no ledger | `inventory_positions` + `inventory_movements` ledger; counter becomes a derived mirror |

## Checkout/security baseline (before this work)
Checkout cannot succeed in production fixtures (zero stock, gates off) — correct and preserved. Direct client write paths into `orders`, `cart_items`, `product_variants` (admin) existed and are revoked at cutover (`supabase/cutover/`).
