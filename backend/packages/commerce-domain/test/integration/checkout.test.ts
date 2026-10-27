import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppError } from '@jw/contracts';
import {
  V,
  V2,
  actor,
  addToCart,
  boot,
  flags,
  invariantStockMatchesLedger,
  order,
  quote,
  ready,
} from './harness.ts';
import { cancelOrder, getCart, setLine } from '../../src/index.ts';

let h: Awaited<ReturnType<typeof boot>>;
beforeAll(async () => {
  h = await boot();
});
afterAll(() => h.close());
beforeEach(async () => {
  await h.fx.resetCommerceData();
  await h.fx.openStore();
});

const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'OK';
  } catch (e) {
    return e instanceof AppError ? e.code : `RAW:${(e as Error).message}`;
  }
};

describe('merchant gates', () => {
  it('refuses quotes while checkout is disabled, policy unconfirmed, or authority is legacy', async () => {
    const userId = await h.fx.user();
    const addr = await h.fx.address(userId);
    await h.fx.setStock(V, 5);
    await addToCart(h.db, userId, V, 1);
    await h.fx.openStore({ checkout_enabled: false });
    expect(await code(quote(h.db, userId, addr))).toBe('CHECKOUT_DISABLED');
    await h.fx.openStore({ checkout_policy_confirmed: false });
    expect(await code(quote(h.db, userId, addr))).toBe('POLICY_NOT_CONFIGURED');
    await h.fx.openStore();
    expect(await code(quote(h.db, userId, addr, 'cod', { ...flags, checkout: false }))).toBe(
      'CHECKOUT_DISABLED',
    );
  });
  it('online payment needs a configured payment window; COD respects its limit', async () => {
    const { userId, addressId } = { userId: await h.fx.user(), addressId: '' };
    const a = await h.fx.address(userId);
    await h.fx.setStock(V, 50);
    await addToCart(h.db, userId, V, 20); // 20 × 29900 = 598000 > cod limit 500000
    expect(await code(quote(h.db, userId, a, 'cod'))).toBe('UNSUPPORTED_PAYMENT_METHOD');
    await h.fx.openStore({ payment_window_minutes: null });
    expect(await code(quote(h.db, userId, a, 'online'))).toBe('POLICY_NOT_CONFIGURED');
    void addressId;
  });
  it('zero-stock seed state can never produce a quote', async () => {
    const userId = await h.fx.user();
    const a = await h.fx.address(userId);
    await addToCart(h.db, userId, V, 1);
    expect(await code(quote(h.db, userId, a))).toBe('STOCK_SHORTAGE');
  });
});

