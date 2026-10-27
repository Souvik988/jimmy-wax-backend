import type { Db } from '@jw/database';
import { settleReservations } from './inventory.ts';

/**
 * Durable reservation expiry. The authority is the database row (expires_at), NOT a Redis TTL
 * or a delayed job: a missed/duplicated job only delays/repeats a sweep, and settleReservations
 * guarantees exactly one release effect per reservation.
 */
export async function expireReservations(db: Db, batch = 100): Promise<number> {
  return db.tx({ kind: 'system', reason: 'reservation_expiry' }, async (c) => {
    const due = await c.query<{ id: string }>(
      `SELECT o.id FROM orders o
        WHERE o.status = 'pending_payment'
          AND EXISTS (SELECT 1 FROM stock_reservations r WHERE r.order_id = o.id AND r.status = 'active' AND r.expires_at <= now())
        ORDER BY o.created_at LIMIT $1 FOR UPDATE OF o SKIP LOCKED`,
      [batch],
    );
    for (const row of due.rows) {
      await settleReservations(c, row.id, 'expired', null);
      await c.query(`UPDATE orders SET status = 'expired' WHERE id = $1`, [row.id]);
      await c.query(
        `UPDATE payment_attempts SET status = 'expired', updated_at = now() WHERE order_id = $1 AND status IN ('created','pending')`,
        [row.id],
      );
      await c.query(
        `INSERT INTO outbox (aggregate_type, aggregate_id, event_type, payload) VALUES ('order', $1, 'order.expired', $2)`,
        [row.id, { orderId: row.id }],
      );
    }
    return due.rowCount ?? 0;
  });
}

export interface OutboxRow {
  id: number;
  aggregate_type: string;
  aggregate_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  attempts: number;
}

/** Claims a batch with a lease. SKIP LOCKED lets many relays run; an expired lease is reclaimable. */
export async function claimOutbox(
  db: Db,
  worker: string,
  batch = 50,
  leaseSeconds = 60,
): Promise<OutboxRow[]> {
  return db.tx({ kind: 'system', reason: 'outbox_claim' }, async (c) => {
    const r = await c.query<OutboxRow>(
      `WITH picked AS MATERIALIZED (
         SELECT id FROM outbox WHERE published_at IS NULL AND dead_at IS NULL AND available_at <= now()
            AND (claim_expires_at IS NULL OR claim_expires_at < now())
          ORDER BY id FOR UPDATE SKIP LOCKED LIMIT $2)
       UPDATE outbox o SET claimed_by = $1, claim_expires_at = now() + make_interval(secs => $3), attempts = attempts + 1
         FROM picked WHERE o.id = picked.id
       RETURNING o.id, o.aggregate_type, o.aggregate_id, o.event_type, o.payload, o.attempts`,
      [worker, batch, leaseSeconds],
    );
    return r.rows.sort((a, b) => a.id - b.id);
  });
}

export type Handler = (row: OutboxRow, c: import('@jw/database').PoolClient) => Promise<void>;

/**
 * Runs one handler for one event with inbox de-duplication in the SAME transaction as the effect:
 * crash before commit → nothing happened and the lease expires → retry; crash after commit →
 * inbox row exists, effect is not repeated.
 */
export async function deliver(
  db: Db,
  consumer: string,
  row: OutboxRow,
  handler: Handler,
): Promise<'done' | 'duplicate'> {
  return db.tx({ kind: 'system', reason: `consumer:${consumer}` }, async (c) => {
    const ins = await c.query(
      `INSERT INTO inbox (consumer, event_id) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING 1`,
      [consumer, row.id],
    );
    if (ins.rowCount === 0) return 'duplicate';
    await handler(row, c);
    return 'done';
  });
}

export async function markPublished(db: Db, id: number): Promise<void> {
  await db.tx({ kind: 'system', reason: 'outbox_publish' }, (c) =>
    c.query(`UPDATE outbox SET published_at = now(), claimed_by = NULL, last_error = NULL WHERE id = $1`, [
      id,
    ]),
  );
}

/** Exponential backoff with jitter; dead-letters after maxAttempts (operators can replay). */
export async function markFailed(db: Db, row: OutboxRow, err: string, maxAttempts = 8): Promise<void> {
  const delay = Math.min(3600, 2 ** row.attempts * 5) * (0.5 + Math.random() / 2);
  await db.tx({ kind: 'system', reason: 'outbox_fail' }, (c) =>
    c.query(
      `UPDATE outbox SET last_error = $2, claimed_by = NULL, claim_expires_at = NULL,
              available_at = now() + make_interval(secs => $3),
              dead_at = CASE WHEN $4 THEN now() ELSE NULL END WHERE id = $1`,
      [row.id, err.slice(0, 500), delay, row.attempts >= maxAttempts],
    ),
  );
}

export async function cleanupIdempotency(db: Db): Promise<number> {
  return db.tx({ kind: 'system', reason: 'idem_cleanup' }, async (c) => {
    const r = await c.query(`DELETE FROM idempotency_keys WHERE expires_at < now() AND state = 'completed'`);
    return r.rowCount ?? 0;
  });
}
