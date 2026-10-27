import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLogger } from '@jw/observability';
import { experienceDb } from '@jw/test-support';
import { createExperienceApp } from '../../../experience-api/src/app.ts';
import { startHarness } from './harness.ts';
import { makePng } from './png.ts';

/** Contract 1.4.0 hardening: DASH-BR-008/009/012/013/015/018/022/032/033/037/039/040/041/042 and the HSN invoice change. */
const V = 'twinkle-shine-leather-polish';
const U = randomUUID().slice(0, 6);
let h: Awaited<ReturnType<typeof startHarness>>;
let pub = '';
let pubServer: import('node:http').Server;
const edb = experienceDb(2);
let admin: { id: string; token: string };
let admin1: { id: string; token: string }; // no MFA
let catalog: { id: string; token: string };
let support: { id: string; token: string };
let finance: { id: string; token: string };
let fulfil: { id: string; token: string };
let fulfil1: { id: string; token: string };
let seed = 7000;

beforeAll(async () => {
  h = await startHarness();
  pubServer = await new Promise((resolve) => {
    const s = createExperienceApp({
      db: edb,
      logger: createLogger('silent'),
      ttlMs: 1,
      storage: h.storage,
    }).listen(0, '127.0.0.1', () => {
      pub = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
      resolve(s);
    });
  });
  await h.fx.resetCommerceData();
  await h.fx.openStore({ cod_fee_paise: 2500 });
  admin = await h.staff('admin');
  admin1 = await h.staff('admin', 'aal1');
  catalog = await h.staff('catalog');
  support = await h.staff('support');
  finance = await h.staff('finance');
  fulfil = await h.staff('fulfillment');
  fulfil1 = await h.staff('fulfillment', 'aal1');
});
afterAll(async () => {
  pubServer.close();
  await edb.close();
  await h.close();
});
const A = (path: string) => `/v1/admin${path}`;
const upload = (token: string, extra = '') =>
  h.call('POST', `/v1/admin/media?filename=h-${seed}.png${extra}`, token, makePng(640, 480, seed++), {
    'content-type': 'image/png',
  });

describe('invoices: reading is side-effect free; issuing is guarded (DASH-BR-008) and carries HSN', () => {
  it('GET never issues; POST needs fulfil + MFA + reason, issues once, role-scoped PII, HSN printed', async () => {
    const { order } = await h.placeOrder('cod', V, 1);
    await h.moveOrder(order.id, 'confirmed', admin.token);
    await h.sup.query(`UPDATE product_variants SET hsn_code = '34051000' WHERE id = $1`, [V]);

    // seller profile is missing: issuing is refused and nothing is created
    expect(
      (await h.call('POST', A(`/orders/${order.id}/invoice`), fulfil.token, { reason: 'customer asked' }))
        .json.error.code,
    ).toBe('POLICY_NOT_CONFIGURED');
    const st = (await h.call('GET', A('/settings'), admin.token)).json.settings;
    expect(
      (
        await h.call('PATCH', A('/settings'), admin.token, {
          expectedVersion: st.version,
          reason: 'gst profile',
          merchantGstin: '27AAPFU0939F1ZV',
          merchantLegalName: 'JIMMY WAX Test',
          merchantState: 'Maharashtra',
          merchantAddress: '1 Shop Road, Mumbai',
        })
      ).status,
    ).toBe(204);

    const read = await h.call('GET', A(`/orders/${order.id}/invoice`), support.token);
    expect([read.status, read.json.error.code]).toEqual([404, 'NOT_FOUND']);
    expect(
      (await h.sup.query(`SELECT count(*)::int n FROM invoices WHERE order_id = $1`, [order.id])).rows[0].n,
    ).toBe(0);

    expect(
      (await h.call('POST', A(`/orders/${order.id}/invoice`), support.token, { reason: 'try it' })).status,
    ).toBe(403);
    expect(
      (await h.call('POST', A(`/orders/${order.id}/invoice`), fulfil1.token, { reason: 'no mfa' })).json.error
        .code,
    ).toBe('MFA_REQUIRED');
    expect((await h.call('POST', A(`/orders/${order.id}/invoice`), fulfil.token, {})).status).toBe(400);

    const issued = await h.call('POST', A(`/orders/${order.id}/invoice`), fulfil.token, {
      reason: 'customer asked',
    });
    expect(issued.status).toBe(201);
    expect(issued.json.invoiceNumber).toMatch(/^JW\/\d{4}-\d{2}\/\d{6}$/);
    expect(issued.json.hsnIncluded).toBe(true);
    expect(issued.json.lines[0].hsn).toBe('34051000');
    const again = await h.call('POST', A(`/orders/${order.id}/invoice`), fulfil.token, { reason: 'retry' });
    expect([again.status, again.json.invoiceNumber]).toEqual([200, issued.json.invoiceNumber]);
    expect(
      (await h.sup.query(`SELECT count(*)::int n FROM invoices WHERE order_id = $1`, [order.id])).rows[0].n,
    ).toBe(1);
    expect(
      (
        await h.sup.query(
          `SELECT count(*)::int n FROM audit_log WHERE action = 'invoice.issue' AND resource_id = $1`,
          [order.id],
        )
      ).rows[0].n,
    ).toBe(1);

    // reads: fulfilment sees the address, support/finance do not
    expect((await h.call('GET', A(`/orders/${order.id}/invoice`), fulfil.token)).json.buyer.address).not.toBe(
      '',
    );
    expect((await h.call('GET', A(`/orders/${order.id}/invoice`), support.token)).json.buyer.address).toBe(
      '',
    );
    expect((await h.call('GET', A(`/orders/${order.id}/invoice`), finance.token)).json.buyer.address).toBe(
      '',
    );
    expect((await h.call('GET', A(`/orders/${order.id}/invoice`), support.token)).json.buyer.name).toBe(
      'Test Buyer',
    );
  });
});

