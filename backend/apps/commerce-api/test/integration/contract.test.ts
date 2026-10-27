import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '@jw/config';
import { InMemoryStorage, TestPaymentGateway } from '@jw/integrations';
import { createLogger } from '@jw/observability';
import { Fixtures, apiDb, conforms, experienceDb, specSha256, superPool } from '@jw/test-support';
import { createApp } from '../../src/app.ts';
import { createTokenService } from '../../src/auth.ts';
import { mintFor, testEnv } from './support.ts';
import { createExperienceApp } from '../../../experience-api/src/app.ts';
import { MemoryStore } from '../../src/rateLimit.ts';

const V = 'twinkle-shine-leather-polish';
const config = loadConfig(testEnv());
const tokens = createTokenService(config);
const db = apiDb(4);
const edb = experienceDb();
const sup = superPool();
const fx = new Fixtures(sup);
let api = '';
let exp = '';
const servers: import('node:http').Server[] = [];

beforeAll(async () => {
  await fx.resetCommerceData();
  await fx.openStore();
  const a = createApp({
    config,
    db,
    tokens,
    storage: new InMemoryStorage(),
    gateway: new TestPaymentGateway(),
    logger: createLogger('silent'),
    limits: new MemoryStore(),
    rateLimitsEnabled: false,
  });
  const e = createExperienceApp({ db: edb, logger: createLogger('silent'), ttlMs: 1 });
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
  await edb.close();
  await sup.end();
});

const mint = (sub: string) => mintFor(db, tokens, sub);

