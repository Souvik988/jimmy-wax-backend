import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { TestPaymentGateway, WebhookVerificationError } from '@jw/integrations';
import { V, actor, boot, invariantStockMatchesLedger, order, ready } from './harness.ts';
import {
  createPaymentAttempt,
  expireReservations,
  ingestWebhook,
  processPaymentEvent,
  reconcilePendingAttempts,
  claimOutbox,
  deliver,
  markFailed,
  markPublished,
  notifyHandler,
} from '../../src/index.ts';

let h: Awaited<ReturnType<typeof boot>>;
const gw = new TestPaymentGateway();
beforeAll(async () => {
  h = await boot();
});
afterAll(() => h.close());
beforeEach(async () => {
  await h.fx.resetCommerceData();
  await h.fx.openStore();
  gw.orders.clear();
});

/** Places an ONLINE order (stock reserved, awaiting payment) and opens its payment attempt. */
async function onlineOrder(qty = 1, stock = 5) {
  await h.fx.setStock(V, stock);
  const { userId, q } = await ready(h, qty, 'online');
  const placed = await order(h.db, userId, q.id);
  const attempt = await createPaymentAttempt(h.db, gw, userId, placed.body.id, randomUUID());
  return { userId, orderId: placed.body.id, total: placed.body.totalPaise, attempt };
}
function hook(
  type: string,
  providerOrderId: string,
  status: string,
  amountPaise: number,
  id = randomUUID(),
  currency = 'INR',
) {
  const raw = Buffer.from(
    JSON.stringify({
      id,
      type,
      providerOrderId,
      providerPaymentId: 'pay_' + id.slice(0, 6),
      status,
      amountPaise,
      currency,
    }),
  );
  return { raw, headers: { 'x-test-signature': gw.sign(raw) }, id };
}
const send = async (w: ReturnType<typeof hook>) => {
  const r = await ingestWebhook(h.db, gw, w.raw, w.headers);
  return r.eventId === null ? 'duplicate' : processPaymentEvent(h.db, r.eventId);
};
const orderRow = async (id: string) =>
  (await h.sup.query(`SELECT status, payment_status FROM orders WHERE id=$1`, [id])).rows[0];