describe('order detail carries what the console needs (DASH-BR-009)', () => {
  it('customerId by permission, per-line allocation, status history, shipments, returns and message state', async () => {
    const { order, userId } = await h.placeOrder('cod', V, 2);
    await h.moveOrder(order.id, 'confirmed', admin.token);
    const full = (await h.call('GET', A(`/orders/${order.id}`), admin.token)).json;
    expect(full.customerId).toBe(userId);
    expect((await h.call('GET', A(`/orders/${order.id}`), finance.token)).json.customerId).toBeNull(); // no customers:read
    expect(full.statusHistory.map((s: { to: string }) => s.to)).toEqual(['placed', 'confirmed']);
    expect(full.statusHistory[1].from).toBe('placed');
    const line = full.lines[0];
    expect(line).toMatchObject({ productId: expect.any(String), variantId: V, discountPaise: 0 });
    expect(line.taxPaise).toBeGreaterThan(0);
    expect(full.allocation.shipping.totalPaise).toBe(full.shippingPaise);
    expect(full.allocation.codFee.totalPaise).toBe(full.codFeePaise);
    expect(full.shipments).toEqual([]);
    expect(full.returns).toEqual([]);
    expect(full.messages).toEqual([]);
    // the worker queues one email per outbox event, keyed event:outboxId; the detail shows its delivery state
    const ev = (
      await h.sup.query(
        `SELECT id, event_type FROM outbox WHERE aggregate_type = 'order' AND aggregate_id = $1 ORDER BY id LIMIT 1`,
        [order.id],
      )
    ).rows[0];
    await h.sup.query(
      `INSERT INTO email_outbox (dedupe_key, to_email, template, payload, status) VALUES ($1, 'buyer@example.test', $2, '{}', 'sent')`,
      [`${ev.event_type}:${ev.id}`, ev.event_type],
    );
    const withMail = (await h.call('GET', A(`/orders/${order.id}`), admin.token)).json;
    expect(withMail.messages).toEqual([
      { template: ev.event_type, status: 'sent', createdAt: expect.any(String) },
    ]);
  });
});

