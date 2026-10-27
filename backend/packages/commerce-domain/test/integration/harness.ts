import { randomUUID } from 'node:crypto';
import type { Db } from '@jw/database';
import { Fixtures, apiDb, superPool, workerDb } from '@jw/test-support';
import { createQuote, placeOrder, setLine, type Flags } from '../../src/index.ts';

export const V = 'twinkle-shine-leather-polish'; // ₹299.00 = 29900 paise
export const V2 = 'polish-cloth-kit'; // ₹499.00
export const flags: Flags = { checkout: true, cod: true, onlinePayments: true };

export async function boot() {
  const db = apiDb(30);
  const wdb = workerDb(10);
  const sup = superPool();
  const fx = new Fixtures(sup);
  await fx.resetCommerceData();
  await fx.openStore();
  return {
    db,
    wdb,
    sup,
    fx,
    async close() {
      await db.close();
      await wdb.close();
      await sup.end();
    },
  };
}

export const actor = (userId: string) => ({ kind: 'customer' as const, userId });

export async function addToCart(db: Db, userId: string, variant: string, qty: number) {
  return db.tx(actor(userId), (c) => setLine(c, { userId }, variant, qty));
}
export async function quote(
  db: Db,
  userId: string,
  addressId: string,
  paymentMethod: 'cod' | 'online' = 'cod',
  f: Flags = flags,
) {
  return db.tx(actor(userId), (c) => createQuote(c, userId, { addressId, paymentMethod }, { flags: f }));
}
export async function order(db: Db, userId: string, quoteId: string, key = randomUUID(), f: Flags = flags) {
  return db.tx(actor(userId), (c) => placeOrder(c, userId, { quoteId, idempotencyKey: key }, { flags: f }));
}
/** A customer who has a cart, an address and a quote, ready to place. */
export async function ready(
  h: Awaited<ReturnType<typeof boot>>,
  qty = 1,
  method: 'cod' | 'online' = 'cod',
  variant = V,
) {
  const userId = await h.fx.user();
  const addressId = await h.fx.address(userId);
  await addToCart(h.db, userId, variant, qty);
  const q = await quote(h.db, userId, addressId, method);
  return { userId, addressId, q };
}
export async function invariantStockMatchesLedger(h: Awaited<ReturnType<typeof boot>>) {
  const r = await h.sup.query(`
    SELECT p.variant_id, p.on_hand, p.reserved,
           coalesce(sum(m.delta_on_hand),0)::int AS led_on_hand, coalesce(sum(m.delta_reserved),0)::int AS led_reserved
      FROM inventory_positions p LEFT JOIN inventory_movements m ON m.variant_id = p.variant_id
     GROUP BY p.variant_id, p.on_hand, p.reserved`);
  return r.rows as Array<{
    variant_id: string;
    on_hand: number;
    reserved: number;
    led_on_hand: number;
    led_reserved: number;
  }>;
}
