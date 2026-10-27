import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cmpVersion, inRollout } from '@jw/commerce-domain';
import { startHarness } from './harness.ts';

const V = 'twinkle-shine-leather-polish';
let h: Awaited<ReturnType<typeof startHarness>>;
let admin: { id: string; token: string };
let admin1: { id: string; token: string }; // no MFA

beforeAll(async () => {
  h = await startHarness();
  await h.fx.resetCommerceData();
  await h.fx.openStore({ cod_fee_paise: 2500 });
  admin = await h.staff('admin');
  admin1 = await h.staff('admin', 'aal1');
});
afterAll(async () => {
  await h.close();
});
const A = (path: string) => `/v1/admin${path}`;

describe('store pause', () => {
  it('refuses new orders with a clear message while paused and resumes cleanly', async () => {
    const s = await (async () => {
      const id = await h.fx.user();
      const token = await h.mint(id, 'aal1');
      await h.fx.setStock(V, 100);
      const a = await h.call('POST', '/v1/addresses', token, {
        recipientName: 'P Buyer',
        phone: '9999999999',
        line1: '1 Rd',
        city: 'Pune',
        state: 'Maharashtra',
        postalCode: '411001',
        isDefault: true,
      });
      await h.call('PUT', `/v1/cart/lines/${V}`, token, { quantity: 1 });
      return { token, addressId: a.json.id as string };
    })();
    const q = await h.call('POST', '/v1/checkout/quotes', s.token, {
      addressId: s.addressId,
      paymentMethod: 'cod',
    });
    expect(q.status).toBe(201);

    const paused = await h.call('PUT', A('/store-status'), admin1.token, {
      ordersPaused: true,
      pauseMessage: 'Back on Monday',
    });
    expect([paused.status, paused.json.ordersPaused, paused.json.checkoutOpen]).toEqual([200, true, false]);
    const blockedQuote = await h.call('POST', '/v1/checkout/quotes', s.token, {
      addressId: s.addressId,
      paymentMethod: 'cod',
    });
    expect([
      blockedQuote.status,
      blockedQuote.json.error.code,
      blockedQuote.json.error.message,
      blockedQuote.json.error.paused,
    ]).toEqual([503, 'CHECKOUT_DISABLED', 'Back on Monday', true]);
    // A quote taken before the pause cannot be turned into an order either.
    const blockedOrder = await h.call(
      'POST',
      '/v1/orders',
      s.token,
      { quoteId: q.json.id },
      { 'idempotency-key': randomUUID() },
    );
    expect([blockedOrder.status, blockedOrder.json.error.code]).toEqual([503, 'CHECKOUT_DISABLED']);

    const resumed = await h.call('PUT', A('/store-status'), admin1.token, { ordersPaused: false });
    expect([resumed.json.ordersPaused, resumed.json.checkoutOpen]).toEqual([false, true]);
    const ok = await h.call(
      'POST',
      '/v1/orders',
      s.token,
      { quoteId: q.json.id },
      { 'idempotency-key': randomUUID() },
    );
    expect(ok.status).toBe(201);
    const acts = await h.sup.query(
      `SELECT action FROM audit_log WHERE resource_type = 'store_settings' AND action LIKE 'store.%' ORDER BY id`,
    );
    expect(acts.rows.map((r) => r.action)).toEqual(['store.pause', 'store.resume']);
  });

  it('settings accept brand and support facts', async () => {
    const cur = (await h.call('GET', A('/settings'), admin.token)).json.settings;
    const r = await h.call('PATCH', A('/settings'), admin.token, {
      expectedVersion: cur.version,
      reason: 'support contact',
      brandName: 'JIMMY WAX',
      supportEmail: 'help@example.com',
      supportPhone: '+91 98000 00000',
    });
    expect(r.status).toBe(204);
    const after = (await h.call('GET', A('/settings'), admin.token)).json.settings;
    expect([after.brandName, after.supportEmail]).toEqual(['JIMMY WAX', 'help@example.com']);
  });
});