describe('returns and refunds lists (DASH-BR-013/015/018)', () => {
  it('return policy is readable by every role that reads returns; lists page with a cursor; refunds expose payment capability', async () => {
    await h.sup.query(`UPDATE store_settings SET return_window_days = 7 WHERE id = 1`);
    const r = await h.call('GET', A('/returns?limit=1'), fulfil.token);
    expect(r.json.returnPolicy).toEqual({ returnWindowDays: 7, configured: true });
    expect(r.json).toHaveProperty('nextCursor');
    await h.sup.query(`UPDATE store_settings SET return_window_days = NULL WHERE id = 1`);
    expect((await h.call('GET', A('/returns'), support.token)).json.returnPolicy).toEqual({
      returnWindowDays: null,
      configured: false,
    });

    // three refunds -> pages of one
    const { order } = await h.placeOrder('online', V, 1);
    for (let i = 0; i < 3; i += 1)
      await h.sup.query(
        `INSERT INTO refunds (order_id, amount_paise, status, reason, idempotency_key) VALUES ($1, 100, 'pending', $2, $3)`,
        [order.id, `r${i}`, `k${U}${i}`],
      );
    const p1 = await h.call('GET', A('/refunds?limit=1'), finance.token);
    expect(p1.json.items).toHaveLength(1);
    expect(p1.json.nextCursor).toEqual(expect.any(String));
    expect(p1.json.paymentCapability).toMatchObject({ configured: true, provider: expect.any(String) });
    expect(JSON.stringify(p1.json.paymentCapability)).not.toMatch(/key|secret|rzp_/i);
    const p2 = await h.call(
      'GET',
      A(`/refunds?limit=1&cursor=${encodeURIComponent(p1.json.nextCursor)}`),
      finance.token,
    );
    expect(p2.json.items[0].id).not.toBe(p1.json.items[0].id);
  });
});

describe('manual shipment package snapshot (DASH-BR-012)', () => {
  it('a package override needs a reason and is stored on the shipment', async () => {
    const { order } = await h.placeOrder('cod', V, 1);
    await h.moveOrder(order.id, 'confirmed', admin.token);
    await h.moveOrder(order.id, 'processing', admin.token);
    const pkg = { weightGrams: 900, lengthMm: 300, widthMm: 200, heightMm: 100 };
    const noReason = await h.call('POST', A(`/orders/${order.id}/shipments`), fulfil.token, {
      courier: 'Local Courier',
      trackingNumber: `PK${U}1`,
      package: pkg,
    });
    expect(noReason.status).toBe(400);
    const ok = await h.call('POST', A(`/orders/${order.id}/shipments`), fulfil.token, {
      courier: 'Local Courier',
      trackingNumber: `PK${U}1`,
      package: pkg,
      overrideReason: 'bundled with a gift box',
    });
    expect(ok.status).toBe(201);
    const list = (await h.call('GET', A(`/orders/${order.id}/shipments`), fulfil.token)).json.items;
    expect(list[0]).toMatchObject({ package: pkg, packageOverrideReason: 'bundled with a gift box' });
  });
});

describe('manual shipments: forward-only events, provider-free cancel, guarded return receipt (DASH-BR-011/014/016)', () => {
  const toProcessing = async () => {
    const { order } = await h.placeOrder('cod', V, 1);
    await h.moveOrder(order.id, 'confirmed', admin.token);
    await h.moveOrder(order.id, 'processing', admin.token);
    return order;
  };

  it('events only move forward and terminal shipments accept nothing more', async () => {
    const order = await toProcessing();
    const sh = await h.call('POST', A(`/orders/${order.id}/shipments`), fulfil.token, {
      courier: 'Local Courier',
      trackingNumber: `FW${U}1`,
    });
    expect(sh.status).toBe(201);
    const ev = (status: string) =>
      h.call('POST', A(`/shipments/${sh.json.id}/events`), fulfil.token, { status });
    expect((await ev('delivered')).status).toBe(409); // cannot be delivered straight from label_created
    expect((await ev('in_transit')).status).toBe(204);
    expect((await ev('out_for_delivery')).status).toBe(204);
    const back = await ev('label_created'); // backwards
    expect([back.status, back.json.error.code]).toEqual([409, 'ILLEGAL_STATE']);
    expect((await ev('delivered')).status).toBe(204);
    const after = await ev('out_for_delivery');
    expect([after.status, after.json.error.code]).toEqual([409, 'ILLEGAL_STATE']);
  });

  it('a manual shipment can be cancelled without a provider, returning the order to processing, with a reason and MFA', async () => {
    const order = await toProcessing();
    const sh = await h.call('POST', A(`/orders/${order.id}/shipments`), fulfil.token, {
      courier: 'Local Courier',
      trackingNumber: `CX${U}1`,
    });
    expect(
      (await h.call('POST', A(`/shipments/${sh.json.id}/cancel`), fulfil1.token, { reason: 'Wrong address' }))
        .json.error.code,
    ).toBe('MFA_REQUIRED');
    expect((await h.call('POST', A(`/shipments/${sh.json.id}/cancel`), fulfil.token, {})).status).toBe(400);
    const ok = await h.call('POST', A(`/shipments/${sh.json.id}/cancel`), fulfil.token, {
      reason: 'Wrong address',
    });
    expect(ok.status).toBe(200);
    expect((await h.sup.query(`SELECT status FROM orders WHERE id = $1`, [order.id])).rows[0].status).toBe(
      'processing',
    );
    expect(
      (
        await h.sup.query(
          `SELECT 1 FROM audit_log WHERE action = 'shipment.cancel' AND resource_id = $1 AND reason = 'Wrong address'`,
          [sh.json.id],
        )
      ).rowCount,
    ).toBe(1);
  });

  it('receiving a return restocks, so it needs step-up like a stock adjustment', async () => {
    const id = randomUUID();
    expect((await h.call('POST', A(`/returns/${id}/receive`), fulfil1.token)).json.error.code).toBe(
      'MFA_REQUIRED',
    );
    expect((await h.call('POST', A(`/returns/${id}/receive`), support.token)).status).toBe(403);
    expect((await h.call('POST', A(`/returns/${id}/receive`), fulfil.token)).status).toBe(404); // permitted, but there is no such return
  });
});

