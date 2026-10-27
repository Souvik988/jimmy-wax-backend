import type { Db, PoolClient } from '@jw/database';
import { AppError } from '@jw/contracts';
import type { PaymentGateway } from '@jw/integrations';
import { restockCommittedOrder, settleReservations } from './inventory.ts';
import { loadSettings } from './quote.ts';

export type AdminRole = 'support' | 'catalog' | 'fulfillment' | 'finance' | 'designer' | 'admin';
export type Permission =
  | 'orders:read'
  | 'orders:fulfil'
  | 'orders:cancel'
  | 'customers:read'
  | 'customers:write'
  | 'customers:export'
  | 'catalog:read'
  | 'catalog:write'
  | 'inventory:read'
  | 'inventory:write'
  | 'payments:read'
  | 'refunds:write'
  | 'settings:read'
  | 'settings:write'
  | 'ops:read'
  | 'ops:replay'
  | 'audit:read'
  | 'reviews:moderate'
  | 'media:read'
  | 'media:write'
  | 'experience:read'
  | 'experience:write'
  | 'experience:publish'
  | 'shipping:read'
  | 'shipping:write'
  | 'coupons:read'
  | 'coupons:write'
  | 'analytics:read'
  | 'integrations:read'
  | 'integrations:manage'
  | 'team:manage'
  | 'flags:manage';

const ALL_PERMISSIONS: Permission[] = [
  'orders:read',
  'orders:fulfil',
  'orders:cancel',
  'customers:read',
  'customers:write',
  'customers:export',
  'catalog:read',
  'catalog:write',
  'inventory:read',
  'inventory:write',
  'payments:read',
  'refunds:write',
  'settings:read',
  'settings:write',
  'ops:read',
  'ops:replay',
  'audit:read',
  'reviews:moderate',
  'media:read',
  'media:write',
  'experience:read',
  'experience:write',
  'experience:publish',
  'shipping:read',
  'shipping:write',
  'coupons:read',
  'coupons:write',
  'analytics:read',
  'integrations:read',
  'integrations:manage',
  'team:manage',
  'flags:manage',
];

const ROLE_PERMISSIONS: Record<AdminRole, Permission[]> = {
  support: [
    'orders:read',
    'customers:read',
    'customers:write',
    'reviews:moderate',
    'media:read',
    'shipping:read',
  ],
  catalog: [
    'catalog:read',
    'catalog:write',
    'inventory:read',
    'media:read',
    'media:write',
    'experience:read',
  ],
  fulfillment: [
    'orders:read',
    'orders:fulfil',
    'orders:cancel',
    'inventory:read',
    'inventory:write',
    'customers:read',
    'shipping:read',
    'shipping:write',
    'analytics:read',
  ],
  finance: [
    'orders:read',
    'payments:read',
    'refunds:write',
    'audit:read',
    'coupons:read',
    'analytics:read',
    'shipping:read',
  ],
  designer: ['catalog:read', 'media:read', 'media:write', 'experience:read', 'experience:write'],
  admin: ALL_PERMISSIONS,
};
/** Actions that additionally require an MFA (AAL2) session. */
export const STEP_UP: Permission[] = [
  'refunds:write',
  'settings:write',
  'ops:replay',
  'orders:cancel',
  'inventory:write',
  'team:manage',
  'integrations:manage',
  'experience:publish',
  'customers:export',
  'flags:manage',
];

export const permissionsFor = (r: AdminRole) => ROLE_PERMISSIONS[r];
export const can = (r: AdminRole, p: Permission) => ROLE_PERMISSIONS[r].includes(p);

