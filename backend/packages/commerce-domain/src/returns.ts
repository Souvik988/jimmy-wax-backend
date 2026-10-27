import type { PoolClient } from '@jw/database';
import { AppError } from '@jw/contracts';
import { audit, type AdminRole } from './admin.ts';
import { allocateProportional } from './money.ts';

interface Ctx {
  adminId: string;
  role: AdminRole;
  requestId?: string;
}

export async function requestReturn(
  c: PoolClient,
  userId: string,
  orderId: string,
  items: Array<{ orderItemId: number; quantity: number }>,
  reason: string,
) {
  const st = (await c.query(`SELECT return_window_days FROM store_settings WHERE id = 1`)).rows[0];
  if (!st?.return_window_days) throw new AppError('POLICY_NOT_CONFIGURED', 'Returns are not available yet');
  const o = (
    await c.query(`SELECT * FROM orders WHERE id = $1 AND user_id = $2 FOR UPDATE`, [orderId, userId])
  ).rows[0];
  if (!o) throw new AppError('NOT_FOUND', 'Order not found');
  if (o.status !== 'delivered') throw new AppError('ILLEGAL_STATE', 'Only delivered orders can be returned');
  const del = await c.query(
    `SELECT max(e.occurred_at) AS at FROM shipment_events e JOIN shipments s ON s.id = e.shipment_id WHERE s.order_id = $1 AND e.status = 'delivered'`,
    [orderId],
  );
  const deliveredAt: Date = del.rows[0]?.at ?? o.updated_at;
  if (Date.now() > new Date(deliveredAt).getTime() + st.return_window_days * 86_400_000) {
    throw new AppError('ILLEGAL_STATE', `The ${st.return_window_days}-day return window has ended`);
  }
  if (items.length === 0) throw new AppError('VALIDATION_FAILED', 'Choose at least one item');
  const lines = (await c.query(`SELECT id, quantity FROM order_items WHERE order_id = $1`, [orderId])).rows;
  const already = await c.query(
    `SELECT ri.order_item_id, sum(ri.quantity)::int AS q FROM return_items ri JOIN returns r ON r.id = ri.return_id
      WHERE r.order_id = $1 AND r.status IN ('requested','approved','received','closed') GROUP BY 1`,
    [orderId],
  );
  const used = new Map(already.rows.map((r) => [Number(r.order_item_id), r.q as number]));
  const seen = new Set<number>();
  for (const it of items) {
    const line = lines.find((l) => Number(l.id) === it.orderItemId);
    if (!line || seen.has(it.orderItemId)) throw new AppError('VALIDATION_FAILED', 'Invalid item selection');
    seen.add(it.orderItemId);
    if (it.quantity + (used.get(it.orderItemId) ?? 0) > line.quantity) {
      throw new AppError('VALIDATION_FAILED', 'Return quantity exceeds what was delivered', {
        fields: { quantity: 'too high' },
      });
    }
  }
  let ret;
  try {
    ret = await c.query(`INSERT INTO returns (order_id, user_id, reason) VALUES ($1,$2,$3) RETURNING id`, [
      orderId,
      userId,
      reason.trim(),
    ]);
  } catch (e) {
    if ((e as { code?: string }).code === '23505')
      throw new AppError('ILLEGAL_STATE', 'A return for this order is already open');
    throw e;
  }
  for (const it of items) {
    await c.query(`INSERT INTO return_items (return_id, order_item_id, quantity) VALUES ($1,$2,$3)`, [
      ret.rows[0].id,
      it.orderItemId,
      it.quantity,
    ]);
  }
  return { id: ret.rows[0].id as string, status: 'requested' as const };
}

export async function decideReturn(c: PoolClient, x: Ctx, returnId: string, approve: boolean, note: string) {
  const r = (await c.query(`SELECT * FROM returns WHERE id = $1 FOR UPDATE`, [returnId])).rows[0];
  if (!r) throw new AppError('NOT_FOUND', 'Return not found');
  if (r.status !== 'requested') throw new AppError('ILLEGAL_STATE', 'This return was already decided');
  await c.query(
    `UPDATE returns SET status = $2, decision_note = $3, decided_by = $4, updated_at = now() WHERE id = $1`,
    [returnId, approve ? 'approved' : 'rejected', note, x.adminId],
  );
  const o = (await c.query(`SELECT order_number, user_id FROM orders WHERE id = $1`, [r.order_id])).rows[0];
  await c.query(
    `INSERT INTO outbox (aggregate_type, aggregate_id, event_type, payload) VALUES ('order',$1,'return.decided',$2)`,
    [r.order_id, { orderId: r.order_id, userId: o.user_id, approved: approve, note }],
  );
  await audit(c, {
    actorId: x.adminId,
    actorRole: x.role,
    action: approve ? 'return.approve' : 'return.reject',
    resourceType: 'return',
    resourceId: returnId,
    reason: note,
    requestId: x.requestId,
  });
}

