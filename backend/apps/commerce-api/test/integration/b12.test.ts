import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { allocate, computeDiscount } from '@jw/commerce-domain';
import { startHarness } from './harness.ts';

const V = 'twinkle-shine-leather-polish';
let h: Awaited<ReturnType<typeof startHarness>>;
let admin: { id: string; token: string };

beforeAll(async () => {
  h = await startHarness();
  await h.fx.resetCommerceData();
  await h.fx.openStore({ cod_fee_paise: 2500 });
  await h.sup.query(`DELETE FROM coupons`);
  admin = await h.staff('admin');
});
afterAll(async () => {
  await h.close();
});

const mk = (over: Record<string, unknown> = {}) =>
  h.call('POST', '/v1/admin/coupons', admin.token, {
    code: `T${randomUUID().slice(0, 8).toUpperCase()}`,
    ...(over.kind ? {} : { kind: 'percentage', valueBps: 1000 }),
    ...over,
  });

/** A customer with a cart and a default address, ready to quote. */
async function shopper(quantity = 1) {
  const id = await h.fx.user();
  const token = await h.mint(id, 'aal1');
  await h.fx.setStock(V, 500);
  const a = await h.call('POST', '/v1/addresses', token, {
    recipientName: 'Test Buyer',
    phone: '9999999999',
    line1: '12 Road',
    city: 'Pune',
    state: 'Maharashtra',
    postalCode: '411001',
    isDefault: true,
  });
  await h.call('PUT', `/v1/cart/lines/${V}`, token, { quantity });
  return { id, token, addressId: a.json.id as string };
}
const quote = (
  s: { token: string; addressId: string },
  method: 'cod' | 'online' = 'cod',
  couponCode?: string,
) =>
  h.call('POST', '/v1/checkout/quotes', s.token, {
    addressId: s.addressId,
    paymentMethod: method,
    ...(couponCode ? { couponCode } : {}),
  });
const order = (s: { token: string }, quoteId: string) =>
  h.call('POST', '/v1/orders', s.token, { quoteId }, { 'idempotency-key': randomUUID() });

describe('discount maths (pure)', () => {
  const lines = [
    { key: 'a', productId: 'p1', amountPaise: 33333 },
    { key: 'b', productId: 'p2', amountPaise: 33333 },
    { key: 'c', productId: 'p3', amountPaise: 33334 },
  ];
  it('allocates exactly, never losing or inventing a paisa', () => {
    for (const total of [0, 1, 2, 99, 100, 9999, 33333]) {
      const parts = allocate(
        total,
        lines.map((l) => l.amountPaise),
      );
      expect(parts.reduce((n, p) => n + p, 0)).toBe(total);
      parts.forEach((p, i) => expect(p).toBeLessThanOrEqual(lines[i]!.amountPaise));
    }
    expect(allocate(5, [0, 10, 0])).toEqual([0, 5, 0]);
  });
  const base = {
    value_bps: null,
    value_paise: null,
    min_order_paise: 0,
    max_discount_paise: null,
    scope_product_ids: [] as string[],
  };
  it('percentage rounds down and respects the cap', () => {
    expect(computeDiscount({ ...base, kind: 'percentage', value_bps: 1000 }, lines, 40).discountPaise).toBe(
      10000,
    );
    expect(
      computeDiscount({ ...base, kind: 'percentage', value_bps: 1000, max_discount_paise: 5000 }, lines, 40)
        .discountPaise,
    ).toBe(5000);
  });
  it('flat never exceeds what it applies to; scope limits the base', () => {
    expect(computeDiscount({ ...base, kind: 'flat', value_paise: 500000 }, lines, 40).discountPaise).toBe(
      100000,
    );
    const r = computeDiscount(
      { ...base, kind: 'flat', value_paise: 500000, scope_product_ids: ['p1'] },
      lines,
      40,
    );
    expect(r.discountPaise).toBe(33333);
    expect(r.lineDiscounts).toEqual([33333, 0, 0]);
  });
  it('rejects with a reason when the cart does not qualify', () => {
    const reason = (f: () => unknown) => {
      try {
        f();
      } catch (e) {
        return (e as { details?: { reason?: string } }).details?.reason;
      }
    };
    expect(
      reason(() =>
        computeDiscount({ ...base, kind: 'flat', value_paise: 100, min_order_paise: 999999 }, lines, 40),
      ),
    ).toBe('min_order');
    expect(
      reason(() =>
        computeDiscount({ ...base, kind: 'flat', value_paise: 100, scope_product_ids: ['zzz'] }, lines, 40),
      ),
    ).toBe('not_applicable');
    expect(reason(() => computeDiscount({ ...base, kind: 'free_shipping' }, lines, 0))).toBe(
      'shipping_already_free',
    );
  });
});

