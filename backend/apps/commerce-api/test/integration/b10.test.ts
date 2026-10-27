import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  FakeShippingProvider,
  ShippingError,
  ShiprocketProvider,
  normaliseStatus,
  parseProviderDate,
} from '@jw/integrations';
import { exp, reconcileShipments, runBulkJob, shipOrder, sweepShippingEvents } from '@jw/commerce-domain';
import { workerDb } from '@jw/test-support';
import { startHarness } from './harness.ts';

const V = 'twinkle-shine-leather-polish';
let h: Awaited<ReturnType<typeof startHarness>>;
let fake: FakeShippingProvider;
let admin: { id: string; token: string };
let ful: { id: string; token: string };
let ful1: { id: string; token: string }; // fulfilment without MFA

beforeAll(async () => {
  fake = new FakeShippingProvider('hook-secret');
  h = await startHarness({ shipping: fake });
  await h.fx.resetCommerceData();
  await h.fx.openStore({ cod_fee_paise: 2500 });
  await h.sup.query(
    `UPDATE product_variants SET weight_grams = 250, length_mm = 120, width_mm = 60, height_mm = 40, hsn_code = '3405' WHERE id = $1`,
    [V],
  );
  await h.sup.query(
    `UPDATE shipping_settings SET pickup_location = 'Primary warehouse', pickup_pin = '743287', courier_rule = 'balanced'`,
  );
  admin = await h.staff('admin');
  ful = await h.staff('fulfillment');
  ful1 = await h.staff('fulfillment', 'aal1');
});
afterAll(async () => {
  await h.close();
});
beforeEach(() => {
  fake.failNext = {};
  fake.balancePaise = 500_000;
  fake.unserviceablePins.clear();
  fake.timeoutAfterCreate = false;
});

const deps = () => ({ db: h.db, provider: fake, storage: h.storage });
const x = () => ({ adminId: ful.id, role: 'fulfillment' as const });
/** A COD order moved to "processing" (ready to ship). */
async function readyOrder(method: 'cod' | 'online' = 'cod', postalCode = '411001') {
  const o = await h.placeOrder(method, V, 2, postalCode);
  if (method === 'online')
    await h.sup.query(`UPDATE orders SET status = 'placed', payment_status = 'paid' WHERE id = $1`, [
      o.order.id,
    ]);
  expect((await h.moveOrder(o.order.id, 'confirmed', ful.token)).status).toBe(200);
  expect((await h.moveOrder(o.order.id, 'processing', ful.token)).status).toBe(200);
  return o;
}
const hook = (awb: string, status: string, id: number, ts = '23 05 2023 11:43:52', scans: unknown[] = []) =>
  JSON.stringify({
    awb,
    courier_name: 'FastCourier Air',
    current_status: status,
    current_status_id: id,
    current_timestamp: ts,
    order_id: 'x',
    etd: '2023-05-26 10:00:00',
    is_return: 0,
    scans,
  });
/** Webhook handlers apply events after acknowledging; wait until every stored event is processed. */
async function settle() {
  for (let i = 0; i < 40; i++) {
    await sweepShippingEvents(h.db);
    const n = await h.sup.query(
      'SELECT count(*)::int n FROM shipping_provider_events WHERE processed_at IS NULL',
    );
    if (n.rows[0].n === 0) return;
    await new Promise((r) => setTimeout(r, 50));
  }
}
const post = (body: string, token = 'hook-secret') =>
  h.call('POST', '/v1/webhooks/fake', undefined, body, {
    'x-api-key': token,
    'content-type': 'application/json',
  });

async function putSettings(token: string, patch: Record<string, unknown>) {
  const cur = (await h.call('GET', '/v1/admin/shipping/settings', token)).json;
  return h.call('PUT', '/v1/admin/shipping/settings', token, {
    ...patch,
    expectedUpdatedAt: cur.updatedAt,
    reason: 'test change',
  });
}

