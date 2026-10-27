import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import sharp from 'sharp';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '@jw/config';
import { ConsoleEmailSender, InMemoryStorage, TestPaymentGateway } from '@jw/integrations';
import { createLogger } from '@jw/observability';
import { Fixtures, apiDb, experienceDb, superPool, workerDb } from '@jw/test-support';
import {
  claimOutbox,
  computeTax,
  deliver,
  markPublished,
  notifyHandler,
  sendDueEmails,
} from '@jw/commerce-domain';
import { createApp } from '../../src/app.ts';
import { createTokenService } from '../../src/auth.ts';
import { MemoryStore } from '../../src/rateLimit.ts';
import { createExperienceApp } from '../../../experience-api/src/app.ts';
import { mintFor, testEnv } from './support.ts';

const V = 'twinkle-shine-leather-polish';
const config = loadConfig(testEnv());
const tokens = createTokenService(config);
const db = apiDb(5);
const wdb = workerDb(3);
const edb = experienceDb(3);
const sup = superPool();
const fx = new Fixtures(sup);
const storage = new InMemoryStorage();
let api = '';
let exp = '';
const servers: import('node:http').Server[] = [];

beforeAll(async () => {
  const a = createApp({
    config,
    db,
    tokens,
    storage,
    gateway: new TestPaymentGateway(),
    logger: createLogger(process.env.TEST_LOG ?? 'silent'),
    limits: new MemoryStore(),
    rateLimitsEnabled: false,
  });
  const e = createExperienceApp({ db: edb, logger: createLogger('silent'), ttlMs: 1, storage });
  for (const [app, set] of [
    [a, (u: string) => (api = u)],
    [e, (u: string) => (exp = u)],
  ] as const) {
    await new Promise<void>((r) => {
      const s = app.listen(0, '127.0.0.1', () => {
        set(`http://127.0.0.1:${(s.address() as AddressInfo).port}`);
        r();
      });
      servers.push(s);
    });
  }
});
afterAll(async () => {
  servers.forEach((s) => s.close());
  await db.close();
  await wdb.close();
  await edb.close();
  await sup.end();
});
beforeEach(async () => {
  await fx.resetCommerceData();
  await fx.openStore();
  await sup.query(`DELETE FROM admin_users`);
  await sup.query(`TRUNCATE reviews, content_versions, content_pages RESTART IDENTITY CASCADE`);
});

async function call(
  base: string,
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
  let json: unknown = null;
  try {
    json = t ? JSON.parse(t) : null;
  } catch {
    json = t;
  }
  return { status: res.status, json: json as any, text: t, headers: res.headers };
}
const A = (m: string, p: string, t?: string, b?: unknown, h?: Record<string, string>) =>
  call(api, m, p, t, b, h);
const E = (p: string) => call(exp, 'GET', p);

async function staff(role: 'support' | 'catalog' | 'fulfillment' | 'finance' | 'admin') {
  const id = await fx.user();
  await sup.query(`INSERT INTO admin_users (user_id, role) VALUES ($1,$2)`, [id, role]);
  return { id, token: await mintFor(db, tokens, id, { aal: 'aal2', client: 'admin' }) };
}
const addr = {
  recipientName: 'Test Buyer',
  phone: '9999999999',
  line1: '12 Road',
  city: 'Pune',
  state: 'Maharashtra',
  postalCode: '411001',
  isDefault: true,
};

async function customer(pin = '411001') {
  const id = await fx.user();
  const token = await mintFor(db, tokens, id);
  const a = await A('POST', '/v1/addresses', token, { ...addr, postalCode: pin });
  return { id, token, addressId: a.json.id as string };
}
async function buy(c: { token: string; addressId: string }, method: 'cod' | 'online' = 'cod', qty = 1) {
  await A('PUT', `/v1/cart/lines/${V}`, c.token, { quantity: qty });
  const q = await A('POST', '/v1/checkout/quotes', c.token, {
    addressId: c.addressId,
    paymentMethod: method,
  });
  const o = await A(
    'POST',
    '/v1/orders',
    c.token,
    { quoteId: q.json.id },
    { 'idempotency-key': randomUUID() },
  );
  return { q: q.json, o: o.json, status: o.status };
}

async function pinGuard(token: string) {
  const current = (await A('GET', '/v1/admin/shipping/pins', token)).json;
  return { expectedEtag: current.etag as string, reason: 'test change' };
}