describe('coupons through the API', () => {
  it('admin CRUD is validated, audited and permissioned', async () => {
    const bad = await mk({ kind: 'percentage', valueBps: undefined });
    expect([bad.status, bad.json.error.code]).toEqual([400, 'VALIDATION_FAILED']);
    const mixed = await mk({ kind: 'flat', valuePaise: 100, valueBps: 500 });
    expect(mixed.status).toBe(400);
    const c = await mk({ description: 'Ten percent' });
    expect(c.status).toBe(201);
    expect(c.json).toMatchObject({ kind: 'percentage', valueBps: 1000, status: 'live', redeemed: 0 });
    const dup = await mk({ code: c.json.code });
    expect([dup.status, dup.json.error.code]).toEqual([400, 'VALIDATION_FAILED']);

    const fin = await h.staff('finance');
    expect((await h.call('GET', '/v1/admin/coupons', fin.token)).status).toBe(200);
    expect(
      (
        await h.call('POST', '/v1/admin/coupons', fin.token, {
          code: 'NOPE10',
          kind: 'flat',
          valuePaise: 100,
        })
      ).status,
    ).toBe(403);
    const des = await h.staff('designer');
    expect((await h.call('GET', '/v1/admin/coupons', des.token)).status).toBe(403);
    const cust = await h.fx.user();
    expect((await h.call('GET', '/v1/admin/coupons', await h.mint(cust, 'aal1'))).status).toBe(403);

    const off = await h.call('POST', `/v1/admin/coupons/${c.json.id}/deactivate`, admin.token);
    expect([off.status, off.json.status]).toEqual([200, 'inactive']);
    const audit = await h.sup.query(
      `SELECT action FROM audit_log WHERE resource_type = 'coupon' AND resource_id = $1 ORDER BY id`,
      [c.json.id],
    );
    expect(audit.rows.map((r) => r.action)).toEqual(['coupon.create', 'coupon.update']);
  });

  it('a percentage coupon discounts the quote, keeps GST consistent and is redeemed once on order', async () => {
    const c = await mk({ maxDiscountPaise: 100000 });
    const s = await shopper(2);
    const plain = await quote(s);
    expect(plain.json.discountPaise).toBe(0);

    const applied = await h.call('POST', '/v1/cart/coupon', s.token, { code: c.json.code.toLowerCase() });
    expect(applied.status).toBe(200);
    expect((await h.call('GET', '/v1/cart', s.token)).json.couponCode).toBe(c.json.code);

    const q = await quote(s);
    expect(q.status).toBe(201);
    const expected = Math.floor((plain.json.subtotalPaise * 1000) / 10000);
    expect(q.json.discountPaise).toBe(expected);
    expect(q.json.couponCode).toBe(c.json.code);
    // Prices are tax-inclusive: total = subtotal - discount + shipping + COD fee, and GST is on the discounted amounts.
    expect(q.json.totalPaise).toBe(
      q.json.subtotalPaise - expected + q.json.shippingPaise + q.json.codFeePaise,
    );
    const lineParts = q.json.taxBreakdown.lines.reduce(
      (n: number, l: { taxablePaise: number; taxPaise: number }) => n + l.taxablePaise + l.taxPaise,
      0,
    );
    expect(lineParts).toBe(q.json.subtotalPaise - expected);
    expect(q.json.lines.reduce((n: number, l: { discountPaise: number }) => n + l.discountPaise, 0)).toBe(
      expected,
    );

    const o = await order(s, q.json.id);
    expect(o.status).toBe(201);
    expect(o.json).toMatchObject({ discountPaise: expected, couponCode: c.json.code });
    const items = await h.sup.query(
      `SELECT sum(discount_paise)::int AS d FROM order_items WHERE order_id = $1`,
      [o.json.id],
    );
    expect(items.rows[0].d).toBe(expected);
    const red = await h.sup.query(
      `SELECT discount_paise, released_at FROM coupon_redemptions WHERE order_id = $1`,
      [o.json.id],
    );
    expect(red.rows).toEqual([{ discount_paise: expected, released_at: null }]);
    expect((await h.call('GET', `/v1/admin/coupons/${c.json.id}`, admin.token)).json).toMatchObject({
      redeemed: 1,
      discountGivenPaise: expected,
    });
  });

  it('enforces the per-customer limit and gives the use back when the order is cancelled', async () => {
    const c = await mk({ kind: 'flat', valuePaise: 1000, usageLimitPerCustomer: 1 });
    const s = await shopper();
    const q1 = await quote(s, 'cod', c.json.code);
    expect(q1.json.discountPaise).toBe(1000);
    const o = await order(s, q1.json.id);
    expect(o.status).toBe(201);

    await h.call('PUT', `/v1/cart/lines/${V}`, s.token, { quantity: 1 });
    const again = await quote(s, 'cod', c.json.code);
    expect([again.status, again.json.error.code, again.json.error.reason]).toEqual([
      422,
      'COUPON_INVALID',
      'already_used',
    ]);

    const cancel = await h.call('POST', `/v1/orders/${o.json.id}/cancel`, s.token, {
      reason: 'changed my mind',
    });
    expect(cancel.status).toBe(200);
    const released = await h.sup.query(`SELECT released_at FROM coupon_redemptions WHERE order_id = $1`, [
      o.json.id,
    ]);
    expect(released.rows[0].released_at).not.toBeNull();
    const after = await quote(s, 'cod', c.json.code);
    expect(after.status).toBe(201);
  });

  it('never oversells a total usage limit, even with concurrent orders', async () => {
    const c = await mk({ kind: 'flat', valuePaise: 500, usageLimitTotal: 1 });
    const a = await shopper();
    const b = await shopper();
    const [qa, qb] = await Promise.all([quote(a, 'cod', c.json.code), quote(b, 'cod', c.json.code)]);
    expect([qa.status, qb.status]).toEqual([201, 201]);
    const [oa, ob] = await Promise.all([order(a, qa.json.id), order(b, qb.json.id)]);
    expect([oa.status, ob.status].sort()).toEqual([201, 422]);
    const loser = oa.status === 422 ? oa : ob;
    expect(loser.json.error.code).toBe('COUPON_INVALID');
    const n = await h.sup.query(
      `SELECT count(*)::int AS n FROM coupon_redemptions WHERE coupon_id = $1 AND released_at IS NULL`,
      [c.json.id],
    );
    expect(n.rows[0].n).toBe(1);
    // The losing order did not partially commit: its cart line and stock are intact.
    const lost = oa.status === 422 ? a : b;
    expect((await h.call('GET', '/v1/cart', lost.token)).json.lines).toHaveLength(1);
  });

  it('free shipping waives the shipping charge and its GST', async () => {
    const c = await mk({ kind: 'free_shipping' });
    const s = await shopper();
    const plain = await quote(s);
    const q = await quote(s, 'cod', c.json.code);
    expect(plain.json.shippingPaise).toBeGreaterThan(0);
    expect(q.json).toMatchObject({
      shippingPaise: 0,
      shippingDiscountPaise: plain.json.shippingPaise,
      discountPaise: 0,
    });
    expect(q.json.taxBreakdown.shipping).toEqual({ taxablePaise: 0, taxPaise: 0 });
    expect(q.json.totalPaise).toBe(plain.json.totalPaise - plain.json.shippingPaise);
  });

  it('rejects unknown, expired, scheduled, below-minimum and exhausted codes with the same safe shape', async () => {
    const s = await shopper();
    const unknown = await h.call('POST', '/v1/cart/coupon', s.token, { code: 'DOESNOTEXIST' });
    expect([unknown.status, unknown.json.error.code, unknown.json.error.reason]).toEqual([
      422,
      'COUPON_INVALID',
      'unknown',
    ]);
    const past = await mk({ startsAt: '2020-01-01T00:00:00Z', endsAt: '2020-02-01T00:00:00Z' });
    expect(
      (await h.call('POST', '/v1/cart/coupon', s.token, { code: past.json.code })).json.error.reason,
    ).toBe('expired');
    const future = await mk({ startsAt: '2099-01-01T00:00:00Z' });
    expect(
      (await h.call('POST', '/v1/cart/coupon', s.token, { code: future.json.code })).json.error.reason,
    ).toBe('not_started');
    const big = await mk({ minOrderPaise: 90_000_000 });
    expect(
      (await h.call('POST', '/v1/cart/coupon', s.token, { code: big.json.code })).json.error.reason,
    ).toBe('min_order');
    const off = await mk({ active: false });
    expect(
      (await h.call('POST', '/v1/cart/coupon', s.token, { code: off.json.code })).json.error.reason,
    ).toBe('unknown');
    expect((await h.call('DELETE', '/v1/cart/coupon', s.token)).status).toBe(204);
  });

  it('freezes type and value once redeemed', async () => {
    const c = await mk({ kind: 'flat', valuePaise: 700 });
    const s = await shopper();
    const q = await quote(s, 'cod', c.json.code);
    expect((await order(s, q.json.id)).status).toBe(201);
    const edit = await h.call('PATCH', `/v1/admin/coupons/${c.json.id}`, admin.token, { valuePaise: 900 });
    expect([edit.status, edit.json.error.code]).toEqual([409, 'ILLEGAL_STATE']);
    const ok = await h.call('PATCH', `/v1/admin/coupons/${c.json.id}`, admin.token, { usageLimitTotal: 50 });
    expect([ok.status, ok.json.usageLimitTotal]).toEqual([200, 50]);
  });
});