describe('provider adapters (mocked transport — NOT evidence of live Shiprocket behaviour)', () => {
  it('maps statuses by name and parses the sample timestamp format', () => {
    expect(normaliseStatus('PICKED UP')).toBe('picked_up');
    expect(normaliseStatus('manifest generated')).toBe('pickup_scheduled');
    expect(normaliseStatus('In  Transit')).toBe('in_transit');
    expect(normaliseStatus('RTO DELIVERED')).toBe('returned_to_origin');
    expect(normaliseStatus('SOMETHING NEW')).toBeNull();
    expect(parseProviderDate('23 05 2023 11:43:52')).toBe('2023-05-23T06:13:52.000Z'); // IST assumed (unverified)
  });

  it('Shiprocket adapter: single-flight login, retries once on 401, maps errors, never follows non-https documents', async () => {
    const log: string[] = [];
    let logins = 0;
    let expire = true;
    const f = (async (url: string, init?: RequestInit) => {
      const u = String(url);
      log.push(`${init?.method ?? 'GET'} ${u.replace('https://apiv2.shiprocket.in', '')}`);
      if (u.endsWith('/auth/login')) return Response.json({ token: `t${++logins}` });
      if (u.includes('serviceability')) {
        if (expire) {
          expire = false;
          return new Response('{"message":"Unauthenticated"}', { status: 401 });
        }
        return Response.json({
          data: {
            available_courier_companies: [
              {
                courier_company_id: 5,
                courier_name: 'X',
                rate: 80.5,
                cod_charges: 30,
                estimated_delivery_days: 3,
                rating: 4.2,
              },
            ],
          },
        });
      }
      if (u.includes('orders/create/adhoc'))
        return Response.json({ message: 'Wallet balance is low, please recharge' }, { status: 422 });
      if (u.includes('generate/label')) return Response.json({ label_url: 'http://insecure.example/l.pdf' });
      return new Response('{}', { status: 429 });
    }) as unknown as typeof fetch;
    const p = new ShiprocketProvider({ email: 'api@example.test', password: 'pw', webhookToken: 'w' }, f);
    const [a, b] = await Promise.all([
      p.checkServiceability({
        pickupPin: '743287',
        deliveryPin: '411001',
        weightGrams: 300,
        cod: true,
        declaredValuePaise: 50000,
      }),
      p.walletBalancePaise(),
    ]);
    expect(a.couriers[0]).toMatchObject({
      courierId: '5',
      freightPaise: 8050,
      codChargesPaise: 3000,
      etdDays: 3,
    });
    expect(b).toBeNull(); // unverified endpoint failing must not break anything
    expect(logins).toBe(2); // single-flight first login + one forced refresh after the 401
    await expect(
      p.createOrder({
        reference: 'JW-1',
        orderDate: new Date(),
        pickupLocation: 'P',
        address: {
          name: 'A B',
          phone: '9999999999',
          email: null,
          line1: 'x',
          line2: '',
          city: 'c',
          state: 's',
          pincode: '411001',
        },
        items: [],
        paymentMethod: 'cod',
        orderTotalPaise: 100,
        codAmountPaise: 100,
        package: { weightGrams: 1, lengthMm: 1, widthMm: 1, heightMm: 1 },
      }),
    ).rejects.toMatchObject({ code: 'wallet_low', retryable: false });
    await expect(p.fetchLabel('1')).rejects.toBeInstanceOf(ShippingError);
    expect(() => p.verifyWebhook(Buffer.from('{}'), { 'x-api-key': 'nope' })).toThrow();
  });
});