describe('public media is approved-only; operators preview through an authenticated route (DASH-BR-042)', () => {
  it('draft and rejected media 404 publicly, 200 for operators; approval opens it; archive closes it again', async () => {
    const up = await upload(catalog.token);
    const sha = up.json.sha256 as string;
    expect((await fetch(`${pub}/v1/media/${sha}/orig.webp`)).status).toBe(404);
    const op = await h.call('GET', A(`/media-files/${sha}/orig.webp`), catalog.token);
    expect(op.status).toBe(200);
    expect(op.headers.get('cache-control')).toContain('no-store');
    expect((await h.call('GET', A(`/media-files/${sha}/orig.webp`), undefined)).status).toBe(401);
    expect((await h.call('GET', A(`/media-files/${'0'.repeat(64)}/orig.webp`), catalog.token)).status).toBe(
      404,
    );

    await h.call('PATCH', A(`/media/${up.json.id}`), catalog.token, { alt: 'A tin of polish' });
    // rejected stays private
    await h.call('POST', A(`/media/${up.json.id}/reject`), admin.token, { note: 'blurry' });
    expect((await fetch(`${pub}/v1/media/${sha}/orig.webp`)).status).toBe(404);
    expect(
      (await h.call('POST', A(`/media/${up.json.id}/approve`), admin.token, { note: 'fine' })).json.approval,
    ).toBe('approved');
    const pubRes = await fetch(`${pub}/v1/media/${sha}/orig.webp`);
    expect([pubRes.status, pubRes.headers.get('cache-control')]).toEqual([
      200,
      expect.stringContaining('immutable'),
    ]);

    const stamp = (await h.call('GET', A(`/media/${up.json.id}`), catalog.token)).json.updatedAt as string;
    expect(
      (
        await h.call('POST', A(`/media/${up.json.id}/archive`), catalog.token, {
          expectedUpdatedAt: stamp,
          reason: 'retired',
        })
      ).json.archived,
    ).toBe(true);
    expect((await fetch(`${pub}/v1/media/${sha}/orig.webp`)).status).toBe(404);
  });

  it('only administrators approve (documented): catalog cannot, and the dev bridge flag is the only way to serve drafts', async () => {
    const up = await upload(catalog.token);
    expect((await h.call('POST', A(`/media/${up.json.id}/approve`), catalog.token, {})).status).toBe(403);
    const bridge = await new Promise<import('node:http').Server>((resolve) => {
      const s = createExperienceApp({
        db: edb,
        logger: createLogger('silent'),
        ttlMs: 1,
        storage: h.storage,
        allowUnapprovedMedia: true,
      }).listen(0, '127.0.0.1', () => resolve(s));
    });
    try {
      const r = await fetch(
        `http://127.0.0.1:${(bridge.address() as AddressInfo).port}/v1/media/${up.json.sha256}/orig.webp`,
      );
      expect([r.status, r.headers.get('cache-control')]).toEqual([200, 'no-store']);
    } finally {
      bridge.close();
    }
  });
});