describe('COD order transaction', () => {
  it('creates an immutable snapshot, decrements stock exactly once, consumes the cart, writes outbox', async () => {
    await h.fx.setStock(V, 10);
    const { userId, q } = await ready(h, 2);
    expect(q.subtotalPaise).toBe(59800);
    expect(q.shippingPaise).toBe(4000);
    expect(q.totalPaise).toBe(63800);
    expect(q.stockReserved).toBe(false);
    const placed = await order(h.db, userId, q.id);
    expect(placed.status).toBe(201);
    expect(placed.body).toMatchObject({
      status: 'placed',
      paymentStatus: 'cod_due',
      totalPaise: 63800,
      paymentMethod: 'cod',
    });
    expect(await h.fx.stockOf(V)).toEqual({ onHand: 8, reserved: 0 });
    // the public read model shows availability straight from the position
    expect(
      (await h.sup.query(`SELECT available FROM v_catalog_products WHERE variant_id=$1`, [V])).rows[0]
        .available,
    ).toBe(8);
    const cart = await h.db.tx(actor(userId), (c) => getCart(c, { userId }));
    expect(cart.lines).toHaveLength(0);
    const ob = await h.sup.query(`SELECT event_type FROM outbox WHERE aggregate_id = $1`, [placed.body.id]);
    expect(ob.rows.map((r) => r.event_type)).toEqual(['order.placed']);
    // snapshot is independent of later catalog edits
    await h.sup.query(`UPDATE products SET name = 'Renamed' WHERE id = $1`, [V]);
    await h.sup.query(`UPDATE product_variants SET price_paise = 1 WHERE id = $1`, [V]);
    const row = (
      await h.sup.query(`SELECT product_name, unit_price_paise FROM order_items WHERE order_id=$1`, [
        placed.body.id,
      ])
    ).rows[0];
    await h.sup.query(`UPDATE products SET name = 'Twinkle Shine Leather Polish' WHERE id = $1`, [V]);
    await h.sup.query(`UPDATE product_variants SET price_paise = 29900 WHERE id = $1`, [V]);
    expect(row).toEqual({ product_name: 'Twinkle Shine Leather Polish', unit_price_paise: 29900 });
    // total reconciles
    const o = (await h.sup.query(`SELECT * FROM orders WHERE id=$1`, [placed.body.id])).rows[0];
    expect(o.total_paise).toBe(o.subtotal_paise - o.discount_paise + o.shipping_paise + o.cod_fee_paise);
    expect(await invariantStockMatchesLedger(h)).toSatisfy(
      (rows: Array<{ on_hand: number; led_on_hand: number }>) =>
        rows.every((r) => r.on_hand === r.led_on_hand),
    );
  });

  it('free shipping at the confirmed threshold', async () => {
    await h.fx.setStock(V2, 100);
    const { q } = await ready(h, 4, 'cod', V2); // 4 × 49900 = 199600 < 200000
    expect(q.shippingPaise).toBe(4000);
    const u = await h.fx.user();
    const a = await h.fx.address(u);
    await addToCart(h.db, u, V2, 5); // 249500 ≥ threshold
    expect((await quote(h.db, u, a)).shippingPaise).toBe(0);
  });

  it('deleting a saved address leaves the order and its address snapshot intact', async () => {
    await h.fx.setStock(V, 3);
    const { userId, addressId, q } = await ready(h, 1);
    const placed = await order(h.db, userId, q.id);
    await h.sup.query(`DELETE FROM addresses WHERE id = $1`, [addressId]);
    const o = (
      await h.sup.query(`SELECT address_id, address_snapshot FROM orders WHERE id=$1`, [placed.body.id])
    ).rows[0];
    expect(o.address_id).toBeNull();
    expect(o.address_snapshot.pin).toBe('400001');
  });

  it('rejects quote expiry, reuse, stale price and cart changes with explicit codes', async () => {
    await h.fx.setStock(V, 10);
    const a = await ready(h, 1);
    await h.sup.query(`UPDATE checkout_quotes SET expires_at = now() - interval '1 second' WHERE id = $1`, [
      a.q.id,
    ]);
    expect(await code(order(h.db, a.userId, a.q.id))).toBe('QUOTE_EXPIRED');

    const b = await ready(h, 1);
    await order(h.db, b.userId, b.q.id);
    expect(await code(order(h.db, b.userId, b.q.id))).toBe('QUOTE_ALREADY_USED');

    const c = await ready(h, 1);
    await h.sup.query(`UPDATE product_variants SET price_paise = price_paise + 100 WHERE id = $1`, [V]);
    // the cart-version check fires first only if cart changed; here price drift must be caught
    expect(await code(order(h.db, c.userId, c.q.id))).toBe('QUOTE_STALE');
    await h.sup.query(`UPDATE product_variants SET price_paise = 29900 WHERE id = $1`, [V]);

    const d = await ready(h, 1);
    await addToCart(h.db, d.userId, V2, 1); // cart changed after quote
    await h.fx.setStock(V2, 5);
    expect(await code(order(h.db, d.userId, d.q.id))).toBe('CART_VERSION_CONFLICT');
  });

  it('never buys a valid subset: any short line fails the whole quote and leaves stock untouched', async () => {
    await h.fx.setStock(V, 5);
    await h.fx.setStock(V2, 0);
    const u = await h.fx.user();
    const a = await h.fx.address(u);
    await addToCart(h.db, u, V, 1);
    await addToCart(h.db, u, V2, 1);
    try {
      await quote(h.db, u, a);
      expect.unreachable();
    } catch (e) {
      expect((e as AppError).code).toBe('STOCK_SHORTAGE');
      expect((e as AppError).details?.lines).toEqual([{ variantId: V2, requested: 1, available: 0 }]);
    }
    expect(await h.fx.stockOf(V)).toEqual({ onHand: 5, reserved: 0 });
  });
});

