import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '@jw/config';
import { InMemoryStorage, TestPaymentGateway } from '@jw/integrations';
import { createLogger } from '@jw/observability';
import { Fixtures, apiDb, superPool, workerDb } from '@jw/test-support';
import { expireReservations } from '@jw/commerce-domain';
import { createApp } from '../../src/app.ts';
import { createTokenService } from '../../src/auth.ts';
import { forge, mintFor, testEnv } from './support.ts';
import { MemoryStore } from '../../src/rateLimit.ts';

const V = 'twinkle-shine-leather-polish';
const config = loadConfig(testEnv());
const tokens = createTokenService(config);

const db = apiDb(2); // deliberately tiny pool: forces connection reuse across users
const sup = superPool();
const fx = new Fixtures(sup);
const gateway = new TestPaymentGateway();
let base = '';
let server: import('node:http').Server;

const mint = (sub: string, over: { exp?: string; aud?: string; iss?: string; otherKey?: boolean } = {}) =>
  Object.keys(over).length ? forge({ sub, ...over }) : mintFor(db, tokens, sub);

async function call(
  method: string,
  path: string,
  opts: { token?: string; body?: unknown; headers?: Record<string, string>; raw?: string } = {},
) {
  const res = await fetch(base + path, {
    method,
    headers: {
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
      ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(opts.headers ?? {}),
    },
    body: opts.raw ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined),
  });
  const text = await res.text();
  return { status: res.status, headers: res.headers, json: text ? JSON.parse(text) : null };
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
});

const addr = {
  recipientName: 'A B',
  phone: '9999999999',
  line1: '1 Road',
  city: 'Pune',
  state: 'MH',
  postalCode: '411001',
  isDefault: true,
};

async function customer() {
  const id = await fx.user();
  return { id, token: await mint(id) };
}