describe('shipping settings, queue, planning', () => {
  it('settings are role-gated and audited; auto-ship needs a pickup location; support cannot change them', async () => {
    const support = await h.staff('support');
    expect(
      (await h.call('PUT', '/v1/admin/shipping/settings', support.token, { autoShip: true })).status,
    ).toBe(403);
    expect((await h.call('GET', '/v1/admin/shipping/settings', support.token)).status).toBe(200);
    const upd = await putSettings(ful.token, { preferredCouriers: ['MidWay'], courierRule: 'preferred' });
    expect([upd.status, upd.json.courierRule]).toEqual([200, 'preferred']);
    await putSettings(ful.token, { courierRule: 'balanced' });
    // guarded: missing reason/stamp is a 400; a stale stamp is a 409 and writes nothing
    expect(
      (await h.call('PUT', '/v1/admin/shipping/settings', ful.token, { courierRule: 'cheapest' })).status,
    ).toBe(400);
    const stale = await h.call('PUT', '/v1/admin/shipping/settings', ful.token, {
      courierRule: 'cheapest',
      expectedUpdatedAt: '2020-01-01T00:00:00.000Z',
      reason: 'stale write',
    });
    expect([stale.status, stale.json.error.code]).toEqual([409, 'CART_VERSION_CONFLICT']);
    expect((await h.call('GET', '/v1/admin/shipping/settings', ful.token)).json.courierRule).toBe('balanced');
    const a = await h.sup.query(
      `SELECT 1 FROM audit_log WHERE action = 'shipping.settings' AND reason = 'test change'`,
    );
    expect(a.rowCount).toBeGreaterThan(0);
    const prov = await h.call('GET', '/v1/admin/shipping/provider', ful.token);
    expect(prov.json).toMatchObject({
      provider: 'fake',
      configured: true,
      reachable: true,
      walletBalancePaise: 500000,
      pickupLocations: ['Primary warehouse'],
    });
  });

  it('ready queue: processing + payable orders only, package from the catalogue (weights, stacked heights), COD amount', async () => {
    const o = await readyOrder('cod');
    const notReady = await h.placeOrder('cod'); // still "placed"
    const q = await h.call('GET', '/v1/admin/shipping/ready', ful.token);
    const row = q.json.items.find((i: { id: string }) => i.id === o.order.id);
    expect(row).toBeTruthy();
    expect(q.json.items.some((i: { id: string }) => i.id === notReady.order.id)).toBe(false);
    expect(row.package).toEqual({ weightGrams: 500, lengthMm: 120, widthMm: 60, heightMm: 80 }); // 2 × 250 g, heights stack
    expect(row.codAmountPaise).toBe(row.totalPaise);
    expect(row.volumetricGrams).toBe(Math.round((12 * 6 * 8) / 5));
  });

  it('plan: serviceability + courier options + recommendation; unserviceable PIN and missing pickup PIN are explained', async () => {
    const o = await readyOrder('cod');
    const plan = await h.call('POST', `/v1/admin/orders/${o.order.id}/shipments/plan`, ful.token);
    expect(plan.status).toBe(200);
    expect(plan.json.options).toHaveLength(3);
    expect(plan.json.recommended).toBe('12'); // balanced picks the middle courier
    expect(plan.json.options[0].codChargesPaise).toBeGreaterThan(0);
    await putSettings(ful.token, { courierRule: 'cheapest' });
    expect(
      (await h.call('POST', `/v1/admin/orders/${o.order.id}/shipments/plan`, ful.token)).json.recommended,
    ).toBe('11');
    await putSettings(ful.token, { courierRule: 'fastest' });
    expect(
      (await h.call('POST', `/v1/admin/orders/${o.order.id}/shipments/plan`, ful.token)).json.recommended,
    ).toBe('10');
    await putSettings(ful.token, { courierRule: 'balanced' });
    fake.unserviceablePins.add('411001');
    const no = await h.call('POST', `/v1/admin/orders/${o.order.id}/shipments/plan`, ful.token);
    expect([no.json.serviceable, no.json.options]).toEqual([false, []]);
    await h.sup.query(`UPDATE shipping_settings SET pickup_pin = NULL`);
    const missing = await h.call('POST', `/v1/admin/orders/${o.order.id}/shipments/plan`, ful.token);
    expect([missing.status, missing.json.error.code]).toEqual([503, 'POLICY_NOT_CONFIGURED']);
    await h.sup.query(`UPDATE shipping_settings SET pickup_pin = '743287'`);
  });

  it('a negative provider verdict can gate customer quotes (cached, off by default, never a network call in checkout)', async () => {
    const o = await readyOrder('cod', '411001');
    fake.unserviceablePins.add('411001');
    await h.call('POST', `/v1/admin/orders/${o.order.id}/shipments/plan`, ful.token); // fills the cache: 411001 = not serviceable
    const quote = async () => {
      const id = await h.fx.user();
      const token = await h.mint(id, 'aal1');
      await h.fx.setStock(V, 50);
      const a = await h.call('POST', '/v1/addresses', token, {
        recipientName: 'Q',
        phone: '9999999999',
        line1: '1 Road',
        city: 'Pune',
        state: 'MH',
        postalCode: '411001',
        isDefault: true,
      });
      await h.call('PUT', `/v1/cart/lines/${V}`, token, { quantity: 1 });
      return h.call('POST', '/v1/checkout/quotes', token, { addressId: a.json.id, paymentMethod: 'cod' });
    };
    try {
      expect((await quote()).status).toBe(201); // setting off ⇒ the owner's PIN list alone decides
      await putSettings(ful.token, { requireProviderCheck: true });
      const blocked = await quote();
      expect([blocked.status, blocked.json.error.code]).toEqual([422, 'NOT_SERVICEABLE']);
      fake.unserviceablePins.clear();
      await h.call('POST', `/v1/admin/orders/${o.order.id}/shipments/plan`, ful.token); // provider now says yes ⇒ cache refreshed
      expect((await quote()).status).toBe(201);
    } finally {
      await putSettings(ful.token, { requireProviderCheck: false });
      fake.unserviceablePins.clear();
      await h.sup.query(`DELETE FROM pin_serviceability_cache`);
    }
  });
});