/** Calls the real server and asserts the response conforms to the documented schema. */
async function check(
  base: string,
  method: string,
  template: string,
  path: string,
  status: number,
  opts: { token?: string; body?: unknown; headers?: Record<string, string> } = {},
) {
  const res = await fetch(base + path, {
    method,
    headers: {
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
      ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(opts.headers ?? {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  expect(res.status, `${method} ${path}: ${text}`).toBe(status);
  const problems = await conforms(method, template, status, json);
  expect(problems, `${method} ${template} -> ${status}`).toEqual([]);
  return json;
}

describe(`responses conform to contracts/api/openapi.yaml`, () => {
  it('spec hash is stable and reportable', () => expect(specSha256()).toMatch(/^[0-9a-f]{64}$/));

  it('experience reads', async () => {
    await fx.setStock(V, 3);
    await check(exp, 'GET', '/v1/store-settings', '/v1/store-settings', 200);
    await check(exp, 'GET', '/v1/categories', '/v1/categories', 200);
    const page = await check(exp, 'GET', '/v1/products', '/v1/products?limit=2', 200);
    await check(exp, 'GET', '/v1/products', `/v1/products?limit=2&cursor=${page.nextCursor}`, 200);
    await check(exp, 'GET', '/v1/products/{id}', `/v1/products/${V}`, 200);
    await check(exp, 'GET', '/v1/products/{id}', '/v1/products/does-not-exist', 404);
    await check(exp, 'GET', '/v1/products/{id}/reviews', `/v1/products/${V}/reviews`, 200);
    await check(exp, 'GET', '/v1/products', '/v1/products?limit=999', 400);
  });

  it('guest cart → customer journey → order → payment → cancel', async () => {
    const g = await check(api, 'POST', '/v1/guest-carts', '/v1/guest-carts', 201);
    await check(api, 'GET', '/v1/guest-cart', '/v1/guest-cart', 200, {
      headers: { 'x-guest-cart-token': g.guestCartToken },
    });
    await check(api, 'PUT', '/v1/guest-cart/lines/{variantId}', `/v1/guest-cart/lines/${V}`, 200, {
      body: { quantity: 1 },
      headers: { 'x-guest-cart-token': g.guestCartToken },
    });
    const uid = await fx.user();
    const token = await mint(uid);
    await check(api, 'GET', '/v1/me', '/v1/me', 200, { token });
    await check(api, 'PUT', '/v1/me/preferences', '/v1/me/preferences', 204, {
      token,
      body: { orderUpdates: true, offersAndCareTips: false },
    });
    await check(api, 'PATCH', '/v1/me', '/v1/me', 204, { token, body: { fullName: 'Test Customer' } });
    const addr = await check(api, 'POST', '/v1/addresses', '/v1/addresses', 201, {
      token,
      body: {
        recipientName: 'T C',
        phone: '9999999999',
        line1: '1 Road',
        city: 'Pune',
        state: 'MH',
        postalCode: '411001',
        isDefault: true,
      },
    });
    await check(api, 'GET', '/v1/addresses', '/v1/addresses', 200, { token });
    await check(api, 'PUT', '/v1/addresses/{id}', `/v1/addresses/${addr.id}`, 200, {
      token,
      body: {
        recipientName: 'T C2',
        phone: '9999999999',
        line1: '1 Road',
        city: 'Pune',
        state: 'MH',
        postalCode: '411001',
        isDefault: true,
      },
    });
    const merged = await check(api, 'POST', '/v1/cart/merge', '/v1/cart/merge', 200, {
      token,
      body: { guestCartToken: g.guestCartToken },
    });
    await check(api, 'GET', '/v1/cart', '/v1/cart', 200, { token });
    await check(api, 'PUT', '/v1/cart/lines/{variantId}', `/v1/cart/lines/${V}`, 409, {
      token,
      body: { quantity: 2, expectedVersion: merged.version + 5 },
    });
    await check(api, 'PUT', '/v1/wishlist/{productId}', `/v1/wishlist/${V}`, 204, { token });
    await check(api, 'GET', '/v1/wishlist', '/v1/wishlist', 200, { token });
    await check(api, 'DELETE', '/v1/wishlist/{productId}', `/v1/wishlist/${V}`, 204, { token });

    const q = await check(api, 'POST', '/v1/checkout/quotes', '/v1/checkout/quotes', 201, {
      token,
      body: { addressId: addr.id, paymentMethod: 'online' },
    });
    const order = await check(api, 'POST', '/v1/orders', '/v1/orders', 201, {
      token,
      body: { quoteId: q.id },
      headers: { 'idempotency-key': randomUUID() },
    });
    await check(api, 'POST', '/v1/orders', '/v1/orders', 409, {
      token,
      body: { quoteId: q.id },
      headers: { 'idempotency-key': randomUUID() },
    }); // QUOTE_ALREADY_USED
    await check(api, 'GET', '/v1/orders', '/v1/orders', 200, { token });
    await check(api, 'GET', '/v1/orders/{id}', `/v1/orders/${order.id}`, 200, { token });
    await check(
      api,
      'POST',
      '/v1/orders/{id}/payment-attempts',
      `/v1/orders/${order.id}/payment-attempts`,
      201,
      { token, body: {} },
    );
    await check(api, 'GET', '/v1/orders/{id}/payment', `/v1/orders/${order.id}/payment`, 200, { token });
    await check(api, 'POST', '/v1/orders/{id}/cancel', `/v1/orders/${order.id}/cancel`, 200, {
      token,
      body: { reason: 'contract test' },
    });
    await check(api, 'DELETE', '/v1/addresses/{id}', `/v1/addresses/${addr.id}`, 204, { token });
    await check(api, 'GET', '/v1/orders/{id}', `/v1/orders/${order.id}`, 200, { token }); // history survives address deletion
    await check(api, 'GET', '/v1/orders/{id}', `/v1/orders/${randomUUID()}`, 404, { token });
    await check(api, 'GET', '/v1/cart', '/v1/cart', 401);
  });

  it('every documented ErrorCode matches the implementation enum', async () => {
    const { ERROR_CODES } = await import('@jw/contracts');
    const { default: SwaggerParser } = await import('@apidevtools/swagger-parser');
    const { SPEC_PATH } = await import('@jw/test-support');
    const api2 = (await SwaggerParser.dereference(SPEC_PATH)) as unknown as {
      components: { schemas: { ErrorCode: { enum: string[] } } };
    };
    expect([...api2.components.schemas.ErrorCode.enum].sort()).toEqual(Object.keys(ERROR_CODES).sort());
  });
});

describe('v1.1 responses conform (identity, notifications, devices, home, content, tracking)', () => {
  it('auth + customer service endpoints', async () => {
    const em = `contract-${Date.now()}@example.test`;
    const reg = await check(api, 'POST', '/v1/auth/register', '/v1/auth/register', 201, {
      body: { email: em, password: 'Correct-Horse-9!', fullName: 'Contract Tester' },
    });
    await check(api, 'POST', '/v1/auth/login', '/v1/auth/login', 200, {
      body: { email: em, password: 'Correct-Horse-9!' },
    });
    await check(api, 'POST', '/v1/auth/login', '/v1/auth/login', 401, {
      body: { email: em, password: 'wrong-password-1' },
    });
    const rf = await check(api, 'POST', '/v1/auth/refresh', '/v1/auth/refresh', 200, {
      body: { refreshToken: reg.refreshToken },
    });
    await check(api, 'POST', '/v1/auth/password/forgot', '/v1/auth/password/forgot', 202, {
      body: { email: em },
    });
    const t = reg.accessToken as string;
    await check(api, 'GET', '/v1/notifications', '/v1/notifications', 200, { token: t });
    await check(api, 'POST', '/v1/devices', '/v1/devices', 204, {
      token: t,
      body: { platform: 'android', token: 'x'.repeat(40) },
    });
    await check(api, 'DELETE', '/v1/devices/{token}', `/v1/devices/${'x'.repeat(40)}`, 204, { token: t });
    await check(api, 'GET', '/v1/me/reviews', '/v1/me/reviews', 200, { token: t });
    await check(api, 'GET', '/v1/orders/{id}/shipments', `/v1/orders/${randomUUID()}/shipments`, 404, {
      token: t,
    });
    await check(api, 'GET', '/v1/auth/account/export', '/v1/auth/account/export', 200, { token: t });
    expect(rf.refreshToken).not.toBe(reg.refreshToken);
    await check(api, 'POST', '/v1/auth/account/delete', '/v1/auth/account/delete', 204, {
      token: t,
      body: { password: 'Correct-Horse-9!' },
    });
  });

  it('experience: home + content', async () => {
    await check(exp, 'GET', '/v1/home', '/v1/home', 200);
    await sup.query(
      `INSERT INTO content_pages (slug, kind, title, body_md, status, published_at) VALUES ('contract-page','page','T','# hi','published', now()) ON CONFLICT (slug) DO NOTHING`,
    );
    await check(exp, 'GET', '/v1/content', '/v1/content', 200);
    await check(exp, 'GET', '/v1/content/{slug}', '/v1/content/contract-page', 200);
    await check(exp, 'GET', '/v1/content/{slug}', '/v1/content/nope-page', 404);
    await sup.query(`DELETE FROM content_pages WHERE slug = 'contract-page'`);
  });
});
