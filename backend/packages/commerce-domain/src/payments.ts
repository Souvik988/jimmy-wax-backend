import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Db, PoolClient } from '@jw/database';
import { PG, pgCode } from '@jw/database';
import { AppError } from '@jw/contracts';
import type { PaymentGateway, ProviderPaymentStatus, VerifiedWebhook } from '@jw/integrations';
import { settleReservations } from './inventory.ts';

interface AttemptRow {
  id: string;
  order_id: string;
  provider: string;
  status: string;
  amount_paise: number;
  currency: string;
  provider_order_id: string | null;
}

export interface AttemptDto {
  id: string;
  orderId: string;
  status: string;
  amountPaise: number;
  currency: 'INR';
  provider: string;
  clientConfig: Record<string, string> | null;
}

const toDto = (a: AttemptRow, cfg: Record<string, string> | null): AttemptDto => ({
  id: a.id,
  orderId: a.order_id,
  status: a.status,
  amountPaise: a.amount_paise,
  currency: 'INR',
  provider: a.provider,
  clientConfig: cfg,
});

/**
 * Creates (or resumes) the single live payment attempt for an online order.
 * 1) tx: persist the LOCAL attempt first (unique live-attempt index blocks parallel attempts)
 * 2) call provider OUTSIDE any transaction/lock, using the attempt id as the provider receipt
 * 3) tx: record provider ids. If step 2 timed out after the provider accepted, the next call
 *    finds the order by receipt instead of creating a second one.
 */
export async function createPaymentAttempt(
  db: Db,
  gateway: PaymentGateway,
  userId: string,
  orderId: string,
  idempotencyKey: string,
): Promise<AttemptDto> {
  const attempt = await db.tx({ kind: 'customer', userId }, async (c) => {
    const o = await c.query(`SELECT * FROM orders WHERE id = $1 AND user_id = $2 FOR UPDATE`, [
      orderId,
      userId,
    ]);
    if (o.rowCount === 0) throw new AppError('NOT_FOUND', 'Order not found');
    const order = o.rows[0];
    if (order.payment_method !== 'online' || order.status !== 'pending_payment') {
      throw new AppError('ILLEGAL_STATE', 'This order is not awaiting online payment');
    }
    const res = await c.query(
      `SELECT 1 FROM stock_reservations WHERE order_id = $1 AND status = 'active' AND (expires_at IS NULL OR expires_at > now()) LIMIT 1`,
      [orderId],
    );
    if (res.rowCount === 0)
      throw new AppError('ILLEGAL_STATE', 'The payment window for this order has ended');
    const live = await c.query<AttemptRow>(
      `SELECT * FROM payment_attempts WHERE order_id = $1 AND status IN ('created','pending','authorized')`,
      [orderId],
    );
    if (live.rows[0]) return live.rows[0];
    const ins = await c.query<AttemptRow>(
      `INSERT INTO payment_attempts (order_id, provider, amount_paise, currency, idempotency_key, status)
       VALUES ($1, $2, $3, 'INR', $4, 'created') RETURNING *`,
      [orderId, gateway.name, order.total_paise, idempotencyKey],
    );
    return ins.rows[0]!;
  });

  if (attempt.provider_order_id) return toDto(attempt, gateway.publicConfigFor(attempt.provider_order_id));

  let providerOrderId: string;
  let cfg: Record<string, string>;
  const existing = await gateway.findOrderByReceipt(attempt.id).catch(() => null);
  if (existing) {
    providerOrderId = existing.providerOrderId;
    cfg = gateway.publicConfigFor(providerOrderId);
  } else {
    const created = await gateway.createOrder({
      receipt: attempt.id,
      amountPaise: attempt.amount_paise,
      currency: 'INR',
    });
    providerOrderId = created.providerOrderId;
    cfg = created.publicConfig;
  }
  const saved = await db.tx({ kind: 'customer', userId }, async (c) => {
    const r = await c.query<AttemptRow>(
      `UPDATE payment_attempts SET provider_order_id = $2, status = CASE WHEN status = 'created' THEN 'pending' ELSE status END, updated_at = now()
        WHERE id = $1 AND provider_order_id IS NULL RETURNING *`,
      [attempt.id, providerOrderId],
    );
    if (r.rows[0]) return r.rows[0];
    const cur = await c.query<AttemptRow>(`SELECT * FROM payment_attempts WHERE id = $1`, [attempt.id]);
    return cur.rows[0]!;
  });
  return toDto(saved, cfg);
}