async function deliver_(adminToken: string, orderId: string) {
  const g = async () => (await A('GET', `/v1/admin/orders/${orderId}`, adminToken)).json;
  await A('POST', `/v1/admin/orders/${orderId}/status`, adminToken, {
    to: 'confirmed',
    expectedVersion: (await g()).version,
  });
  await A('POST', `/v1/admin/orders/${orderId}/status`, adminToken, {
    to: 'processing',
    expectedVersion: (await g()).version,
  });
  const sh = await A('POST', `/v1/admin/orders/${orderId}/shipments`, adminToken, {
    courier: 'Delhivery',
    trackingNumber: `AWB${Date.now()}${Math.floor(Math.random() * 1000)}`,
    trackingUrl: 'https://track.example.test/x',
  });
  await A('POST', `/v1/admin/shipments/${sh.json.id}/events`, adminToken, {
    status: 'in_transit',
    description: 'Left hub',
  });
  await A('POST', `/v1/admin/shipments/${sh.json.id}/events`, adminToken, {
    status: 'delivered',
    description: 'Delivered to customer',
  });
  return sh.json.id as string;
}

describe('GST 18% and the ₹25 COD fee', () => {
  it('COD adds exactly the fee; online does not; GST is included, never added; breakdown reconciles; order stores the same numbers', async () => {
    await fx.openStore({ cod_fee_paise: 2500 });
    await fx.setStock(V, 10);
    const c = await customer();
    await A('PUT', `/v1/cart/lines/${V}`, c.token, { quantity: 1 });
    const cod = (
      await A('POST', '/v1/checkout/quotes', c.token, { addressId: c.addressId, paymentMethod: 'cod' })
    ).json;
    const online = (
      await A('POST', '/v1/checkout/quotes', c.token, { addressId: c.addressId, paymentMethod: 'online' })
    ).json;
    expect(cod).toMatchObject({
      subtotalPaise: 29900,
      shippingPaise: 4000,
      codFeePaise: 2500,
      totalPaise: 36400,
      taxInclusive: true,
    });
    expect(online).toMatchObject({ codFeePaise: 0, totalPaise: 33900 });
    const expected = computeTax({
      lines: [{ key: V, amountPaise: 29900 }],
      shippingPaise: 4000,
      codFeePaise: 2500,
      rateBps: 1800,
      inclusive: true,
    });
    expect(cod.taxPaise).toBe(expected.totalTaxPaise);
    expect(cod.taxBreakdown.codFee).toEqual(expected.codFee);
    const placed = await A(
      'POST',
      '/v1/orders',
      c.token,
      { quoteId: cod.id },
      { 'idempotency-key': randomUUID() },
    );
    expect(placed.json).toMatchObject({
      totalPaise: 36400,
      codFeePaise: 2500,
      taxInclusive: true,
      paymentStatus: 'cod_due',
    });
    const row = (
      await sup.query(
        `SELECT total_paise, subtotal_paise, shipping_paise, cod_fee_paise FROM orders WHERE id=$1`,
        [placed.json.id],
      )
    ).rows[0];
    expect(row.total_paise).toBe(row.subtotal_paise + row.shipping_paise + row.cod_fee_paise);
  });

  it('free shipping above ₹2,000 still applies, COD fee still added; fee/GST changes invalidate old quotes', async () => {
    await fx.openStore({ cod_fee_paise: 2500 });
    await fx.setStock(V, 20);
    const c = await customer();
    await A('PUT', `/v1/cart/lines/${V}`, c.token, { quantity: 7 }); // 7 × 299 = 2093 ≥ 2000
    const q = (
      await A('POST', '/v1/checkout/quotes', c.token, { addressId: c.addressId, paymentMethod: 'cod' })
    ).json;
    expect(q).toMatchObject({
      subtotalPaise: 209300,
      shippingPaise: 0,
      codFeePaise: 2500,
      totalPaise: 211800,
    });
    const admin = await staff('admin');
    const st = (await A('GET', '/v1/admin/settings', admin.token)).json.settings;
    expect(st).toMatchObject({ codFeePaise: 2500, gstRateBps: 1800, taxInclusive: true });
    expect(
      (
        await A('PATCH', '/v1/admin/settings', admin.token, {
          expectedVersion: st.version,
          reason: 'raise COD fee',
          codFeePaise: 3000,
        })
      ).status,
    ).toBe(204);
    const o = await A('POST', '/v1/orders', c.token, { quoteId: q.id }, { 'idempotency-key': randomUUID() });
    expect(o.status).toBe(409);
    expect(o.json.error.code).toBe('QUOTE_STALE');
  });

  it('public store policy shows the COD fee and GST basis', async () => {
    await fx.openStore({ cod_fee_paise: 2500 });
    const s = (await E('/v1/store-settings')).json;
    expect(s).toMatchObject({ codFeePaise: 2500, gstRateBps: 1800, taxInclusive: true });
  });
});

