# CONTRACT_DECISIONS

Spec: `openapi.yaml` (OpenAPI 3.0.3, chosen for broad Dart/TS generator support). Status **DRAFT** — written by the backend session; the Flutter session has not yet consumed it. Hash: run `pnpm contract:check` (prints sha256).

1. **Money** integer paise, `currency: "INR"` literal, ≤ 2^53−1. No floats anywhere.
2. **IDs** opaque strings; catalog ids are slugs (existing), orders/quotes/addresses UUID.
3. **Auth** `Authorization: Bearer <Supabase access token>`; anonymous browsing and guest cart (`x-guest-cart-token`, hashed at rest).
4. **Catalog shape**: one `variant` per product (current data model). Multi-variant products will become `variants[]` in a **v2** (breaking) — Flutter currently also uses only the first variant.
5. **Availability**: public API exposes `available` + `availableQuantity` capped at 10.
6. **Pagination**: keyset, opaque `cursor`, `limit` 1–50, deterministic tie-break on id.
7. **Cart**: `version` increments on every mutation; send `expectedVersion` to get `409 CART_VERSION_CONFLICT`. **Merge**: `min(99, user+guest)` per variant, guest cart deleted.
8. **Quote → order**: quote is server-priced, 15-min TTL, does *not* reserve stock. `POST /v1/orders` requires `Idempotency-Key` (8–100 chars, new per purchase attempt, reuse only to retry the same request). Replays return the original 201 body with `Idempotent-Replayed: true`.
9. **Payment truth**: clients poll `GET /v1/orders/{id}/payment`; an SDK success callback is never proof of payment.
10. **Errors**: `{error:{code,message,requestId,retryable,fields?,lines?}}`; `lines` lists offending variants for `STOCK_SHORTAGE`/`ITEM_UNAVAILABLE`.
11. **Not yet in the contract**: shipments/tracking, returns, reviews write, notifications/devices, invoices, search endpoint (use `q` on products), `/home`, `/content/{slug}`, account export/delete.
12. **Compatibility with current Flutter code**: Flutter's `StoreRepository` interface maps cleanly (`fetchCatalog`→products, `fetchSettings`→store-settings, `replaceCart`→line mutations, `placeOrder`→quote+order). Flutter currently shows whole rupees (`~/ 100`); it must switch to paise-exact display.