export interface ConfirmInput {
  providerOrderId: string;
  providerPaymentId: string;
  signature: string;
}

/**
 * Finishes a payment from the checkout SDK callback without waiting for a webhook (webhooks cannot reach a
 * development machine, and may lag in production). The client only supplies references; the outcome is
 * decided by (1) the signature proving the payment belongs to this attempt and (2) the PROVIDER's own order
 * status, fetched server-side. The result is applied through the same idempotent path as webhooks.
 */
export async function confirmPaymentAttempt(
  db: Db,
  gateway: PaymentGateway,
  userId: string,
  orderId: string,
  input: ConfirmInput,
): Promise<{ orderStatus: string; paymentStatus: string; attemptStatus: string }> {
  const attempt = await db.tx({ kind: 'customer', userId }, async (c) => {
    const r = await c.query<AttemptRow>(
      `SELECT a.* FROM payment_attempts a JOIN orders o ON o.id = a.order_id
        WHERE a.order_id = $1 AND o.user_id = $2 AND a.provider_order_id = $3`,
      [orderId, userId, input.providerOrderId],
    );
    return r.rows[0];
  });
  if (!attempt) throw new AppError('NOT_FOUND', 'Payment attempt not found for this order');
  if (!gateway.verifyCheckoutSignature(input.providerOrderId, input.providerPaymentId, input.signature)) {
    throw new AppError('UNAUTHENTICATED', 'Payment signature is not valid');
  }
  const found = await gateway.getOrder(input.providerOrderId);
  if (!found) throw new AppError('UNAVAILABLE', 'The payment provider could not confirm the payment yet');
  if (found.status !== 'created') {
    await db.tx({ kind: 'system', reason: 'payment_confirm' }, (c) =>
      applyProviderFact(
        c,
        attempt.provider,
        input.providerOrderId,
        input.providerPaymentId,
        found.status,
        found.amountPaise,
        found.currency,
      ),
    );
  }
  return db.tx({ kind: 'customer', userId }, async (c) => {
    const r = await c.query(
      `SELECT o.status AS order_status, o.payment_status, a.status AS attempt_status
         FROM orders o JOIN payment_attempts a ON a.order_id = o.id
        WHERE o.id = $1 AND o.user_id = $2 AND a.id = $3`,
      [orderId, userId, attempt.id],
    );
    const row = r.rows[0]!;
    return {
      orderStatus: row.order_status,
      paymentStatus: row.payment_status,
      attemptStatus: row.attempt_status,
    };
  });
}

/**
 * Hosted (redirect) checkout return: the browser arrives from the provider carrying no session, so the
 * signature plus the provider's own order status are the only authority. Resolves the order from OUR attempt
 * row (never from anything the browser said), applies the fact, and reports the server-confirmed state.
 */
export async function confirmCheckoutReturn(
  db: Db,
  gateway: PaymentGateway,
  input: ConfirmInput,
): Promise<{ orderId: string; paymentStatus: string } | null> {
  const attempt = await db.tx({ kind: 'system', reason: 'payment_return' }, async (c) => {
    const r = await c.query<AttemptRow>(
      `SELECT * FROM payment_attempts WHERE provider = $1 AND provider_order_id = $2`,
      [gateway.name, input.providerOrderId],
    );
    return r.rows[0];
  });
  if (!attempt) return null;
  if (!gateway.verifyCheckoutSignature(input.providerOrderId, input.providerPaymentId, input.signature)) {
    throw new AppError('UNAUTHENTICATED', 'Payment signature is not valid');
  }
  const found = await gateway.getOrder(input.providerOrderId).catch(() => null);
  if (found && found.status !== 'created') {
    await db.tx({ kind: 'system', reason: 'payment_return' }, (c) =>
      applyProviderFact(
        c,
        attempt.provider,
        input.providerOrderId,
        input.providerPaymentId,
        found.status,
        found.amountPaise,
        found.currency,
      ),
    );
  }
  const state = await db.tx({ kind: 'system', reason: 'payment_return' }, async (c) => {
    const r = await c.query(`SELECT payment_status FROM orders WHERE id = $1`, [attempt.order_id]);
    return r.rows[0]?.payment_status as string | undefined;
  });
  return { orderId: attempt.order_id, paymentStatus: state ?? 'pending' };
}

/** Resolves our order from a provider order id (used to land a failed/cancelled return on the right page). */
export async function orderIdForProviderOrder(
  db: Db,
  provider: string,
  providerOrderId: string,
): Promise<string | null> {
  return db.tx({ kind: 'system', reason: 'payment_return' }, async (c) => {
    const r = await c.query(
      `SELECT order_id FROM payment_attempts WHERE provider = $1 AND provider_order_id = $2`,
      [provider, providerOrderId],
    );
    return (r.rows[0]?.order_id as string | undefined) ?? null;
  });
}

