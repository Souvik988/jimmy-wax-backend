/**
 * Open-model (arrival-rate) checkout journey load test against a RUNNING commerce-api:
 *   cart PUT → quote POST → order POST (idempotent) for synthetic customers; then verifies business invariants from the DB.
 *   AUTH_SIGNING_PRIVATE_KEY=<same PEM the API uses> API=http://127.0.0.1:4000 TEST_DB_NAME=jimmywax_dev \
 *   tsx scripts/loadtest-checkout.ts <iterationsPerSecond> <seconds> [users] [hotSku=false]
 * LOCAL SMOKE ONLY: generator, API and database share one laptop.
 */
import { randomUUID } from 'node:crypto';
import { loadConfig } from '@jw/config';
import { Fixtures, superPool } from '@jw/test-support';
import { createTokenService } from '../apps/commerce-api/src/auth.ts';

const [rpsArg = '20', secArg = '20', usersArg = '300', hot = 'false'] = process.argv.slice(2);
const rate = Number(rpsArg),
  seconds = Number(secArg),
  nUsers = Number(usersArg);
const API = process.env.API ?? 'http://127.0.0.1:4000';
const V = 'twinkle-shine-leather-polish';
const V2 = 'polish-cloth-kit';

const cfg = loadConfig({
  NODE_ENV: 'test',
  DATABASE_URL: 'postgres://x:y@h/z',
  AUTH_SIGNING_PRIVATE_KEY: process.env.AUTH_SIGNING_PRIVATE_KEY,
  AUTH_TOTP_ENC_KEY: Buffer.alloc(32, 1).toString('base64'),
} as NodeJS.ProcessEnv);
const tokens = createTokenService(cfg);
const sup = superPool();
const fx = new Fixtures(sup);
await fx.resetCommerceData();
await fx.openStore({ cod_fee_paise: 2500 });
await fx.setStock(V, 1_000_000);
await fx.setStock(V2, 1_000_000);

const users: Array<{ token: string; addressId: string; busy: boolean }> = [];
for (let i = 0; i < nUsers; i++) {
  const id = await fx.user();
  const addressId = await fx.address(id, '400001');
  const { accessToken } = await tokens.sign({ userId: id, sid: randomUUID(), aal: 'aal1', client: 'app' });
  users.push({ token: accessToken, addressId, busy: false });
}

const lat: Record<string, number[]> = { cart: [], quote: [], order: [], journey: [] };
const status: Record<string, number> = {};
let started = 0,
  skipped = 0,
  inflight = 0,
  ok = 0;
const bump = (k: string) => (status[k] = (status[k] ?? 0) + 1);

async function call(
  step: string,
  method: string,
  path: string,
  token: string,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  const t = performance.now();
  const r = await fetch(API + path, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => null);
  lat[step]!.push(performance.now() - t);
  bump(`${step}:${r.status}`);
  return { status: r.status, json: j };
}

async function journey(u: (typeof users)[number], n: number) {
  const t0 = performance.now();
  const variant = hot === 'true' ? V : n % 2 ? V : V2;
  try {
    const c = await call('cart', 'PUT', `/v1/cart/lines/${variant}`, u.token, { quantity: 1 });
    if (c.status !== 200) return;
    const q = await call('quote', 'POST', '/v1/checkout/quotes', u.token, {
      addressId: u.addressId,
      paymentMethod: n % 3 ? 'cod' : 'cod',
    });
    if (q.status !== 201) return;
    const o = await call(
      'order',
      'POST',
      '/v1/orders',
      u.token,
      { quoteId: q.json.id },
      { 'idempotency-key': randomUUID() },
    );
    if (o.status === 201) ok++;
  } finally {
    lat.journey!.push(performance.now() - t0);
    u.busy = false;
    inflight--;
  }
}

const t0 = performance.now();
let n = 0,
  rr = 0;
await new Promise<void>((done) => {
  const tick = setInterval(() => {
    const el = (performance.now() - t0) / 1000;
    if (el >= seconds) {
      clearInterval(tick);
      const w = setInterval(() => {
        if (inflight === 0) {
          clearInterval(w);
          done();
        }
      }, 50);
      return;
    }
    const due = Math.floor(el * rate) - started - skipped;
    for (let i = 0; i < due; i++) {
      // find a free user (one journey per user at a time, like a real customer)
      let u: (typeof users)[number] | undefined;
      for (let k = 0; k < users.length; k++) {
        const c = users[(rr + k) % users.length]!;
        if (!c.busy) {
          u = c;
          rr = (rr + k + 1) % users.length;
          break;
        }
      }
      if (!u) {
        skipped++;
        continue;
      } // generator saturation: counted, never hidden
      u.busy = true;
      inflight++;
      started++;
      void journey(u, n++);
    }
  }, 5);
});

const q = (a: number[], p: number) =>
  a.length ? [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))]!.toFixed(1) : '-';
const dbOrders = (await sup.query(`SELECT count(*)::int n FROM orders`)).rows[0].n as number;
const led =
  await sup.query(`SELECT p.variant_id, p.on_hand, p.reserved, coalesce(sum(m.delta_on_hand),0)::int AS led_on_hand, coalesce(sum(m.delta_reserved),0)::int AS led_res
  FROM inventory_positions p LEFT JOIN inventory_movements m ON m.variant_id = p.variant_id GROUP BY 1,2,3`);
const sold = (await sup.query(`SELECT coalesce(sum(quantity),0)::int n FROM order_items`)).rows[0]
  .n as number;
const consumed = 2_000_000 - (led.rows.reduce((a, r) => a + r.on_hand, 0) as number);
const report = {
  targetIterationsPerSec: rate,
  seconds,
  users: nUsers,
  hotSku: hot === 'true',
  journeysStarted: started,
  skippedBecauseAllUsersBusy: skipped,
  ordersCreated201: ok,
  ordersInDb: dbOrders,
  achievedOrdersPerSec: +(ok / seconds).toFixed(1),
  statusCounts: status,
  latencyMs: Object.fromEntries(
    Object.entries(lat).map(([k, v]) => [
      k,
      { n: v.length, p50: q(v, 0.5), p95: q(v, 0.95), p99: q(v, 0.99) },
    ]),
  ),
  invariants: {
    ordersMatchHttp201: dbOrders === ok,
    unitsSoldMatchStockConsumed: sold === consumed,
    ledgerEqualsPosition: led.rows.every((r) => r.on_hand === r.led_on_hand && r.reserved === r.led_res),
  },
};
console.log(JSON.stringify(report, null, 1));
await sup.end();