describe('serviceable PIN codes (merchant-managed)', () => {
  it('empty list ⇒ not configured; list present ⇒ only matching prefixes are deliverable', async () => {
    await fx.setStock(V, 5);
    await sup.query(`DELETE FROM serviceable_pin_prefixes`);
    const c = await customer('411001');
    await A('PUT', `/v1/cart/lines/${V}`, c.token, { quantity: 1 });
    const none = await A('POST', '/v1/checkout/quotes', c.token, {
      addressId: c.addressId,
      paymentMethod: 'cod',
    });
    expect([none.status, none.json.error.code]).toEqual([503, 'POLICY_NOT_CONFIGURED']);
    const admin = await staff('admin');
    expect(
      (
        await A('PUT', '/v1/admin/shipping/pins', admin.token, {
          add: ['400'],
          note: 'Mumbai',
          ...(await pinGuard(admin.token)),
        })
      ).status,
    ).toBe(204);
    const out = await A('POST', '/v1/checkout/quotes', c.token, {
      addressId: c.addressId,
      paymentMethod: 'cod',
    });
    expect([out.status, out.json.error.code]).toEqual([422, 'NOT_SERVICEABLE']);
    await A('PUT', '/v1/admin/shipping/pins', admin.token, {
      add: ['411'],
      ...(await pinGuard(admin.token)),
    });
    expect(
      (await A('POST', '/v1/checkout/quotes', c.token, { addressId: c.addressId, paymentMethod: 'cod' }))
        .status,
    ).toBe(201);
    expect(
      (
        await A('PUT', '/v1/admin/shipping/pins', admin.token, {
          add: ['12'],
          ...(await pinGuard(admin.token)),
        })
      ).status,
    ).toBe(400);
    // guarded writes: a stale list fingerprint is refused, a missing reason is a 400
    const stale = await A('PUT', '/v1/admin/shipping/pins', admin.token, {
      add: ['413'],
      expectedEtag: '0'.repeat(64),
      reason: 'stale write',
    });
    expect([stale.status, stale.json.error.code]).toEqual([409, 'CART_VERSION_CONFLICT']);
    expect(
      (
        await A('PUT', '/v1/admin/shipping/pins', admin.token, {
          add: ['413'],
          expectedEtag: (await A('GET', '/v1/admin/shipping/pins', admin.token)).json.etag,
        })
      ).status,
    ).toBe(400);
  });
});