describe('shipping an order (idempotent state machine)', () => {
  it('ships end to end: AWB, pickup, stored label proxied by the API; sends exactly what the courier must collect', async () => {
    const o = await readyOrder('cod');
    const r = await h.call('POST', `/v1/admin/orders/${o.order.id}/ship`, ful.token, { courierId: '11' });
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({
      status: 'pickup_scheduled',
      courier: 'ValueExpress Surface',
      hasLabel: true,
      provider: 'fake',
    });
    expect(r.json.events.map((e: { status: string }) => e.status)).toEqual([
      'awb_assigned',
      'pickup_scheduled',
    ]);
    const sent = [...fake.orders.values()].find((v) => v.req.reference === `JW-${o.order.orderNumber}`)!.req;
    expect(sent.paymentMethod).toBe('cod');
    expect(sent.codAmountPaise).toBe(o.order.totalPaise); // items + shipping + COD fee, GST included
    expect(sent.items[0]).toMatchObject({ units: 2, hsn: '3405', sellingPricePaise: 29900 });
    expect(sent.items[0]!.taxPaise).toBe(Math.floor((29900 * 1800 * 2 + 11800) / 23600));
    const label = await h.call('GET', `/v1/admin/shipments/${r.json.id}/label`, ful.token);
    expect(label.headers.get('content-type')).toBe('application/pdf');
    expect(label.text).toContain('%PDF');
    expect(label.headers.get('cache-control')).toBe('private, no-store');
    const ord = await h.sup.query(`SELECT status FROM orders WHERE id = $1`, [o.order.id]);
    expect(ord.rows[0].status).toBe('processing'); // the order moves to "shipped" only when the courier picks up
    // a second ship call is a clean conflict, not a second provider order
    const again = await h.call('POST', `/v1/admin/orders/${o.order.id}/ship`, ful.token, {});
    expect([again.status, again.json.error.code]).toEqual([409, 'ILLEGAL_STATE']);
    expect([...fake.orders.keys()].filter((k) => k === `JW-${o.order.orderNumber}`)).toHaveLength(1);
    // customers can see the shipment through the existing endpoint
    const mine = await h.call('GET', `/v1/orders/${o.order.id}/shipments`, o.token);
    expect(mine.json.items?.[0]?.trackingNumber ?? mine.json[0]?.trackingNumber).toBe(r.json.awb);
  });

  it('prepaid orders send COD amount 0; unpaid or not-processing orders are refused; package overrides need a reason', async () => {
    const paid = await readyOrder('online');
    const bad = await h.call('POST', `/v1/admin/orders/${paid.order.id}/ship`, ful.token, {
      package: { weightGrams: 999, lengthMm: 100, widthMm: 100, heightMm: 100 },
    });
    expect(bad.status).toBe(400);
    expect(
      (
        await h.call('POST', `/v1/admin/orders/${paid.order.id}/ship`, ful.token, {
          package: { weightGrams: 999, lengthMm: 100, widthMm: 100, heightMm: 100 },
          overrideReason: 'Extra padding',
        })
      ).status,
    ).toBe(201);
    const sent = [...fake.orders.values()].find(
      (v) => v.req.reference === `JW-${paid.order.orderNumber}`,
    )!.req;
    expect([sent.paymentMethod, sent.codAmountPaise, sent.package.weightGrams]).toEqual(['prepaid', 0, 999]);
    const placed = await h.placeOrder('cod');
    const refused = await h.call('POST', `/v1/admin/orders/${placed.order.id}/ship`, ful.token, {});
    expect([refused.status, refused.json.error.code]).toEqual([409, 'ILLEGAL_STATE']);
    const support = await h.staff('support');
    expect((await h.call('POST', `/v1/admin/orders/${paid.order.id}/ship`, support.token, {})).status).toBe(
      403,
    );
  });

  it('timeout after the provider accepted the order never creates a second provider order; wallet-low is resumable', async () => {
    const o = await readyOrder('cod');
    fake.timeoutAfterCreate = true;
    const t1 = await h.call('POST', `/v1/admin/orders/${o.order.id}/ship`, ful.token, {});
    expect([t1.status, t1.json.error.code, t1.json.error.retryable]).toEqual([503, 'UNAVAILABLE', true]);
    expect([...fake.orders.keys()].filter((k) => k.includes(o.order.orderNumber))).toHaveLength(1); // accepted by the provider
    fake.balancePaise = 5000; // wallet too low for the next step
    const t2 = await h.call('POST', `/v1/admin/orders/${o.order.id}/ship`, ful.token, {});
    expect([t2.status, t2.json.error.code]).toEqual([409, 'ILLEGAL_STATE']);
    expect(t2.json.error.message).toMatch(/wallet/i);
    const rq = (
      await h.sup.query(`SELECT state, error_code FROM shipment_requests WHERE reference = $1`, [
        `JW-${o.order.orderNumber}`,
      ])
    ).rows[0];
    expect(rq).toEqual({ state: 'provider_order_created', error_code: 'wallet_low' }); // resumable, nothing orphaned
    fake.balancePaise = 500_000;
    const t3 = await h.call('POST', `/v1/admin/orders/${o.order.id}/ship`, ful.token, { courierId: '12' });
    expect([t3.status, t3.json.status, t3.json.courier]).toEqual([
      201,
      'pickup_scheduled',
      'MidWay Standard',
    ]);
    expect([...fake.orders.keys()].filter((k) => k.includes(o.order.orderNumber))).toHaveLength(1);
  });

  it('concurrent ship calls cannot double-create (lease); only one shipment results', async () => {
    const o = await readyOrder('cod');
    const results = await Promise.allSettled([
      shipOrder(deps(), x(), o.order.id, {}),
      shipOrder(deps(), x(), o.order.id, {}),
    ]);
    expect(results.some((r) => r.status === 'fulfilled')).toBe(true);
    for (const r of results)
      if (r.status === 'rejected')
        expect(['REQUEST_IN_PROGRESS', 'ILLEGAL_STATE']).toContain((r.reason as { code: string }).code);
    const n = await h.sup.query(`SELECT count(*)::int n FROM shipments WHERE order_id = $1`, [o.order.id]);
    expect(n.rows[0].n).toBe(1);
  });

  it('cancel before pickup needs MFA, frees the order, and re-shipping uses a new reference', async () => {
    const o = await readyOrder('cod');
    const s = await h.call('POST', `/v1/admin/orders/${o.order.id}/ship`, ful.token, {});
    const noMfa = await h.call('POST', `/v1/admin/shipments/${s.json.id}/cancel`, ful1.token, {
      reason: 'Wrong address',
    });
    expect([noMfa.status, noMfa.json.error.code]).toEqual([403, 'MFA_REQUIRED']);
    const ok = await h.call('POST', `/v1/admin/shipments/${s.json.id}/cancel`, ful.token, {
      reason: 'Wrong address',
    });
    expect([ok.status, ok.json.status]).toEqual([200, 'cancelled']);
    const re = await h.call('POST', `/v1/admin/orders/${o.order.id}/ship`, ful.token, {});
    expect(re.status).toBe(201);
    expect([...fake.orders.keys()]).toContain(`JW-${o.order.orderNumber}-R2`);
    // after pickup a shipment can no longer be cancelled
    await post(hook(re.json.awb, 'PICKED UP', 42, '24 05 2023 09:00:00'));
    await settle();
    expect(
      (await h.call('POST', `/v1/admin/shipments/${re.json.id}/cancel`, ful.token, { reason: 'too late' }))
        .status,
    ).toBe(409);
  });
});

