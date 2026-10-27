# RESTORE_DRILLS - log of backup restore drills

Procedure: `docs/build/PRODUCTION_RUNBOOK.md`, section 5. Add one row per drill (quarterly, and after any infrastructure change).

| Date | Environment | Source | Dump size | Dump + restore time | Checks | Result | By |
|---|---|---|---|---|---|---|---|
| 2026-10-10 | local Docker Postgres 17 (`infrastructure/ops/drill-local.sh`) | `jimmywax_dev` (7 orders, 548 audit rows, 18 products, 17 migrations) | 648 KB | 4 s | 13 of 13 passed (ledger, orders, orphan lines, totals vs constraint, stock >= 0, invoice sequence, audit trigger, audit rows, catalogue, published channels, RLS tables = 72, role privileges, roles) | pass | backend session |

Findings from the first drill (fixed the same day):
* The verification query used an outdated order-total formula (it ignored the COD fee and tax-inclusive pricing) and wrongly reported 7 orders off; it now mirrors the `orders_total_reconciles` constraint.
* The first backup used `--no-privileges`, which would have restored tables the application roles cannot read. Backups now keep grants and RLS policies, and the drill checks that `jw_commerce_api`, `jw_experience` and `jw_worker` can read what they need.

Not yet done: a drill against managed Postgres with PITR at production size (needs the hosting decision), timing of a full-size restore, and a drill that points staging at the restored database.