describe('shipments, tracking, invoices and returns', () => {
  it('shipment flow drives order status; customer sees merchant-entered tracking; shipping requires "processing"', async () => {
    await fx.setStock(V, 10);
    const c = await customer();
    const admin = await staff('fulfillment');
    const { o } = await buy(c);
    const early = await A('POST', `/v1/admin/orders/${o.id}/shipments`, admin.token, {
      courier: 'Delhivery',
      trackingNumber: 'AWB123456',
    });
    expect(early.status).toBe(409); // placed, not processing
    const shId = await deliver_(admin.token, o.id);
    const order = (await A('GET', `/v1/orders/${o.id}`, c.token)).json;
    expect(order.status).toBe('delivered');
    const tr = (await A('GET', `/v1/orders/${o.id}/shipments`, c.token)).json.items;
    expect(tr).toHaveLength(1);
    expect(tr[0]).toMatchObject({ id: shId, courier: 'Delhivery', status: 'delivered' });
    expect(tr[0].events.map((e: { status: string }) => e.status)).toEqual([
      'label_created',
      'in_transit',
      'delivered',
    ]);
    // closed shipments accept no more events; other customers cannot see tracking
    expect(
      (await A('POST', `/v1/admin/shipments/${shId}/events`, admin.token, { status: 'in_transit' })).status,
    ).toBe(409);
    const other = await customer();
    expect((await A('GET', `/v1/orders/${o.id}/shipments`, other.token)).status).toBe(404);
  });

  it('GST invoice: refused until seller GST details exist; then issued once, consecutive per FY, intra-state CGST+SGST, escaped HTML', async () => {
    await fx.openStore({ cod_fee_paise: 2500 });
    await fx.setStock(V, 10);
    const c = await customer();
    const admin = await staff('admin');
    const { o } = await buy(c, 'cod', 2);
    await deliver_(admin.token, o.id);
    expect((await A('GET', `/v1/orders/${o.id}/invoice`, c.token)).json.error.code).toBe(
      'POLICY_NOT_CONFIGURED',
    );

    const st = (await A('GET', '/v1/admin/settings', admin.token)).json.settings;
    const bad = await A('PATCH', '/v1/admin/settings', admin.token, {
      expectedVersion: st.version,
      reason: 'gst profile',
      merchantGstin: 'NOT-A-GSTIN',
    });
    expect(bad.status).toBe(400);
    expect(
      (
        await A('PATCH', '/v1/admin/settings', admin.token, {
          expectedVersion: st.version,
          reason: 'gst profile',
          merchantGstin: '27AAPFU0939F1ZV',
          merchantLegalName: 'JIMMY <WAX> & Co',
          merchantState: 'Maharashtra',
          merchantAddress: '1 Shop Road, Mumbai',
        })
      ).status,
    ).toBe(204);

    const inv = (await A('GET', `/v1/orders/${o.id}/invoice`, c.token)).json;
    expect(inv.invoiceNumber).toMatch(/^JW\/\d{4}-\d{2}\/000001$/);
    expect(inv.supply).toBe('intra_state');
    expect(inv.totals.igstPaise).toBe(0);
    expect(inv.totals.cgstPaise + inv.totals.sgstPaise).toBe(inv.totals.gstPaise);
    expect(inv.totals.taxablePaise + inv.totals.gstPaise).toBe(inv.totals.grandTotalPaise);
    expect(inv.totals.grandTotalPaise).toBe(o.totalPaise);
    expect((await A('GET', `/v1/orders/${o.id}/invoice`, c.token)).json.invoiceNumber).toBe(
      inv.invoiceNumber,
    ); // idempotent
    const html = await A('GET', `/v1/orders/${o.id}/invoice.html`, c.token);
    expect(html.text).toContain('JIMMY &lt;WAX&gt; &amp; Co');
    expect(html.text).not.toContain('<WAX>');
    expect(html.headers.get('content-security-policy')).toContain("default-src 'none'");
    // a second order gets the NEXT number; invoices are immutable
    const c2 = await customer('400001');
    const b2 = await buy(c2);
    await deliver_(admin.token, b2.o.id);
    expect((await A('GET', `/v1/orders/${b2.o.id}/invoice`, c2.token)).json.invoiceNumber).toMatch(/000002$/);
    await expect(sup.query(`UPDATE invoices SET invoice_number = 'X'`)).rejects.toThrow(/immutable/);
    // inter-state buyer → IGST
    const c3 = await customer();
    await sup.query(`UPDATE addresses SET state = 'Karnataka' WHERE id = $1`, [c3.addressId]);
    const b3 = await buy(c3);
    await deliver_(admin.token, b3.o.id);
    const i3 = (await A('GET', `/v1/orders/${b3.o.id}/invoice`, c3.token)).json;
    expect(i3.supply).toBe('inter_state');
    expect(i3.totals.igstPaise).toBe(i3.totals.gstPaise);
    expect(i3.totals.cgstPaise).toBe(0);
  });

  it('returns: window must be configured; partial returns restock on receipt exactly once; order closes when fully returned; no over-return', async () => {
    await fx.setStock(V, 10);
    const c = await customer();
    const admin = await staff('admin');
    const { o } = await buy(c, 'cod', 2);
    await deliver_(admin.token, o.id);
    const item = (await sup.query(`SELECT id FROM order_items WHERE order_id=$1`, [o.id])).rows[0]
      .id as number;
    const ask = (qty: number) =>
      A('POST', `/v1/orders/${o.id}/returns`, c.token, {
        reason: 'Not suitable for my shoes',
        items: [{ orderItemId: Number(item), quantity: qty }],
      });
    expect((await ask(1)).json.error.code).toBe('POLICY_NOT_CONFIGURED'); // return window unset

    const st = (await A('GET', '/v1/admin/settings', admin.token)).json.settings;
    await A('PATCH', '/v1/admin/settings', admin.token, {
      expectedVersion: st.version,
      reason: 'return policy',
      returnWindowDays: 7,
    });
    expect((await ask(3)).status).toBe(400); // more than bought
    const r1 = await ask(1);
    expect(r1.status).toBe(201);
    expect((await ask(1)).status).toBe(409); // one open return at a time
    expect((await A('POST', `/v1/admin/returns/${r1.json.id}/receive`, admin.token)).status).toBe(409); // not approved yet
    expect(
      (
        await A('POST', `/v1/admin/returns/${r1.json.id}/decide`, admin.token, {
          approve: true,
          note: 'ok, send it back',
        })
      ).status,
    ).toBe(204);
    const stockBefore = (await fx.stockOf(V)).onHand;
    const rec = await A('POST', `/v1/admin/returns/${r1.json.id}/receive`, admin.token);
    expect(rec.json).toMatchObject({
      status: 'received',
      refundValuePaise: 29900,
      refundQueued: false,
      manualRefundRequired: true,
    });
    expect((await fx.stockOf(V)).onHand).toBe(stockBefore + 1);
    expect((await A('POST', `/v1/admin/returns/${r1.json.id}/receive`, admin.token)).status).toBe(409); // never restocks twice
    expect((await fx.stockOf(V)).onHand).toBe(stockBefore + 1);
    expect((await A('GET', `/v1/orders/${o.id}`, c.token)).json.status).toBe('delivered'); // partial

    const r2 = await ask(1);
    expect(r2.status).toBe(201);
    expect((await ask(1)).status).toBe(400); // nothing left to return
    await A('POST', `/v1/admin/returns/${r2.json.id}/decide`, admin.token, {
      approve: true,
      note: 'second unit ok',
    });
    await A('POST', `/v1/admin/returns/${r2.json.id}/receive`, admin.token);
    expect((await A('GET', `/v1/orders/${o.id}`, c.token)).json.status).toBe('returned');
    expect((await fx.stockOf(V)).onHand).toBe(stockBefore + 2);
    const mine = (await A('GET', `/v1/orders/${o.id}/returns`, c.token)).json.items;
    expect(mine).toHaveLength(2);
    // a stranger cannot return someone else's order
    const other = await customer();
    expect(
      (
        await A('POST', `/v1/orders/${o.id}/returns`, other.token, {
          reason: 'abc def',
          items: [{ orderItemId: Number(item), quantity: 1 }],
        })
      ).status,
    ).toBe(404);
  });

  it('a paid ONLINE order return queues a line-value refund for finance (idempotent)', async () => {
    await fx.openStore({ return_window_days: 7 });
    await fx.setStock(V, 10);
    const c = await customer();
    const admin = await staff('admin');
    const { o } = await buy(c, 'online', 1);
    const att = await A('POST', `/v1/orders/${o.id}/payment-attempts`, c.token, {});
    const payload = JSON.stringify({
      id: 'evt_' + randomUUID(),
      type: 'payment.captured',
      providerOrderId: att.json.clientConfig.orderId,
      providerPaymentId: 'pay_r',
      status: 'captured',
      amountPaise: o.totalPaise,
      currency: 'INR',
    });
    const gw = new TestPaymentGateway();
    await fetch(`${api}/v1/webhooks/test`, {
      method: 'POST',
      body: payload,
      headers: { 'x-test-signature': gw.sign(payload), 'content-type': 'application/json' },
    });
    await expect
      .poll(
        async () =>
          (await sup.query(`SELECT payment_status FROM orders WHERE id=$1`, [o.id])).rows[0].payment_status,
        { timeout: 5000 },
      )
      .toBe('paid');
    await deliver_(admin.token, o.id);
    const item = (await sup.query(`SELECT id FROM order_items WHERE order_id=$1`, [o.id])).rows[0]
      .id as number;
    const r = await A('POST', `/v1/orders/${o.id}/returns`, c.token, {
      reason: 'Changed my mind',
      items: [{ orderItemId: Number(item), quantity: 1 }],
    });
    await A('POST', `/v1/admin/returns/${r.json.id}/decide`, admin.token, {
      approve: true,
      note: 'approved',
    });
    const rec = await A('POST', `/v1/admin/returns/${r.json.id}/receive`, admin.token);
    expect(rec.json).toMatchObject({
      refundQueued: true,
      refundValuePaise: 29900,
      manualRefundRequired: false,
    });
    const refunds = (await sup.query(`SELECT amount_paise, reason FROM refunds WHERE order_id=$1`, [o.id]))
      .rows;
    expect(refunds).toEqual([{ amount_paise: 29900, reason: 'customer_return' }]); // delivery fee not refunded automatically
  });
});