export interface AuditEntry {
  actorId: string;
  actorRole: AdminRole;
  action: string;
  resourceType: string;
  resourceId: string;
  reason?: string | null;
  before?: unknown;
  after?: unknown;
  requestId?: string;
}
export async function audit(c: PoolClient, e: AuditEntry) {
  await c.query(
    `INSERT INTO audit_log (actor_id, actor_role, action, resource_type, resource_id, reason, before, after, request_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      e.actorId,
      e.actorRole,
      e.action,
      e.resourceType,
      e.resourceId,
      e.reason ?? null,
      e.before === undefined ? null : JSON.stringify(e.before),
      e.after === undefined ? null : JSON.stringify(e.after),
      e.requestId ?? null,
    ],
  );
}

interface Ctx {
  adminId: string;
  role: AdminRole;
  requestId?: string;
}

// ---------------------------------------------------------------- inventory
export async function adjustStock(
  c: PoolClient,
  x: Ctx,
  variantId: string,
  delta: number,
  reason: string,
  expectedVersion: number,
) {
  if (!Number.isInteger(delta) || delta === 0 || Math.abs(delta) > 100000)
    throw new AppError('VALIDATION_FAILED', 'Invalid adjustment', {
      fields: { delta: 'non-zero integer, |delta| <= 100000' },
    });
  const cur = await c.query(`SELECT * FROM inventory_positions WHERE variant_id = $1 FOR UPDATE`, [
    variantId,
  ]);
  if (cur.rowCount === 0) throw new AppError('NOT_FOUND', 'Variant not found');
  const p = cur.rows[0];
  if (p.version !== expectedVersion)
    throw new AppError('CART_VERSION_CONFLICT', 'Stock changed since you loaded it; reload and retry');
  if (p.on_hand + delta < p.reserved)
    throw new AppError('ILLEGAL_STATE', `Cannot reduce below reserved stock (${p.reserved})`);
  const upd = await c.query(
    `UPDATE inventory_positions SET on_hand = on_hand + $2, version = version + 1, updated_at = now() WHERE variant_id = $1 RETURNING *`,
    [variantId, delta],
  );
  await c.query(
    `INSERT INTO inventory_movements (variant_id, kind, delta_on_hand, reason, ref_type, actor_id) VALUES ($1, $2, $3, $4, 'admin', $5)`,
    [variantId, delta > 0 ? 'receipt' : 'adjustment', delta, reason, x.adminId],
  );
  await audit(c, {
    actorId: x.adminId,
    actorRole: x.role,
    action: 'inventory.adjust',
    resourceType: 'variant',
    resourceId: variantId,
    reason,
    before: { onHand: p.on_hand },
    after: { onHand: upd.rows[0].on_hand },
    requestId: x.requestId,
  });
  return {
    variantId,
    onHand: upd.rows[0].on_hand as number,
    reserved: upd.rows[0].reserved as number,
    version: upd.rows[0].version as number,
  };
}

// ------------------------------------------------------------------ catalog
export interface VariantPatch {
  pricePaise?: number;
  comparePaise?: number | null;
  active?: boolean;
  title?: string;
  sku?: string;
  weightGrams?: number | null;
  lengthMm?: number | null;
  widthMm?: number | null;
  heightMm?: number | null;
  hsnCode?: string | null;
  barcode?: string | null;
  costPricePaise?: number | null;
  lowStockThreshold?: number;
  reason: string;
  expectedUpdatedAt: string;
}

const VARIANT_COLUMNS: Record<string, string> = {
  title: 'title',
  sku: 'sku',
  weightGrams: 'weight_grams',
  lengthMm: 'length_mm',
  widthMm: 'width_mm',
  heightMm: 'height_mm',
  hsnCode: 'hsn_code',
  barcode: 'barcode',
  costPricePaise: 'cost_price_paise',
};

export async function updateVariant(c: PoolClient, x: Ctx, variantId: string, patch: VariantPatch) {
  const cur = await c.query(`SELECT * FROM product_variants WHERE id = $1 FOR UPDATE`, [variantId]);
  if (cur.rowCount === 0) throw new AppError('NOT_FOUND', 'Variant not found');
  const v = cur.rows[0];
  if (new Date(v.updated_at).toISOString() !== new Date(patch.expectedUpdatedAt).toISOString()) {
    throw new AppError('CART_VERSION_CONFLICT', 'Variant was edited by someone else; reload and retry');
  }
  if (patch.costPricePaise !== undefined && x.role !== 'admin')
    throw new AppError('FORBIDDEN', 'Only administrators may set cost prices');
  const price = patch.pricePaise ?? v.price_paise;
  const compare = patch.comparePaise === undefined ? v.compare_at_price_paise : patch.comparePaise;
  if (compare !== null && compare < price)
    throw new AppError('VALIDATION_FAILED', 'MRP cannot be below the selling price', {
      fields: { comparePaise: 'must be >= price' },
    });
  const sets = ['price_paise = $2', 'compare_at_price_paise = $3', 'active = $4'];
  const args: unknown[] = [variantId, price, compare, patch.active ?? v.active];
  const before: Record<string, unknown> = {
    pricePaise: v.price_paise,
    comparePaise: v.compare_at_price_paise,
    active: v.active,
  };
  for (const [key, col] of Object.entries(VARIANT_COLUMNS)) {
    const value = (patch as unknown as Record<string, unknown>)[key];
    if (value === undefined) continue;
    args.push(value);
    sets.push(`${col} = $${args.length}`);
    before[key] = v[col];
  }
  let r;
  try {
    r = await c.query(
      `UPDATE product_variants SET ${sets.join(', ')}, updated_at = now() WHERE id = $1 RETURNING *`,
      args,
    );
  } catch (e) {
    if ((e as { code?: string }).code === '23505')
      throw new AppError('VALIDATION_FAILED', 'That SKU already exists', {
        fields: { sku: 'already exists' },
      });
    throw e;
  }
  const after: Record<string, unknown> = {
    pricePaise: r.rows[0].price_paise,
    comparePaise: r.rows[0].compare_at_price_paise,
    active: r.rows[0].active,
  };
  for (const [key, col] of Object.entries(VARIANT_COLUMNS))
    if ((patch as unknown as Record<string, unknown>)[key] !== undefined) after[key] = r.rows[0][col];
  if (patch.lowStockThreshold !== undefined) {
    const pos = await c.query(
      `SELECT low_stock_threshold FROM inventory_positions WHERE variant_id = $1 FOR UPDATE`,
      [variantId],
    );
    before['lowStockThreshold'] = pos.rows[0]?.low_stock_threshold ?? null;
    await c.query(`UPDATE inventory_positions SET low_stock_threshold = $2 WHERE variant_id = $1`, [
      variantId,
      patch.lowStockThreshold,
    ]);
    after['lowStockThreshold'] = patch.lowStockThreshold;
  }
  // Selling price, MRP or availability changed: outstanding checkout quotes were priced under the old rules and must be re-quoted.
  if (
    price !== v.price_paise ||
    compare !== v.compare_at_price_paise ||
    (patch.active !== undefined && patch.active !== v.active)
  )
    await c.query(`SELECT private.bump_rules_version()`);
  await audit(c, {
    actorId: x.adminId,
    actorRole: x.role,
    action: 'variant.update',
    resourceType: 'variant',
    resourceId: variantId,
    reason: patch.reason,
    before,
    after,
    requestId: x.requestId,
  });
  return r.rows[0];
}

// ------------------------------------------------------------------- orders
const FULFIL: Record<string, string[]> = {
  placed: ['confirmed'],
  confirmed: ['processing'],
  processing: ['shipped'],
  // 'returned' here = undelivered parcel coming back to us (RTO). Customer returns of DELIVERED orders go through
  // the returns workflow (returns.ts), never through this transition.
  shipped: ['out_for_delivery', 'delivered', 'returned'],
  out_for_delivery: ['delivered', 'returned'],
};

export async function adminTransition(
  c: PoolClient,
  x: Ctx,
  orderId: string,
  to: string,
  expectedVersion: number,
  reason?: string,
) {
  const r = await c.query(`SELECT * FROM orders WHERE id = $1 FOR UPDATE`, [orderId]);
  if (r.rowCount === 0) throw new AppError('NOT_FOUND', 'Order not found');
  const o = r.rows[0];
  if (o.version !== expectedVersion)
    throw new AppError('CART_VERSION_CONFLICT', 'Order changed; reload and retry');
  if (!FULFIL[o.status]?.includes(to))
    throw new AppError('ILLEGAL_STATE', `Cannot move an order from ${o.status} to ${to}`);
  if (to === 'returned') {
    if (!reason)
      throw new AppError('VALIDATION_FAILED', 'A reason is required', { fields: { reason: 'required' } });
    await restockCommittedOrder(c, orderId, 'rto_received', x.adminId);
  }
  await c.query(`UPDATE orders SET status = $2 WHERE id = $1`, [orderId, to]);
  await c.query(
    `INSERT INTO outbox (aggregate_type, aggregate_id, event_type, payload) VALUES ('order',$1,$2,$3)`,
    [orderId, `order.${to}`, { orderId, userId: o.user_id }],
  );
  await audit(c, {
    actorId: x.adminId,
    actorRole: x.role,
    action: 'order.transition',
    resourceType: 'order',
    resourceId: orderId,
    reason,
    before: { status: o.status },
    after: { status: to },
    requestId: x.requestId,
  });
  return { id: orderId, status: to, version: o.version + 1 };
}

export async function adminCancel(
  c: PoolClient,
  x: Ctx,
  orderId: string,
  reason: string,
  expectedVersion: number,
) {
  const r = await c.query(`SELECT * FROM orders WHERE id = $1 FOR UPDATE`, [orderId]);
  if (r.rowCount === 0) throw new AppError('NOT_FOUND', 'Order not found');
  const o = r.rows[0];
  if (o.version !== expectedVersion)
    throw new AppError('CART_VERSION_CONFLICT', 'Order changed; reload and retry');
  if (!['pending_payment', 'placed', 'confirmed', 'processing'].includes(o.status))
    throw new AppError('ILLEGAL_STATE', 'This order can no longer be cancelled');
  if (o.status === 'pending_payment') await settleReservations(c, orderId, 'released', x.adminId);
  else await restockCommittedOrder(c, orderId, 'admin_cancel', x.adminId);
  const paid = o.payment_method === 'online' && o.payment_status === 'paid';
  await c.query(`UPDATE orders SET status = 'cancelled', cancel_reason = $2 WHERE id = $1`, [
    orderId,
    reason,
  ]);
  await c.query(
    `UPDATE payment_attempts SET status = 'cancelled', updated_at = now() WHERE order_id = $1 AND status IN ('created','pending')`,
    [orderId],
  );
  if (paid) {
    await c.query(
      `INSERT INTO refunds (order_id, amount_paise, reason, idempotency_key, requested_by) VALUES ($1,$2,'order_cancelled',$3,$4) ON CONFLICT (order_id, idempotency_key) DO NOTHING`,
      [orderId, o.total_paise, `cancel:${orderId}`, x.adminId],
    );
  }
  await c.query(
    `INSERT INTO outbox (aggregate_type, aggregate_id, event_type, payload) VALUES ('order',$1,'order.cancelled',$2)`,
    [orderId, { orderId, userId: o.user_id, refund: paid }],
  );
  await audit(c, {
    actorId: x.adminId,
    actorRole: x.role,
    action: 'order.cancel',
    resourceType: 'order',
    resourceId: orderId,
    reason,
    before: { status: o.status },
    after: { status: 'cancelled', refundQueued: paid },
    requestId: x.requestId,
  });
  return { id: orderId, status: 'cancelled', refundQueued: paid };
}

export async function markCodCollected(c: PoolClient, x: Ctx, orderId: string, expectedVersion: number) {
  const r = await c.query(`SELECT * FROM orders WHERE id = $1 FOR UPDATE`, [orderId]);
  if (r.rowCount === 0) throw new AppError('NOT_FOUND', 'Order not found');
  const o = r.rows[0];
  if (o.version !== expectedVersion)
    throw new AppError('CART_VERSION_CONFLICT', 'Order changed; reload and retry');
  if (o.payment_method !== 'cod' || o.payment_status !== 'cod_due' || o.status !== 'delivered') {
    throw new AppError('ILLEGAL_STATE', 'Cash can only be recorded as collected for a delivered COD order');
  }
  await c.query(`UPDATE orders SET payment_status = 'cod_collected' WHERE id = $1`, [orderId]);
  await c.query(`UPDATE payment_records SET status = 'captured', updated_at = now() WHERE order_id = $1`, [
    orderId,
  ]);
  await audit(c, {
    actorId: x.adminId,
    actorRole: x.role,
    action: 'order.cod_collected',
    resourceType: 'order',
    resourceId: orderId,
    before: { paymentStatus: 'cod_due' },
    after: { paymentStatus: 'cod_collected' },
    requestId: x.requestId,
  });
}

// ----------------------------------------------------------------- refunds
/**
 * Provider refund with durable idempotency: requested → pending (tx, claims it) → provider call
 * OUTSIDE any transaction → processed/failed (tx). A crash between steps leaves 'pending' that
 * reconciliation/retry resolves using the same idempotency key (never a second refund).
 */
export async function processRefund(db: Db, gateway: PaymentGateway, x: Ctx, refundId: string) {
  const claim = await db.tx({ kind: 'admin', userId: x.adminId, role: x.role }, async (c) => {
    const r = await c.query(
      `SELECT rf.*, pa.provider_payment_id FROM refunds rf LEFT JOIN payment_attempts pa ON pa.id = rf.payment_attempt_id WHERE rf.id = $1 FOR UPDATE OF rf`,
      [refundId],
    );
    if (r.rowCount === 0) throw new AppError('NOT_FOUND', 'Refund not found');
    const rf = r.rows[0];
    if (rf.status === 'processed') return { done: true as const, rf };
    if (!['requested', 'pending', 'failed'].includes(rf.status))
      throw new AppError('ILLEGAL_STATE', 'Refund cannot be processed');
    let paymentId = rf.provider_payment_id as string | null;
    if (!paymentId) {
      const a = await c.query(
        `SELECT provider_payment_id FROM payment_attempts WHERE order_id = $1 AND status = 'captured' LIMIT 1`,
        [rf.order_id],
      );
      paymentId = a.rows[0]?.provider_payment_id ?? null;
    }
    if (!paymentId)
      throw new AppError('ILLEGAL_STATE', 'No captured online payment to refund (COD refunds are manual)');
    await c.query(`UPDATE refunds SET status = 'pending', updated_at = now() WHERE id = $1`, [refundId]);
    await audit(c, {
      actorId: x.adminId,
      actorRole: x.role,
      action: 'refund.process',
      resourceType: 'refund',
      resourceId: refundId,
      before: { status: rf.status },
      after: { status: 'pending' },
      requestId: x.requestId,
    });
    return { done: false as const, rf, paymentId };
  });
  if (claim.done) return { id: refundId, status: 'processed' };
  try {
    const out = await gateway.refund({
      providerPaymentId: claim.paymentId,
      amountPaise: claim.rf.amount_paise,
      idempotencyKey: claim.rf.idempotency_key,
    });
    await db.tx({ kind: 'admin', userId: x.adminId, role: x.role }, async (c) => {
      await c.query(
        `UPDATE refunds SET status = 'processed', provider_refund_id = $2, updated_at = now() WHERE id = $1`,
        [refundId, out.providerRefundId],
      );
      await c.query(
        `UPDATE orders SET payment_status = CASE WHEN (SELECT coalesce(sum(amount_paise),0) FROM refunds WHERE order_id = $1 AND status = 'processed') >= total_paise THEN 'refunded' ELSE 'partially_refunded' END WHERE id = $1 AND payment_status IN ('paid','exception','partially_refunded')`,
        [claim.rf.order_id],
      );
      await c.query(
        `INSERT INTO outbox (aggregate_type, aggregate_id, event_type, payload) SELECT 'order', o.id::text, 'refund.processed', jsonb_build_object('orderId', o.id, 'userId', o.user_id, 'amountPaise', $2::int) FROM orders o WHERE o.id = $1`,
        [claim.rf.order_id, claim.rf.amount_paise],
      );
      await audit(c, {
        actorId: x.adminId,
        actorRole: x.role,
        action: 'refund.processed',
        resourceType: 'refund',
        resourceId: refundId,
        after: { providerRefundId: out.providerRefundId },
        requestId: x.requestId,
      });
    });
    return { id: refundId, status: 'processed' };
  } catch {
    // Left 'pending' on purpose: the provider may have accepted it. Retrying reuses the SAME idempotency key.
    return { id: refundId, status: 'pending' };
  }
}

// --------------------------------------------------------- readiness gating
export interface ReadinessCheck {
  id: string;
  ok: boolean;
  detail: string;
  manual?: boolean;
  /** Non-blocking checks are warnings: they never stop activation. */
  blocking?: boolean;
}
export async function readiness(
  c: PoolClient,
  env: {
    paymentProvider: string;
    flags: { checkout: boolean; cod: boolean; onlinePayments: boolean };
  },
) {
  const s = await loadSettings(c);
  const stock = await c.query(
    `SELECT count(*)::int AS variants, count(*) FILTER (WHERE on_hand > 0)::int AS stocked FROM inventory_positions i JOIN product_variants v ON v.id = i.variant_id WHERE v.active`,
  );
  const pins = await c.query(`SELECT count(*)::int AS n FROM serviceable_pin_prefixes`);
  const serviceabilityConfigured = pins.rows[0].n > 0;
  const checks: ReadinessCheck[] = [
    {
      id: 'authority',
      ok: s.checkout_authority === 'express',
      detail: `checkout_authority = ${s.checkout_authority}`,
    },
    {
      id: 'stock',
      ok: stock.rows[0].stocked > 0,
      detail: `${stock.rows[0].stocked}/${stock.rows[0].variants} active variants have confirmed stock`,
    },
    {
      id: 'shipping',
      ok: s.shipping_fee_paise >= 0,
      detail: `fee ${s.shipping_fee_paise} paise, free threshold ${s.free_shipping_threshold_paise ?? 'none'}`,
      manual: true,
    },
    {
      id: 'serviceability',
      ok: serviceabilityConfigured,
      detail: serviceabilityConfigured
        ? `${pins.rows[0].n} serviceable PIN prefix(es) configured`
        : 'no serviceable PIN codes configured (Admin → Shipping)',
    },
    {
      id: 'gst_profile',
      ok: !!(s.merchant_gstin && s.merchant_legal_name && s.merchant_state && s.merchant_address),
      detail: `GST ${(s.gst_rate_bps / 100).toFixed(0)}% ${s.tax_inclusive ? 'included in prices' : 'added on top'}; GSTIN/legal name/state/address ${s.merchant_gstin ? 'set' : 'NOT set — GST invoices cannot be issued'}`,
      blocking: false,
    },
    {
      id: 'payment_method',
      ok:
        (s.cod_enabled && env.flags.cod) ||
        (s.online_payments_enabled &&
          env.flags.onlinePayments &&
          env.paymentProvider !== 'none' &&
          s.payment_window_minutes !== null),
      detail: `cod=${s.cod_enabled && env.flags.cod}, online=${s.online_payments_enabled && env.flags.onlinePayments}, provider=${env.paymentProvider}`,
    },
    {
      id: 'payment_window',
      ok: !s.online_payments_enabled || s.payment_window_minutes !== null,
      detail: `payment window ${s.payment_window_minutes ?? 'unset'} min`,
    },
  ];
  return { checks, allOk: checks.every((k) => k.ok || k.blocking === false), settings: s };
}

export async function activateCheckout(
  c: PoolClient,
  x: Ctx,
  expectedVersion: number,
  reason: string,
  env: Parameters<typeof readiness>[1],
) {
  await c.query(`SELECT 1 FROM store_settings WHERE id = 1 FOR UPDATE`);
  const rd = await readiness(c, env);
  if (rd.settings.version !== expectedVersion)
    throw new AppError('CART_VERSION_CONFLICT', 'Settings changed; reload and retry');
  if (!rd.allOk)
    throw new AppError('POLICY_NOT_CONFIGURED', 'Checkout prerequisites are not met', {
      lines: rd.checks.filter((k) => !k.ok),
    });
  await c.query(
    `UPDATE store_settings SET checkout_policy_confirmed = true, checkout_enabled = true, version = version + 1, updated_at = now() WHERE id = 1`,
  );
  await audit(c, {
    actorId: x.adminId,
    actorRole: x.role,
    action: 'checkout.activate',
    resourceType: 'store_settings',
    resourceId: '1',
    reason,
    before: { enabled: rd.settings.checkout_enabled },
    after: { enabled: true },
    requestId: x.requestId,
  });
}
export async function disableCheckout(c: PoolClient, x: Ctx, reason: string) {
  await c.query(
    `UPDATE store_settings SET checkout_enabled = false, version = version + 1, updated_at = now() WHERE id = 1`,
  );
  await audit(c, {
    actorId: x.adminId,
    actorRole: x.role,
    action: 'checkout.disable',
    resourceType: 'store_settings',
    resourceId: '1',
    reason,
    requestId: x.requestId,
  });
}
export async function updateSettings(
  c: PoolClient,
  x: Ctx,
  expectedVersion: number,
  reason: string,
  patch: Partial<{
    shipping_fee_paise: number;
    free_shipping_threshold_paise: number | null;
    cod_enabled: boolean;
    cod_max_order_paise: number | null;
    delivery_estimate: string;
    online_payments_enabled: boolean;
    payment_window_minutes: number | null;
    cod_fee_paise: number;
    return_window_days: number | null;
    gst_rate_bps: number;
    tax_inclusive: boolean;
    merchant_legal_name: string | null;
    merchant_gstin: string | null;
    merchant_state: string | null;
    merchant_address: string | null;
    invoice_prefix: string;
    brand_name: string;
    support_email: string | null;
    support_phone: string | null;
  }>,
) {
  const cur = await c.query(`SELECT * FROM store_settings WHERE id = 1 FOR UPDATE`);
  const s = cur.rows[0];
  if (s.version !== expectedVersion)
    throw new AppError('CART_VERSION_CONFLICT', 'Settings changed; reload and retry');
  const ALLOWED = [
    'shipping_fee_paise',
    'free_shipping_threshold_paise',
    'cod_enabled',
    'cod_max_order_paise',
    'delivery_estimate',
    'online_payments_enabled',
    'payment_window_minutes',
    'return_window_days',
    'cod_fee_paise',
    'gst_rate_bps',
    'tax_inclusive',
    'merchant_legal_name',
    'merchant_gstin',
    'merchant_state',
    'merchant_address',
    'invoice_prefix',
    'brand_name',
    'support_email',
    'support_phone',
  ];
  const keys = (Object.keys(patch) as Array<keyof typeof patch>).filter((k) => patch[k] !== undefined);
  if (keys.length === 0) throw new AppError('VALIDATION_FAILED', 'No changes supplied');
  if (keys.some((k) => !ALLOWED.includes(k))) throw new AppError('VALIDATION_FAILED', 'Unsupported setting');
  const sets = keys.map((k, i) => `${k} = $${i + 1}`).join(', ');
  // Pricing-affecting changes invalidate outstanding quotes via rules_version.
  const bump = keys.some((k) =>
    [
      'shipping_fee_paise',
      'free_shipping_threshold_paise',
      'cod_max_order_paise',
      'cod_fee_paise',
      'gst_rate_bps',
      'tax_inclusive',
    ].includes(k),
  );
  const r = await c.query(
    `UPDATE store_settings SET ${sets}, ${bump ? 'rules_version = rules_version + 1,' : ''} version = version + 1, updated_at = now() WHERE id = 1 RETURNING *`,
    keys.map((k) => patch[k]) as unknown[],
  );
  await audit(c, {
    actorId: x.adminId,
    actorRole: x.role,
    action: 'settings.update',
    resourceType: 'store_settings',
    resourceId: '1',
    reason,
    before: Object.fromEntries(keys.map((k) => [k, s[k]])),
    after: Object.fromEntries(keys.map((k) => [k, r.rows[0][k]])),
    requestId: x.requestId,
  });
  return r.rows[0];
}