// ------------------------------------------------------------------ hosted checkout hand-off (mobile app)
/**
 * The app cannot POST a form to the provider, so the API mints a short-lived signed link to a tiny page that does it.
 * The token only names an order and an expiry; everything shown on the page is read from our own database.
 */
export function signHostedToken(secret: string, orderId: string, expiresAtSec: number): string {
  const mac = createHmac('sha256', `hosted-checkout|${secret}`)
    .update(`${orderId}|${expiresAtSec}`)
    .digest('hex');
  return `${orderId}.${expiresAtSec}.${mac}`;
}

export function verifyHostedToken(
  secret: string,
  token: string,
  nowSec = Math.floor(Date.now() / 1000),
): string | null {
  const m = /^([0-9a-f-]{36})\.(\d{9,12})\.([0-9a-f]{64})$/.exec(token);
  if (!m) return null;
  const want = Buffer.from(signHostedToken(secret, m[1]!, Number(m[2])));
  const got = Buffer.from(token);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  return Number(m[2]) >= nowSec ? m[1]! : null;
}

export interface HostedCheckoutData {
  providerOrderId: string;
  keyId: string;
  orderId: string;
  orderNumber: string;
  brandName: string;
  name: string | null;
  contact: string | null;
  email: string | null;
}

/** Everything the hand-off page needs, or null when the order can no longer be paid. */
export async function loadHostedCheckout(
  db: Db,
  gateway: PaymentGateway,
  orderId: string,
): Promise<HostedCheckoutData | null> {
  return db.tx({ kind: 'system', reason: 'payment_hosted_page' }, async (c) => {
    const r = await c.query(
      `SELECT o.id, o.order_number, o.address_snapshot, u.email, a.provider_order_id,
              (SELECT brand_name FROM public.store_settings WHERE id = 1) AS brand_name
         FROM orders o
         JOIN auth.users u ON u.id = o.user_id
         JOIN payment_attempts a ON a.order_id = o.id AND a.status IN ('created','pending','authorized')
        WHERE o.id = $1 AND o.status = 'pending_payment' AND o.payment_method = 'online'
          AND a.provider = $2 AND a.provider_order_id IS NOT NULL
        ORDER BY a.created_at DESC LIMIT 1`,
      [orderId, gateway.name],
    );
    const row = r.rows[0];
    if (!row) return null;
    const snap = (row.address_snapshot ?? {}) as Record<string, unknown>;
    const cfg = gateway.publicConfigFor(row.provider_order_id as string);
    return {
      providerOrderId: row.provider_order_id as string,
      keyId: cfg.keyId ?? '',
      orderId: row.id as string,
      orderNumber: row.order_number as string,
      brandName: (row.brand_name as string | null) ?? 'JIMMY & WAX',
      name: typeof snap.name === 'string' ? snap.name : null,
      contact: typeof snap.phone === 'string' ? snap.phone : null,
      email: (row.email as string | null) ?? null,
    };
  });
}

// ------------------------------------------------------------------ webhooks
export async function ingestWebhook(
  db: Db,
  gateway: PaymentGateway,
  raw: Buffer,
  headers: Record<string, string | string[] | undefined>,
): Promise<{ eventId: number | null; duplicate: boolean }> {
  const v = gateway.verifyWebhook(raw, headers); // throws on bad signature → caller returns 400/401
  const normalized = {
    providerOrderId: v.providerOrderId,
    providerPaymentId: v.providerPaymentId,
    status: v.status,
    amountPaise: v.amountPaise,
    currency: v.currency,
  };
  // Durable intake BEFORE acknowledging; unique (provider, event id) absorbs redeliveries.
  const id = await db.tx({ kind: 'system', reason: 'webhook_intake' }, async (c) => {
    const r = await c.query(
      `INSERT INTO payment_events (provider, provider_event_id, event_type, payload, signature_verified)
       VALUES ($1,$2,$3,$4,true) ON CONFLICT (provider, provider_event_id) DO NOTHING RETURNING id`,
      [gateway.name, v.providerEventId, v.eventType, JSON.stringify({ normalized, raw: v.payload })],
    );
    return r.rows[0]?.id as number | undefined;
  });
  return { eventId: id ?? null, duplicate: id === undefined };
}