describe('provider webhooks → shipment + order progression', () => {
  it('authenticates, dedupes, applies in order, ignores stale/out-of-order events, moves the order, queues emails', async () => {
    const o = await readyOrder('cod');
    const s = await h.call('POST', `/v1/admin/orders/${o.order.id}/ship`, ful.token, {});
    const awb = s.json.awb as string;
    expect((await post(hook(awb, 'PICKED UP', 42), 'wrong')).status).toBe(401);
    expect(
      (await h.call('POST', '/v1/webhooks/fake', undefined, 'not json', { 'x-api-key': 'hook-secret' }))
        .status,
    ).toBe(401);

    const first = await post(
      hook(awb, 'PICKED UP', 42, '24 05 2023 09:00:00', [
        {
          date: '2023-05-24 09:00:00',
          status: 'X-PPOM',
          activity: 'Shipment picked up',
          location: 'Pune',
          'sr-status': '42',
          'sr-status-label': 'PICKED UP',
        },
      ]),
    );
    expect(first.json).toEqual({ received: true, duplicate: false });
    expect((await post(hook(awb, 'PICKED UP', 42, '24 05 2023 09:00:00'))).json.duplicate).toBe(true);
    await settle();
    let sh = (await h.sup.query(`SELECT status, raw_status FROM shipments WHERE id = $1`, [s.json.id]))
      .rows[0];
    expect(sh).toEqual({ status: 'picked_up', raw_status: 'PICKED UP' });
    expect((await h.sup.query(`SELECT status FROM orders WHERE id = $1`, [o.order.id])).rows[0].status).toBe(
      'shipped',
    );

    await post(hook(awb, 'IN TRANSIT', 18, '25 05 2023 10:00:00'));
    await post(hook(awb, 'OUT FOR DELIVERY', 17, '26 05 2023 08:00:00'));
    await post(hook(awb, 'DELIVERED', 7, '26 05 2023 12:00:00'));
    await post(hook(awb, 'IN TRANSIT', 18, '26 05 2023 13:00:00')); // late, out-of-order: must not regress
    await settle();
    sh = (await h.sup.query(`SELECT status, raw_status FROM shipments WHERE id = $1`, [s.json.id])).rows[0];
    expect(sh.status).toBe('delivered');
    expect((await h.sup.query(`SELECT status FROM orders WHERE id = $1`, [o.order.id])).rows[0].status).toBe(
      'delivered',
    );
    const detail = await h.call('GET', `/v1/admin/shipments/${s.json.id}`, ful.token);
    expect(detail.json.events.length).toBeGreaterThanOrEqual(5);
    const kinds = (
      await h.sup.query(`SELECT event_type FROM outbox WHERE aggregate_id = $1 ORDER BY id`, [o.order.id])
    ).rows.map((r) => r.event_type);
    expect(kinds).toEqual(
      expect.arrayContaining(['order.shipped', 'order.out_for_delivery', 'order.delivered']),
    );
  });

  it('NDR and RTO: attempts are counted, re-attempts allowed, RTO never auto-cancels or refunds the order', async () => {
    const o = await readyOrder('cod');
    const s = await h.call('POST', `/v1/admin/orders/${o.order.id}/ship`, ful.token, {});
    const awb = s.json.awb as string;
    for (const [st, id, ts] of [
      ['PICKED UP', 42, '24 05 2023 09:00:00'],
      ['OUT FOR DELIVERY', 17, '25 05 2023 09:00:00'],
      ['UNDELIVERED', 21, '25 05 2023 18:00:00'],
      ['OUT FOR DELIVERY', 17, '26 05 2023 09:00:00'],
      ['UNDELIVERED', 21, '26 05 2023 18:00:00'],
      ['RTO INITIATED', 9, '27 05 2023 09:00:00'],
      ['RTO IN TRANSIT', 46, '28 05 2023 09:00:00'],
    ] as const)
      await post(hook(awb, st, id, ts));
    await new Promise((r) => setTimeout(r, 400));
    await sweepShippingEvents(h.db);
    const sh = (
      await h.sup.query(`SELECT status, ndr_count, rto_state FROM shipments WHERE id = $1`, [s.json.id])
    ).rows[0];
    expect(sh).toEqual({ status: 'rto_in_transit', ndr_count: 2, rto_state: 'rto_in_transit' });
    expect(
      (await h.sup.query(`SELECT status, payment_status FROM orders WHERE id = $1`, [o.order.id])).rows[0]
        .status,
    ).toBe('out_for_delivery');
    const ex = await h.call('GET', '/v1/admin/shipments?exception=true', ful.token);
    expect(ex.json.items.map((i: { id: string }) => i.id)).toContain(s.json.id);
    // late "DELIVERED" after RTO is ignored (RTO progress only)
    await post(hook(awb, 'DELIVERED', 7, '29 05 2023 09:00:00'));
    await new Promise((r) => setTimeout(r, 300));
    expect(
      (await h.sup.query(`SELECT status FROM shipments WHERE id = $1`, [s.json.id])).rows[0].status,
    ).toBe('rto_in_transit');
  });

  it('unknown AWBs and unmapped statuses are stored with an explanation, never guessed; overview counts them', async () => {
    const o = await readyOrder('cod');
    const s = await h.call('POST', `/v1/admin/orders/${o.order.id}/ship`, ful.token, {});
    const unk = await post(hook('NOPE123', 'IN TRANSIT', 18, '24 05 2023 09:00:00'));
    expect(unk.status).toBe(200);
    await post(hook(s.json.awb, 'QUANTUM TELEPORT', 99, '24 05 2023 10:00:00'));
    await new Promise((r) => setTimeout(r, 300));
    await sweepShippingEvents(h.db);
    const errs = (
      await h.sup.query(`SELECT error FROM shipping_provider_events WHERE error IS NOT NULL`)
    ).rows.map((r) => r.error);
    expect(errs).toEqual(expect.arrayContaining(['unknown awb', 'unmapped status "QUANTUM TELEPORT"']));
    expect(
      (await h.sup.query(`SELECT raw_status FROM shipments WHERE id = $1`, [s.json.id])).rows[0].raw_status,
    ).toBe('QUANTUM TELEPORT');
    const ov = await h.call('GET', '/v1/admin/shipments/overview', ful.token);
    expect(ov.json.webhook.eventsWithErrors).toBeGreaterThanOrEqual(2);
  });

  it('reconciliation polls silent shipments and applies what the provider reports', async () => {
    const o = await readyOrder('cod');
    const s = await h.call('POST', `/v1/admin/orders/${o.order.id}/ship`, ful.token, {});
    await post(hook(s.json.awb, 'PICKED UP', 42, '24 05 2023 09:00:00'));
    await new Promise((r) => setTimeout(r, 300));
    await sweepShippingEvents(h.db);
    await h.sup.query(`UPDATE shipments SET last_event_at = now() - interval '12 hours' WHERE id = $1`, [
      s.json.id,
    ]);
    const wdb = workerDb(2);
    try {
      const n = await reconcileShipments(wdb, fake, 6);
      expect(n).toBeGreaterThanOrEqual(1);
    } finally {
      await wdb.close();
    }
    expect(fake.calls).toContain('track');
    expect(
      (await h.sup.query(`SELECT status FROM shipments WHERE id = $1`, [s.json.id])).rows[0].status,
    ).toBe('in_transit'); // fake provider reports IN TRANSIT
    await h.sup.query(`UPDATE shipments SET last_event_at = now() - interval '200 hours' WHERE id = $1`, [
      s.json.id,
    ]);
    const stuck = await h.call('GET', '/v1/admin/shipments?stuck=true', ful.token);
    expect(stuck.json.items.map((i: { id: string }) => i.id)).toContain(s.json.id);
  });
});