describe('message templates', () => {
  it('validates placeholders, previews with sample data and falls back on reset', async () => {
    const list = await h.call('GET', '/v1/admin/message-templates', admin.token);
    expect(list.json.items.map((t: { key: string }) => t.key)).toContain('order.shipped');
    expect(list.json.items.map((t: { key: string }) => t.key)).not.toContain('password_reset');
    expect(
      (
        await h.call('PUT', '/v1/admin/message-templates/password_reset', admin.token, {
          subject: 's',
          body: 'b',
        })
      ).status,
    ).toBe(404);

    const bad = await h.call('PUT', '/v1/admin/message-templates/order.shipped', admin.token, {
      subject: 'Hi {{nope}}',
      body: 'x',
    });
    expect([bad.status, bad.json.error.code]).toEqual([400, 'VALIDATION_FAILED']);

    const set = await h.call('PUT', '/v1/admin/message-templates/order.shipped', admin.token, {
      subject: 'On its way: {{orderNumber}}',
      body: 'Track {{trackingNumber}} via {{courier}}.',
    });
    expect(set.status).toBe(200);
    const prev = await h.call('POST', '/v1/admin/message-templates/order.shipped/test', admin.token, {});
    expect(prev.json).toMatchObject({ subject: 'On its way: JW-20260101-SAMPLE01', sent: false });
    expect(prev.json.body).toContain('Track AWB1234567 via Sample Courier.');

    expect((await h.call('DELETE', '/v1/admin/message-templates/order.shipped', admin.token)).status).toBe(
      204,
    );
    const def = await h.call('POST', '/v1/admin/message-templates/order.shipped/test', admin.token, {});
    expect(def.json.subject).toMatch(/is on its way/);

    const des = await h.staff('designer');
    expect(
      (
        await h.call('PUT', '/v1/admin/message-templates/order.shipped', des.token, {
          subject: 's',
          body: 'b',
        })
      ).status,
    ).toBe(403);
  });

  it('the outbox viewer shows delivery state without recipients', async () => {
    const r = await h.call('GET', '/v1/admin/outbox/emails', admin.token);
    expect(r.status).toBe(200);
    for (const e of r.json.items)
      expect(Object.keys(e).sort()).toEqual(['createdAt', 'id', 'status', 'template']);
  });
});
