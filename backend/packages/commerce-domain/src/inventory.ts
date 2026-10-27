import type { PoolClient } from '@jw/database';
import { AppError } from '@jw/contracts';

export interface StockLine {
  variantId: string;
  quantity: number;
}

const sorted = (lines: StockLine[]) => [...lines].sort((a, b) => (a.variantId < b.variantId ? -1 : 1));

/**
 * Atomic conditional stock take. A single UPDATE both checks and changes availability, so
 * concurrent buyers of the last unit serialise on the row lock and exactly one wins.
 * Lines are processed in deterministic variant order to avoid deadlocks.
 */
export async function takeStock(
  c: PoolClient,
  lines: StockLine[],
  mode: 'reserve' | 'commit',
  ref: { type: string; id: string },
  actorId: string | null,
): Promise<void> {
  const short: unknown[] = [];
  for (const l of sorted(lines)) {
    const sql =
      mode === 'reserve'
        ? `UPDATE inventory_positions SET reserved = reserved + $2, version = version + 1, updated_at = now()
            WHERE variant_id = $1 AND on_hand - reserved >= $2 RETURNING variant_id`
        : `UPDATE inventory_positions SET on_hand = on_hand - $2, version = version + 1, updated_at = now()
            WHERE variant_id = $1 AND on_hand - reserved >= $2 RETURNING variant_id`;
    const r = await c.query(sql, [l.variantId, l.quantity]);
    if (r.rowCount === 0) {
      const avail = await c.query(
        `SELECT on_hand - reserved AS available FROM inventory_positions WHERE variant_id = $1`,
        [l.variantId],
      );
      short.push({ variantId: l.variantId, requested: l.quantity, available: avail.rows[0]?.available ?? 0 });
      continue;
    }
    await c.query(
      `INSERT INTO inventory_movements (variant_id, kind, delta_on_hand, delta_reserved, ref_type, ref_id, actor_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        l.variantId,
        mode,
        mode === 'commit' ? -l.quantity : 0,
        mode === 'reserve' ? l.quantity : 0,
        ref.type,
        ref.id,
        actorId,
      ],
    );
  }
  if (short.length > 0) {
    // The surrounding transaction rolls back every earlier line: no partial allocation.
    throw new AppError('STOCK_SHORTAGE', 'Some items do not have enough stock', { lines: short });
  }
}

export async function createReservations(
  c: PoolClient,
  orderId: string,
  lines: StockLine[],
  expiresAt: Date | null,
): Promise<void> {
  for (const l of sorted(lines)) {
    await c.query(
      `INSERT INTO stock_reservations (order_id, variant_id, quantity, expires_at) VALUES ($1, $2, $3, $4)`,
      [orderId, l.variantId, l.quantity, expiresAt],
    );
  }
}

/**
 * Settles an order's ACTIVE reservations exactly once. The status-guarded UPDATE is the
 * exactly-once gate: a concurrent or repeated call finds no active rows and does nothing.
 */
export async function settleReservations(
  c: PoolClient,
  orderId: string,
  to: 'committed' | 'released' | 'expired',
  actorId: string | null,
): Promise<number> {
  const r = await c.query<{ variant_id: string; quantity: number }>(
    `UPDATE stock_reservations SET status = $2, settled_at = now()
      WHERE order_id = $1 AND status = 'active' RETURNING variant_id, quantity`,
    [orderId, to],
  );
  const rows = [...r.rows].sort((a, b) => (a.variant_id < b.variant_id ? -1 : 1));
  for (const row of rows) {
    if (to === 'committed') {
      await c.query(
        `UPDATE inventory_positions SET on_hand = on_hand - $2, reserved = reserved - $2, version = version + 1, updated_at = now() WHERE variant_id = $1`,
        [row.variant_id, row.quantity],
      );
      await c.query(
        `INSERT INTO inventory_movements (variant_id, kind, delta_on_hand, delta_reserved, ref_type, ref_id, actor_id)
         VALUES ($1, 'commit', $2, $2, 'order', $3, $4)`,
        [row.variant_id, -row.quantity, orderId, actorId],
      );
    } else {
      await c.query(
        `UPDATE inventory_positions SET reserved = reserved - $2, version = version + 1, updated_at = now() WHERE variant_id = $1`,
        [row.variant_id, row.quantity],
      );
      await c.query(
        `INSERT INTO inventory_movements (variant_id, kind, delta_reserved, reason, ref_type, ref_id, actor_id)
         VALUES ($1, 'release', $2, $5, 'order', $3, $4)`,
        [row.variant_id, -row.quantity, orderId, actorId, to],
      );
    }
  }
  return rows.length;
}

/** Return stock of a COMMITTED (already decremented) order, e.g. COD cancellation. Exactly once per order. */
export async function restockCommittedOrder(
  c: PoolClient,
  orderId: string,
  reason: string,
  actorId: string | null,
) {
  const done = await c.query(
    `SELECT 1 FROM inventory_movements WHERE ref_type = 'order_restock' AND ref_id = $1 LIMIT 1`,
    [orderId],
  );
  if (done.rowCount) return;
  const items = await c.query<{ variant_id: string; quantity: number }>(
    `SELECT variant_id, quantity FROM order_items WHERE order_id = $1 ORDER BY variant_id`,
    [orderId],
  );
  for (const it of items.rows) {
    await c.query(
      `UPDATE inventory_positions SET on_hand = on_hand + $2, version = version + 1, updated_at = now() WHERE variant_id = $1`,
      [it.variant_id, it.quantity],
    );
    await c.query(
      `INSERT INTO inventory_movements (variant_id, kind, delta_on_hand, reason, ref_type, ref_id, actor_id)
       VALUES ($1, 'return_restock', $2, $3, 'order_restock', $4, $5)`,
      [it.variant_id, it.quantity, reason, orderId, actorId],
    );
  }
}
