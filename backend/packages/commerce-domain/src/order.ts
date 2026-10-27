import { randomUUID } from 'node:crypto';
import type { PoolClient } from '@jw/database';
import { AppError } from '@jw/contracts';
import { lockCart } from './cart.ts';
import { redeemCoupon } from './coupons.ts';
import { createReservations, restockCommittedOrder, settleReservations, takeStock } from './inventory.ts';
import { canonicalHash } from './money.ts';
import { assertCheckoutOpen, loadSettings, type Flags, type QuoteLine } from './quote.ts';

export interface OrderDto {
  id: string;
  orderNumber: string;
  status: string;
  paymentStatus: string;
  paymentMethod: 'cod' | 'online';
  currency: 'INR';
  subtotalPaise: number;
  discountPaise: number;
  couponCode: string | null;
  shippingDiscountPaise: number;
  taxPaise: number;
  shippingPaise: number;
  codFeePaise: number;
  taxInclusive: boolean;
  taxBreakdown: unknown;
  totalPaise: number;
  address: Record<string, string>;
  lines: Array<
    Omit<QuoteLine, 'sku' | 'productId'> & { sku: string; productId: string; orderItemId: number }
  >;
  createdAt: string;
  version: number;
}

export async function loadOrder(c: PoolClient, orderId: string, userId?: string): Promise<OrderDto> {
  const o = await c.query(
    `SELECT * FROM orders WHERE id = $1 ${userId ? 'AND user_id = $2' : ''}`,
    userId ? [orderId, userId] : [orderId],
  );
  if (o.rowCount === 0) throw new AppError('NOT_FOUND', 'Order not found');
  const items = await c.query(`SELECT * FROM order_items WHERE order_id = $1 ORDER BY id`, [orderId]);
  const x = o.rows[0];
  return {
    id: x.id,
    orderNumber: x.order_number,
    status: x.status,
    paymentStatus: x.payment_status,
    paymentMethod: x.payment_method,
    currency: 'INR',
    subtotalPaise: x.subtotal_paise,
    discountPaise: x.discount_paise,
    couponCode: x.coupon_code ?? null,
    shippingDiscountPaise: x.shipping_discount_paise ?? 0,
    taxPaise: x.tax_paise,
    shippingPaise: x.shipping_paise,
    codFeePaise: x.cod_fee_paise,
    taxInclusive: x.tax_inclusive,
    taxBreakdown: x.tax_breakdown,
    totalPaise: x.total_paise,
    address: x.address_snapshot,
    lines: items.rows.map((i) => ({
      orderItemId: Number(i.id),
      variantId: i.variant_id,
      productId: i.product_id,
      sku: i.sku,
      productName: i.product_name,
      variantTitle: i.variant_title,
      assetPath: i.asset_path,
      unitPricePaise: i.unit_price_paise,
      quantity: i.quantity,
      lineTotalPaise: i.line_total_paise,
      discountPaise: i.discount_paise ?? 0,
    })),
    createdAt: new Date(x.created_at).toISOString(),
    version: x.version,
  };
}

export interface PlacedResult {
  status: number;
  body: OrderDto;
  replayed: boolean;
}

/**
 * THE order transaction (single authority; see ADR-001). One short PostgreSQL transaction:
 *   idempotency claim → quote validation → price/active re-check → stock take (deterministic order)
 *   → order + immutable line snapshot → payment record → cart consumption (quoted lines only)
 *   → outbox event → idempotency completion.
 * No network call to any provider happens inside it.
 */
