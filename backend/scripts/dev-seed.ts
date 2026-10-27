/**
 * LOCAL DEVELOPMENT DATA ONLY (synthetic customers, synthetic stock). Never run against a real project.
 *   TEST_DB_NAME=jimmywax_dev tsx scripts/dev-seed.ts
 * Creates 3 synthetic customers with COD/online orders and sets demo stock + serviceable PINs.
 */
import { randomUUID } from 'node:crypto';
import { Fixtures, apiDb, superPool } from '@jw/test-support';
import { createQuote, placeOrder, setLine } from '../packages/commerce-domain/src/index.ts';

async function main() {
  const sup = superPool();
  const fx = new Fixtures(sup);
  const db = apiDb(4);
  const flags = { checkout: true, cod: true, onlinePayments: true };
  await fx.setStock('twinkle-shine-leather-polish', 40);
  await fx.setStock('polish-cloth-kit', 25);
  await fx.openStore({ cod_fee_paise: 2500 }); // owner-confirmed COD handling fee
  for (const [i, method, variant, qty] of [
    [1, 'cod', 'twinkle-shine-leather-polish', 2],
    [2, 'cod', 'polish-cloth-kit', 1],
    [3, 'online', 'twinkle-shine-leather-polish', 1],
  ] as const) {
    const u = await fx.user(`customer${i}@example.test`);
    const a = await fx.address(u);
    const actor = { kind: 'customer' as const, userId: u };
    await db.tx(actor, (c) => setLine(c, { userId: u }, variant, qty));
    const q = await db.tx(actor, (c) =>
      createQuote(c, u, { addressId: a, paymentMethod: method }, { flags }),
    );
    await db.tx(actor, (c) => placeOrder(c, u, { quoteId: q.id, idempotencyKey: randomUUID() }, { flags }));
  }
  // leave the store in its safe default: checkout OFF until an operator activates it
  await sup.query(`UPDATE store_settings SET checkout_enabled = false, checkout_policy_confirmed = false`);
  console.log('Seeded synthetic customers/orders. Create an operator with scripts/create-admin.ts');
  await db.close();
  await sup.end();
}
main();
