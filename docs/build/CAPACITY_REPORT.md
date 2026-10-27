# CAPACITY_REPORT (2026-10-03)

**Verdict: the 1M-registered / 500 rps profile is NOT demonstrated.** Below is real, local, single-machine evidence — useful for finding bottlenecks, not for sizing production.

## Environment (all numbers below)
Windows laptop, 12 vCPU, **7.5 GB RAM shared with Docker and unrelated containers (≈200 MB free)**; PostgreSQL 17 in Docker; **one** Node process for the API (`tsx`, not built, pool = 10); load generator on the same machine; synthetic data (4 products, ≤ 2.4k orders). Generators: `scripts/loadtest.ts` (reads) and `scripts/loadtest-checkout.ts` (cart → quote → order journeys, open arrival-rate model, DB invariants checked afterwards). k6 profile written (`loadtest/k6-profile.js`) but k6 is not installed.

## Results
| Test | Offered | Result | Errors | Invariants after |
|---|---|---|---|---|
| Catalogue reads (`experience-api`) | 300 req/s, 15 s | p50 3.2 ms · p95 18 ms · p99 60 ms | 0 | — |
| Checkout journeys, mixed SKUs | 15 orders/s | order p95 38 ms · journey p95 77 ms | 0 | ✔ |
| Checkout journeys, mixed SKUs | 60 orders/s (180 req/s) | order p95 46 ms · journey p95 91 ms · p99 139 ms | 0 | ✔ |
| **Hot SKU** (everyone buys the same variant) — *before* fix | 60 orders/s | journey p95 **3.4 s** (order tx serialised on the stock row) | 0 | ✔ |
| **Hot SKU** — *after* fix (stock taken as the LAST statement of the order tx; stock-mirror trigger removed) | 60 orders/s | journey p95 **91 ms** | 0 | ✔ |
| Checkout journeys, mixed SKUs | 120 orders/s (360 req/s) | **saturated**: journey p95 7.5 s (queueing; single API process + generator + DB on one laptop) | 0 (all 2,399 succeeded, slowly) | ✔ |

"Invariants ✔" = HTTP 201 count == orders in DB; units sold == stock consumed; inventory ledger == position, for every run.
Interpretation: on this laptop one API process handles ≈ 60–100 completed orders/s before queueing, **with the hot-SKU case now no worse than the mixed case at 60/s**. Real hardware, network, a 5M-order table and provider latency will differ.

## Not measured (no evidence exists)
500 rps × 30 min, 2,000 rps burst, 4 h soak; 5M-order data scale and `EXPLAIN (ANALYZE, BUFFERS)` on realistic data; multi-replica behaviour; replica loss; slow-provider injection; failover; CDN/media; online-payment journeys under load; cost.

## Design notes that matter for scale
* The only contended write is one conditional `UPDATE inventory_positions` per variant (+ one ledger row), executed last in the transaction → lock hold ≈ 2 statements + commit. Expect a per-SKU ceiling of roughly 1 / (commit latency); measure on real storage before considering sharded counters.
* `statement_timeout` 5 s, `lock_timeout` 2 s; deadlock/serialization retry ×3; pool waiting is exported (`db_pool_connections{state="waiting"}`) with an alert.
* Connection budget plan: (2 API × 10) + (2 experience × 10) + (1 worker × 10) + admin/migration 10 ≈ 60 behind a transaction-mode pooler.

## Plan to produce real evidence (needs owner inputs 11, 15, 16)
Staging with the compose topology in `infrastructure/prod/`, seed 1M users / 5M orders (generator not written), run k6 sustained/burst/soak with the 80/15/5 mix, then cold-cache, hot-SKU, slow-provider, replica-kill and concurrent-admin variants; record p50/p95/p99, 5xx, 429/503 as failures, dropped iterations, DB waits, event-loop delay, queue lag; size from the bottleneck.