describe('customers', () => {
  it('lists masked, reveals only with an audited reason, edits notes and blocks with MFA', async () => {
    const o = await h.placeOrder('cod', V, 1);
    await h.sup.query(
      `UPDATE auth.users SET email = 'jane.doe@example.com', phone = '9876543210' WHERE id = $1`,
      [o.userId],
    );
    await h.sup.query(`UPDATE profiles SET full_name = '=cmd|calc' WHERE id = $1`, [o.userId]);

    const sup = await h.staff('support');
    const list = await h.call('GET', A('/customers?q=jane'), sup.token);
    expect(list.status).toBe(200);
    const row = list.json.items.find((c: { id: string }) => c.id === o.userId);
    expect(row).toMatchObject({ email: 'j*******@example.com', phone: '******3210', orders: 1 });
    expect(JSON.stringify(list.json)).not.toContain('jane.doe');
    // Staff accounts never appear in the customer list.
    expect(list.json.items.some((c: { id: string }) => c.id === admin.id)).toBe(false);

    const noReason = await h.call('POST', A(`/customers/${o.userId}/reveal`), sup.token, {});
    expect(noReason.status).toBe(400);
    const rev = await h.call('POST', A(`/customers/${o.userId}/reveal`), sup.token, {
      reason: 'Call about delivery',
    });
    expect(rev.json).toMatchObject({ email: 'jane.doe@example.com', phone: '9876543210' });
    expect(rev.json.addresses[0]).toMatchObject({ pin: '411001', city: 'Pune' });
    const aud = await h.sup.query(
      `SELECT actor_id, reason FROM audit_log WHERE action = 'customer.reveal' AND resource_id = $1`,
      [o.userId],
    );
    expect(aud.rows).toEqual([{ actor_id: sup.id, reason: 'Call about delivery' }]);

    const notes = await h.call('PATCH', A(`/customers/${o.userId}`), sup.token, {
      notes: 'Prefers evening calls',
      tags: ['VIP', 'vip', 'gift'],
    });
    expect([notes.status, notes.json.tags, notes.json.notes]).toEqual([
      200,
      ['vip', 'gift'],
      'Prefers evening calls',
    ]);

    // Block needs MFA; blocking revokes sessions and disables sign-in.
    const need = await h.call('POST', A(`/customers/${o.userId}/block`), admin1.token, {
      blocked: true,
      reason: 'Fraud ring',
    });
    expect([need.status, need.json.error.code]).toEqual([403, 'MFA_REQUIRED']);
    const blocked = await h.call('POST', A(`/customers/${o.userId}/block`), admin.token, {
      blocked: true,
      reason: 'Fraud ring',
    });
    expect([blocked.status, blocked.json.blocked, blocked.json.blockedReason]).toEqual([
      200,
      true,
      'Fraud ring',
    ]);
    expect(
      (await h.sup.query(`SELECT status FROM auth.users WHERE id = $1`, [o.userId])).rows[0].status,
    ).toBe('disabled');
    expect(
      (await h.call('GET', A('/customers?blocked=true'), sup.token)).json.items.map(
        (c: { id: string }) => c.id,
      ),
    ).toContain(o.userId);
    const un = await h.call('POST', A(`/customers/${o.userId}/block`), admin.token, {
      blocked: false,
      reason: 'Resolved',
    });
    expect(un.json.blocked).toBe(false);
    expect(
      (await h.sup.query(`SELECT status FROM auth.users WHERE id = $1`, [o.userId])).rows[0].status,
    ).toBe('active');
    const self = await h.call('POST', A(`/customers/${admin.id}/block`), admin.token, {
      blocked: true,
      reason: 'self',
    });
    expect([self.status, self.json.error.code]).toEqual([409, 'ILLEGAL_STATE']);
  });

  it('exports are permissioned, MFA-gated, audited and formula-safe', async () => {
    const sup = await h.staff('support');
    expect((await h.call('GET', A('/exports/customers.csv'), sup.token)).status).toBe(403);
    expect((await h.call('GET', A('/exports/customers.csv'), admin1.token)).json.error.code).toBe(
      'MFA_REQUIRED',
    );
    const r = await h.call('GET', A('/exports/customers.csv'), admin.token);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('text/csv');
    expect(r.text).toContain("'=cmd|calc");
    expect(r.text.split('\n').some((l) => l.startsWith('=') || l.includes(',=cmd'))).toBe(false);
    expect(
      (await h.sup.query(`SELECT 1 FROM audit_log WHERE action = 'customer.export'`)).rowCount,
    ).toBeGreaterThan(0);
  });
});