const RANK: Record<string, number> = { created: 0, pending: 1, failed: 2, authorized: 3, captured: 9 };

/** Applies one stored event. Safe to call repeatedly / concurrently: row lock + state guards. */
export async function processPaymentEvent(
  db: Db,
  eventId: number,
): Promise<'processed' | 'ignored' | 'failed' | 'skipped'> {
  return db.tx({ kind: 'system', reason: 'payment_event' }, async (c) => {
    const e = await c.query(
      `SELECT * FROM payment_events WHERE id = $1 AND status IN ('received','failed') FOR UPDATE SKIP LOCKED`,
      [eventId],
    );
    if (e.rowCount === 0) return 'skipped';
    const ev = e.rows[0];
    const n = ev.payload.normalized as {
      providerOrderId?: string;
      providerPaymentId?: string;
      status?: ProviderPaymentStatus;
      amountPaise?: number;
      currency?: string;
    };
    let outcome: 'processed' | 'ignored' | 'failed' = 'ignored';
    let err: string | null = null;
    if (n.providerOrderId && n.status) {
      const r = await applyProviderFact(
        c,
        ev.provider,
        n.providerOrderId,
        n.providerPaymentId ?? null,
        n.status,
        n.amountPaise,
        n.currency,
      );
      outcome = r.outcome;
      err = r.error ?? null;
    }
    await c.query(
      `UPDATE payment_events SET status = $2, attempts = attempts + 1, last_error = $3, processed_at = now() WHERE id = $1`,
      [eventId, outcome, err],
    );
    return outcome;
  });
}

/** Provider truth → local state. Shared by webhooks and reconciliation. */
export async function applyProviderFact(
  c: PoolClient,
  provider: string,
  providerOrderId: string,
  providerPaymentId: string | null,
  status: ProviderPaymentStatus,
  amountPaise: number | undefined,
  currency: string | undefined,
): Promise<{ outcome: 'processed' | 'ignored' | 'failed'; error?: string }> {
  // LOCK ORDER (global rule): order row first, then its attempt/reservation rows. Every code path
  // (cancel, expiry sweep, webhook, reconciliation) follows it, so they cannot deadlock each other.
  const probe = await c.query<{ order_id: string }>(
    `SELECT order_id FROM payment_attempts WHERE provider = $1 AND provider_order_id = $2`,
    [provider, providerOrderId],
  );
  if (!probe.rows[0]) return { outcome: 'ignored', error: 'unknown provider reference' };
  const o = await c.query(`SELECT * FROM orders WHERE id = $1 FOR UPDATE`, [probe.rows[0].order_id]);
  const order = o.rows[0];
  const a = await c.query<AttemptRow>(
    `SELECT * FROM payment_attempts WHERE provider = $1 AND provider_order_id = $2 FOR UPDATE`,
    [provider, providerOrderId],
  );
  const attempt = a.rows[0]!;

  if (status === 'captured') {
    if (attempt.status === 'captured') return { outcome: 'ignored' }; // duplicate effect suppressed
    if (amountPaise !== attempt.amount_paise || (currency ?? 'INR') !== attempt.currency) {
      await c.query(
        `UPDATE orders SET payment_status = 'exception' WHERE id = $1 AND payment_status <> 'paid'`,
        [order.id],
      );
      await c.query(
        `INSERT INTO outbox (aggregate_type, aggregate_id, event_type, payload) VALUES ('order',$1,'payment.mismatch',$2)`,
        [order.id, { orderId: order.id, expected: attempt.amount_paise, got: amountPaise ?? null }],
      );
      return { outcome: 'failed', error: 'amount_or_currency_mismatch' };
    }
    await c.query(
      `UPDATE payment_attempts SET status = 'captured', provider_payment_id = $2, updated_at = now() WHERE id = $1`,
      [attempt.id, providerPaymentId],
    );
    const reservationLive =
      (
        await c.query(`SELECT 1 FROM stock_reservations WHERE order_id = $1 AND status = 'active' LIMIT 1`, [
          order.id,
        ])
      ).rowCount! > 0;
    if (order.status === 'pending_payment' && reservationLive) {
      await settleReservations(c, order.id, 'committed', null);
      await c.query(`UPDATE orders SET status = 'placed', payment_status = 'paid' WHERE id = $1`, [order.id]);
      await c.query(
        `UPDATE payment_records SET status = 'captured', provider_reference = $2, updated_at = now() WHERE order_id = $1`,
        [order.id, providerPaymentId],
      );
      await c.query(
        `INSERT INTO outbox (aggregate_type, aggregate_id, event_type, payload) VALUES ('order',$1,'payment.captured',$2)`,
        [order.id, { orderId: order.id, userId: order.user_id }],
      );
    } else {
      // Money arrived but the order cannot be fulfilled (expired/cancelled/stock released): never ship
      // phantom inventory. Flag it and queue a full refund for the finance workflow.
      await c.query(`UPDATE orders SET payment_status = 'exception' WHERE id = $1`, [order.id]);
      await c.query(
        `INSERT INTO refunds (order_id, payment_attempt_id, amount_paise, reason, idempotency_key)
         VALUES ($1,$2,$3,'late_capture_unfulfillable',$4) ON CONFLICT (order_id, idempotency_key) DO NOTHING`,
        [order.id, attempt.id, attempt.amount_paise, `late:${attempt.id}`],
      );
      await c.query(
        `INSERT INTO outbox (aggregate_type, aggregate_id, event_type, payload) VALUES ('order',$1,'payment.late_capture',$2)`,
        [order.id, { orderId: order.id, attemptId: attempt.id }],
      );
    }
    return { outcome: 'processed' };
  }

  // authorized / failed: never downgrade past what we already know; never mark the order paid.
  const target = status === 'failed' ? 'failed' : status === 'authorized' ? 'authorized' : 'pending';
  if ((RANK[target] ?? 0) <= (RANK[attempt.status] ?? 0) && attempt.status !== 'created')
    return { outcome: 'ignored' };
  if (attempt.status === 'captured') return { outcome: 'ignored' };
  await c.query(
    `UPDATE payment_attempts SET status = $2, provider_payment_id = coalesce($3, provider_payment_id), updated_at = now() WHERE id = $1`,
    [attempt.id, target, providerPaymentId],
  );
  if (target === 'failed') {
    await c.query(
      `INSERT INTO outbox (aggregate_type, aggregate_id, event_type, payload) VALUES ('order',$1,'payment.failed',$2)`,
      [order.id, { orderId: order.id, userId: order.user_id }],
    );
  }
  return { outcome: 'processed' };
}