describe('bulk shipping', () => {
  it('ships many orders with a strategy; failures are per-order and never block the rest; large batches need MFA', async () => {
    const a = await readyOrder('cod');
    const b = await readyOrder('cod');
    const c = await readyOrder('cod', '411001');
    fake.unserviceablePins.add('411099'); // inside the owner's PIN prefix list, but the courier network says no
    const bad = await readyOrder('cod', '411099');
    // threshold 5 by default: 4 orders do not need MFA
    const job = await h.call('POST', '/v1/admin/shipments/bulk', ful1.token, {
      orderIds: [a.order.id, b.order.id, c.order.id, bad.order.id],
      strategy: 'cheapest',
    });
    expect(job.status).toBe(202);
    await new Promise((r) => setTimeout(r, 1500));
    let j = (await h.call('GET', `/v1/admin/shipments/bulk/${job.json.id}`, ful1.token)).json;
    if (j.status !== 'done') {
      await runBulkJob(deps(), job.json.id);
      j = (await h.call('GET', `/v1/admin/shipments/bulk/${job.json.id}`, ful1.token)).json;
    }
    expect([j.status, j.total, j.succeeded, j.failed]).toEqual(['done', 4, 3, 1]);
    expect(j.results.find((r: { ok: boolean }) => !r.ok)).toMatchObject({
      orderId: bad.order.id,
      code: 'NOT_SERVICEABLE',
    });
    fake.unserviceablePins.clear();
    const couriers = (
      await h.sup.query(`SELECT DISTINCT courier FROM shipments WHERE order_id = ANY($1)`, [
        [a.order.id, b.order.id, c.order.id],
      ])
    ).rows.map((r) => r.courier);
    expect(couriers).toEqual(['ValueExpress Surface']); // cheapest

    // a mixed batch: one order is not shippable (still "placed") — recorded, others proceed
    const good = await readyOrder('cod');
    const notReady = await h.placeOrder('cod');
    const job2 = await h.call('POST', '/v1/admin/shipments/bulk', ful.token, {
      orderIds: [notReady.order.id, good.order.id],
      strategy: 'fastest',
    });
    await new Promise((r) => setTimeout(r, 1500));
    let j2 = (await h.call('GET', `/v1/admin/shipments/bulk/${job2.json.id}`, ful.token)).json;
    if (j2.status !== 'done') {
      await runBulkJob(deps(), job2.json.id);
      j2 = (await h.call('GET', `/v1/admin/shipments/bulk/${job2.json.id}`, ful.token)).json;
    }
    expect([j2.succeeded, j2.failed]).toEqual([1, 1]);
    expect(j2.results.find((r: { ok: boolean }) => !r.ok).error).toMatch(/processing/);

    // above the threshold a fresh MFA session is required (spend control)
    await putSettings(ful.token, { bulkConfirmThreshold: 1 });
    const ids = [a.order.id, b.order.id];
    const guarded = await h.call('POST', '/v1/admin/shipments/bulk', ful1.token, {
      orderIds: ids,
      strategy: 'cheapest',
    });
    expect([guarded.status, guarded.json.error.code]).toEqual([403, 'MFA_REQUIRED']);
    await putSettings(ful.token, { bulkConfirmThreshold: 5 });
  });

  it('manifests are provider documents proxied through the API', async () => {
    const o = await readyOrder('cod');
    const s = await h.call('POST', `/v1/admin/orders/${o.order.id}/ship`, ful.token, {});
    const m = await h.call('POST', '/v1/admin/shipments/manifest', ful.token, { shipmentIds: [s.json.id] });
    expect(m.headers.get('content-type')).toBe('application/pdf');
    expect(m.text).toContain('manifest');
  });
});

describe('experience: worker bookkeeping and database role', () => {
  it('the worker role can activate due releases (least-privilege role is enough)', async () => {
    const wdb = workerDb(2);
    try {
      const n = await wdb.tx({ kind: 'system', reason: 'test' }, (c) => exp.activateDueReleases(c));
      expect(typeof n).toBe('number');
    } finally {
      await wdb.close();
    }
  });
});