describe('orders extras', () => {
  it('notes, packing slip, resend confirmation and range export', async () => {
    const o = await h.placeOrder('cod', V, 2);
    const fin = await h.staff('finance');
    const n = await h.call('POST', A(`/orders/${o.order.id}/notes`), fin.token, {
      body: 'Customer asked for gift wrap',
    });
    expect([n.status, n.json.items[0].body, n.json.items[0].authorRole]).toEqual([
      201,
      'Customer asked for gift wrap',
      'finance',
    ]);
    expect((await h.call('GET', A(`/orders/${o.order.id}/notes`), admin.token)).json.items).toHaveLength(1);
    const des = await h.staff('designer');
    expect((await h.call('POST', A(`/orders/${o.order.id}/notes`), des.token, { body: 'x' })).status).toBe(
      403,
    );

    const ful = await h.staff('fulfillment');
    const slip = await h.call('GET', A(`/orders/${o.order.id}/packing-slip`), ful.token);
    expect(slip.json).toMatchObject({
      orderNumber: o.order.orderNumber,
      paymentMethod: 'cod',
      collectOnDeliveryPaise: o.order.totalPaise,
    });
    expect(slip.json.items[0]).toMatchObject({ quantity: 2 });
    expect(slip.json.shipTo.pin).toBe('411001');

    await h.sup.query(`UPDATE auth.users SET email = 'buyer@example.com' WHERE id = $1`, [o.userId]);
    const re = await h.call('POST', A(`/orders/${o.order.id}/resend-confirmation`), ful.token);
    expect([re.status, re.json.queued]).toEqual([202, true]);
    const q = await h.sup.query(
      `SELECT to_email, template FROM email_outbox WHERE template = 'order.placed' AND to_email = 'buyer@example.com'`,
    );
    expect(q.rowCount).toBe(1);

    const day = new Date().toISOString().slice(0, 10);
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    expect(
      (await h.call('GET', A(`/exports/orders.csv?from=${day}&to=${tomorrow}`), admin1.token)).json.error
        .code,
    ).toBe('MFA_REQUIRED');
    const csv = await h.call('GET', A(`/exports/orders.csv?from=${day}&to=${tomorrow}`), admin.token);
    expect(csv.text).toContain(o.order.orderNumber);
  });
});