/** Polls the provider for attempts stuck in created/pending (missing webhooks, timeouts). */
export async function reconcilePendingAttempts(
  db: Db,
  gateway: PaymentGateway,
  olderThanSeconds = 120,
  limit = 50,
): Promise<number> {
  const rows = await db.tx(
    { kind: 'system', reason: 'reconcile_list' },
    async (c) =>
      (
        await c.query<AttemptRow>(
          `SELECT * FROM payment_attempts WHERE provider = $1 AND status IN ('created','pending','authorized')
         AND updated_at < now() - make_interval(secs => $2) ORDER BY updated_at LIMIT $3`,
          [gateway.name, olderThanSeconds, limit],
        )
      ).rows,
  );
  let changed = 0;
  for (const a of rows) {
    const found = a.provider_order_id
      ? await gateway.getOrder(a.provider_order_id).catch(() => null)
      : await gateway.findOrderByReceipt(a.id).catch(() => null);
    if (!found) continue;
    await db.tx({ kind: 'system', reason: 'reconcile_apply' }, async (c) => {
      if (!a.provider_order_id) {
        await c.query(
          `UPDATE payment_attempts SET provider_order_id = $2, status = 'pending', updated_at = now() WHERE id = $1 AND provider_order_id IS NULL`,
          [a.id, found.providerOrderId],
        );
      }
      const r = await applyProviderFact(
        c,
        a.provider,
        found.providerOrderId,
        found.providerPaymentId ?? null,
        found.status,
        found.amountPaise,
        found.currency,
      );
      if (r.outcome === 'processed') changed++;
      await c.query(`UPDATE payment_attempts SET updated_at = now() WHERE id = $1`, [a.id]);
    });
  }
  return changed;
}

export { PG, pgCode };
export type { VerifiedWebhook };

/** Safety net: process stored events that were ingested but not yet applied (crash / restart). */
export async function processPendingPaymentEvents(db: Db, limit = 100): Promise<number> {
  const ids = await db.tx({ kind: 'system', reason: 'payment_event_sweep' }, async (c) =>
    (
      await c.query<{ id: number }>(
        `SELECT id FROM payment_events WHERE status IN ('received','failed') AND attempts < 10 ORDER BY id LIMIT $1`,
        [limit],
      )
    ).rows.map((r) => r.id),
  );
  let n = 0;
  for (const id of ids) if ((await processPaymentEvent(db, id)) !== 'skipped') n++;
  return n;
}