describe('reviews with photos and moderation', () => {
  const jpeg = () =>
    sharp({ create: { width: 40, height: 30, channels: 3, background: '#d33' } })
      .jpeg()
      .toBuffer();

  it('only verified purchasers review; photos are sanitised, quarantined, then published only on approval', async () => {
    await fx.setStock(V, 10);
    const c = await customer();
    const admin = await staff('admin');
    const body = { rating: 5, title: 'Lovely shine', body: 'Worked great on my brown shoes.' };
    expect((await A('POST', `/v1/products/${V}/reviews`, c.token, body)).status).toBe(409); // not delivered yet
    const { o } = await buy(c);
    await deliver_(admin.token, o.id);
    const rv = await A('POST', `/v1/products/${V}/reviews`, c.token, body);
    expect(rv.status).toBe(201);
    expect((await A('POST', `/v1/products/${V}/reviews`, c.token, body)).status).toBe(409); // one per product

    // upload validation: type is sniffed from bytes, not trusted from the header
    const post = (buf: Buffer, ct = 'image/jpeg') =>
      fetch(`${api}/v1/reviews/${rv.json.id}/photos`, {
        method: 'POST',
        headers: { authorization: `Bearer ${c.token}`, 'content-type': ct },
        body: new Uint8Array(buf),
      });
    expect((await post(Buffer.from('<?php echo 1; ?>'.repeat(10)))).status).toBe(400);
    expect((await post(Buffer.from('GIF89a'.padEnd(64, 'x')))).status).toBe(400);
    const original = await sharp({ create: { width: 40, height: 30, channels: 3, background: '#d33' } })
      .withExif({ IFD0: { Copyright: 'SECRET-OWNER' } })
      .jpeg()
      .toBuffer();
    expect(original.includes(Buffer.from('SECRET-OWNER'))).toBe(true);
    const up = await post(original);
    expect(up.status).toBe(201);
    const media = (await up.json()) as { id: string };
    const stored = [...storage.objects.entries()].find(([k]) => k.startsWith('review-private/'));
    expect(stored![1].includes(Buffer.from('SECRET-OWNER'))).toBe(false); // EXIF stripped by re-encode
    expect(stored![1].subarray(8, 12).toString('ascii')).toBe('WEBP');
    expect([...storage.objects.keys()].some((k) => k.startsWith('review-public/'))).toBe(false); // nothing public yet

    // pending content is invisible publicly
    expect((await E(`/v1/products/${V}/reviews`)).json.items).toHaveLength(0);
    expect((await call(exp, 'GET', `/v1/media/reviews/${media.id}`)).status).toBe(404);
    // the author sees their own pending photo; another customer does not
    expect((await call(api, 'GET', `/v1/reviews/${rv.json.id}/photos/${media.id}`, c.token)).status).toBe(
      200,
    );
    const other = await customer();
    expect((await call(api, 'GET', `/v1/reviews/${rv.json.id}/photos/${media.id}`, other.token)).status).toBe(
      404,
    );

    // moderation needs the right role
    const fulfil = await staff('fulfillment');
    expect(
      (await A('POST', `/v1/admin/reviews/${rv.json.id}/moderate`, fulfil.token, { approve: true })).status,
    ).toBe(403);
    const queue = (await A('GET', '/v1/admin/reviews?status=pending', admin.token)).json.items;
    expect(queue[0]).toMatchObject({ id: rv.json.id, verifiedPurchase: true });
    expect(queue[0].photos).toHaveLength(1);
    expect(
      (
        await A('POST', `/v1/admin/reviews/${rv.json.id}/moderate`, admin.token, {
          approve: true,
          note: 'good',
        })
      ).status,
    ).toBe(204);
    expect((await E(`/v1/products/${V}/reviews`)).json.items[0].photos).toEqual([]); // review approved, photo still pending
    expect(
      (await A('POST', `/v1/admin/review-media/${media.id}/moderate`, admin.token, { approve: true })).status,
    ).toBe(204);
    expect(
      (await A('POST', `/v1/admin/review-media/${media.id}/moderate`, admin.token, { approve: true })).status,
    ).toBe(409);
    const pub = (await E(`/v1/products/${V}/reviews`)).json.items[0];
    expect(pub.photos).toHaveLength(1);
    const img = await call(exp, 'GET', pub.photos[0].url);
    expect(img.status).toBe(200);
    expect(img.headers.get('content-type')).toBe('image/webp');
    expect(img.headers.get('cache-control')).toContain('immutable');
    expect(JSON.stringify(pub)).not.toMatch(/user/i);
  });

  it('rejecting a review hides it and its photos', async () => {
    await fx.setStock(V, 10);
    const c = await customer();
    const admin = await staff('admin');
    const { o } = await buy(c);
    await deliver_(admin.token, o.id);
    const rv = await A('POST', `/v1/products/${V}/reviews`, c.token, {
      rating: 1,
      title: 'Spam',
      body: 'buy cheap stuff at spam.example',
    });
    await fetch(`${api}/v1/reviews/${rv.json.id}/photos`, {
      method: 'POST',
      headers: { authorization: `Bearer ${c.token}`, 'content-type': 'image/jpeg' },
      body: new Uint8Array(await jpeg()),
    });
    await A('POST', `/v1/admin/reviews/${rv.json.id}/moderate`, admin.token, {
      approve: false,
      note: 'spam',
    });
    expect((await E(`/v1/products/${V}/reviews`)).json.items).toHaveLength(0);
    expect((await sup.query(`SELECT status FROM review_media`)).rows[0].status).toBe('rejected');
    const mine = (await A('GET', '/v1/me/reviews', c.token)).json.items[0];
    expect(mine).toMatchObject({ status: 'rejected', moderationNote: 'spam' });
  });
});