describe('media usage, in-use filter, guarded archive, rights fields, bundled key (DASH-BR-037/039/040/041)', () => {
  it('usage lists Studio drafts and live releases; inUse filters; archive is guarded and audited', async () => {
    const up = await upload(catalog.token);
    const id = up.json.id as string;
    const inUse = async (v: boolean) =>
      (
        (await h.call('GET', A(`/media?inUse=${v}&limit=50`), catalog.token)).json.items as Array<{
          id: string;
        }>
      ).some((m) => m.id === id);
    expect(await inUse(false)).toBe(true);
    expect(await inUse(true)).toBe(false);

    const key = `custom:use-${U}`;
    await h.sup.query(`INSERT INTO exp_documents (channel, kind, key, body) VALUES ('web', 'page', $1, $2)`, [
      key,
      JSON.stringify({ blocks: [{ props: { image: { mediaId: id } } }] }),
    ]);
    try {
      const usage = (await h.call('GET', A(`/media/${id}/usage`), catalog.token)).json.items as Array<{
        type: string;
        id: string;
      }>;
      expect(usage).toEqual([{ type: 'studio_draft', id: `web/page:${key}`, label: expect.any(String) }]);
      expect(await inUse(true)).toBe(true);
      expect(await inUse(false)).toBe(false);
      const stamp = (await h.call('GET', A(`/media/${id}`), catalog.token)).json.updatedAt as string;
      const refused = await h.call('POST', A(`/media/${id}/archive`), catalog.token, {
        expectedUpdatedAt: stamp,
        reason: 'cleanup',
      });
      expect([refused.status, refused.json.error.code]).toEqual([409, 'ILLEGAL_STATE']);
      expect(refused.json.error.lines[0]).toMatchObject({ type: 'studio_draft' });
    } finally {
      await h.sup.query(`DELETE FROM exp_documents WHERE channel = 'web' AND key = $1`, [key]);
    }
    const stamp = (await h.call('GET', A(`/media/${id}`), catalog.token)).json.updatedAt as string;
    const stale = await h.call('POST', A(`/media/${id}/archive`), catalog.token, {
      expectedUpdatedAt: '2020-01-01T00:00:00.000Z',
      reason: 'cleanup',
    });
    expect(stale.status).toBe(409);
    expect(
      (
        await h.call('POST', A(`/media/${id}/archive`), catalog.token, {
          expectedUpdatedAt: stamp,
          reason: 'x',
        })
      ).status,
    ).toBe(400); // reason too short
    expect(
      (
        await h.call('POST', A(`/media/${id}/archive`), catalog.token, {
          expectedUpdatedAt: stamp,
          reason: 'no longer needed',
        })
      ).json.archived,
    ).toBe(true);
    const audit = (
      await h.sup.query(
        `SELECT reason, before, after FROM audit_log WHERE action = 'media.archive' AND resource_id = $1`,
        [id],
      )
    ).rows[0];
    expect(audit).toMatchObject({
      reason: 'no longer needed',
      before: { archived: false },
      after: { archived: true },
    });
    const stamp2 = (await h.call('GET', A(`/media/${id}`), catalog.token)).json.updatedAt as string;
    expect(
      (
        await h.call('POST', A(`/media/${id}/restore`), catalog.token, {
          expectedUpdatedAt: stamp2,
          reason: 'needed again',
        })
      ).json.archived,
    ).toBe(false);
    expect(
      (
        await h.call('POST', A(`/media/${id}/restore`), catalog.token, {
          expectedUpdatedAt: stamp2,
          reason: 'again',
        })
      ).status,
    ).toBe(409); // stale and not archived
  });

  it('rights fields travel in the upload header (not the URL) and are editable; bundledKey is admin-only with step-up', async () => {
    const meta = Buffer.from(
      JSON.stringify({
        rightsHolder: 'Studio Lumen',
        provenanceNote: 'Shot 2026-09-14 by in-house photographer',
        consentReference: 'REL-0042',
      }),
    ).toString('base64url');
    const up = await h.call(
      'POST',
      `/v1/admin/media?filename=r-${seed}.png&alt=Tin`,
      catalog.token,
      makePng(640, 480, seed++),
      { 'content-type': 'image/png', 'x-jw-upload-meta': meta },
    );
    expect(up.status).toBe(201);
    expect(up.json).toMatchObject({
      rightsHolder: 'Studio Lumen',
      provenanceNote: 'Shot 2026-09-14 by in-house photographer',
      consentReference: 'REL-0042',
      bundledKey: null,
    });
    expect((await upload(catalog.token, '&license=ok')).status).toBe(201);
    const badMeta = await h.call(
      'POST',
      `/v1/admin/media?filename=b-${seed}.png`,
      catalog.token,
      makePng(640, 480, seed++),
      { 'content-type': 'image/png', 'x-jw-upload-meta': '***' },
    );
    expect(badMeta.status).toBe(400);

    const id = up.json.id as string;
    expect(
      (await h.call('PATCH', A(`/media/${id}`), catalog.token, { rightsHolder: 'New Holder' })).json
        .rightsHolder,
    ).toBe('New Holder');
    const key = 'assets/runtime/banners/test.jpg';
    expect((await h.call('PATCH', A(`/media/${id}`), catalog.token, { bundledKey: key })).status).toBe(403);
    expect(
      (await h.call('PATCH', A(`/media/${id}`), admin1.token, { bundledKey: key })).json.error.code,
    ).toBe('MFA_REQUIRED');
    const set = await h.call('PATCH', A(`/media/${id}`), admin.token, { bundledKey: key });
    expect(set.json.bundledKey).toBe(key);
    const audit = (
      await h.sup.query(
        `SELECT before, after FROM audit_log WHERE action = 'media.update' AND resource_id = $1 ORDER BY id DESC LIMIT 1`,
        [id],
      )
    ).rows[0];
    expect(audit).toMatchObject({ before: { bundledKey: null }, after: { bundledKey: key } });
  });
});

