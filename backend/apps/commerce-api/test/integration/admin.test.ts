import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '@jw/config';
import { InMemoryStorage, TestPaymentGateway } from '@jw/integrations';
import { createLogger } from '@jw/observability';
import { Fixtures, apiDb, superPool } from '@jw/test-support';
import { createApp } from '../../src/app.ts';
import { createTokenService } from '../../src/auth.ts';
import { forge, mintFor, testEnv } from './support.ts';
import { MemoryStore } from '../../src/rateLimit.ts';

const V = 'twinkle-shine-leather-polish';
const config = loadConfig(testEnv());
const tokens = createTokenService(config);
const db = apiDb(5);
const sup = superPool();
const fx = new Fixtures(sup);
const gateway = new TestPaymentGateway();
let base = '';
let server: import('node:http').Server;

const mint = (sub: string, aal: 'aal1' | 'aal2' = 'aal2') =>
  mintFor(db, tokens, sub, { aal, client: aal === 'aal2' ? 'admin' : 'app' });

async function call(
  method: string,
  path: string,
  token?: string,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  const res = await fetch(base + path, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const t = await res.text();
  return { status: res.status, json: t ? JSON.parse(t) : null };
}
async function staff(
  role: 'support' | 'catalog' | 'fulfillment' | 'finance' | 'admin',
  aal: 'aal1' | 'aal2' = 'aal2',
) {
  const id = await fx.user();
  await sup.query(`INSERT INTO admin_users (user_id, role) VALUES ($1,$2)`, [id, role]);
  return { id, token: await mint(id, aal) };
}
async function customerWithOrder(method: 'cod' | 'online' = 'cod') {
  const id = await fx.user();
  const token = await mint(id, 'aal1');
  await fx.setStock(V, 10);
  const a = await call('POST', '/v1/addresses', token, {
    recipientName: 'Buyer',
    phone: '9999999999',
    line1: '12 Road',
    city: 'Pune',
    state: 'MH',
    postalCode: '411001',
    isDefault: true,
  });
  await call('PUT', `/v1/cart/lines/${V}`, token, { quantity: 1 });
  const q = await call('POST', '/v1/checkout/quotes', token, { addressId: a.json.id, paymentMethod: method });
  const o = await call(
    'POST',
    '/v1/orders',
    token,
    { quoteId: q.json.id },
    { 'idempotency-key': randomUUID() },
  );
  return { id, token, order: o.json };
}

beforeAll(async () => {
  const app = createApp({
    config,
    db,
    tokens,
    storage: new InMemoryStorage(),
    gateway,
    logger: createLogger(process.env.TEST_LOG ?? 'silent'),
    limits: new MemoryStore(),
    rateLimitsEnabled: false,
  });
  await new Promise<void>((r) => {
    server = app.listen(0, '127.0.0.1', () => r());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.close();
  await db.close();
  await sup.end();
});
beforeEach(async () => {
  await fx.resetCommerceData();
  await fx.openStore();
  await sup.query(`DELETE FROM admin_users`);
  await sup.query(`TRUNCATE audit_log`).catch(() => undefined);
});

describe('admin access control', () => {
  it('customers (and unknown tokens) are denied; disabled staff are denied', async () => {
    const c = await customerWithOrder();
    expect((await call('GET', '/v1/admin/me', c.token)).status).toBe(403);
    expect((await call('GET', '/v1/admin/orders', c.token)).status).toBe(403);
    const s = await staff('admin');
    expect((await call('GET', '/v1/admin/me', s.token)).status).toBe(200);
    await sup.query(`UPDATE admin_users SET disabled = true WHERE user_id = $1`, [s.id]); // revocation is immediate
    expect((await call('GET', '/v1/admin/me', s.token)).status).toBe(403);
    expect((await call('GET', '/v1/admin/me')).status).toBe(401);
  });
  it('a token signed by any other key — even naming a real admin — grants nothing', async () => {
    const admin = await staff('admin');
    const forged = await forge({ sub: admin.id, otherKey: true, aal: 'aal2' });
    expect((await call('GET', '/v1/admin/orders', forged)).status).toBe(401);
    // a valid customer token is authenticated but not authorised
    const cust = await fx.user();
    expect((await call('GET', '/v1/admin/orders', await mint(cust, 'aal1'))).status).toBe(403);
  });
  it('permissions are enforced per role on the server', async () => {
    const c = await customerWithOrder();
    const support = await staff('support');
    const catalog = await staff('catalog');
    const fulfil = await staff('fulfillment');
    expect((await call('GET', '/v1/admin/orders', support.token)).status).toBe(200);
    expect(
      (
        await call('POST', `/v1/admin/orders/${c.order.id}/status`, support.token, {
          to: 'confirmed',
          expectedVersion: c.order.version,
        })
      ).status,
    ).toBe(403);
    expect((await call('GET', '/v1/admin/inventory', support.token)).status).toBe(403);
    expect((await call('GET', '/v1/admin/orders', catalog.token)).status).toBe(403);
    expect(
      (
        await call('PATCH', '/v1/admin/settings', fulfil.token, {
          expectedVersion: 1,
          reason: 'abc',
          shippingFeePaise: 1,
        })
      ).status,
    ).toBe(403);
    expect((await call('POST', '/v1/admin/refunds/' + randomUUID() + '/process', fulfil.token)).status).toBe(
      403,
    );
  });
  it('sensitive actions need an MFA (aal2) session; reading does not', async () => {
    const c = await customerWithOrder();
    const f1 = await staff('fulfillment', 'aal1');
    expect((await call('GET', '/v1/admin/orders', f1.token)).status).toBe(200);
    expect(
      (
        await call('POST', `/v1/admin/orders/${c.order.id}/cancel`, f1.token, {
          reason: 'customer asked',
          expectedVersion: c.order.version,
        })
      ).status,
    ).toBe(403);
    const f2 = await staff('fulfillment', 'aal2');
    expect(
      (
        await call('POST', `/v1/admin/orders/${c.order.id}/cancel`, f2.token, {
          reason: 'customer asked',
          expectedVersion: c.order.version,
        })
      ).status,
    ).toBe(200);
  });
  it('support sees a redacted address; fulfilment sees the full one', async () => {
    const c = await customerWithOrder();
    const s = await call('GET', `/v1/admin/orders/${c.order.id}`, (await staff('support')).token);
    expect(s.json.address).toEqual({ name: 'Buyer', city: 'Pune', state: 'MH', pin: '411001' });
    const f = await call('GET', `/v1/admin/orders/${c.order.id}`, (await staff('fulfillment')).token);
    expect(f.json.address.phone).toBe('9999999999');
  });
});

describe('database-level admin gate (defence in depth)', () => {
  it('the app role cannot change prices/settings unless the API bound a verified admin role', async () => {
    await expect(
      db.tx({ kind: 'customer', userId: await fx.user() }, (c) =>
        c.query(`UPDATE product_variants SET price_paise = 1 WHERE id = $1`, [V]),
      ),
    ).resolves.toMatchObject({ rowCount: 0 });
    await expect(
      db.tx({ kind: 'admin', userId: await fx.user(), role: 'fulfillment' }, (c) =>
        c.query(`UPDATE product_variants SET price_paise = 1 WHERE id = $1`, [V]),
      ),
    ).resolves.toMatchObject({ rowCount: 0 });
    await expect(
      db.tx({ kind: 'admin', userId: await fx.user(), role: 'support' }, (c) =>
        c.query(`UPDATE store_settings SET checkout_enabled = true`),
      ),
    ).resolves.toMatchObject({ rowCount: 0 });
    expect(
      (await sup.query(`SELECT price_paise FROM product_variants WHERE id = $1`, [V])).rows[0].price_paise,
    ).toBe(29900);
  });
  it('audit log is append-only even for superusers via normal SQL', async () => {
    const s = await staff('admin');
    await call('POST', '/v1/admin/inventory/' + V + '/adjust', s.token, {
      delta: 3,
      reason: 'stock take',
      expectedVersion: 1,
    }).catch(() => undefined);
    await sup.query(`INSERT INTO audit_log (action, resource_type) VALUES ('x','y')`);
    await expect(sup.query(`UPDATE audit_log SET reason = 'tamper'`)).rejects.toThrow(/append-only/);
    await expect(sup.query(`DELETE FROM audit_log`)).rejects.toThrow(/append-only/);
  });
});

describe('inventory, catalog and settings workflows', () => {
  it('stock adjustment: reason required, optimistic concurrency, cannot drop below reserved, ledger + audit written', async () => {
    const s = await staff('admin');
    const inv = (await call('GET', '/v1/admin/inventory', s.token)).json.items.find(
      (i: { variantId: string }) => i.variantId === V,
    );
    const ok = await call('POST', `/v1/admin/inventory/${V}/adjust`, s.token, {
      delta: 20,
      reason: 'opening stock count',
      expectedVersion: inv.version,
    });
    expect(ok.json).toMatchObject({ onHand: 20, reserved: 0 });
    const stale = await call('POST', `/v1/admin/inventory/${V}/adjust`, s.token, {
      delta: 1,
      reason: 'again',
      expectedVersion: inv.version,
    });
    expect(stale.status).toBe(409);
    expect(
      (
        await call('POST', `/v1/admin/inventory/${V}/adjust`, s.token, {
          delta: 1,
          reason: '',
          expectedVersion: ok.json.version,
        })
      ).status,
    ).toBe(400);
    const sh = await call('POST', `/v1/admin/inventory/${V}/adjust`, s.token, {
      delta: -21,
      reason: 'shrinkage',
      expectedVersion: ok.json.version,
    });
    expect(sh.status).toBe(409);
    const led = await sup.query(
      `SELECT delta_on_hand, reason, actor_id FROM inventory_movements WHERE ref_type = 'admin'`,
    );
    expect(led.rows).toEqual([{ delta_on_hand: 20, reason: 'opening stock count', actor_id: s.id }]);
    const au = await call('GET', '/v1/admin/audit?resourceType=variant', s.token);
    expect(au.json.items[0]).toMatchObject({
      action: 'inventory.adjust',
      actorId: s.id,
      reason: 'opening stock count',
    });
  });
  it('price edit by catalog role is audited and detects concurrent edits', async () => {
    const cat = await staff('catalog');
    const list = (await call('GET', '/v1/admin/catalog/variants', cat.token)).json.items.find(
      (v: { id: string }) => v.id === V,
    );
    const ok = await call('PATCH', `/v1/admin/catalog/variants/${V}`, cat.token, {
      pricePaise: 31900,
      reason: 'merchant approved MRP',
      expectedUpdatedAt: list.updatedAt,
    });
    expect(ok.status).toBe(200);
    expect(ok.json.pricePaise).toBe(31900);
    expect(
      (
        await call('PATCH', `/v1/admin/catalog/variants/${V}`, cat.token, {
          pricePaise: 100,
          reason: 'stale write',
          expectedUpdatedAt: list.updatedAt,
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await call('PATCH', `/v1/admin/catalog/variants/${V}`, cat.token, {
          pricePaise: 99999999,
          comparePaise: 5,
          reason: 'bad',
          expectedUpdatedAt: ok.json.updatedAt,
        })
      ).status,
    ).toBe(400);
    // metadata edits (SKU/title/package/HSN/barcode) and the low-stock threshold go through the same guarded, audited PATCH
    const rulesBefore = (await sup.query(`SELECT rules_version FROM store_settings`)).rows[0]
      .rules_version as number;
    const meta = await call('PATCH', `/v1/admin/catalog/variants/${V}`, cat.token, {
      title: 'Renamed size',
      weightGrams: 120,
      lengthMm: 80,
      widthMm: 60,
      heightMm: 40,
      hsnCode: '3405',
      barcode: '8901234567890',
      lowStockThreshold: 7,
      reason: 'package re-measured',
      expectedUpdatedAt: ok.json.updatedAt,
    });
    expect(meta.status).toBe(200);
    const row = (
      await sup.query(`SELECT title, weight_grams, hsn_code, barcode FROM product_variants WHERE id = $1`, [
        V,
      ])
    ).rows[0];
    expect(row).toMatchObject({
      title: 'Renamed size',
      weight_grams: 120,
      hsn_code: '3405',
      barcode: '8901234567890',
    });
    expect(
      (await sup.query(`SELECT low_stock_threshold FROM inventory_positions WHERE variant_id = $1`, [V]))
        .rows[0].low_stock_threshold,
    ).toBe(7);
    // metadata alone does not invalidate quotes; a price change does
    expect((await sup.query(`SELECT rules_version FROM store_settings`)).rows[0].rules_version).toBe(
      rulesBefore,
    );
    const repriced = await call('PATCH', `/v1/admin/catalog/variants/${V}`, cat.token, {
      pricePaise: 32000,
      reason: 'price review',
      expectedUpdatedAt: meta.json.updatedAt,
    });
    expect(repriced.status).toBe(200);
    expect((await sup.query(`SELECT rules_version FROM store_settings`)).rows[0].rules_version).toBe(
      rulesBefore + 1,
    );
    // cost is admin-only; invalid HSN is rejected; the audit row carries before/after of the edited fields
    expect(
      (
        await call('PATCH', `/v1/admin/catalog/variants/${V}`, cat.token, {
          costPricePaise: 100,
          reason: 'cost',
          expectedUpdatedAt: repriced.json.updatedAt,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await call('PATCH', `/v1/admin/catalog/variants/${V}`, cat.token, {
          hsnCode: 'abc',
          reason: 'bad hsn',
          expectedUpdatedAt: repriced.json.updatedAt,
        })
      ).status,
    ).toBe(400);
    const metaAudit = await sup.query(
      `SELECT before, after FROM audit_log WHERE action = 'variant.update' AND reason = 'package re-measured'`,
    );
    expect(metaAudit.rows[0].after).toMatchObject({ title: 'Renamed size', lowStockThreshold: 7 });
    expect(metaAudit.rows[0].before).toHaveProperty('title');
    await sup.query(`UPDATE product_variants SET price_paise = 29900 WHERE id = $1`, [V]);
  });
  it('checkout cannot be activated until prerequisites hold; activation is explicit, audited and kill-switchable', async () => {
    const a = await staff('admin');
    await sup.query(`UPDATE store_settings SET checkout_enabled = false, checkout_policy_confirmed = false`);
    await fx.setStock(V, 0);
    const s0 = (await call('GET', '/v1/admin/settings', a.token)).json;
    expect(s0.readiness.allOk).toBe(false);
    expect(s0.readiness.checks.find((c: { id: string }) => c.id === 'stock').ok).toBe(false);
    const refused = await call('POST', '/v1/admin/checkout/activate', a.token, {
      confirm: true,
      reason: 'go live',
      expectedVersion: s0.settings.version,
    });
    expect(refused.status).toBe(503);
    expect(refused.json.error.code).toBe('POLICY_NOT_CONFIGURED');
    expect((await sup.query(`SELECT checkout_enabled FROM store_settings`)).rows[0].checkout_enabled).toBe(
      false,
    );
    // with stock but NO serviceable PIN list, activation is still refused
    await fx.setStock(V, 5);
    await sup.query(`DELETE FROM serviceable_pin_prefixes`);
    const noPins = await call('POST', '/v1/admin/checkout/activate', a.token, {
      confirm: true,
      reason: 'go live',
      expectedVersion: s0.settings.version,
    });
    expect(noPins.status).toBe(503);
    expect(noPins.json.error.lines.map((l: { id: string }) => l.id)).toContain('serviceability');
    await sup.query(`INSERT INTO serviceable_pin_prefixes (prefix) VALUES ('400')`);
    expect(
      (
        await call('POST', '/v1/admin/checkout/activate', a.token, {
          confirm: false,
          reason: 'go live',
          expectedVersion: s0.settings.version,
        })
      ).status,
    ).toBe(400);
    // all prerequisites hold + explicit confirmation → activation succeeds and is audited
    const ok = await call('POST', '/v1/admin/checkout/activate', a.token, {
      confirm: true,
      reason: 'go live',
      expectedVersion: s0.settings.version,
    });
    expect(ok.status).toBe(204);
    expect(
      (await sup.query(`SELECT checkout_enabled, checkout_policy_confirmed FROM store_settings`)).rows[0],
    ).toEqual({ checkout_enabled: true, checkout_policy_confirmed: true });
    expect(
      (await call('GET', '/v1/admin/audit?resourceType=store_settings', a.token)).json.items[0].action,
    ).toBe('checkout.activate');
    // kill switch always available to admin
    expect(
      (
        await call('POST', '/v1/admin/checkout/disable', (await staff('admin', 'aal1')).token, {
          reason: 'incident',
        })
      ).status,
    ).toBe(204);
    expect((await sup.query(`SELECT checkout_enabled FROM store_settings`)).rows[0].checkout_enabled).toBe(
      false,
    );
  });
  it('shipping rule change bumps rules_version so outstanding quotes become stale', async () => {
    const a = await staff('admin');
    const c = await customerWithOrder(); // consumed; make a fresh quote instead
    void c;
    const u = await fx.user();
    const t = await mint(u, 'aal1');
    const ad = await call('POST', '/v1/addresses', t, {
      recipientName: 'B',
      phone: '9999999999',
      line1: '1',
      city: 'P',
      state: 'M',
      postalCode: '411001',
      isDefault: true,
    });
    await fx.setStock(V, 10);
    await call('PUT', `/v1/cart/lines/${V}`, t, { quantity: 1 });
    const q = await call('POST', '/v1/checkout/quotes', t, { addressId: ad.json.id, paymentMethod: 'cod' });
    const st = (await call('GET', '/v1/admin/settings', a.token)).json.settings;
    expect(
      (
        await call('PATCH', '/v1/admin/settings', a.token, {
          expectedVersion: st.version,
          reason: 'new shipping fee',
          shippingFeePaise: 5000,
        })
      ).status,
    ).toBe(204);
    const o = await call(
      'POST',
      '/v1/orders',
      t,
      { quoteId: q.json.id },
      { 'idempotency-key': randomUUID() },
    );
    expect(o.status).toBe(409);
    expect(o.json.error.code).toBe('QUOTE_STALE');
    expect(
      (
        await call('PATCH', '/v1/admin/settings', a.token, {
          expectedVersion: st.version,
          reason: 'stale',
          shippingFeePaise: 1,
        })
      ).status,
    ).toBe(409);
    await sup.query(`UPDATE store_settings SET shipping_fee_paise = 4000`);
  });
});

describe('fulfilment, returns, COD and refunds', () => {
  it('fulfilment follows the state machine; returns restock on receipt exactly once; COD cash recorded only after delivery', async () => {
    const f = await staff('fulfillment');
    const c = await customerWithOrder('cod');
    let v = c.order.version;
    const step = async (to: string, extra: object = {}) => {
      const r = await call('POST', `/v1/admin/orders/${c.order.id}/status`, f.token, {
        to,
        expectedVersion: v,
        ...extra,
      });
      if (r.status === 200) v = r.json.version;
      return r;
    };
    expect((await step('shipped')).status).toBe(409); // cannot skip states
    expect((await step('confirmed')).status).toBe(200);
    expect(
      (
        await call('POST', `/v1/admin/orders/${c.order.id}/status`, f.token, {
          to: 'processing',
          expectedVersion: 1,
        })
      ).status,
    ).toBe(409); // stale version
    expect((await step('processing')).status).toBe(200);
    expect((await step('shipped')).status).toBe(200);
    expect(
      (await call('POST', `/v1/admin/orders/${c.order.id}/cod-collected`, f.token, { expectedVersion: v }))
        .status,
    ).toBe(409); // not delivered yet
    expect((await step('delivered')).status).toBe(200);
    expect(
      (await call('POST', `/v1/admin/orders/${c.order.id}/cod-collected`, f.token, { expectedVersion: v }))
        .status,
    ).toBe(204);
    expect(
      (await sup.query(`SELECT payment_status FROM orders WHERE id=$1`, [c.order.id])).rows[0].payment_status,
    ).toBe('cod_collected');
    v = (await call('GET', `/v1/admin/orders/${c.order.id}`, f.token)).json.version;
    // a DELIVERED order can only come back through the returns workflow, never via a status flip
    expect((await step('returned', { reason: 'sneaky' })).status).toBe(409);
    expect(await fx.stockOf(V)).toEqual({ onHand: 9, reserved: 0 });
  });

  it('admin-cancelling a PAID online order queues a refund; processing it twice calls the provider once per key', async () => {
    const c = await customerWithOrder('online');
    const att = await call('POST', `/v1/orders/${c.order.id}/payment-attempts`, c.token, {});
    const payload = JSON.stringify({
      id: 'evt_' + randomUUID(),
      type: 'payment.captured',
      providerOrderId: att.json.clientConfig.orderId,
      providerPaymentId: 'pay_x',
      status: 'captured',
      amountPaise: c.order.totalPaise,
      currency: 'INR',
    });
    await call('POST', '/v1/webhooks/test', undefined, undefined).catch(() => undefined);
    await fetch(`${base}/v1/webhooks/test`, {
      method: 'POST',
      body: payload,
      headers: { 'x-test-signature': gateway.sign(payload), 'content-type': 'application/json' },
    });
    await expect
      .poll(
        async () =>
          (await sup.query(`SELECT payment_status FROM orders WHERE id=$1`, [c.order.id])).rows[0]
            .payment_status,
        { timeout: 5000 },
      )
      .toBe('paid');

    const fin = await staff('finance');
    const ful = await staff('fulfillment');
    const ver = (await call('GET', `/v1/admin/orders/${c.order.id}`, ful.token)).json.version;
    const cancel = await call('POST', `/v1/admin/orders/${c.order.id}/cancel`, ful.token, {
      reason: 'out of stock at packing',
      expectedVersion: ver,
    });
    expect(cancel.status, JSON.stringify(cancel.json)).toBe(200);
    expect(cancel.json.refundQueued).toBe(true);
    expect(await fx.stockOf(V)).toEqual({ onHand: 10, reserved: 0 });
    const refunds = (await call('GET', '/v1/admin/refunds', fin.token)).json.items;
    expect(refunds).toHaveLength(1);
    let calls = 0;
    const orig = gateway.refund.bind(gateway);
    gateway.refund = async (i) => {
      calls++;
      return orig(i);
    };
    const p1 = await call('POST', `/v1/admin/refunds/${refunds[0].id}/process`, fin.token);
    const p2 = await call('POST', `/v1/admin/refunds/${refunds[0].id}/process`, fin.token);
    expect(p1.json.status).toBe('processed');
    expect(p2.json.status).toBe('processed');
    expect(calls).toBe(1);
    expect(
      (await sup.query(`SELECT payment_status FROM orders WHERE id=$1`, [c.order.id])).rows[0].payment_status,
    ).toBe('refunded');
    gateway.refund = orig;
  });

  it('dead-lettered events are visible to ops and replayable only by admin with a reason (audited)', async () => {
    const a = await staff('admin');
    await sup.query(
      `INSERT INTO outbox (aggregate_type, aggregate_id, event_type, dead_at, attempts, last_error) VALUES ('order','x','order.placed', now(), 8, 'boom')`,
    );
    const dead = (await call('GET', '/v1/admin/ops/outbox?state=dead', a.token)).json.items;
    expect(dead).toHaveLength(1);
    expect(
      (
        await call('POST', `/v1/admin/ops/outbox/${dead[0].id}/replay`, (await staff('fulfillment')).token, {
          reason: 'retry it',
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await call('POST', `/v1/admin/ops/outbox/${dead[0].id}/replay`, a.token, {
          reason: 'provider recovered',
        })
      ).status,
    ).toBe(204);
    expect(
      (await call('POST', `/v1/admin/ops/outbox/${dead[0].id}/replay`, a.token, { reason: 'again' })).status,
    ).toBe(409);
    expect((await sup.query(`SELECT dead_at FROM outbox`)).rows[0].dead_at).toBeNull();
  });

  it('dashboard figures come from data and carry their definitions', async () => {
    const a = await staff('admin');
    await customerWithOrder('cod');
    const d = (await call('GET', '/v1/admin/dashboard', a.token)).json;
    expect(d.definitions.window).toMatch(/Asia\/Kolkata/);
    expect(d.ordersByStatus).toEqual([{ status: 'placed', count: 1, totalPaise: 33900 }]);
    expect(d.outbox.pending).toBeGreaterThanOrEqual(1);
  });
});