describe('concurrency', () => {
  it('100 customers racing for the last unit: exactly one order, stock never negative', async () => {
    await h.fx.setStock(V, 100); // so every buyer can obtain a quote; then shrink to ONE unit
    const buyers = await Promise.all(
      Array.from({ length: 100 }, async () => {
        const userId = await h.fx.user();
        const addressId = await h.fx.address(userId);
        await addToCart(h.db, userId, V, 1);
        const q = await quote(h.db, userId, addressId);
        return { userId, q };
      }),
    );
    await h.sup.query(`UPDATE inventory_positions SET on_hand = 1, reserved = 0 WHERE variant_id = $1`, [V]);
    const results = await Promise.all(buyers.map((b) => code(order(h.db, b.userId, b.q.id))));
    expect(results.filter((r) => r === 'OK')).toHaveLength(1);
    expect(results.filter((r) => r === 'STOCK_SHORTAGE')).toHaveLength(99);
    expect(await h.fx.stockOf(V)).toEqual({ onHand: 0, reserved: 0 });
    const orders = await h.sup.query(`SELECT count(*)::int AS n FROM orders`);
    expect(orders.rows[0].n).toBe(1);
  });

  it('simultaneous duplicate keys yield ONE order and identical responses', async () => {
    await h.fx.setStock(V, 10);
    const { userId, q } = await ready(h, 1);
    const key = randomUUID();
    const rs = await Promise.all(
      Array.from({ length: 8 }, () =>
        order(h.db, userId, q.id, key).then(
          (r) => r,
          (e) => e,
        ),
      ),
    );
    const ok = rs.filter((r) => !(r instanceof Error));
    expect(ok).toHaveLength(8);
    expect(new Set(ok.map((r) => r.body.id)).size).toBe(1);
    expect(ok.filter((r) => r.replayed)).toHaveLength(7);
    expect((await h.sup.query(`SELECT count(*)::int n FROM orders`)).rows[0].n).toBe(1);
    expect(await h.fx.stockOf(V)).toEqual({ onHand: 9, reserved: 0 });
  });

  it('same key + different intent is a conflict; retry after commit returns the original', async () => {
    await h.fx.setStock(V, 10);
    const a = await ready(h, 1);
    const key = randomUUID();
    const first = await order(h.db, a.userId, a.q.id, key);
    const retry = await order(h.db, a.userId, a.q.id, key);
    expect(retry).toMatchObject({ replayed: true, status: 201 });
    expect(retry.body).toEqual(first.body);
    await addToCart(h.db, a.userId, V, 1);
    const q2 = await quote(h.db, a.userId, a.addressId);
    expect(await code(order(h.db, a.userId, q2.id, key))).toBe('DUPLICATE_REQUEST_MISMATCH');
    expect((await h.sup.query(`SELECT count(*)::int n FROM orders`)).rows[0].n).toBe(1);
  });

  it('items added while an order is being placed survive (only quoted quantities are consumed)', async () => {
    await h.fx.setStock(V, 20);
    await h.fx.setStock(V2, 20);
    const { userId, q } = await ready(h, 1);
    const [o, add] = await Promise.all([
      order(h.db, userId, q.id).then(
        (r) => r,
        (e) => e,
      ),
      h.db
        .tx(actor(userId), (c) => setLine(c, { userId }, V2, 2))
        .then(
          (r) => r,
          (e) => e,
        ),
    ]);
    const cart = await h.db.tx(actor(userId), (c) => getCart(c, { userId }));
    if (o instanceof Error) {
      // add won the lock first → explicit conflict, nothing lost, nothing consumed
      expect((o as AppError).code).toBe('CART_VERSION_CONFLICT');
      expect(cart.lines.map((l) => l.variantId).sort()).toEqual([V, V2].sort());
    } else {
      expect(add instanceof Error).toBe(false);
      expect(cart.lines.map((l) => [l.variantId, l.quantity])).toEqual([[V2, 2]]);
    }
  });

  it('cart version conflicts are explicit', async () => {
    const u = await h.fx.user();
    const c1 = await addToCart(h.db, u, V, 1);
    await h.db.tx(actor(u), (c) => setLine(c, { userId: u }, V, 2, c1.version));
    expect(await code(h.db.tx(actor(u), (c) => setLine(c, { userId: u }, V, 3, c1.version)))).toBe(
      'CART_VERSION_CONFLICT',
    );
  });
});

describe('cancellation and state machine', () => {
  it('COD cancel restocks exactly once (idempotent) and the ledger reconciles', async () => {
    await h.fx.setStock(V, 5);
    const { userId, q } = await ready(h, 2);
    const placed = await order(h.db, userId, q.id);
    expect(await h.fx.stockOf(V)).toEqual({ onHand: 3, reserved: 0 });
    await h.db.tx(actor(userId), (c) => cancelOrder(c, userId, placed.body.id, 'changed my mind'));
    await h.db.tx(actor(userId), (c) => cancelOrder(c, userId, placed.body.id, 'again'));
    expect(await h.fx.stockOf(V)).toEqual({ onHand: 5, reserved: 0 });
    const led = await invariantStockMatchesLedger(h);
    expect(led.every((r) => r.on_hand === r.led_on_hand)).toBe(true);
  });

  it('database rejects illegal order transitions regardless of caller', async () => {
    await h.fx.setStock(V, 5);
    const { userId, q } = await ready(h, 1);
    const placed = await order(h.db, userId, q.id);
    await expect(
      h.sup.query(`UPDATE orders SET status = 'delivered' WHERE id = $1`, [placed.body.id]),
    ).rejects.toThrow(/Illegal order transition/);
    await h.sup.query(`UPDATE orders SET status = 'confirmed' WHERE id = $1`, [placed.body.id]);
    await expect(
      h.sup.query(`UPDATE orders SET status = 'placed' WHERE id = $1`, [placed.body.id]),
    ).rejects.toThrow(/Illegal order transition/);
  });

  it('refunds can never exceed the order total (partial refunds sum-checked)', async () => {
    await h.fx.setStock(V, 5);
    const { userId, q } = await ready(h, 1);
    const placed = await order(h.db, userId, q.id); // total 33900
    const ins = (amt: number, k: string) =>
      h.sup.query(
        `INSERT INTO refunds (order_id, amount_paise, reason, idempotency_key) VALUES ($1,$2,'t',$3)`,
        [placed.body.id, amt, k],
      );
    await ins(20000, 'a');
    await expect(ins(14000, 'b')).rejects.toThrow(/exceeds refundable/);
    await ins(13900, 'c');
  });

  it('inventory CHECK constraints stop oversell even for direct SQL', async () => {
    await expect(
      h.sup.query(`UPDATE inventory_positions SET reserved = on_hand + 1 WHERE variant_id = $1`, [V]),
    ).rejects.toThrow();
  });
});