describe('transactional email + in-app notifications', () => {
  it('phone-only customers receive an inbox event without an invalid email job', async () => {
    await fx.setStock(V, 10);
    const c = await customer();
    await sup.query('UPDATE auth.users SET phone = $2, email = NULL WHERE id = $1', [c.id, '+919899999991']);
    await buy(c);
    const rows = await claimOutbox(wdb, 'phone-only-test', 50);
    for (const row of rows) {
      await deliver(wdb, 'notifications', row, notifyHandler);
      await markPublished(wdb, row.id);
    }
    expect((await A('GET', '/v1/notifications', c.token)).json.items).toHaveLength(1);
    expect((await sup.query('SELECT count(*)::int AS n FROM email_outbox')).rows[0].n).toBe(0);
  });
  async function pump() {
    const rows = await claimOutbox(wdb, 'test', 50);
    for (const r of rows) {
      await deliver(wdb, 'notifications', r, notifyHandler);
      await markPublished(wdb, r.id);
    }
  }

  it('order events create an in-app notification and ONE email; redelivery and sending never duplicate; tokens are redacted after sending', async () => {
    await fx.setStock(V, 10);
    const c = await customer();
    const me = (await sup.query(`SELECT email FROM auth.users WHERE id = $1`, [c.id])).rows[0]
      .email as string;
    await buy(c);
    await pump();
    await pump();
    const mails = (
      await sup.query(`SELECT template, to_email, status FROM email_outbox WHERE to_email = $1`, [me])
    ).rows;
    expect(mails).toEqual([{ template: 'order.placed', to_email: me, status: 'pending' }]);
    const sender = new ConsoleEmailSender();
    expect(await sendDueEmails(wdb, sender)).toBe(1);
    expect(await sendDueEmails(wdb, sender)).toBe(0);
    expect(sender.sent).toHaveLength(1);
    expect(sender.sent[0]!.subject).toMatch(/^Order JW-\d{8}-[0-9A-F]{8} received$/);
    expect(sender.sent[0]!.text).toContain('Cash on Delivery');
    expect(
      (await sup.query(`SELECT payload FROM email_outbox WHERE to_email = $1`, [me])).rows[0].payload,
    ).toEqual({ redacted: true });
    const notes = (await A('GET', '/v1/notifications', c.token)).json.items;
    expect(notes).toHaveLength(1);
    expect((await A('POST', `/v1/notifications/${notes[0].id}/read`, c.token)).status).toBe(204);
    expect((await A('GET', '/v1/notifications', c.token)).json.items[0].read).toBe(true);
  });

  it('customers who switched off order updates get neither notification nor email; failed sends retry with backoff', async () => {
    await fx.setStock(V, 10);
    const c = await customer();
    await A('PUT', '/v1/me/preferences', c.token, { orderUpdates: false, offersAndCareTips: false });
    await buy(c);
    await pump();
    expect((await sup.query(`SELECT count(*)::int n FROM email_outbox`)).rows[0].n).toBe(0);
    expect((await A('GET', '/v1/notifications', c.token)).json.items).toHaveLength(0);

    await sup.query(
      `INSERT INTO email_outbox (to_email, template, payload) VALUES ('x@example.test','order.placed','{"orderNumber":"JW-1","totalPaise":100,"paymentMethod":"cod"}')`,
    );
    const failing = {
      name: 'boom',
      send: async () => {
        throw new Error('smtp down');
      },
    };
    expect(await sendDueEmails(wdb, failing)).toBe(0);
    const row = (
      await sup.query(
        `SELECT status, attempts, last_error, available_at > now() AS delayed FROM email_outbox`,
      )
    ).rows[0];
    expect(row).toMatchObject({ status: 'pending', attempts: 1, delayed: true });
    expect(row.last_error).toContain('smtp down');
  });
});