describe('analytics', () => {
  it('sales totals reconcile with the orders table; definitions are returned; csv works', async () => {
    await h.fx.resetCommerceData();
    await h.fx.openStore({ cod_fee_paise: 2500 });
    const a = await h.placeOrder('cod', V, 1);
    const b = await h.placeOrder('cod', V, 3);
    const gone = await h.placeOrder('cod', V, 1);
    await h.sup.query(`UPDATE orders SET status = 'cancelled' WHERE id = $1`, [gone.order.id]);
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    const from = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

    const fin = await h.staff('finance');
    const s = await h.call('GET', A(`/analytics/sales?from=${from}&to=${tomorrow}`), fin.token);
    expect(s.status).toBe(200);
    expect(s.json.totals.orders).toBe(2);
    expect(s.json.totals.revenuePaise).toBe(a.order.totalPaise + b.order.totalPaise);
    expect(s.json.totals.aovPaise).toBe(Math.round((a.order.totalPaise + b.order.totalPaise) / 2));
    expect(s.json.definitions.sales).toMatch(/cancelled/i);
    expect(s.json.byPaymentMethod).toEqual([
      { method: 'cod', orders: 2, revenuePaise: a.order.totalPaise + b.order.totalPaise },
    ]);

    const p = await h.call('GET', A(`/analytics/products?from=${from}&to=${tomorrow}`), fin.token);
    expect(p.json.items[0]).toMatchObject({ productId: V, units: 4, orders: 2 });
    const g = await h.call('GET', A(`/analytics/gst?from=${from}&to=${tomorrow}`), fin.token);
    const taxSum = (await h.sup.query(`SELECT sum(tax_paise)::int t FROM orders WHERE status <> 'cancelled'`))
      .rows[0].t;
    expect(g.json.months.reduce((n: number, m: { gstPaise: number }) => n + m.gstPaise, 0)).toBe(taxSum);
    expect(g.json.months[0].taxablePaise + g.json.months[0].gstPaise).toBe(
      a.order.totalPaise + b.order.totalPaise,
    );
    // GSTR-1 working paper: reconciles with the same orders, shows IGST (no merchant GSTIN set) and exports offline-tool CSV
    const month = new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 7);
    const g1 = await h.call('GET', A(`/analytics/gstr1?month=${month}`), fin.token);
    expect(g1.status).toBe(200);
    expect(g1.json.orders).toBe(2);
    expect(
      g1.json.totals.taxablePaise +
        g1.json.totals.igstPaise +
        g1.json.totals.cgstPaise +
        g1.json.totals.sgstPaise,
    ).toBe(a.order.totalPaise + b.order.totalPaise);
    expect(g1.json.totals.igstPaise + g1.json.totals.cgstPaise + g1.json.totals.sgstPaise).toBe(taxSum);
    expect(g1.json.warnings.join(' ')).toMatch(/GSTIN is not set/);
    expect(g1.json.b2cs[0]).toMatchObject({ placeOfSupply: '27-Maharashtra', orders: 2 });
    const g1csv = await h.call('GET', A(`/analytics/gstr1?month=${month}&format=csv&table=hsn`), fin.token);
    expect(g1csv.text.split('\r\n')[0]).toContain('HSN,Description,UQC');
    expect((await h.call('GET', A('/analytics/gstr1?month=2026-13'), fin.token)).status).toBe(400);
    const geo = await h.call('GET', A(`/analytics/geo?from=${from}&to=${tomorrow}`), fin.token);
    expect(geo.json.byState[0]).toMatchObject({ state: 'Maharashtra', orders: 2 });
    for (const k of ['customers', 'shipping', 'returns'])
      expect((await h.call('GET', A(`/analytics/${k}?from=${from}&to=${tomorrow}`), fin.token)).status).toBe(
        200,
      );
    const csv = await h.call('GET', A(`/analytics/sales?from=${from}&to=${tomorrow}&format=csv`), fin.token);
    expect(csv.text.split('\n')[0]).toBe(
      'bucket,orders,subtotalPaise,discountPaise,shippingPaise,taxPaise,revenuePaise,aovPaise',
    );

    expect((await h.call('GET', A(`/analytics/sales?from=${tomorrow}&to=${from}`), fin.token)).status).toBe(
      400,
    );
    const des = await h.staff('designer');
    expect((await h.call('GET', A('/analytics/sales'), des.token)).status).toBe(403);
  });
});

