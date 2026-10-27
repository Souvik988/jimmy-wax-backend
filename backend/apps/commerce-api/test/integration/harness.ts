import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { loadConfig } from '@jw/config';
import { InMemoryStorage, TestPaymentGateway } from '@jw/integrations';
import { createLogger } from '@jw/observability';
import { Fixtures, apiDb, superPool } from '@jw/test-support';
import { createApp, type Deps } from '../../src/app.ts';
import { createTokenService } from '../../src/auth.ts';
import { MemoryStore } from '../../src/rateLimit.ts';
import { mintFor, testEnv } from './support.ts';

export type Role = 'support' | 'catalog' | 'fulfillment' | 'finance' | 'designer' | 'admin';

/** One API server over the real test database, plus helpers shared by the B8–B12 suites. */
export async function startHarness(
  opts: {
    env?: Record<string, string>;
    gateway?: Deps['gateway'];
    shipping?: Deps['shipping'];
    pool?: number;
    rateLimits?: boolean;
  } = {},
) {
  const config = loadConfig(testEnv(opts.env));
  const tokens = createTokenService(config);
  const db = apiDb(opts.pool ?? 5);
  const sup = superPool();
  const fx = new Fixtures(sup);
  const storage = new InMemoryStorage();
  // Suites create catalogue rows (products, categories, collections); remove whatever they added on close so
  // other suites see the seeded catalogue regardless of file order.
  const seeded = {
    products: (await sup.query('SELECT id FROM products')).rows.map((r) => r.id as string),
    categories: (await sup.query('SELECT id FROM categories')).rows.map((r) => r.id as string),
    collections: (await sup.query('SELECT id FROM collections')).rows.map((r) => r.id as string),
  };
  async function restoreCatalogue() {
    // Stock ledgers are append-only, so rows a suite created are retired rather than deleted.
    const run = (q: string, v: unknown[]) =>
      sup.query(q, v).catch((e) => console.error('restoreCatalogue:', e.message));
    await run('DELETE FROM collections WHERE id <> ALL($1::text[])', [seeded.collections]);
    await run('UPDATE product_variants SET active = false WHERE product_id <> ALL($1::text[])', [
      seeded.products,
    ]);
    await run(
      'UPDATE products SET active = false, archived_at = coalesce(archived_at, now()) WHERE id <> ALL($1::text[])',
      [seeded.products],
    );
    await run('UPDATE categories SET active = false WHERE id <> ALL($1::text[])', [seeded.categories]);
  }
  const gateway = opts.gateway === undefined ? new TestPaymentGateway() : opts.gateway;
  const app = createApp({
    config,
    db,
    tokens,
    storage,
    gateway,
    shipping: opts.shipping ?? null,
    logger: createLogger(process.env.TEST_LOG ?? 'silent'),
    limits: new MemoryStore(),
    rateLimitsEnabled: opts.rateLimits ?? false,
  });
  let base = '';
  const server = await new Promise<import('node:http').Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => {
      base = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
      resolve(s);
    });
  });

  const mint = (sub: string, aal: 'aal1' | 'aal2' = 'aal2') =>
    mintFor(db, tokens, sub, { aal, client: aal === 'aal2' ? 'admin' : 'app' });

  async function call(
    method: string,
    path: string,
    token?: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) {
    const raw = typeof body === 'string' || Buffer.isBuffer(body);
    const res = await fetch(base + path, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body !== undefined && !raw ? { 'content-type': 'application/json' } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : raw ? (body as BodyInit) : JSON.stringify(body),
    });
    const ct = res.headers.get('content-type') ?? '';
    const t = await res.text();
    return {
      status: res.status,
      json: ct.includes('json') && t ? JSON.parse(t) : null,
      text: t,
      headers: res.headers,
    };
  }

  async function staff(role: Role, aal: 'aal1' | 'aal2' = 'aal2') {
    const id = await fx.user();
    await sup.query(`INSERT INTO admin_users (user_id, role) VALUES ($1,$2)`, [id, role]);
    return { id, token: await mint(id, aal) };
  }

  /** A real customer places a real order through the API (quote → order), so every downstream path is exercised. */
  async function placeOrder(
    method: 'cod' | 'online' = 'cod',
    variantId = 'twinkle-shine-leather-polish',
    quantity = 1,
    postalCode = '411001',
  ) {
    const id = await fx.user();
    const token = await mint(id, 'aal1');
    await fx.setStock(variantId, 50);
    const a = await call('POST', '/v1/addresses', token, {
      recipientName: 'Test Buyer',
      phone: '9999999999',
      line1: '12 Road',
      city: 'Pune',
      state: 'Maharashtra',
      postalCode,
      isDefault: true,
    });
    await call('PUT', `/v1/cart/lines/${variantId}`, token, { quantity });
    const q = await call('POST', '/v1/checkout/quotes', token, {
      addressId: a.json.id,
      paymentMethod: method,
    });
    const o = await call(
      'POST',
      '/v1/orders',
      token,
      { quoteId: q.json.id },
      { 'idempotency-key': randomUUID() },
    );
    if (o.status !== 201) throw new Error(`placeOrder failed: ${o.status} ${o.text}`);
    return { userId: id, token, order: o.json as { id: string; orderNumber: string; totalPaise: number } };
  }
  async function moveOrder(orderId: string, to: 'confirmed' | 'processing', adminToken: string) {
    const v = (await sup.query(`SELECT version FROM orders WHERE id = $1`, [orderId])).rows[0]
      .version as number;
    return call('POST', `/v1/admin/orders/${orderId}/status`, adminToken, { to, expectedVersion: v });
  }

  return {
    placeOrder,
    moveOrder,
    config,
    tokens,
    db,
    sup,
    fx,
    storage,
    base: () => base,
    call,
    mint,
    staff,
    close: async () => {
      await restoreCatalogue();
      server.close();
      await db.close();
      await sup.end();
    },
  };
}