describe('categories and collections: guarded writes (DASH-BR-022/032/033)', () => {
  it('category edits need the revision; stale edits are 409; delete lists blockers including archived products', async () => {
    const created = await h.call('POST', A('/categories'), catalog.token, {
      name: `Guarded ${U}`,
      description: 'x',
    });
    expect(created.status).toBe(201);
    expect(created.json).toMatchObject({ rev: 1, productCount: 0, archivedProductCount: 0 });
    const id = created.json.id as string;
    expect(
      (await h.call('PATCH', A(`/categories/${id}`), catalog.token, { description: 'no rev' })).status,
    ).toBe(400);
    const ok = await h.call('PATCH', A(`/categories/${id}`), catalog.token, {
      description: 'edited',
      expectedRev: 1,
    });
    expect([ok.status, ok.json.rev]).toEqual([200, 2]);
    const stale = await h.call('PATCH', A(`/categories/${id}`), catalog.token, {
      description: 'again',
      expectedRev: 1,
    });
    expect([stale.status, stale.json.error.code]).toEqual([409, 'CART_VERSION_CONFLICT']);
    const aud = (
      await h.sup.query(
        `SELECT before, after FROM audit_log WHERE action = 'category.update' AND resource_id = $1`,
        [id],
      )
    ).rows[0];
    expect(aud).toMatchObject({ before: { description: 'x' }, after: { description: 'edited' } });

    const p = await h.call('POST', A('/products'), catalog.token, {
      id: `tp-${U}-cat`,
      name: `Cat product ${U}`,
      categoryId: id,
      keyBenefits: ['Shine'],
      tags: ['t'],
      variants: [
        {
          id: `tp-${U}-cat`,
          sku: `SKU-${U}-CAT`,
          title: 'Standard',
          pricePaise: 10000,
          weightGrams: 250,
          lengthMm: 120,
          widthMm: 60,
          heightMm: 40,
          hsnCode: '3405',
        },
      ],
    });
    expect(p.status).toBe(201);
    await h.call('POST', A(`/products/tp-${U}-cat/archive`), catalog.token, {
      expectedVersion: 1,
      reason: 'test archive',
    });
    const listed = (await h.call('GET', A('/categories'), catalog.token)).json.items.find(
      (c: { id: string }) => c.id === id,
    );
    expect(listed).toMatchObject({ productCount: 0, archivedProductCount: 1 });
    const blocked = await h.call('DELETE', A(`/categories/${id}`), catalog.token);
    expect([blocked.status, blocked.json.error.code]).toEqual([409, 'ILLEGAL_STATE']);
    expect(blocked.json.error.lines).toEqual([
      { type: 'product', id: `tp-${U}-cat`, label: expect.any(String), archived: true },
    ]);
  });

  it('collection delete needs revision + reason and is refused while Studio uses it', async () => {
    const id = `col-g-${U}`;
    expect(
      (
        await h.call('POST', A('/collections'), catalog.token, {
          id,
          name: `Guard ${U}`,
          kind: 'manual',
          productIds: [],
        })
      ).status,
    ).toBe(201);
    expect((await h.call('DELETE', A(`/collections/${id}`), catalog.token, { expectedRev: 1 })).status).toBe(
      400,
    ); // reason required
    expect(
      (
        await h.call('DELETE', A(`/collections/${id}`), catalog.token, {
          expectedRev: 5,
          reason: 'wrong rev',
        })
      ).status,
    ).toBe(409);
    const key = `custom:col-${U}`;
    await h.sup.query(`INSERT INTO exp_documents (channel, kind, key, body) VALUES ('web', 'page', $1, $2)`, [
      key,
      JSON.stringify({ blocks: [{ props: { source: { kind: 'collection', slug: id } } }] }),
    ]);
    try {
      const refused = await h.call('DELETE', A(`/collections/${id}`), catalog.token, {
        expectedRev: 1,
        reason: 'cleanup',
      });
      expect([refused.status, refused.json.error.code]).toEqual([409, 'ILLEGAL_STATE']);
      expect(refused.json.error.lines[0]).toMatchObject({ type: 'studio_draft', id: `web/page:${key}` });
    } finally {
      await h.sup.query(`DELETE FROM exp_documents WHERE channel = 'web' AND key = $1`, [key]);
    }
    expect(
      (await h.call('DELETE', A(`/collections/${id}`), catalog.token, { expectedRev: 1, reason: 'cleanup' }))
        .status,
    ).toBe(204);
    expect(
      (
        await h.sup.query(
          `SELECT reason FROM audit_log WHERE action = 'collection.delete' AND resource_id = $1`,
          [id],
        )
      ).rows[0].reason,
    ).toBe('cleanup');
  });
});

