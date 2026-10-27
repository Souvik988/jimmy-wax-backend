import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { createDb, type Db } from '@jw/database';

export const TEST_DB = process.env.TEST_DB_NAME ?? 'jimmywax_test';
const host = `127.0.0.1:${process.env.PG_HOST_PORT ?? '54422'}`;
export const adminUrl = `postgres://postgres:postgres@${host}/${TEST_DB}`;
export const apiUrl = `postgres://jw_api_login:jw_api_dev@${host}/${TEST_DB}`;
export const experienceUrl = `postgres://jw_experience_login:jw_experience_dev@${host}/${TEST_DB}`;
export const workerUrl = `postgres://jw_worker_login:jw_worker_dev@${host}/${TEST_DB}`;

export function apiDb(poolMax = 10): Db {
  return createDb({
    url: apiUrl,
    poolMax,
    statementTimeoutMs: 10_000,
    lockTimeoutMs: 5_000,
    appName: 'test-api',
  });
}

export function experienceDb(poolMax = 5): Db {
  return createDb({
    url: experienceUrl,
    poolMax,
    statementTimeoutMs: 5_000,
    lockTimeoutMs: 1_000,
    appName: 'test-experience',
  });
}

export function workerDb(poolMax = 10): Db {
  return createDb({
    url: workerUrl,
    poolMax,
    statementTimeoutMs: 10_000,
    lockTimeoutMs: 5_000,
    appName: 'test-worker',
  });
}

/** Superuser pool for FIXTURES and invariant assertions only (bypasses RLS on purpose). */
export function superPool(): pg.Pool {
  return new pg.Pool({ connectionString: adminUrl, max: 4 });
}

export { conforms, specSha256, SPEC_PATH } from './contract.ts';

export class Fixtures {
  constructor(readonly sup: pg.Pool) {}

  async user(email = `u-${randomUUID().slice(0, 8)}@example.test`): Promise<string> {
    const r = await this.sup.query(`INSERT INTO auth.users (email) VALUES ($1) RETURNING id`, [email]);
    return r.rows[0].id;
  }
  async address(userId: string, postalCode = '400001'): Promise<string> {
    const r = await this.sup.query(
      `INSERT INTO addresses (user_id, recipient_name, phone, line1, city, state, postal_code, is_default)
       VALUES ($1,'Test Buyer','9999999999','1 Test Street','Mumbai','Maharashtra',$2,true) RETURNING id`,
      [userId, postalCode],
    );
    return r.rows[0].id;
  }
  /** Sets stock the way operations would: through a ledger movement, so ledger == position. */
  async setStock(variantId: string, onHand: number) {
    await this.sup.query(
      `WITH old AS (SELECT on_hand, reserved FROM inventory_positions WHERE variant_id = $1 FOR UPDATE),
            upd AS (UPDATE inventory_positions SET on_hand = $2, reserved = 0, version = version + 1 WHERE variant_id = $1 RETURNING 1)
       INSERT INTO inventory_movements (variant_id, kind, delta_on_hand, delta_reserved, reason)
       SELECT $1, 'adjustment', $2 - old.on_hand, -old.reserved, 'test fixture' FROM old, upd`,
      [variantId, onHand],
    );
  }
  async openStore(over: Record<string, unknown> = {}) {
    const s = {
      checkout_enabled: true,
      checkout_policy_confirmed: true,
      cod_enabled: true,
      online_payments_enabled: true,
      payment_window_minutes: 30,
      cod_max_order_paise: 500000,
      free_shipping_threshold_paise: 200000,
      shipping_fee_paise: 4000,
      cod_fee_paise: 0,
      gst_rate_bps: 1800,
      tax_inclusive: true,
      return_window_days: null,
      orders_paused: false,
      pause_message: '',
      ...over,
    };
    await this.sup.query(
      `UPDATE store_settings SET checkout_enabled=$1, checkout_policy_confirmed=$2, cod_enabled=$3, online_payments_enabled=$4,
        payment_window_minutes=$5, cod_max_order_paise=$6, free_shipping_threshold_paise=$7, shipping_fee_paise=$8,
        cod_fee_paise=$9, gst_rate_bps=$10, tax_inclusive=$11, return_window_days=$12,
        merchant_legal_name=null, merchant_gstin=null, merchant_state=null, merchant_address=null,
        checkout_authority='express' WHERE id = 1`,
      [
        s.checkout_enabled,
        s.checkout_policy_confirmed,
        s.cod_enabled,
        s.online_payments_enabled,
        s.payment_window_minutes,
        s.cod_max_order_paise,
        s.free_shipping_threshold_paise,
        s.shipping_fee_paise,
        s.cod_fee_paise,
        s.gst_rate_bps,
        s.tax_inclusive,
        s.return_window_days,
      ],
    );
    await this.sup.query(
      `INSERT INTO serviceable_pin_prefixes (prefix) VALUES ('400'), ('411'), ('110') ON CONFLICT DO NOTHING`,
    );
  }
  async stockOf(variantId: string) {
    const r = await this.sup.query(
      `SELECT on_hand, reserved FROM inventory_positions WHERE variant_id = $1`,
      [variantId],
    );
    return { onHand: r.rows[0].on_hand as number, reserved: r.rows[0].reserved as number };
  }
  async resetCommerceData() {
    await this.sup.query(`
      TRUNCATE outbox, inbox, payment_events, refunds, payment_attempts, stock_reservations, payment_records,
               order_items, orders, checkout_quotes, idempotency_keys, cart_lines, carts, addresses,
               inventory_movements, notifications, shipment_events, shipments, return_items, returns, invoices,
               invoice_counters, review_media, device_tokens, email_outbox RESTART IDENTITY CASCADE`);
    await this.sup.query(`UPDATE inventory_positions SET on_hand = 0, reserved = 0`);
  }
}