/**
 * Goods physically received: restock exactly once per return (status-guarded), queue a refund for ONLINE-paid
 * orders (line value only — delivery/COD fees are not refunded unless finance decides), close the order as
 * `returned` when every unit has come back. COD refunds are a manual cash/bank transfer and are only recorded.
 */
export async function receiveReturn(c: PoolClient, x: Ctx, returnId: string) {
  const r = (await c.query(`SELECT * FROM returns WHERE id = $1 FOR UPDATE`, [returnId])).rows[0];
  if (!r) throw new AppError('NOT_FOUND', 'Return not found');
  if (r.status !== 'approved') throw new AppError('ILLEGAL_STATE', 'Only approved returns can be received');
  const o = (await c.query(`SELECT * FROM orders WHERE id = $1 FOR UPDATE`, [r.order_id])).rows[0];
  const items = (
    await c.query(
      `SELECT ri.quantity AS rq, i.* FROM return_items ri JOIN order_items i ON i.id = ri.order_item_id WHERE ri.return_id = $1 ORDER BY i.variant_id`,
      [returnId],
    )
  ).rows;
  await c.query(
    `UPDATE returns SET status = 'received', received_by = $2, updated_at = now() WHERE id = $1`,
    [returnId, x.adminId],
  );
  let refundValue = 0;
  for (const i of items) {
    await c.query(
      `UPDATE inventory_positions SET on_hand = on_hand + $2, version = version + 1, updated_at = now() WHERE variant_id = $1`,
      [i.variant_id, i.rq],
    );
    await c.query(
      `INSERT INTO inventory_movements (variant_id, kind, delta_on_hand, reason, ref_type, ref_id, actor_id) VALUES ($1,'return_restock',$2,'customer return received','return',$3,$4)`,
      [i.variant_id, i.rq, returnId, x.adminId],
    );
    // Net of the coupon share for these units, so a discounted order is never over-refunded.
    refundValue += i.unit_price_paise * i.rq - Math.floor(((i.discount_paise ?? 0) * i.rq) / i.quantity);
  }
  const totalUnits = (
    await c.query(`SELECT sum(quantity)::int AS n FROM order_items WHERE order_id = $1`, [r.order_id])
  ).rows[0].n;
  const returnedUnits = (
    await c.query(
      `SELECT coalesce(sum(ri.quantity),0)::int AS n FROM return_items ri JOIN returns rt ON rt.id = ri.return_id WHERE rt.order_id = $1 AND rt.status IN ('received','closed')`,
      [r.order_id],
    )
  ).rows[0].n;
  if (returnedUnits >= totalUnits)
    await c.query(`UPDATE orders SET status = 'returned' WHERE id = $1`, [r.order_id]);
  let refundQueued = false;
  if (
    o.payment_method === 'online' &&
    ['paid', 'partially_refunded'].includes(o.payment_status) &&
    refundValue > 0
  ) {
    await c.query(
      `INSERT INTO refunds (order_id, amount_paise, reason, idempotency_key, requested_by) VALUES ($1,$2,'customer_return',$3,$4) ON CONFLICT (order_id, idempotency_key) DO NOTHING`,
      [r.order_id, refundValue, `return:${returnId}`, x.adminId],
    );
    refundQueued = true;
  }
  await audit(c, {
    actorId: x.adminId,
    actorRole: x.role,
    action: 'return.receive',
    resourceType: 'return',
    resourceId: returnId,
    after: { refundValuePaise: refundValue, refundQueued },
    requestId: x.requestId,
  });
  return {
    id: returnId,
    status: 'received',
    refundValuePaise: refundValue,
    refundQueued,
    manualRefundRequired: o.payment_method === 'cod',
  };
}

export { allocateProportional };