describe('variants list, exports, rate limits', () => {
  it('variants can be filtered by product and paged; ids and HSN are included', async () => {
    const all = (await h.call('GET', A('/catalog/variants?limit=1'), catalog.token)).json;
    expect(all.items).toHaveLength(1);
    expect(all.nextCursor).toEqual(expect.any(String));
    expect(all.items[0]).toMatchObject({ productId: expect.any(String), updatedAt: expect.any(String) });
    const one = (
      await h.call('GET', A(`/catalog/variants?productId=${all.items[0].productId}`), catalog.token)
    ).json.items as Array<{ productId: string }>;
    expect(one.length).toBeGreaterThan(0);
    expect(one.every((v) => v.productId === all.items[0].productId)).toBe(true);
    expect((await h.call('GET', A('/catalog/variants?productId=BAD%20ID'), catalog.token)).status).toBe(400);
  });

  it('admin reads and writes have separate, configurable ceilings with Retry-After', async () => {
    expect(h.config.ADMIN_RATE_READ_PER_MIN).toBe(600);
    expect(h.config.ADMIN_RATE_WRITE_PER_MIN).toBe(360);
    const tight = await startHarness({
      env: { ADMIN_RATE_READ_PER_MIN: '30', ADMIN_RATE_WRITE_PER_MIN: '30' },
      pool: 2,
      rateLimits: true,
    });
    try {
      const op = await tight.staff('admin');
      let limited: Awaited<ReturnType<typeof tight.call>> | undefined;
      for (let i = 0; i < 40 && !limited; i += 1) {
        const r = await tight.call('GET', '/v1/admin/me', op.token);
        if (r.status === 429) limited = r;
      }
      expect(limited?.status).toBe(429);
      expect(Number(limited?.headers.get('retry-after'))).toBeGreaterThan(0);
      // writes have their own bucket: a (invalid) write is judged on its merits, not rate-limited
      expect((await tight.call('POST', '/v1/admin/coupons', op.token, {})).status).toBe(400);
    } finally {
      await tight.close();
    }
  });
});