describe('app versions and flags', () => {
  it('compares versions and classifies launch checks', async () => {
    expect([
      cmpVersion('1.2.0', '1.10.0'),
      cmpVersion('2.0.0', '2.0.0'),
      cmpVersion('3.0.1', '3.0.0'),
    ]).toEqual([-1, 0, 1]);
    const bad = await h.call('PUT', A('/app-versions/android'), admin.token, {
      latestVersion: '1.0.0',
      minSupportedVersion: '2.0.0',
    });
    expect([bad.status, bad.json.error.code]).toEqual([400, 'VALIDATION_FAILED']);
    const set = await h.call('PUT', A('/app-versions/android'), admin.token, {
      latestVersion: '1.4.0',
      minSupportedVersion: '1.2.0',
      storeUrl: 'https://play.google.com/store/apps/details?id=x',
      message: 'Please update',
    });
    expect(set.json).toMatchObject({ platform: 'android', latestVersion: '1.4.0' });
    expect(
      (
        await h.call('PUT', A('/app-versions/android'), admin.token, {
          latestVersion: '1.4.0',
          minSupportedVersion: '1.2.0',
          storeUrl: 'http://insecure',
        })
      ).status,
    ).toBe(400);
    expect(
      (await h.call('GET', A('/app-versions'), admin.token)).json.items.map(
        (v: { platform: string }) => v.platform,
      ),
    ).toEqual(['android', 'ios']);
    const { versionCheck } = await import('@jw/commerce-domain');
    const chk = (v: string) =>
      h.db.tx({ kind: 'anonymous' }, (c) => versionCheck(c, 'android', v)).then((r) => r.status);
    expect([await chk('1.1.9'), await chk('1.3.0'), await chk('1.4.0'), await chk('2.0.0')]).toEqual([
      'force_update',
      'update_available',
      'ok',
      'ok',
    ]);
  });

  it('flags are admin-managed, audited and roll out deterministically', async () => {
    const r = await h.call('PUT', A('/flags/new_home'), admin.token, {
      enabled: true,
      rolloutPercent: 50,
      description: 'New home',
    });
    expect(r.json).toMatchObject({ key: 'new_home', enabled: true, rolloutPercent: 50 });
    expect((await h.call('PUT', A('/flags/Bad Key'), admin.token, { enabled: true })).status).toBe(400);
    expect(
      (await h.call('PUT', A('/flags/new_home'), admin1.token, { enabled: false })).json.error.code,
    ).toBe('MFA_REQUIRED');
    const ids = Array.from({ length: 400 }, () => randomUUID());
    const on = ids.filter((i) => inRollout('new_home', i, 50)).length;
    expect(on).toBeGreaterThan(140);
    expect(on).toBeLessThan(260);
    expect(ids.every((i) => inRollout('new_home', i, 50) === inRollout('new_home', i, 50))).toBe(true);
    expect(ids.every((i) => inRollout('x', i, 100) && !inRollout('x', i, 0))).toBe(true);
    expect((await h.call('DELETE', A('/flags/new_home'), admin.token)).status).toBe(204);
    expect((await h.call('DELETE', A('/flags/new_home'), admin.token)).status).toBe(404);
  });
});

describe('integrations and health', () => {
  it('reports status without secrets and records honest test outcomes', async () => {
    const list = await h.call('GET', A('/integrations'), admin.token);
    expect(list.status).toBe(200);
    expect(list.json.items.map((i: { name: string }) => i.name)).toEqual([
      'razorpay',
      'sms',
      'smtp',
      'shipping',
      'storage',
      'maps',
    ]);
    expect(JSON.stringify(list.json)).not.toMatch(/secret|password|key_id|rzp_/i);
    const st = await h.call('POST', A('/integrations/storage/test'), admin.token);
    expect(st.json).toMatchObject({ name: 'storage', ok: true });
    const sm = await h.call('POST', A('/integrations/smtp/test'), admin.token);
    expect(sm.json.ok).toBe(false);
    expect(sm.json.detail).toMatch(/not configured/i);
    const sh = await h.call('POST', A('/integrations/shipping/test'), admin.token);
    expect([sh.json.ok, sh.json.detail]).toEqual([false, expect.stringMatching(/manual/i)]);
    const after = await h.call('GET', A('/integrations'), admin.token);
    expect(after.json.items.find((i: { name: string }) => i.name === 'storage').lastCheck).toMatchObject({
      ok: true,
    });
    const fin = await h.staff('finance');
    expect((await h.call('POST', A('/integrations/storage/test'), fin.token)).status).toBe(403);
  });

  it('health surfaces queue problems', async () => {
    const r = await h.call('GET', A('/health'), admin.token);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({
      outbox: { dead: expect.any(Number) },
      email: { failed: expect.any(Number) },
      provider: 'manual',
    });
    expect(Array.isArray(r.json.alerts)).toBe(true);
  });
});