describe('authentication', () => {
  it('rejects missing, forged, expired, wrong-audience, wrong-issuer and alg=none tokens', async () => {
    const id = await fx.user();
    expect((await call('GET', '/v1/cart')).status).toBe(401);
    expect((await call('GET', '/v1/cart', { token: await mint(id, { otherKey: true }) })).status).toBe(401);
    expect((await call('GET', '/v1/cart', { token: await mint(id, { exp: '-1m' }) })).status).toBe(401);
    expect((await call('GET', '/v1/cart', { token: await mint(id, { aud: 'other' }) })).status).toBe(401);
    expect((await call('GET', '/v1/cart', { token: await mint(id, { iss: 'https://evil/' }) })).status).toBe(
      401,
    );
    const none = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(JSON.stringify({ sub: id, aud: 'jimmywax-api', iss: 'jimmywax', exp: 9999999999 })).toString('base64url')}.`;
    expect((await call('GET', '/v1/cart', { token: none })).status).toBe(401);
    expect((await call('GET', '/v1/cart', { token: await mint(id) })).status).toBe(200);
  });
  it('a client-supplied role/userId can never grant access to another account', async () => {
    const a = await customer();
    const b = await customer();
    const res = await call('GET', `/v1/orders?userId=${b.id}`, {
      token: a.token,
      headers: { 'x-user-id': b.id },
    });
    expect(res.status).toBe(200);
    expect(res.json.items).toEqual([]);
  });
  it('error bodies have stable code, request id, retryable flag', async () => {
    const r = await call('POST', '/v1/addresses', {
      token: (await customer()).token,
      body: { line1: '' },
      headers: { 'x-request-id': 'req-12345678' },
    });
    expect(r.status).toBe(400);
    expect(r.json.error).toMatchObject({
      code: 'VALIDATION_FAILED',
      requestId: 'req-12345678',
      retryable: false,
    });
    expect(Object.keys(r.json.error.fields)).toContain('recipientName');
  });
});

describe('ownership / IDOR', () => {
  it('another customer cannot read, cancel, pay, edit or delete my resources', async () => {
    const a = await customer();
    const b = await customer();
    await fx.setStock(V, 5);
    const created = await call('POST', '/v1/addresses', { token: a.token, body: addr });
    expect(created.status).toBe(201);
    await call('PUT', `/v1/cart/lines/${V}`, { token: a.token, body: { quantity: 1 } });
    const q = await call('POST', '/v1/checkout/quotes', {
      token: a.token,
      body: { addressId: created.json.id, paymentMethod: 'online' },
    });
    expect(q.status).toBe(201);
    const o = await call('POST', '/v1/orders', {
      token: a.token,
      body: { quoteId: q.json.id },
      headers: { 'idempotency-key': randomUUID() },
    });
    expect(o.status).toBe(201);

    for (const [m, p, body] of [
      ['GET', `/v1/orders/${o.json.id}`, undefined],
      ['POST', `/v1/orders/${o.json.id}/cancel`, { reason: 'x' }],
      ['POST', `/v1/orders/${o.json.id}/payment-attempts`, {}],
      ['GET', `/v1/orders/${o.json.id}/payment`, undefined],
      ['PUT', `/v1/addresses/${created.json.id}`, addr],
      ['DELETE', `/v1/addresses/${created.json.id}`, undefined],
    ] as const) {
      const r = await call(m, p, { token: b.token, body });
      expect(r.status, `${m} ${p}`).toBe(404);
    }
    // B cannot quote against A's address nor consume A's quote
    expect(
      (
        await call('POST', '/v1/checkout/quotes', {
          token: b.token,
          body: { addressId: created.json.id, paymentMethod: 'cod' },
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await call('POST', '/v1/orders', {
          token: b.token,
          body: { quoteId: q.json.id },
          headers: { 'idempotency-key': randomUUID() },
        })
      ).status,
    ).toBe(404);
    // A still owns everything
    expect((await call('GET', `/v1/orders/${o.json.id}`, { token: a.token })).status).toBe(200);
  });

  it('identity never leaks across pooled connections (pool=2, 60 interleaved requests, 6 users)', async () => {
    const users = await Promise.all(Array.from({ length: 6 }, () => customer()));
    await Promise.all(
      users.map((u, i) =>
        call('POST', '/v1/addresses', { token: u.token, body: { ...addr, recipientName: `User ${i}` } }),
      ),
    );
    const results = await Promise.all(
      Array.from({ length: 60 }, async (_, n) => {
        const i = n % 6;
        const r = await call('GET', '/v1/addresses', { token: users[i]!.token });
        return { i, names: r.json.items.map((x: { recipientName: string }) => x.recipientName) };
      }),
    );
    for (const r of results) expect(r.names).toEqual([`User ${r.i}`]);
  });

  it('without a bound actor the app database role sees ZERO customer rows (RLS defence in depth)', async () => {
    const a = await customer();
    await call('POST', '/v1/addresses', { token: a.token, body: addr });
    for (const t of ['addresses', 'carts', 'orders', 'checkout_quotes', 'notifications', 'profiles']) {
      const r = await db.tx({ kind: 'anonymous' }, (c) => c.query(`SELECT count(*)::int n FROM ${t}`));
      expect(r.rows[0].n, t).toBe(0);
    }
    // and the setting does not survive the transaction on the pooled connection
    const leak = await db.pool.query(`SELECT current_setting('app.actor_id', true) AS a`);
    expect(leak.rows[0].a === null || leak.rows[0].a === '').toBe(true);
  });

  it('the app role cannot touch tables it does not own (least privilege)', async () => {
    // column grant exists for the admin path, but RLS (admin gate) turns an unbound update into a no-op
    expect((await db.pool.query(`UPDATE store_settings SET checkout_enabled = true`)).rowCount).toBe(0);
    await expect(
      db.pool.query(
        `UPDATE store_settings SET checkout_policy_confirmed = true, cod_enabled = true, version = 99`,
      ),
    ).resolves.toMatchObject({ rowCount: 0 });
    await expect(db.pool.query(`DELETE FROM store_settings`)).rejects.toThrow(/permission denied/);
    await expect(db.pool.query(`DELETE FROM audit_log`)).rejects.toThrow(/permission denied/);
    await expect(db.pool.query(`UPDATE invoices SET invoice_number = 'x'`)).rejects.toThrow(
      /permission denied/,
    );
    await expect(db.pool.query(`UPDATE audit_log SET reason = 'x'`)).rejects.toThrow(/permission denied/);
  });
});

describe('journeys over HTTP', () => {
  it('guest cart → sign-in → deterministic merge → COD checkout → idempotent replay → history', async () => {
    await fx.setStock(V, 10);
    const g = await call('POST', '/v1/guest-carts');
    expect(g.status).toBe(201);
    const gt = g.json.guestCartToken as string;
    await call('PUT', `/v1/guest-cart/lines/${V}`, {
      body: { quantity: 2 },
      headers: { 'x-guest-cart-token': gt },
    });
    expect(
      (await call('GET', '/v1/guest-cart', { headers: { 'x-guest-cart-token': 'z'.repeat(43) } })).status,
    ).toBe(404);

    const u = await customer();
    await call('PUT', `/v1/cart/lines/${V}`, { token: u.token, body: { quantity: 1 } });
    const merged = await call('POST', '/v1/cart/merge', { token: u.token, body: { guestCartToken: gt } });
    expect(merged.json.lines).toMatchObject([{ variantId: V, quantity: 3 }]); // min(99, 1 + 2)
    expect((await call('GET', '/v1/guest-cart', { headers: { 'x-guest-cart-token': gt } })).status).toBe(404); // consumed

    const a = await call('POST', '/v1/addresses', { token: u.token, body: addr });
    const q = await call('POST', '/v1/checkout/quotes', {
      token: u.token,
      body: { addressId: a.json.id, paymentMethod: 'cod' },
    });
    expect(q.json).toMatchObject({
      subtotalPaise: 89700,
      shippingPaise: 4000,
      totalPaise: 93700,
      stockReserved: false,
    });
    const key = randomUUID();
    const o1 = await call('POST', '/v1/orders', {
      token: u.token,
      body: { quoteId: q.json.id },
      headers: { 'idempotency-key': key },
    });
    const o2 = await call('POST', '/v1/orders', {
      token: u.token,
      body: { quoteId: q.json.id },
      headers: { 'idempotency-key': key },
    });
    expect(o1.status).toBe(201);
    expect(o2.headers.get('idempotent-replayed')).toBe('true');
    expect(o2.json).toEqual(o1.json);
    expect((await call('POST', '/v1/orders', { token: u.token, body: { quoteId: q.json.id } })).status).toBe(
      400,
    ); // key required
    const hist = await call('GET', '/v1/orders?limit=1', { token: u.token });
    expect(hist.json.items).toHaveLength(1);
    expect(hist.json.items[0]).toMatchObject({ id: o1.json.id, status: 'placed', paymentStatus: 'cod_due' });
    expect((await call('GET', '/v1/orders?cursor=garbage', { token: u.token })).status).toBe(400);
  });

  it('online: attempt → forged webhook rejected → signed webhook marks paid; client never decides', async () => {
    await fx.setStock(V, 5);
    const u = await customer();
    const a = await call('POST', '/v1/addresses', { token: u.token, body: addr });
    await call('PUT', `/v1/cart/lines/${V}`, { token: u.token, body: { quantity: 1 } });
    const q = await call('POST', '/v1/checkout/quotes', {
      token: u.token,
      body: { addressId: a.json.id, paymentMethod: 'online' },
    });
    const o = await call('POST', '/v1/orders', {
      token: u.token,
      body: { quoteId: q.json.id },
      headers: { 'idempotency-key': randomUUID() },
    });
    expect(o.json).toMatchObject({ status: 'pending_payment', paymentStatus: 'pending' });
    const att = await call('POST', `/v1/orders/${o.json.id}/payment-attempts`, { token: u.token, body: {} });
    expect(att.status).toBe(201);
    const providerOrderId = att.json.clientConfig.orderId as string;

    const payload = JSON.stringify({
      id: 'evt_' + randomUUID(),
      type: 'payment.captured',
      providerOrderId,
      providerPaymentId: 'pay_1',
      status: 'captured',
      amountPaise: o.json.totalPaise,
      currency: 'INR',
    });
    const forged = await call('POST', '/v1/webhooks/test', {
      raw: payload,
      headers: { 'x-test-signature': 'bad', 'content-type': 'application/json' },
    });
    expect(forged.status).toBe(401);
    expect(
      (await call('GET', `/v1/orders/${o.json.id}/payment`, { token: u.token })).json.paymentStatus,
    ).toBe('pending');

    const good = await call('POST', '/v1/webhooks/test', {
      raw: payload,
      headers: { 'x-test-signature': gateway.sign(payload), 'content-type': 'application/json' },
    });
    expect(good.status).toBe(200);
    await expect
      .poll(
        async () =>
          (await call('GET', `/v1/orders/${o.json.id}/payment`, { token: u.token })).json.paymentStatus,
        { timeout: 5000 },
      )
      .toBe('paid');
    const again = await call('POST', '/v1/webhooks/test', {
      raw: payload,
      headers: { 'x-test-signature': gateway.sign(payload), 'content-type': 'application/json' },
    });
    expect(again.json.duplicate).toBe(true);
  });

  it('online: SDK callback confirm needs a valid signature and the provider saying paid; never trusts the client', async () => {
    await fx.setStock(V, 5);
    const u = await customer();
    const other = await customer();
    const a = await call('POST', '/v1/addresses', { token: u.token, body: addr });
    await call('PUT', `/v1/cart/lines/${V}`, { token: u.token, body: { quantity: 1 } });
    const q = await call('POST', '/v1/checkout/quotes', {
      token: u.token,
      body: { addressId: a.json.id, paymentMethod: 'online' },
    });
    const o = await call('POST', '/v1/orders', {
      token: u.token,
      body: { quoteId: q.json.id },
      headers: { 'idempotency-key': randomUUID() },
    });
    const att = await call('POST', `/v1/orders/${o.json.id}/payment-attempts`, { token: u.token, body: {} });
    const providerOrderId = att.json.clientConfig.orderId as string;
    const url = `/v1/orders/${o.json.id}/payment-attempts/confirm`;
    const body = (sig: string) => ({ providerOrderId, providerPaymentId: 'pay_cb_1', signature: sig });

    // forged signature
    expect((await call('POST', url, { token: u.token, body: body('f'.repeat(64)) })).status).toBe(401);
    // another customer cannot confirm someone else's order
    expect(
      (
        await call('POST', url, {
          token: other.token,
          body: body(gateway.signCheckout(providerOrderId, 'pay_cb_1')),
        })
      ).status,
    ).toBe(404);
    // a valid signature while the provider still says "created" does not mark anything paid
    const good = body(gateway.signCheckout(providerOrderId, 'pay_cb_1'));
    const early = await call('POST', url, { token: u.token, body: good });
    expect(early.status).toBe(200);
    expect(early.json.paymentStatus).toBe('pending');
    // provider reports the order paid -> confirmed; repeating is harmless
    gateway.orders.get(providerOrderId)!.status = 'captured';
    const done = await call('POST', url, { token: u.token, body: good });
    expect(done.json).toMatchObject({
      paymentStatus: 'paid',
      orderStatus: 'placed',
      attemptStatus: 'captured',
    });
    const again = await call('POST', url, { token: u.token, body: good });
    expect(again.json.paymentStatus).toBe('paid');
    expect(
      (await call('GET', `/v1/orders/${o.json.id}/payment`, { token: u.token })).json.paymentStatus,
    ).toBe('paid');
  });

  it('online: hosted checkout return verifies server-side and redirects to the website; forged or failed returns never mark paid', async () => {
    await fx.setStock(V, 5);
    const u = await customer();
    const a = await call('POST', '/v1/addresses', { token: u.token, body: addr });
    await call('PUT', `/v1/cart/lines/${V}`, { token: u.token, body: { quantity: 1 } });
    const q = await call('POST', '/v1/checkout/quotes', {
      token: u.token,
      body: { addressId: a.json.id, paymentMethod: 'online' },
    });
    const o = await call('POST', '/v1/orders', {
      token: u.token,
      body: { quoteId: q.json.id },
      headers: { 'idempotency-key': randomUUID() },
    });
    const att = await call('POST', `/v1/orders/${o.json.id}/payment-attempts`, { token: u.token, body: {} });
    expect(att.json.clientConfig).toMatchObject({ keyId: 'test_key' });
    // resuming returns the same provider order with the public key id (the page can be reopened after leaving)
    const resumed = await call('POST', `/v1/orders/${o.json.id}/payment-attempts`, {
      token: u.token,
      body: {},
    });
    expect(resumed.json.clientConfig).toEqual(att.json.clientConfig);
    const providerOrderId = att.json.clientConfig.orderId as string;
    const post = (fields: Record<string, string>) =>
      fetch(`${base}/v1/payments/test/return`, {
        method: 'POST',
        redirect: 'manual',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(fields).toString(),
      });

    const forged = await post({
      razorpay_order_id: providerOrderId,
      razorpay_payment_id: 'pay_r1',
      razorpay_signature: 'f'.repeat(64),
    });
    expect(forged.status).toBe(303);
    expect(forged.headers.get('location')).toContain('pay=failed');
    const cancelled = await post({
      'error[code]': 'BAD_REQUEST_ERROR',
      'error[metadata]': JSON.stringify({ order_id: providerOrderId }),
    });
    expect(cancelled.headers.get('location')).toContain(`/orders/${o.json.id}?pay=failed`);
    expect(
      (await call('GET', `/v1/orders/${o.json.id}/payment`, { token: u.token })).json.paymentStatus,
    ).toBe('pending');

    const sig = gateway.signCheckout(providerOrderId, 'pay_r1');
    const early = await post({
      razorpay_order_id: providerOrderId,
      razorpay_payment_id: 'pay_r1',
      razorpay_signature: sig,
    });
    expect(early.headers.get('location')).toContain(`/orders/${o.json.id}?pay=pending`);
    gateway.orders.get(providerOrderId)!.status = 'captured';
    const ok = await post({
      razorpay_order_id: providerOrderId,
      razorpay_payment_id: 'pay_r1',
      razorpay_signature: sig,
    });
    expect(ok.headers.get('location')).toContain(`/orders/${o.json.id}?pay=paid&placed=1`);
    expect(
      (await call('GET', `/v1/orders/${o.json.id}/payment`, { token: u.token })).json.paymentStatus,
    ).toBe('paid');
    expect(
      (
        await post({
          razorpay_order_id: 'order_unknown',
          razorpay_payment_id: 'pay_x',
          razorpay_signature: sig,
        })
      ).status,
    ).toBe(303);
    expect((await fetch(`${base}/v1/payments/other/return`, { method: 'POST' })).status).toBe(404);
  });

  it('online: app hand-off link is signed, short-lived and renders the provider form from our own data; app returns never redirect to the website', async () => {
    await fx.setStock(V, 5);
    const u = await customer();
    const other = await customer();
    const a = await call('POST', '/v1/addresses', { token: u.token, body: addr });
    await call('PUT', `/v1/cart/lines/${V}`, { token: u.token, body: { quantity: 1 } });
    const q = await call('POST', '/v1/checkout/quotes', {
      token: u.token,
      body: { addressId: a.json.id, paymentMethod: 'online' },
    });
    const o = await call('POST', '/v1/orders', {
      token: u.token,
      body: { quoteId: q.json.id },
      headers: { 'idempotency-key': randomUUID() },
    });
    expect(
      (await call('POST', `/v1/orders/${o.json.id}/payment-link`, { token: other.token, body: {} })).status,
    ).toBe(404);
    const link = await call('POST', `/v1/orders/${o.json.id}/payment-link`, { token: u.token, body: {} });
    expect(link.status).toBe(201);
    expect(link.json.attempt.clientConfig.orderId).toBeTruthy();
    const url = new URL(link.json.url);
    const page = await fetch(url);
    expect(page.status).toBe(200);
    expect(page.headers.get('content-security-policy')).toContain('form-action https://api.razorpay.com');
    const html = await page.text();
    expect(html).toContain(`name="order_id" value="${link.json.attempt.clientConfig.orderId}"`);
    expect(html).toContain('callback_url');
    expect(html).toContain('/v1/payments/test/return?c=app');
    // tampered, malformed and expired tokens are refused with no order data
    const t = url.searchParams.get('t')!;
    expect((await fetch(`${url.origin}${url.pathname}?t=${t.slice(0, -1)}0`)).status).toBe(410);
    expect((await fetch(`${url.origin}${url.pathname}?t=nope`)).status).toBe(410);
    expect((await fetch(`${url.origin}/v1/payments/other/start?t=${t}`)).status).toBe(404);
    // app return: no website redirect, a plain page (APP_RETURN_URL is not configured in this test)
    const providerOrderId = link.json.attempt.clientConfig.orderId as string;
    gateway.orders.get(providerOrderId)!.status = 'captured';
    const ret = await fetch(`${base}/v1/payments/test/return?c=app`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        razorpay_order_id: providerOrderId,
        razorpay_payment_id: 'pay_app1',
        razorpay_signature: gateway.signCheckout(providerOrderId, 'pay_app1'),
      }).toString(),
    });
    expect(ret.status).toBe(200);
    expect(await ret.text()).toContain('Payment received');
    expect(
      (await call('GET', `/v1/orders/${o.json.id}/payment`, { token: u.token })).json.paymentStatus,
    ).toBe('paid');
    // once paid the link no longer renders a payable form
    expect((await fetch(url)).status).toBe(410);
  });

  it('payment attempt after the window ends is refused; expiry then releases stock', async () => {
    await fx.setStock(V, 5);
    const u = await customer();
    const a = await call('POST', '/v1/addresses', { token: u.token, body: addr });
    await call('PUT', `/v1/cart/lines/${V}`, { token: u.token, body: { quantity: 2 } });
    const q = await call('POST', '/v1/checkout/quotes', {
      token: u.token,
      body: { addressId: a.json.id, paymentMethod: 'online' },
    });
    const o = await call('POST', '/v1/orders', {
      token: u.token,
      body: { quoteId: q.json.id },
      headers: { 'idempotency-key': randomUUID() },
    });
    await sup.query(`UPDATE stock_reservations SET expires_at = now() - interval '1 second'`);
    const late = await call('POST', `/v1/orders/${o.json.id}/payment-attempts`, { token: u.token, body: {} });
    expect(late.status).toBe(409);
    const w = workerDb(2);
    await expireReservations(w);
    await w.close();
    expect(await fx.stockOf(V)).toEqual({ onHand: 5, reserved: 0 });
  });

  it('wishlist add/remove is idempotent and paginated', async () => {
    const u = await customer();
    for (let i = 0; i < 2; i++)
      expect((await call('PUT', `/v1/wishlist/${V}`, { token: u.token })).status).toBe(204);
    expect((await call('PUT', '/v1/wishlist/polish-cloth-kit', { token: u.token })).status).toBe(204);
    expect((await call('PUT', '/v1/wishlist/nope', { token: u.token })).status).toBe(404);
    const p1 = await call('GET', '/v1/wishlist?limit=1', { token: u.token });
    expect(p1.json.items).toHaveLength(1);
    const p2 = await call('GET', `/v1/wishlist?limit=1&cursor=${p1.json.nextCursor}`, { token: u.token });
    expect(p2.json.items[0].productId).not.toBe(p1.json.items[0].productId);
    expect(p2.json.nextCursor).toBeNull();
    expect((await call('DELETE', `/v1/wishlist/${V}`, { token: u.token })).status).toBe(204);
    expect((await call('DELETE', `/v1/wishlist/${V}`, { token: u.token })).status).toBe(204);
  });
});

describe('abuse controls', () => {
  it('oversized and malformed bodies are rejected with stable codes', async () => {
    const u = await customer();
    const big = await call('POST', '/v1/addresses', {
      token: u.token,
      raw: JSON.stringify({ x: 'a'.repeat(40_000) }),
      headers: { 'content-type': 'application/json' },
    });
    expect(big.status).toBe(413);
    const bad = await call('POST', '/v1/addresses', {
      token: u.token,
      raw: '{oops',
      headers: { 'content-type': 'application/json' },
    });
    expect(bad.status).toBe(400);
  });
  it('rate limits are bucketed: exhausting checkout does not affect browsing', async () => {
    const app = createApp({
      config,
      db,
      tokens,
      storage: new InMemoryStorage(),
      gateway,
      logger: createLogger(process.env.TEST_LOG ?? 'silent'),
      limits: new MemoryStore(),
      rateLimitsEnabled: true,
    });
    const s = await new Promise<import('node:http').Server>((r) => {
      const x = app.listen(0, '127.0.0.1', () => r(x));
    });
    const b = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
    const u = await customer();
    const h = { authorization: `Bearer ${u.token}`, 'content-type': 'application/json' };
    let limited = 0;
    for (let i = 0; i < 40; i++) {
      const r = await fetch(`${b}/v1/checkout/quotes`, {
        method: 'POST',
        headers: h,
        body: JSON.stringify({ addressId: randomUUID(), paymentMethod: 'cod' }),
      });
      if (r.status === 429) limited++;
    }
    expect(limited).toBeGreaterThan(0);
    expect((await fetch(`${b}/v1/cart`, { headers: h })).status).toBe(200);
    s.close();
  });
  it('health endpoints are unauthenticated and metrics expose no PII', async () => {
    expect((await call('GET', '/healthz')).status).toBe(200);
    expect((await call('GET', '/readyz')).status).toBe(200);
    const m = await fetch(`${base}/metrics`);
    const t = await m.text();
    expect(t).toContain('http_request_duration_seconds');
    expect(t).not.toMatch(/example\.test|Bearer/);
  });
});