describe('devices and published content', () => {
  it('device tokens belong to one account at a time', async () => {
    const a = await customer();
    const b = await customer();
    const token = 'fcm-token-' + 'x'.repeat(40);
    expect((await A('POST', '/v1/devices', a.token, { platform: 'android', token })).status).toBe(204);
    expect((await A('POST', '/v1/devices', b.token, { platform: 'android', token })).status).toBe(204); // phone changed hands
    const owners = (await sup.query(`SELECT user_id FROM device_tokens WHERE token = $1`, [token])).rows;
    expect(owners).toEqual([{ user_id: b.id }]);
    expect((await A('DELETE', `/v1/devices/${token}`, a.token)).status).toBe(204); // cannot remove someone else's
    expect((await sup.query(`SELECT count(*)::int n FROM device_tokens`)).rows[0].n).toBe(1);
    expect((await A('DELETE', `/v1/devices/${token}`, b.token)).status).toBe(204);
  });

  it('policy pages are versioned drafts until published; the public API serves only the published version', async () => {
    const admin = await staff('catalog');
    const save = (title: string, bodyMd: string, expectedVersion?: number) =>
      A('PUT', '/v1/admin/content/privacy-policy', admin.token, {
        kind: 'policy',
        title,
        bodyMd,
        ...(expectedVersion ? { expectedVersion } : {}),
      });
    expect((await save('Privacy Policy', '# v1')).json).toMatchObject({ version: 1 });
    expect((await E('/v1/content/privacy-policy')).status).toBe(404); // draft is private
    expect((await A('POST', '/v1/admin/content/privacy-policy/publish', admin.token)).status).toBe(204);
    expect((await E('/v1/content/privacy-policy')).json).toMatchObject({
      title: 'Privacy Policy',
      bodyMd: '# v1',
      version: 1,
    });
    expect((await save('Privacy Policy', '# v2', 1)).json.version).toBe(2);
    expect((await save('Privacy Policy', '# stale', 1)).status).toBe(409); // concurrent edit detected
    expect(
      (await sup.query(`SELECT count(*)::int n FROM content_versions WHERE slug = 'privacy-policy'`)).rows[0]
        .n,
    ).toBe(2);
    expect((await E('/v1/content')).json.items.map((x: { slug: string }) => x.slug)).toEqual([
      'privacy-policy',
    ]);
    const home = (await E('/v1/home')).json;
    expect(home.categories.length).toBeGreaterThan(0);
    expect(home.products).toHaveLength(4);
    expect(home.store).toMatchObject({ currency: 'INR' });
  });
});