export async function placeOrder(
  c: PoolClient,
  userId: string,
  input: { quoteId: string; idempotencyKey: string },
  deps: { flags: Flags },
): Promise<PlacedResult> {
  const scope = `order:${userId}`;
  const requestHash = canonicalHash({ quoteId: input.quoteId });

  // 1. Claim the key. A concurrent duplicate blocks here until we commit, then sees our row.
  const claim = await c.query(
    `INSERT INTO idempotency_keys (scope, key, request_hash) VALUES ($1, $2, $3)
     ON CONFLICT (scope, key) DO NOTHING RETURNING 1`,
    [scope, input.idempotencyKey, requestHash],
  );
  if (claim.rowCount === 0) {
    const prior = await c.query(`SELECT * FROM idempotency_keys WHERE scope = $1 AND key = $2`, [
      scope,
      input.idempotencyKey,
    ]);
    const p = prior.rows[0];
    if (p.request_hash !== requestHash) {
      throw new AppError(
        'DUPLICATE_REQUEST_MISMATCH',
        'This idempotency key was already used with a different request',
      );
    }
    if (p.state !== 'completed')
      throw new AppError('REQUEST_IN_PROGRESS', 'The original request is still being processed');
    return { status: p.response_status, body: p.response_body as OrderDto, replayed: true };
  }

  // 2. Serialise with cart mutations, then validate the quote.
  const cart = await lockCart(c, { userId }, false);
  const qr = await c.query(`SELECT * FROM checkout_quotes WHERE id = $1 AND user_id = $2 FOR UPDATE`, [
    input.quoteId,
    userId,
  ]);
  if (qr.rowCount === 0) throw new AppError('NOT_FOUND', 'Quote not found');
  const q = qr.rows[0];
  if (q.consumed_order_id) throw new AppError('QUOTE_ALREADY_USED', 'This quote has already been used');
  if (new Date(q.expires_at).getTime() <= Date.now())
    throw new AppError('QUOTE_EXPIRED', 'This quote has expired; request a new one');
  if (!cart || cart.id !== q.cart_id || cart.version !== q.cart_version) {
    throw new AppError('CART_VERSION_CONFLICT', 'Your cart changed after the quote was created');
  }

  const settings = await loadSettings(c);
  assertCheckoutOpen(settings, deps.flags, q.payment_method);
  if (settings.rules_version !== q.rules_version)
    throw new AppError('QUOTE_STALE', 'Store rules changed; request a new quote');

  const quoted = q.lines as QuoteLine[];
  // 3. Re-validate price/active against the live catalog (quote prices must still hold).
  const live = await c.query(
    `SELECT v.id, v.price_paise, v.active AS v_active, p.active AS p_active
       FROM product_variants v JOIN products p ON p.id = v.product_id WHERE v.id = ANY($1::text[])`,
    [quoted.map((l) => l.variantId)],
  );
  const liveById = new Map(live.rows.map((r) => [r.id, r]));
  const stale = quoted.filter((l) => {
    const r = liveById.get(l.variantId);
    return !r || !r.v_active || !r.p_active || r.price_paise !== l.unitPricePaise;
  });
  if (stale.length) {
    throw new AppError('QUOTE_STALE', 'Prices or availability changed; request a new quote', {
      lines: stale.map((l) => ({ variantId: l.variantId })),
    });
  }

  const orderId = randomUUID();
  const number = `JW-${new Date().toISOString().slice(0, 10).replaceAll('-', '')}-${orderId.replaceAll('-', '').slice(0, 8).toUpperCase()}`;
  const isCod = q.payment_method === 'cod';

  // 4. Stock is taken LAST (step 8) so the hot-row lock is held only for the final statements before COMMIT.
  //    COD commits immediately (decision D-7); online reserves until the payment window ends.
  const stock = quoted.map((l) => ({ variantId: l.variantId, quantity: l.quantity }));

  // 5. Order + immutable snapshot. address_id is nullable/SET NULL so address deletion never touches history.
  await c.query(
    `INSERT INTO orders (id, order_number, user_id, address_id, address_snapshot, payment_method, payment_status, status,
        subtotal_paise, discount_paise, tax_paise, shipping_paise, total_paise, quote_id, idempotency_key, rules_version,
        cod_fee_paise, tax_inclusive, tax_breakdown, placed_via, coupon_id, coupon_code, shipping_discount_paise)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,'express',$20,$21,$22)`,
    [
      orderId,
      number,
      userId,
      q.address_id,
      q.address_snapshot,
      q.payment_method,
      isCod ? 'cod_due' : 'pending',
      isCod ? 'placed' : 'pending_payment',
      q.subtotal_paise,
      q.discount_paise,
      q.tax_paise,
      q.shipping_paise,
      q.total_paise,
      q.id,
      input.idempotencyKey,
      q.rules_version,
      q.cod_fee_paise,
      q.tax_inclusive,
      q.tax_breakdown,
      q.coupon_id,
      q.coupon_code,
      q.shipping_discount_paise,
    ],
  );
  if (q.coupon_id) {
    await redeemCoupon(c, {
      couponId: q.coupon_id,
      userId,
      orderId,
      discountPaise: q.discount_paise,
      shippingDiscountPaise: q.shipping_discount_paise,
    });
  }
  for (const l of quoted) {
    await c.query(
      `INSERT INTO order_items (order_id, product_id, variant_id, sku, product_name, variant_title, asset_path, unit_price_paise, quantity, line_total_paise, discount_paise)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        orderId,
        l.productId,
        l.variantId,
        l.sku,
        l.productName,
        l.variantTitle,
        l.assetPath,
        l.unitPricePaise,
        l.quantity,
        l.lineTotalPaise,
        l.discountPaise ?? 0,
      ],
    );
  }
  await c.query(
    `INSERT INTO payment_records (order_id, provider, status, amount_paise) VALUES ($1, $2, 'pending', $3)`,
    [orderId, isCod ? 'cash_on_delivery' : 'gateway', q.total_paise],
  );
  if (!isCod) {
    await createReservations(
      c,
      orderId,
      stock,
      new Date(Date.now() + (settings.payment_window_minutes ?? 0) * 60_000),
    );
  }

  // 6. Consume ONLY the quoted quantities; lines added concurrently are untouched (cart is locked).
  for (const l of quoted) {
    await c.query(`DELETE FROM cart_lines WHERE cart_id = $1 AND variant_id = $2 AND quantity <= $3`, [
      q.cart_id,
      l.variantId,
      l.quantity,
    ]);
    await c.query(
      `UPDATE cart_lines SET quantity = quantity - $3, updated_at = now() WHERE cart_id = $1 AND variant_id = $2 AND quantity > $3`,
      [q.cart_id, l.variantId, l.quantity],
    );
  }
  await c.query(`UPDATE carts SET version = version + 1, updated_at = now() WHERE id = $1`, [q.cart_id]);
  await c.query(`UPDATE checkout_quotes SET consumed_order_id = $2 WHERE id = $1`, [q.id, orderId]);

  // 7. Outbox + idempotency completion (same transaction → atomic).
  await c.query(
    `INSERT INTO outbox (aggregate_type, aggregate_id, event_type, payload) VALUES ('order', $1, 'order.placed', $2)`,
    [
      orderId,
      { orderId, userId, orderNumber: number, paymentMethod: q.payment_method, totalPaise: q.total_paise },
    ],
  );
  const dto = await loadOrder(c, orderId, userId);
  await c.query(
    `UPDATE idempotency_keys SET state = 'completed', response_status = 201, response_body = $3,
            resource_type = 'order', resource_id = $4, completed_at = now() WHERE scope = $1 AND key = $2`,
    [scope, input.idempotencyKey, JSON.stringify(dto), orderId],
  );
  // 8. The ONLY contended step: conditional stock UPDATE + ledger row, then COMMIT. A shortage rolls everything back.
  await takeStock(c, stock, isCod ? 'commit' : 'reserve', { type: 'order', id: orderId }, userId);
  return { status: 201, body: dto, replayed: false };
}

/** Customer cancellation: only before fulfilment starts, never after payment without a refund path. */
export async function cancelOrder(
  c: PoolClient,
  userId: string,
  orderId: string,
  reason: string,
): Promise<OrderDto> {
  const r = await c.query(`SELECT * FROM orders WHERE id = $1 AND user_id = $2 FOR UPDATE`, [
    orderId,
    userId,
  ]);
  if (r.rowCount === 0) throw new AppError('NOT_FOUND', 'Order not found');
  const o = r.rows[0];
  if (o.status === 'cancelled') return loadOrder(c, orderId, userId); // idempotent
  if (!['pending_payment', 'placed'].includes(o.status)) {
    throw new AppError('ILLEGAL_STATE', 'This order can no longer be cancelled');
  }
  if (o.status === 'pending_payment') {
    await settleReservations(c, orderId, 'released', userId);
  } else {
    await restockCommittedOrder(c, orderId, 'customer_cancel', userId);
  }
  const paidOnline = o.payment_method === 'online' && o.payment_status === 'paid';
  await c.query(`UPDATE orders SET status = 'cancelled', cancel_reason = $2 WHERE id = $1`, [
    orderId,
    reason,
  ]);
  if (paidOnline) {
    await c.query(
      `INSERT INTO refunds (order_id, amount_paise, reason, idempotency_key, requested_by) VALUES ($1,$2,'order_cancelled',$3,$4)
       ON CONFLICT (order_id, idempotency_key) DO NOTHING`,
      [orderId, o.total_paise, `cancel:${orderId}`, userId],
    );
  }
  await c.query(
    `UPDATE payment_attempts SET status = 'cancelled', updated_at = now() WHERE order_id = $1 AND status IN ('created','pending')`,
    [orderId],
  );
  await c.query(
    `INSERT INTO outbox (aggregate_type, aggregate_id, event_type, payload) VALUES ('order', $1, 'order.cancelled', $2)`,
    [orderId, { orderId, userId, refund: paidOnline }],
  );
  return loadOrder(c, orderId, userId);
}