describe('online order: reservation → payment → commit', () => {
  it('reserves (not decrements) stock at order time and exposes it as unavailable', async () => {
    const o = await onlineOrder(2, 5);
    expect(await h.fx.stockOf(V)).toEqual({ onHand: 5, reserved: 2 });
    expect(await orderRow(o.orderId)).toEqual({ status: 'pending_payment', payment_status: 'pending' });
    expect(
      (await h.sup.query(`SELECT available FROM v_catalog_products WHERE variant_id=$1`, [V])).rows[0]
        .available,
    ).toBe(3);
  });

  it('a verified captured webhook commits stock and marks paid; redelivery has no second effect', async () => {
    const o = await onlineOrder(2, 5);
    const w = hook('payment.captured', o.attempt.clientConfig!.orderId!, 'captured', o.total);
    expect(await send(w)).toBe('processed');
    expect(await orderRow(o.orderId)).toEqual({ status: 'placed', payment_status: 'paid' });
    expect(await h.fx.stockOf(V)).toEqual({ onHand: 3, reserved: 0 });
    expect(await send(w)).toBe('duplicate'); // same provider event id
    const again = hook('payment.captured', o.attempt.clientConfig!.orderId!, 'captured', o.total); // NEW event id, same fact
    expect(await send(again)).toBe('ignored'); // business effect suppressed
    expect(await h.fx.stockOf(V)).toEqual({ onHand: 3, reserved: 0 });
    expect(
      (await h.sup.query(`SELECT count(*)::int n FROM outbox WHERE event_type='payment.captured'`)).rows[0].n,
    ).toBe(1);
    expect(
      (await invariantStockMatchesLedger(h)).every(
        (r) => r.on_hand === r.led_on_hand && r.reserved === r.led_reserved,
      ),
    ).toBe(true);
  });

  it('rejects forged signatures and never trusts a client callback', async () => {
    const o = await onlineOrder();
    const w = hook('payment.captured', o.attempt.clientConfig!.orderId!, 'captured', o.total);
    await expect(ingestWebhook(h.db, gw, w.raw, { 'x-test-signature': 'deadbeef' })).rejects.toThrow(
      WebhookVerificationError,
    );
    expect(await orderRow(o.orderId)).toEqual({ status: 'pending_payment', payment_status: 'pending' });
    expect((await h.sup.query(`SELECT count(*)::int n FROM payment_events`)).rows[0].n).toBe(0);
  });

  it('amount/currency mismatch flags an exception and does NOT fulfil', async () => {
    const o = await onlineOrder();
    expect(
      await send(hook('payment.captured', o.attempt.clientConfig!.orderId!, 'captured', o.total - 1)),
    ).toBe('failed');
    expect(await orderRow(o.orderId)).toEqual({ status: 'pending_payment', payment_status: 'exception' });
    expect(await h.fx.stockOf(V)).toEqual({ onHand: 5, reserved: 1 });
  });

  it('reordered events: a late "failed" after "captured" cannot undo payment', async () => {
    const o = await onlineOrder();
    await send(hook('payment.captured', o.attempt.clientConfig!.orderId!, 'captured', o.total));
    expect(await send(hook('payment.failed', o.attempt.clientConfig!.orderId!, 'failed', o.total))).toBe(
      'ignored',
    );
    expect(await orderRow(o.orderId)).toEqual({ status: 'placed', payment_status: 'paid' });
  });

  it('authorization alone is not paid', async () => {
    const o = await onlineOrder();
    await send(hook('payment.authorized', o.attempt.clientConfig!.orderId!, 'authorized', o.total));
    expect(await orderRow(o.orderId)).toEqual({ status: 'pending_payment', payment_status: 'pending' });
  });

  it('unknown provider references are ignored safely', async () => {
    expect(await send(hook('payment.captured', 'order_unknown', 'captured', 100))).toBe('ignored');
  });

  it('only one live payment attempt per order; resuming returns the same attempt', async () => {
    const o = await onlineOrder();
    const again = await createPaymentAttempt(h.db, gw, o.userId, o.orderId, randomUUID());
    expect(again.id).toBe(o.attempt.id);
    expect((await h.sup.query(`SELECT count(*)::int n FROM payment_attempts`)).rows[0].n).toBe(1);
  });

  it('provider timeout AFTER accept: retry adopts the existing provider order (no duplicate)', async () => {
    await h.fx.setStock(V, 5);
    const { userId, q } = await ready(h, 1, 'online');
    const placed = await order(h.db, userId, q.id);
    gw.failNextCreateAfterAccept = true;
    await expect(createPaymentAttempt(h.db, gw, userId, placed.body.id, randomUUID())).rejects.toThrow(
      /timeout/,
    );
    const a = await createPaymentAttempt(h.db, gw, userId, placed.body.id, randomUUID());
    expect(gw.orders.size).toBe(1);
    expect(a.status).toBe('pending');
  });

  it('ownership: another customer cannot open a payment attempt for my order', async () => {
    const o = await onlineOrder();
    const other = await h.fx.user();
    await expect(createPaymentAttempt(h.db, gw, other, o.orderId, randomUUID())).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('missing webhook is recovered by reconciliation against provider status', async () => {
    const o = await onlineOrder();
    const po = gw.orders.get(o.attempt.clientConfig!.orderId!)!;
    po.status = 'captured';
    await h.sup.query(`UPDATE payment_attempts SET updated_at = now() - interval '10 minutes'`);
    expect(await reconcilePendingAttempts(h.wdb, gw, 60)).toBe(1);
    expect(await orderRow(o.orderId)).toEqual({ status: 'placed', payment_status: 'paid' });
    expect(await reconcilePendingAttempts(h.wdb, gw, 60)).toBe(0); // idempotent
  });
});

describe('expiry and late capture', () => {
  it('expiry releases reservation exactly once, even with repeated/concurrent sweeps', async () => {
    const o = await onlineOrder(2, 5);
    await h.sup.query(`UPDATE stock_reservations SET expires_at = now() - interval '1 minute'`);
    const swept = await Promise.all([
      expireReservations(h.wdb),
      expireReservations(h.wdb),
      expireReservations(h.wdb),
    ]);
    expect(swept.reduce((a, b) => a + b, 0)).toBe(1);
    expect(await expireReservations(h.wdb)).toBe(0);
    expect(await orderRow(o.orderId)).toEqual({ status: 'expired', payment_status: 'pending' });
    expect(await h.fx.stockOf(V)).toEqual({ onHand: 5, reserved: 0 });
  });

  it('capture racing/after expiry → exception + full refund request, no phantom fulfilment, no stock change', async () => {
    const o = await onlineOrder(1, 5);
    await h.sup.query(`UPDATE stock_reservations SET expires_at = now() - interval '1 minute'`);
    await expireReservations(h.wdb);
    expect(await send(hook('payment.captured', o.attempt.clientConfig!.orderId!, 'captured', o.total))).toBe(
      'processed',
    );
    expect(await orderRow(o.orderId)).toEqual({ status: 'expired', payment_status: 'exception' });
    const rf = (
      await h.sup.query(`SELECT amount_paise, reason, status FROM refunds WHERE order_id=$1`, [o.orderId])
    ).rows;
    expect(rf).toEqual([
      { amount_paise: o.total, reason: 'late_capture_unfulfillable', status: 'requested' },
    ]);
    expect(await h.fx.stockOf(V)).toEqual({ onHand: 5, reserved: 0 });
    await send(hook('payment.captured', o.attempt.clientConfig!.orderId!, 'captured', o.total)); // redelivery
    expect((await h.sup.query(`SELECT count(*)::int n FROM refunds`)).rows[0].n).toBe(1);
  });

  it('concurrent capture webhook vs expiry sweep ends in exactly one consistent state', async () => {
    for (let i = 0; i < 5; i++) {
      await h.fx.resetCommerceData();
      const o = await onlineOrder(1, 5);
      await h.sup.query(`UPDATE stock_reservations SET expires_at = now() - interval '1 minute'`);
      await Promise.all([
        expireReservations(h.wdb),
        send(hook('payment.captured', o.attempt.clientConfig!.orderId!, 'captured', o.total)),
      ]);
      const r = await orderRow(o.orderId);
      const st = await h.fx.stockOf(V);
      if (r.status === 'placed') expect(st).toEqual({ onHand: 4, reserved: 0 });
      else {
        expect(r).toEqual({ status: 'expired', payment_status: 'exception' });
        expect(st).toEqual({ onHand: 5, reserved: 0 });
      }
    }
  });
});

describe('outbox / inbox', () => {
  async function seedEvents(n: number) {
    await h.sup.query(
      `INSERT INTO outbox (aggregate_type, aggregate_id, event_type, payload)
      SELECT 'order', gen_random_uuid()::text, 'order.placed', jsonb_build_object('userId', $1::text) FROM generate_series(1, $2)`,
      [await h.fx.user(), n],
    );
  }
  it('two relays never claim the same row; an expired lease is reclaimable', async () => {
    await seedEvents(20);
    const [a, b] = await Promise.all([claimOutbox(h.wdb, 'w1', 20), claimOutbox(h.wdb, 'w2', 20)]);
    const ids = [...a, ...b].map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(20);
    await h.sup.query(`UPDATE outbox SET claim_expires_at = now() - interval '1 second'`);
    expect(await claimOutbox(h.wdb, 'w3', 50)).toHaveLength(20); // "worker crashed" → lease expired
  });

  it('crash after commit but before ack does not repeat the effect (inbox dedupe)', async () => {
    await seedEvents(1);
    const [row] = await claimOutbox(h.wdb, 'w1', 1);
    expect(await deliver(h.wdb, 'notify', row!, notifyHandler)).toBe('done');
    // worker dies before markPublished; lease expires; another worker re-claims and re-delivers
    await h.sup.query(`UPDATE outbox SET claim_expires_at = now() - interval '1 second'`);
    const [again] = await claimOutbox(h.wdb, 'w2', 1);
    expect(await deliver(h.wdb, 'notify', again!, notifyHandler)).toBe('duplicate');
    await markPublished(h.wdb, again!.id);
    expect((await h.sup.query(`SELECT count(*)::int n FROM notifications`)).rows[0].n).toBe(1);
  });

  it('a poisoned event backs off then dead-letters without blocking others', async () => {
    await seedEvents(2);
    const rows = await claimOutbox(h.wdb, 'w1', 10);
    const poison = rows[0]!;
    for (let i = 0; i < 8; i++) {
      await h.sup.query(`UPDATE outbox SET attempts = $2 WHERE id = $1`, [poison.id, i + 1]);
      await markFailed(h.wdb, { ...poison, attempts: i + 1 }, 'boom');
    }
    const dead = (
      await h.sup.query(`SELECT dead_at IS NOT NULL AS dead FROM outbox WHERE id=$1`, [poison.id])
    ).rows[0];
    expect(dead.dead).toBe(true);
    await markPublished(h.wdb, rows[1]!.id);
    expect(
      (await h.sup.query(`SELECT count(*)::int n FROM outbox WHERE published_at IS NOT NULL`)).rows[0].n,
    ).toBe(1);
  });
});
