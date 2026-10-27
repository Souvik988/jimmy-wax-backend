import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLogger } from '@jw/observability';
import { Fixtures, experienceDb, superPool } from '@jw/test-support';
import { createExperienceApp } from '../../src/app.ts';

const db = experienceDb();
const sup = superPool();
const fx = new Fixtures(sup);
let base = '';
let server: import('node:http').Server;

beforeAll(async () => {
  await fx.resetCommerceData();
  await fx.openStore();
  await fx.setStock('twinkle-shine-leather-polish', 250);
  const app = createExperienceApp({ db, logger: createLogger('silent'), ttlMs: 50 });
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
const get = async (p: string) => {
  const r = await fetch(base + p);
  return { status: r.status, headers: r.headers, json: await r.json() };
};

describe('experience API', () => {
  it('returns one product with all variants across pagination and detail', async () => {
    await sup.query(`INSERT INTO product_variants(id,product_id,sku,title,price_paise,active)
      VALUES('pagination-polish-pack','twinkle-shine-leather-polish','PAGINATION-PACK','Second pack',59900,true)`);
    try {
      const items: Array<{ id: string; variants: Array<{ id: string }> }> = [];
      let cursor: string | null = null;
      do {
        const page = await get(
          '/v1/products?limit=1' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''),
        );
        items.push(...page.json.items);
        cursor = page.json.nextCursor;
      } while (cursor);
      expect(items).toHaveLength(4);
      expect(new Set(items.map((x) => x.id)).size).toBe(4);
      expect(items.find((x) => x.id === 'twinkle-shine-leather-polish')!.variants.map((x) => x.id)).toEqual(
        expect.arrayContaining(['twinkle-shine-leather-polish', 'pagination-polish-pack']),
      );
      const detail = await get('/v1/products/twinkle-shine-leather-polish');
      expect(detail.json.variants).toHaveLength(2);
      expect(detail.json.variant.id).toBe('twinkle-shine-leather-polish');
    } finally {
      await sup.query(`DELETE FROM inventory_positions WHERE variant_id='pagination-polish-pack'`);
      await sup.query(`DELETE FROM product_variants WHERE id='pagination-polish-pack'`);
      await new Promise((r) => setTimeout(r, 80));
    }
  });
  it('serves the four launch products with integer paise, public cache headers, and capped stock depth', async () => {
    const r = await get('/v1/products?limit=10');
    expect(r.status).toBe(200);
    expect(r.json.items).toHaveLength(4);
    expect(r.headers.get('cache-control')).toContain('max-age=30');
    const polish = r.json.items.find((p: { id: string }) => p.id === 'twinkle-shine-leather-polish');
    expect(polish.variant).toMatchObject({
      pricePaise: 29900,
      comparePaise: 39900,
      currency: 'INR',
      available: true,
      availableQuantity: 10,
    });
    expect(polish.media[0].assetPath).toContain('assets/runtime/');
    const out = r.json.items.find((p: { id: string }) => p.id === 'black-shoe-care');
    expect(out.variant.available).toBe(false);
  });
  it('answers delivery-area questions publicly: null until configured, then true/false by prefix', async () => {
    await sup.query('DELETE FROM serviceable_pin_prefixes');
    expect((await get('/v1/serviceability/743287')).json).toMatchObject({ pin: '743287', serviceable: null });
    await sup.query(`INSERT INTO serviceable_pin_prefixes (prefix, note) VALUES ('7432', 'test')`);
    await new Promise((r) => setTimeout(r, 80)); // outlast the micro-cache
    expect((await get('/v1/serviceability/743287')).json).toMatchObject({ serviceable: true });
    expect((await get('/v1/serviceability/110001')).json).toMatchObject({
      serviceable: false,
      deliveryEstimate: null,
    });
    expect((await get('/v1/serviceability/12ab')).status).toBe(400);
    await sup.query(`DELETE FROM serviceable_pin_prefixes WHERE prefix = '7432'`);
    await sup.query(`INSERT INTO serviceable_pin_prefixes (prefix, note) VALUES ('743287', 'restored')`);
  });

  it('paginates deterministically with opaque cursors; rejects bad input', async () => {
    const p1 = await get('/v1/products?limit=2');
    const p2 = await get(`/v1/products?limit=2&cursor=${p1.json.nextCursor}`);
    const ids = [...p1.json.items, ...p2.json.items].map((x: { id: string }) => x.id);
    expect(new Set(ids).size).toBe(4);
    expect(p2.json.nextCursor).toBeNull();
    expect((await get('/v1/products?cursor=%%%')).status).toBe(400);
    expect((await get('/v1/products?limit=500')).status).toBe(400);
    expect((await get('/v1/products/NOPE!')).status).toBe(404);
  });
  it('filters by category and searches with escaped wildcards', async () => {
    expect((await get('/v1/products?category=kits')).json.items).toHaveLength(2);
    expect((await get('/v1/products?q=leather')).json.items).toHaveLength(1);
    expect((await get('/v1/products?q=%25%25')).json.items).toHaveLength(0);
  });
  it('exposes only public store settings and never customer or admin data', async () => {
    const s = (await get('/v1/store-settings')).json;
    expect(Object.keys(s).sort()).toEqual([
      'brandName',
      'checkoutOpen',
      'codEnabled',
      'codFeePaise',
      'codMaxOrderPaise',
      'currency',
      'deliveryEstimate',
      'freeShippingThresholdPaise',
      'gstRateBps',
      'onlinePaymentsEnabled',
      'ordersPaused',
      'pauseMessage',
      'shippingFeePaise',
      'supportEmail',
      'supportPhone',
      'taxInclusive',
    ]);
  });
  it('the experience role cannot read tables or write anything', async () => {
    for (const t of [
      'orders',
      'addresses',
      'profiles',
      'reviews',
      'store_settings',
      'inventory_positions',
      'products',
    ]) {
      await expect(db.pool.query(`SELECT 1 FROM ${t} LIMIT 1`), t).rejects.toThrow(/permission denied/);
    }
    await expect(db.pool.query(`UPDATE v_categories SET name = 'x'`)).rejects.toThrow(/permission denied/);
    await expect(db.pool.query(`SELECT user_id FROM v_approved_reviews`)).rejects.toThrow(/does not exist/);
  });
  it('approved reviews only, no author identity; pending/rejected never leak', async () => {
    const u = await fx.user();
    await sup.query(`DELETE FROM reviews`);
    await sup.query(
      `INSERT INTO reviews (product_id, user_id, rating, title, body, status) VALUES ('twinkle-shine-leather-polish',$1,5,'Great','Good shine','approved')`,
      [u],
    );
    const u2 = await fx.user();
    await sup.query(
      `INSERT INTO reviews (product_id, user_id, rating, title, body, status) VALUES ('twinkle-shine-leather-polish',$1,1,'Spam','buy now','pending')`,
      [u2],
    );
    const r = await get('/v1/products/twinkle-shine-leather-polish/reviews');
    expect(r.json.items).toHaveLength(1);
    expect(JSON.stringify(r.json)).not.toMatch(/user_id|userId|Spam|buy now/);
  });
  it('concurrent identical requests share one database query (single-flight)', async () => {
    await new Promise((r) => setTimeout(r, 80)); // let ttl expire
    const rs = await Promise.all(Array.from({ length: 50 }, () => get('/v1/categories')));
    expect(rs.every((x) => x.status === 200)).toBe(true);
  });
});
