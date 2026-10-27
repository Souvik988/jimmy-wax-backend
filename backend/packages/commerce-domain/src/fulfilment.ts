import { createHash } from 'node:crypto';
import type { Db, PoolClient } from '@jw/database';
import { AppError, decodeCursor, encodeCursor } from '@jw/contracts';
import {
  ShippingError,
  WebhookVerificationError,
  normaliseStatus,
  type CourierOption,
  type NormalStatus,
  type ObjectStorage,
  type PackageDims,
  type ProviderWebhook,
  type ShipmentRequest,
  type ShippingProvider,
} from '@jw/integrations';
import { z } from 'zod';
import { audit, type AdminRole } from './admin.ts';
import { gstIncluded } from './money.ts';

interface Ctx {
  adminId: string;
  role: AdminRole;
  requestId?: string;
}
type Actor = { kind: 'admin'; userId: string; role: AdminRole };
const actorOf = (x: Ctx): Actor => ({ kind: 'admin', userId: x.adminId, role: x.role });
const SYSTEM = { kind: 'system', reason: 'shipping' } as const;

// ============================================================================ settings
export const ShippingSettingsPatch = z.object({
  pickupLocation: z.string().trim().min(2).max(120).nullable().optional(),
  pickupPin: z
    .string()
    .regex(/^[0-9]{6}$/)
    .nullable()
    .optional(),
  defaultWeightGrams: z.number().int().min(1).max(50000).optional(),
  defaultLengthMm: z.number().int().min(1).max(2000).optional(),
  defaultWidthMm: z.number().int().min(1).max(2000).optional(),
  defaultHeightMm: z.number().int().min(1).max(2000).optional(),
  courierRule: z.enum(['cheapest', 'fastest', 'balanced', 'preferred']).optional(),
  preferredCouriers: z.array(z.string().trim().min(2).max(60)).max(10).optional(),
  autoShip: z.boolean().optional(),
  bulkConfirmThreshold: z.number().int().min(1).max(200).optional(),
  requireProviderCheck: z.boolean().optional(),
  stuckAfterHours: z.number().int().min(6).max(720).optional(),
});

const settingsDto = (s: Record<string, unknown>) => ({
  pickupLocation: (s.pickup_location as string | null) ?? null,
  pickupPin: (s.pickup_pin as string | null) ?? null,
  defaultWeightGrams: s.default_weight_grams as number,
  defaultLengthMm: s.default_length_mm as number,
  defaultWidthMm: s.default_width_mm as number,
  defaultHeightMm: s.default_height_mm as number,
  courierRule: s.courier_rule as 'cheapest' | 'fastest' | 'balanced' | 'preferred',
  preferredCouriers: s.preferred_couriers as string[],
  autoShip: s.auto_ship as boolean,
  bulkConfirmThreshold: s.bulk_confirm_threshold as number,
  requireProviderCheck: s.require_provider_check as boolean,
  stuckAfterHours: s.stuck_after_hours as number,
  /** The version stamp a write must echo back (`expectedUpdatedAt`); null only before the row was ever written. */
  updatedAt: s.updated_at ? new Date(s.updated_at as string).toISOString() : null,
});
export type ShippingSettings = ReturnType<typeof settingsDto>;

export async function getShippingSettings(c: PoolClient): Promise<ShippingSettings> {
  const r = await c.query(`SELECT * FROM shipping_settings WHERE id = 1`);
  return settingsDto(r.rows[0]);
}

/** Required with every shipping-settings write: the updatedAt you loaded (409 if someone else saved since) and why. */
export const ShippingSettingsGuard = z.object({
  expectedUpdatedAt: z.string().datetime(),
  reason: z.string().trim().min(3).max(300),
});

export async function updateShippingSettings(
  c: PoolClient,
  x: Ctx,
  patch: z.infer<typeof ShippingSettingsPatch>,
  guard: z.infer<typeof ShippingSettingsGuard>,
) {
  const map: Record<string, string> = {
    pickupLocation: 'pickup_location',
    pickupPin: 'pickup_pin',
    defaultWeightGrams: 'default_weight_grams',
    defaultLengthMm: 'default_length_mm',
    defaultWidthMm: 'default_width_mm',
    defaultHeightMm: 'default_height_mm',
    courierRule: 'courier_rule',
    preferredCouriers: 'preferred_couriers',
    autoShip: 'auto_ship',
    bulkConfirmThreshold: 'bulk_confirm_threshold',
    requireProviderCheck: 'require_provider_check',
    stuckAfterHours: 'stuck_after_hours',
  };
  const lock = await c.query(`SELECT updated_at FROM shipping_settings WHERE id = 1 FOR UPDATE`);
  if (
    new Date(lock.rows[0].updated_at as string).toISOString() !==
    new Date(guard.expectedUpdatedAt).toISOString()
  )
    throw new AppError(
      'CART_VERSION_CONFLICT',
      'Shipping settings changed since you loaded them; reload and retry',
    );
  const before = await getShippingSettings(c);
  const sets: string[] = [];
  const args: unknown[] = [];
  for (const [k, col] of Object.entries(map)) {
    const v = (patch as Record<string, unknown>)[k];
    if (v === undefined) continue;
    args.push(v);
    sets.push(`${col} = $${args.length}`);
  }
  if (patch.autoShip === true && !before.pickupLocation && !patch.pickupLocation)
    throw new AppError('VALIDATION_FAILED', 'Choose a pickup location before enabling auto-ship', {
      fields: { pickupLocation: 'required for auto-ship' },
    });
  if (sets.length) {
    await c.query(`UPDATE shipping_settings SET ${sets.join(', ')}, updated_at = now() WHERE id = 1`, args);
    await audit(c, {
      actorId: x.adminId,
      actorRole: x.role,
      action: 'shipping.settings',
      resourceType: 'shipping_settings',
      resourceId: '1',
      reason: guard.reason,
      before,
      after: patch,
      requestId: x.requestId,
    });
  }
  return getShippingSettings(c);
}

// ============================================================================ package + courier choice
export async function packageForOrder(
  c: PoolClient,
  orderId: string,
): Promise<{ package: PackageDims; warnings: string[] }> {
  const s = await getShippingSettings(c);
  const items = await c.query(
    `SELECT oi.quantity, oi.sku, v.weight_grams, v.length_mm, v.width_mm, v.height_mm
       FROM order_items oi LEFT JOIN product_variants v ON v.id = oi.variant_id WHERE oi.order_id = $1`,
    [orderId],
  );
  const warnings: string[] = [];
  let weight = 0;
  let length = 0;
  let width = 0;
  let height = 0;
  for (const i of items.rows) {
    const q = i.quantity as number;
    if (i.weight_grams == null) warnings.push(`${i.sku}: no weight set (used the default)`);
    if (i.length_mm == null || i.width_mm == null || i.height_mm == null)
      warnings.push(`${i.sku}: no dimensions set (used the defaults)`);
    weight += (i.weight_grams ?? s.defaultWeightGrams) * q;
    length = Math.max(length, i.length_mm ?? s.defaultLengthMm);
    width = Math.max(width, i.width_mm ?? s.defaultWidthMm);
    height += (i.height_mm ?? s.defaultHeightMm) * q; // items are stacked
  }
  return {
    package: {
      weightGrams: weight || s.defaultWeightGrams,
      lengthMm: length || s.defaultLengthMm,
      widthMm: width || s.defaultWidthMm,
      heightMm: height || s.defaultHeightMm,
    },
    warnings: [...new Set(warnings)],
  };
}

/** Volumetric weight in grams (L×B×H cm / 5000 × 1000). Couriers bill on the greater of this and dead weight. */
export const volumetricGrams = (p: PackageDims) =>
  Math.round(((p.lengthMm / 10) * (p.widthMm / 10) * (p.heightMm / 10)) / 5);

export function chooseCourier(
  options: CourierOption[],
  rule: ShippingSettings['courierRule'] | 'courier',
  preferred: string[] = [],
  courierId?: string,
): CourierOption | null {
  if (!options.length) return null;
  if (rule === 'courier') return options.find((o) => o.courierId === courierId) ?? null;
  const cost = (o: CourierOption) => o.freightPaise + o.codChargesPaise;
  const byCost = [...options].sort((a, b) => cost(a) - cost(b));
  const byEtd = [...options].sort((a, b) => (a.etdDays ?? 99) - (b.etdDays ?? 99) || cost(a) - cost(b));
  if (rule === 'cheapest') return byCost[0]!;
  if (rule === 'fastest') return byEtd[0]!;
  if (rule === 'preferred') {
    const p = options.find((o) => preferred.some((n) => o.name.toLowerCase().includes(n.toLowerCase())));
    if (p) return p;
  }
  // balanced: 60 % cost, 40 % speed, small bonus for rating
  const minC = cost(byCost[0]!);
  const maxC = cost(byCost[byCost.length - 1]!);
  const minE = byEtd[0]!.etdDays ?? 0;
  const maxE = byEtd[byEtd.length - 1]!.etdDays ?? 0;
  const norm = (v: number, lo: number, hi: number) => (hi === lo ? 0 : (v - lo) / (hi - lo));
  const score = (o: CourierOption) =>
    0.6 * norm(cost(o), minC, maxC) + 0.4 * norm(o.etdDays ?? maxE, minE, maxE) - 0.02 * (o.rating ?? 0);
  return [...options].sort((a, b) => score(a) - score(b))[0]!;
}

// ============================================================================ order loading
interface OrderForShipping {
  id: string;
  orderNumber: string;
  userId: string;
  status: string;
  paymentMethod: 'cod' | 'online';
  paymentStatus: string;
  totalPaise: number;
  codFeePaise: number;
  gstBps: number;
  createdAt: Date;
  address: {
    name: string;
    phone: string;
    line1: string;
    line2: string;
    city: string;
    state: string;
    pincode: string;
  };
  email: string | null;
  items: Array<{ name: string; sku: string; units: number; unitPricePaise: number; hsn: string | null }>;
}

async function loadOrder(c: PoolClient, orderId: string): Promise<OrderForShipping> {
  const o = await c.query(
    `SELECT o.*, u.email, ss.gst_rate_bps FROM orders o JOIN auth.users u ON u.id = o.user_id CROSS JOIN store_settings ss WHERE o.id = $1 AND ss.id = 1`,
    [orderId],
  );
  if (o.rowCount === 0) throw new AppError('NOT_FOUND', 'Order not found');
  const x = o.rows[0];
  const a = (x.address_snapshot ?? {}) as Record<string, string>;
  const items = await c.query(
    `SELECT oi.product_name, oi.variant_title, oi.sku, oi.quantity, oi.unit_price_paise, v.hsn_code
       FROM order_items oi LEFT JOIN product_variants v ON v.id = oi.variant_id WHERE oi.order_id = $1 ORDER BY oi.id`,
    [orderId],
  );
  return {
    id: x.id,
    orderNumber: x.order_number,
    userId: x.user_id,
    status: x.status,
    paymentMethod: x.payment_method,
    paymentStatus: x.payment_status,
    totalPaise: x.total_paise,
    codFeePaise: x.cod_fee_paise ?? 0,
    gstBps: x.gst_rate_bps ?? 0,
    createdAt: x.created_at,
    address: {
      // The order stores an immutable snapshot: { name, phone, address, landmark, city, state, pin }.
      name: a.name ?? a.recipient_name ?? '',
      phone: a.phone ?? '',
      line1: a.address ?? a.line1 ?? '',
      line2: a.landmark ?? '',
      city: a.city ?? '',
      state: a.state ?? '',
      pincode: a.pin ?? a.postal_code ?? '',
    },
    email: x.email ?? null,
    items: items.rows.map((i) => ({
      name: `${i.product_name}${i.variant_title && i.variant_title !== 'Default' ? ` (${i.variant_title})` : ''}`,
      sku: i.sku,
      units: i.quantity,
      unitPricePaise: i.unit_price_paise,
      hsn: i.hsn_code ?? null,
    })),
  };
}

const isPayable = (o: OrderForShipping) =>
  o.paymentMethod === 'cod' || ['paid', 'cod_due'].includes(o.paymentStatus);

function toProviderRequest(
  o: OrderForShipping,
  reference: string,
  pickupLocation: string,
  pkg: PackageDims,
): ShipmentRequest {
  return {
    reference,
    orderDate: o.createdAt,
    pickupLocation,
    address: { ...o.address, email: o.email },
    items: o.items.map((i) => ({
      name: i.name,
      sku: i.sku,
      units: i.units,
      sellingPricePaise: i.unitPricePaise,
      hsn: i.hsn,
      taxPaise: gstIncluded(i.unitPricePaise, o.gstBps),
    })),
    paymentMethod: o.paymentMethod === 'cod' ? 'cod' : 'prepaid',
    orderTotalPaise: o.totalPaise,
    // the courier collects exactly what the customer was quoted: items + shipping + COD fee (GST included)
    codAmountPaise: o.paymentMethod === 'cod' ? o.totalPaise : 0,
    package: pkg,
  };
}

// ============================================================================ ready queue + plan
export async function readyToShip(c: PoolClient, f: { limit: number; cursor?: string }) {
  const cur = decodeCursor(f.cursor, z.object({ t: z.string(), id: z.string() }));
  const args: unknown[] = [];
  const w = [
    `o.status = 'processing'`,
    `(o.payment_method = 'cod' OR o.payment_status IN ('paid', 'cod_due'))`,
    `NOT EXISTS (SELECT 1 FROM shipments s WHERE s.order_id = o.id AND s.status NOT IN ('failed', 'returned_to_origin', 'cancelled', 'lost', 'damaged'))`,
    `NOT EXISTS (SELECT 1 FROM shipment_requests r WHERE r.order_id = o.id AND r.state NOT IN ('done', 'failed', 'cancelled'))`,
  ];
  if (cur)
    w.push(
      `(o.created_at, o.id) > (${args.push(cur.t) && `$${args.length}`}::timestamptz, ${args.push(cur.id) && `$${args.length}`}::uuid)`,
    );
  args.push(f.limit + 1);
  const r = await c.query(
    `SELECT o.id, o.order_number, o.payment_method, o.payment_status, o.total_paise, o.created_at, o.address_snapshot,
            (SELECT count(*)::int FROM order_items i WHERE i.order_id = o.id) AS lines,
            (SELECT k.serviceable FROM pin_serviceability_cache k WHERE k.pin = o.address_snapshot->>'pin') AS pin_ok
       FROM orders o WHERE ${w.join(' AND ')} ORDER BY o.created_at, o.id LIMIT $${args.length}`,
    args,
  );
  const rows = r.rows.slice(0, f.limit);
  const out = [];
  for (const o of rows) {
    const pk = await packageForOrder(c, o.id);
    const a = o.address_snapshot as Record<string, string>;
    const warnings = [...pk.warnings];
    if (!(await getShippingSettings(c)).pickupLocation) warnings.push('No pickup location is configured');
    out.push({
      id: o.id as string,
      orderNumber: o.order_number as string,
      customerName: a.name ?? '',
      city: a.city ?? '',
      pincode: a.pin ?? '',
      lines: o.lines as number,
      paymentMethod: o.payment_method as string,
      codAmountPaise: o.payment_method === 'cod' ? (o.total_paise as number) : 0,
      totalPaise: o.total_paise as number,
      package: pk.package,
      volumetricGrams: volumetricGrams(pk.package),
      serviceable: (o.pin_ok as boolean | null) ?? null,
      ageHours: Math.round((Date.now() - new Date(o.created_at).getTime()) / 3600_000),
      warnings,
    });
  }
  const last = rows[rows.length - 1];
  return {
    items: out,
    nextCursor:
      r.rows.length > f.limit && last
        ? encodeCursor({ t: new Date(last.created_at).toISOString(), id: last.id })
        : null,
  };
}

export async function planShipment(db: Db, provider: ShippingProvider, x: Ctx, orderId: string) {
  const base = await db.tx(actorOf(x), async (c) => ({
    o: await loadOrder(c, orderId),
    pk: await packageForOrder(c, orderId),
    s: await getShippingSettings(c),
  }));
  const warnings = [...base.pk.warnings];
  if (!isPayable(base.o)) warnings.push('Payment has not been received for this order');
  if (!base.s.pickupLocation) warnings.push('No pickup location is configured');
  if (!base.s.pickupPin)
    throw new AppError('POLICY_NOT_CONFIGURED', 'Set the pickup PIN code in shipping settings first');
  let res;
  try {
    res = await provider.checkServiceability({
      pickupPin: base.s.pickupPin,
      deliveryPin: base.o.address.pincode,
      weightGrams: Math.max(base.pk.package.weightGrams, volumetricGrams(base.pk.package)),
      cod: base.o.paymentMethod === 'cod',
      declaredValuePaise: base.o.totalPaise,
    });
  } catch (e) {
    throw mapShippingError(e);
  }
  const rec = chooseCourier(res.couriers, base.s.courierRule, base.s.preferredCouriers);
  const wallet = await provider.walletBalancePaise().catch(() => null);
  await db.tx(SYSTEM, (c) =>
    c.query(
      `INSERT INTO pin_serviceability_cache (pin, serviceable, couriers, min_etd_days) VALUES ($1,$2,$3,$4) ON CONFLICT (pin) DO UPDATE SET serviceable = $2, couriers = $3, min_etd_days = $4, checked_at = now()`,
      [
        base.o.address.pincode,
        res.serviceable,
        res.couriers.length,
        res.couriers.reduce<number | null>(
          (m, c0) => (c0.etdDays == null ? m : m == null ? c0.etdDays : Math.min(m, c0.etdDays)),
          null,
        ),
      ],
    ),
  );
  if (rec && wallet !== null && wallet < rec.freightPaise + rec.codChargesPaise)
    warnings.push('The Shiprocket wallet balance looks too low for this shipment');
  return {
    order: {
      id: base.o.id,
      orderNumber: base.o.orderNumber,
      status: base.o.status,
      paymentMethod: base.o.paymentMethod,
      totalPaise: base.o.totalPaise,
      codAmountPaise: base.o.paymentMethod === 'cod' ? base.o.totalPaise : 0,
      pincode: base.o.address.pincode,
    },
    package: base.pk.package,
    volumetricGrams: volumetricGrams(base.pk.package),
    serviceable: res.serviceable,
    options: res.couriers,
    recommended: rec?.courierId ?? null,
    rule: base.s.courierRule,
    walletBalancePaise: wallet,
    warnings,
  };
}

// ============================================================================ errors
export function mapShippingError(e: unknown): AppError {
  if (e instanceof AppError) return e;
  if (e instanceof ShippingError) {
    switch (e.code) {
      case 'not_serviceable':
        return new AppError('NOT_SERVICEABLE', e.message);
      case 'wallet_low':
        return new AppError('ILLEGAL_STATE', `Shipping wallet balance is too low: ${e.message}`);
      case 'invalid_request':
        return new AppError('VALIDATION_FAILED', e.message);
      case 'not_found':
        return new AppError('NOT_FOUND', e.message);
      default:
        return new AppError(
          'UNAVAILABLE',
          `The shipping provider could not complete this (${e.code}); try again shortly`,
        );
    }
  }
  return new AppError('INTERNAL', 'Shipping provider call failed');
}

// ============================================================================ ship an order (idempotent state machine)
export interface ShipDeps {
  db: Db;
  provider: ShippingProvider;
  storage: ObjectStorage;
}
export const ShipInput = z.object({
  courierId: z.string().max(40).optional(),
  package: z
    .object({
      weightGrams: z.number().int().min(1).max(50000),
      lengthMm: z.number().int().min(1).max(2000),
      widthMm: z.number().int().min(1).max(2000),
      heightMm: z.number().int().min(1).max(2000),
    })
    .optional(),
  overrideReason: z.string().trim().min(3).max(200).optional(),
});
export type ShipInput = z.infer<typeof ShipInput>;

async function claim(c: PoolClient, id: string): Promise<boolean> {
  const r = await c.query(
    `UPDATE shipment_requests SET lease_until = now() + interval '90 seconds' WHERE id = $1 AND (lease_until IS NULL OR lease_until < now()) RETURNING id`,
    [id],
  );
  return (r.rowCount ?? 0) > 0;
}
const release = (c: PoolClient, id: string) =>
  c.query(`UPDATE shipment_requests SET lease_until = NULL, updated_at = now() WHERE id = $1`, [id]);

export async function shipOrder(deps: ShipDeps, x: Ctx, orderId: string, input: ShipInput = {}) {
  const { db, provider, storage } = deps;
  const A = actorOf(x);
  // 1) open (or resume) the request — one open request per order is enforced by a unique index
  const req = await db.tx(A, async (c) => {
    const o = await loadOrder(c, orderId);
    const existing = await c.query(
      `SELECT * FROM shipment_requests WHERE order_id = $1 AND state NOT IN ('done', 'failed', 'cancelled')`,
      [orderId],
    );
    if (existing.rowCount) {
      if (input.courierId)
        await c.query(`UPDATE shipment_requests SET courier_choice = $2 WHERE id = $1`, [
          existing.rows[0].id,
          input.courierId,
        ]);
      return existing.rows[0];
    }
    if (o.status !== 'processing')
      throw new AppError('ILLEGAL_STATE', 'Mark the order "processing" before shipping it');
    if (!isPayable(o)) throw new AppError('ILLEGAL_STATE', 'Payment has not been received for this order');
    const active = await c.query(
      `SELECT 1 FROM shipments WHERE order_id = $1 AND status NOT IN ('failed', 'returned_to_origin', 'cancelled', 'lost', 'damaged')`,
      [orderId],
    );
    if (active.rowCount) throw new AppError('ILLEGAL_STATE', 'This order already has an active shipment');
    const s = await getShippingSettings(c);
    if (!s.pickupLocation)
      throw new AppError('POLICY_NOT_CONFIGURED', 'Choose a pickup location in shipping settings first');
    const pk = input.package ? { package: input.package, warnings: [] } : await packageForOrder(c, orderId);
    if (input.package && !input.overrideReason)
      throw new AppError('VALIDATION_FAILED', 'Say why the package differs from the catalogue', {
        fields: { overrideReason: 'required when overriding the package' },
      });
    const n = (await c.query(`SELECT count(*)::int n FROM shipment_requests WHERE order_id = $1`, [orderId]))
      .rows[0].n as number;
    const reference = `JW-${o.orderNumber}${n > 0 ? `-R${n + 1}` : ''}`;
    const ins = await c.query(
      `INSERT INTO shipment_requests (order_id, reference, attempt, provider, package, courier_choice, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [
        orderId,
        reference,
        n + 1,
        provider.name,
        JSON.stringify(pk.package),
        input.courierId ?? null,
        x.adminId,
      ],
    );
    await audit(c, {
      actorId: x.adminId,
      actorRole: x.role,
      action: 'shipment.request',
      resourceType: 'order',
      resourceId: orderId,
      after: { reference, override: input.overrideReason },
      requestId: x.requestId,
    });
    return ins.rows[0];
  });
  const id = req.id as string;
  if (!(await db.tx(A, (c) => claim(c, id))))
    throw new AppError(
      'REQUEST_IN_PROGRESS',
      'This shipment is already being created; check again in a moment',
    );

  const fail = async (e: unknown, nonRetryableFinal: boolean): Promise<never> => {
    const mapped = mapShippingError(e);
    const code = e instanceof ShippingError ? e.code : 'unknown';
    await db.tx(A, async (c) => {
      await c.query(
        `UPDATE shipment_requests SET error_code = $2, error = $3, ${nonRetryableFinal ? `state = 'failed',` : ''} lease_until = NULL, updated_at = now() WHERE id = $1`,
        [id, code, mapped.message.slice(0, 300)],
      );
    });
    throw mapped;
  };

  try {
    for (;;) {
      const r = (await db.tx(A, (c) => c.query(`SELECT * FROM shipment_requests WHERE id = $1`, [id])))
        .rows[0];
      if (r.state === 'done') {
        await db.tx(A, (c) => release(c, id));
        return shipmentDetail(db, x, r.shipment_id);
      }
      if (r.state === 'planned') {
        const built = await db.tx(A, async (c) => ({
          o: await loadOrder(c, orderId),
          s: await getShippingSettings(c),
        }));
        try {
          let ref = await provider.findOrderByReference(r.reference);
          if (!ref)
            ref = await provider.createOrder(
              toProviderRequest(built.o, r.reference, built.s.pickupLocation!, r.package as PackageDims),
            );
          await db.tx(A, (c) =>
            c.query(
              `UPDATE shipment_requests SET state = 'provider_order_created', provider_order_id = $2, provider_shipment_id = $3, error = NULL, error_code = NULL, updated_at = now() WHERE id = $1`,
              [id, ref!.providerOrderId, ref!.providerShipmentId],
            ),
          );
        } catch (e) {
          return fail(e, !(e instanceof ShippingError && e.retryable));
        }
      } else if (r.state === 'provider_order_created') {
        try {
          const a = await provider.assignAwb(r.provider_shipment_id, r.courier_choice ?? undefined);
          await db.tx(A, async (c) => {
            const o = await loadOrder(c, orderId);
            const pk = r.package as PackageDims;
            const sh = await c.query(
              `INSERT INTO shipments (order_id, courier, tracking_number, status, provider, provider_order_id, provider_shipment_id, courier_id, charges_paise, cod_amount_paise, weight_grams, dims, created_by, last_event_at)
               VALUES ($1,$2,$3,'awb_assigned',$4,$5,$6,$7,$8,$9,$10,$11,$12, now())
               ON CONFLICT (courier, tracking_number) DO UPDATE SET updated_at = now() RETURNING id`,
              [
                orderId,
                a.courierName || 'Courier',
                a.awb,
                provider.name,
                r.provider_order_id,
                r.provider_shipment_id,
                a.courierId,
                a.chargesPaise,
                o.paymentMethod === 'cod' ? o.totalPaise : 0,
                pk.weightGrams,
                JSON.stringify(pk),
                x.adminId,
              ],
            );
            await c.query(
              `INSERT INTO shipment_events (shipment_id, status, description, source, created_by) VALUES ($1,'awb_assigned',$2,'provider',$3) ON CONFLICT DO NOTHING`,
              [sh.rows[0].id, `AWB ${a.awb} assigned (${a.courierName})`, x.adminId],
            );
            await c.query(
              `UPDATE shipment_requests SET state = 'awb_assigned', awb = $2, courier_id = $3, courier_name = $4, charges_paise = $5, shipment_id = $6, error = NULL, error_code = NULL, updated_at = now() WHERE id = $1`,
              [id, a.awb, a.courierId, a.courierName, a.chargesPaise, sh.rows[0].id],
            );
            await audit(c, {
              actorId: x.adminId,
              actorRole: x.role,
              action: 'shipment.awb',
              resourceType: 'shipment',
              resourceId: sh.rows[0].id,
              after: { awb: a.awb, courier: a.courierName, chargesPaise: a.chargesPaise },
              requestId: x.requestId,
            });
          });
        } catch (e) {
          return fail(e, false);
        }
      } else if (r.state === 'awb_assigned') {
        try {
          const p = await provider.schedulePickup(r.provider_shipment_id);
          await db.tx(A, async (c) => {
            await c.query(
              `UPDATE shipments SET status = 'pickup_scheduled', pickup_scheduled_at = $2, updated_at = now(), last_event_at = now() WHERE id = $1 AND status = 'awb_assigned'`,
              [r.shipment_id, p.scheduledFor],
            );
            await c.query(
              `INSERT INTO shipment_events (shipment_id, status, description, source, created_by) VALUES ($1,'pickup_scheduled','Pickup scheduled','provider',$2) ON CONFLICT DO NOTHING`,
              [r.shipment_id, x.adminId],
            );
            await c.query(
              `UPDATE shipment_requests SET state = 'pickup_scheduled', error = NULL, error_code = NULL, updated_at = now() WHERE id = $1`,
              [id],
            );
          });
        } catch (e) {
          return fail(e, false);
        }
      } else if (r.state === 'pickup_scheduled') {
        try {
          const pdf = await provider.fetchLabel(r.provider_shipment_id);
          const key = `labels/${r.shipment_id}.pdf`;
          await storage.put(key, pdf);
          await db.tx(A, async (c) => {
            await c.query(`UPDATE shipments SET label_key = $2, updated_at = now() WHERE id = $1`, [
              r.shipment_id,
              key,
            ]);
            await c.query(
              `UPDATE shipment_requests SET state = 'done', error = NULL, error_code = NULL, updated_at = now() WHERE id = $1`,
              [id],
            );
          });
        } catch (e) {
          return fail(e, false);
        }
      } else {
        await db.tx(A, (c) => release(c, id));
        throw new AppError('ILLEGAL_STATE', `This shipment request is ${r.state}`);
      }
    }
  } catch (e) {
    await db.tx(A, (c) => release(c, id)).catch(() => undefined);
    throw e;
  }
}

// ============================================================================ reads
const shipDto = (s: Record<string, unknown>) => ({
  id: s.id as string,
  orderId: s.order_id as string,
  orderNumber: (s.order_number as string | undefined) ?? undefined,
  provider: s.provider as string,
  courier: s.courier as string,
  awb: s.tracking_number as string,
  trackingUrl: (s.tracking_url as string | null) ?? null,
  status: s.status as string,
  rawStatus: (s.raw_status as string | null) ?? null,
  codAmountPaise: s.cod_amount_paise as number,
  chargesPaise: (s.charges_paise as number | null) ?? null,
  weightGrams: (s.weight_grams as number | null) ?? null,
  etd: s.etd ? new Date(s.etd as string).toISOString() : null,
  pickupScheduledAt: s.pickup_scheduled_at ? new Date(s.pickup_scheduled_at as string).toISOString() : null,
  lastEventAt: s.last_event_at ? new Date(s.last_event_at as string).toISOString() : null,
  ndrCount: s.ndr_count as number,
  rtoState: (s.rto_state as string | null) ?? null,
  hasLabel: s.label_key != null,
  createdAt: new Date(s.created_at as string).toISOString(),
});

export async function shipmentDetail(db: Db, x: Ctx, shipmentId: string) {
  return db.tx(actorOf(x), async (c) => {
    const s = await c.query(
      `SELECT s.*, o.order_number FROM shipments s JOIN orders o ON o.id = s.order_id WHERE s.id = $1`,
      [shipmentId],
    );
    if (s.rowCount === 0) throw new AppError('NOT_FOUND', 'Shipment not found');
    const ev = await c.query(
      `SELECT status, description, occurred_at, source FROM shipment_events WHERE shipment_id = $1 ORDER BY occurred_at, id`,
      [shipmentId],
    );
    return {
      ...shipDto(s.rows[0]),
      events: ev.rows.map((e) => ({
        status: e.status as string,
        description: e.description as string,
        occurredAt: new Date(e.occurred_at).toISOString(),
        source: e.source as string,
      })),
    };
  });
}

const EXCEPTION_LIST = ['undelivered', 'rto_initiated', 'rto_in_transit', 'lost', 'damaged', 'failed'];
export async function listShipments(
  c: PoolClient,
  f: {
    status?: string;
    courier?: string;
    exception?: boolean;
    stuck?: boolean;
    q?: string;
    limit: number;
    cursor?: string;
  },
) {
  const cur = decodeCursor(f.cursor, z.object({ t: z.string(), id: z.string() }));
  const args: unknown[] = [];
  const add = (v: unknown) => `$${args.push(v)}`;
  const w: string[] = [];
  if (f.status) w.push(`s.status = ${add(f.status)}`);
  if (f.courier) w.push(`s.courier ILIKE ${add(`%${f.courier}%`)}`);
  if (f.exception) w.push(`s.status = ANY(${add(EXCEPTION_LIST)})`);
  if (f.stuck)
    w.push(
      `s.status NOT IN ('delivered','returned_to_origin','cancelled','lost','damaged','failed') AND coalesce(s.last_event_at, s.created_at) < now() - make_interval(hours => (SELECT stuck_after_hours FROM shipping_settings WHERE id = 1))`,
    );
  if (f.q) w.push(`(s.tracking_number ILIKE ${add(`%${f.q}%`)} OR o.order_number ILIKE ${add(`%${f.q}%`)})`);
  if (cur) w.push(`(s.created_at, s.id) < (${add(cur.t)}::timestamptz, ${add(cur.id)}::uuid)`);
  const r = await c.query(
    `SELECT s.*, o.order_number FROM shipments s JOIN orders o ON o.id = s.order_id ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY s.created_at DESC, s.id DESC LIMIT ${add(f.limit + 1)}`,
    args,
  );
  const rows = r.rows.slice(0, f.limit);
  const last = rows[rows.length - 1];
  return {
    items: rows.map(shipDto),
    nextCursor:
      r.rows.length > f.limit && last
        ? encodeCursor({ t: new Date(last.created_at).toISOString(), id: last.id })
        : null,
  };
}

export async function shippingOverview(c: PoolClient) {
  const r = await c.query(
    `SELECT count(*) FILTER (WHERE status = ANY($1))::int AS exceptions,
            count(*) FILTER (WHERE status NOT IN ('delivered','returned_to_origin','cancelled','lost','damaged','failed')
                              AND coalesce(last_event_at, created_at) < now() - make_interval(hours => (SELECT stuck_after_hours FROM shipping_settings WHERE id = 1)))::int AS stuck,
            count(*) FILTER (WHERE status NOT IN ('delivered','returned_to_origin','cancelled','lost','damaged','failed'))::int AS active
       FROM shipments`,
    [EXCEPTION_LIST],
  );
  const ev = await c.query(
    `SELECT count(*) FILTER (WHERE processed_at IS NULL)::int AS pending, count(*) FILTER (WHERE error IS NOT NULL)::int AS errors, max(received_at) AS last_at FROM shipping_provider_events`,
  );
  const rq = await c.query(
    `SELECT count(*) FILTER (WHERE error IS NOT NULL AND state NOT IN ('done','cancelled'))::int AS stalled FROM shipment_requests`,
  );
  return {
    activeShipments: r.rows[0].active as number,
    exceptions: r.rows[0].exceptions as number,
    stuck: r.rows[0].stuck as number,
    webhook: {
      pendingEvents: ev.rows[0].pending as number,
      eventsWithErrors: ev.rows[0].errors as number,
      lastReceivedAt: ev.rows[0].last_at ? new Date(ev.rows[0].last_at).toISOString() : null,
    },
    stalledRequests: rq.rows[0].stalled as number,
  };
}

// ============================================================================ cancel / label
export async function cancelShipment(deps: ShipDeps, x: Ctx, shipmentId: string, reason: string) {
  const { db, provider } = deps;
  const A = actorOf(x);
  const s = (await db.tx(A, (c) => c.query(`SELECT * FROM shipments WHERE id = $1`, [shipmentId]))).rows[0];
  if (!s) throw new AppError('NOT_FOUND', 'Shipment not found');
  if (!['awb_assigned', 'pickup_scheduled', 'pending_provider', 'label_created'].includes(s.status))
    throw new AppError('ILLEGAL_STATE', 'Only a shipment that has not been picked up can be cancelled');
  if (s.provider !== 'manual') {
    try {
      await provider.cancel({ providerOrderId: s.provider_order_id, awb: s.tracking_number });
    } catch (e) {
      throw mapShippingError(e);
    }
  }
  await db.tx(A, async (c) => {
    await c.query(
      `UPDATE shipments SET status = 'cancelled', updated_at = now(), last_event_at = now() WHERE id = $1`,
      [shipmentId],
    );
    await c.query(
      `INSERT INTO shipment_events (shipment_id, status, description, source, created_by) VALUES ($1,'cancelled',$2,'manual',$3)`,
      [shipmentId, `Cancelled: ${reason}`, x.adminId],
    );
    await c.query(
      `UPDATE shipment_requests SET state = 'cancelled', updated_at = now() WHERE shipment_id = $1 AND state NOT IN ('cancelled')`,
      [shipmentId],
    );
    // A manual shipment marks the order `shipped` the moment it is created. Cancelling the only live shipment before pickup must
    // hand the order back to `processing` in the same transaction, otherwise it could never be shipped again (DASH-BR-011).
    let orderStatus: string | undefined;
    const o = (await c.query(`SELECT status FROM orders WHERE id = $1 FOR UPDATE`, [s.order_id])).rows[0] as
      { status: string } | undefined;
    if (o?.status === 'shipped') {
      const other = await c.query(
        `SELECT 1 FROM shipments WHERE order_id = $1 AND id <> $2 AND status NOT IN ('cancelled', 'failed', 'returned_to_origin', 'lost', 'damaged')`,
        [s.order_id, shipmentId],
      );
      if (!other.rowCount) {
        await c.query(`UPDATE orders SET status = 'processing' WHERE id = $1`, [s.order_id]);
        orderStatus = 'processing';
      }
    }
    await audit(c, {
      actorId: x.adminId,
      actorRole: x.role,
      action: 'shipment.cancel',
      resourceType: 'shipment',
      resourceId: shipmentId,
      reason,
      before: { shipmentStatus: s.status },
      after: { shipmentStatus: 'cancelled', ...(orderStatus ? { orderStatus } : {}) },
      requestId: x.requestId,
    });
  });
  return shipmentDetail(db, x, shipmentId);
}

export async function labelFor(deps: ShipDeps, x: Ctx, shipmentId: string): Promise<Buffer> {
  const { db, provider, storage } = deps;
  const s = (
    await db.tx(actorOf(x), (c) =>
      c.query(`SELECT label_key, provider, provider_shipment_id FROM shipments WHERE id = $1`, [shipmentId]),
    )
  ).rows[0];
  if (!s) throw new AppError('NOT_FOUND', 'Shipment not found');
  if (s.label_key) {
    const b = await storage.get(s.label_key);
    if (b) return b;
  }
  if (s.provider === 'manual' || !s.provider_shipment_id)
    throw new AppError('NOT_FOUND', 'No label is stored for this shipment');
  try {
    const pdf = await provider.fetchLabel(s.provider_shipment_id);
    const key = `labels/${shipmentId}.pdf`;
    await storage.put(key, pdf);
    await db.tx(actorOf(x), (c) =>
      c.query(`UPDATE shipments SET label_key = $2 WHERE id = $1`, [shipmentId, key]),
    );
    return pdf;
  } catch (e) {
    throw mapShippingError(e);
  }
}

// ============================================================================ webhook intake + processing
export async function ingestShippingWebhook(
  db: Db,
  provider: ShippingProvider,
  raw: Buffer,
  headers: Record<string, string | string[] | undefined>,
) {
  const hook = provider.verifyWebhook(raw, headers); // throws WebhookVerificationError
  return storeEvent(db, provider.name, hook);
}

async function storeEvent(db: Db, providerName: string, hook: ProviderWebhook) {
  const r = await db.tx(SYSTEM, (c) =>
    c.query(
      `INSERT INTO shipping_provider_events (provider, dedupe_key, awb, payload) VALUES ($1,$2,$3,$4) ON CONFLICT (dedupe_key) DO NOTHING RETURNING id`,
      [providerName, hook.dedupeKey, hook.awb, JSON.stringify(hook)],
    ),
  );
  return { duplicate: r.rowCount === 0, eventId: (r.rows[0]?.id as string | undefined) ?? null };
}

const RANK: Record<string, number> = {
  pending_provider: 0,
  label_created: 1,
  awb_assigned: 2,
  pickup_scheduled: 3,
  picked_up: 4,
  in_transit: 5,
  out_for_delivery: 6,
  delivered: 7,
};
const TERMINAL = new Set(['delivered', 'returned_to_origin', 'cancelled', 'lost', 'damaged']);
const ORDER_PATH = ['processing', 'shipped', 'out_for_delivery', 'delivered'];

/** Whether `next` may replace `cur`: forward progress, NDR/RTO exceptions, and re-attempts after an NDR. */
export function allowedTransition(cur: string, next: NormalStatus): boolean {
  if (TERMINAL.has(cur)) return false;
  if (next === cur) return false;
  if (['rto_initiated', 'rto_in_transit', 'returned_to_origin'].includes(cur))
    return ['rto_in_transit', 'returned_to_origin', 'lost', 'damaged'].includes(next) && cur !== next;
  if (cur === 'undelivered')
    return (
      next === 'out_for_delivery' ||
      next === 'delivered' ||
      (next as string).startsWith('rto') ||
      next === 'returned_to_origin' ||
      next === 'lost' ||
      next === 'damaged' ||
      next === 'in_transit'
    );
  if (next in RANK) return (RANK[next] as number) > (RANK[cur] ?? -1);
  return true; // exception states
}

export async function processShippingEvent(
  db: Db,
  eventId: string,
): Promise<'applied' | 'ignored' | 'unknown_awb' | 'unmapped'> {
  return db.tx(SYSTEM, async (c) => {
    const e = await c.query(
      `SELECT * FROM shipping_provider_events WHERE id = $1 AND processed_at IS NULL FOR UPDATE SKIP LOCKED`,
      [eventId],
    );
    if (e.rowCount === 0) return 'ignored';
    const hook = e.rows[0].payload as ProviderWebhook;
    const sh = (await c.query(`SELECT * FROM shipments WHERE tracking_number = $1 FOR UPDATE`, [hook.awb]))
      .rows[0];
    const done = (error: string | null) =>
      c.query(`UPDATE shipping_provider_events SET processed_at = now(), error = $2 WHERE id = $1`, [
        eventId,
        error,
      ]);
    if (!sh) {
      await done('unknown awb');
      return 'unknown_awb';
    }
    // history: every scan once (unique index makes replays harmless)
    const scans = [...hook.events].sort((a, b) => a.at.localeCompare(b.at));
    for (const s of scans) {
      const st = normaliseStatus(s.status) ?? s.status.toLowerCase().replace(/\s+/g, '_').slice(0, 60);
      await c.query(
        `INSERT INTO shipment_events (shipment_id, status, description, occurred_at, source) VALUES ($1,$2,$3,$4,'provider') ON CONFLICT DO NOTHING`,
        [sh.id, st || 'update', `${s.activity}${s.location ? ` — ${s.location}` : ''}`.slice(0, 300), s.at],
      );
    }
    const next = normaliseStatus(hook.currentStatus);
    await c.query(
      `UPDATE shipments SET raw_status = $2, raw_status_id = $3, last_event_at = greatest(coalesce(last_event_at, $4::timestamptz), $4::timestamptz), etd = coalesce($5::timestamptz, etd), updated_at = now() WHERE id = $1`,
      [sh.id, hook.currentStatus, hook.currentStatusId, hook.occurredAt, hook.etd],
    );
    if (!next) {
      await done(`unmapped status "${hook.currentStatus}"`);
      return 'unmapped';
    }
    if (!allowedTransition(sh.status, next)) {
      await done(null);
      return 'ignored';
    }
    const ndr = next === 'undelivered' ? ', ndr_count = ndr_count + 1' : '';
    const rto = next.startsWith('rto')
      ? `, rto_state = '${next}'`
      : next === 'returned_to_origin'
        ? `, rto_state = 'returned_to_origin'`
        : '';
    await c.query(`UPDATE shipments SET status = $2 ${ndr} ${rto} WHERE id = $1`, [sh.id, next]);
    if (!scans.length)
      await c.query(
        `INSERT INTO shipment_events (shipment_id, status, description, occurred_at, source) VALUES ($1,$2,$3,$4,'provider') ON CONFLICT DO NOTHING`,
        [sh.id, next, hook.currentStatus, hook.occurredAt],
      );

    // order progression follows pickup / delivery (never cancels or refunds on its own)
    const wanted =
      next === 'picked_up' || next === 'in_transit'
        ? 'shipped'
        : next === 'out_for_delivery'
          ? 'out_for_delivery'
          : next === 'delivered'
            ? 'delivered'
            : null;
    if (wanted) {
      const o = (await c.query(`SELECT * FROM orders WHERE id = $1 FOR UPDATE`, [sh.order_id])).rows[0];
      let i = ORDER_PATH.indexOf(o.status);
      const target = ORDER_PATH.indexOf(wanted);
      while (i >= 0 && i < target) {
        const to = ORDER_PATH[i + 1]!;
        await c.query(`UPDATE orders SET status = $2 WHERE id = $1`, [o.id, to]);
        await c.query(
          `INSERT INTO outbox (aggregate_type, aggregate_id, event_type, payload) VALUES ('order',$1,$2,$3)`,
          [
            o.id,
            `order.${to}`,
            to === 'shipped'
              ? {
                  orderId: o.id,
                  userId: o.user_id,
                  courier: sh.courier,
                  trackingNumber: sh.tracking_number,
                  trackingUrl: sh.tracking_url,
                }
              : { orderId: o.id, userId: o.user_id },
          ],
        );
        i++;
      }
    }
    await done(null);
    return 'applied';
  });
}

/** Applies events that were stored but not yet processed (webhook handler crashed / worker sweep). */
export async function sweepShippingEvents(db: Db, limit = 50): Promise<number> {
  const ids = (
    await db.tx(SYSTEM, (c) =>
      c.query(`SELECT id FROM shipping_provider_events WHERE processed_at IS NULL ORDER BY id LIMIT $1`, [
        limit,
      ]),
    )
  ).rows.map((r) => r.id as string);
  for (const id of ids) await processShippingEvent(db, id).catch(() => undefined);
  return ids.length;
}

/** Polls the provider for active shipments that have been silent for a while (missed webhooks). */
export async function reconcileShipments(
  db: Db,
  provider: ShippingProvider,
  silentHours = 6,
  limit = 25,
): Promise<number> {
  const rows = (
    await db.tx(SYSTEM, (c) =>
      c.query(
        `SELECT tracking_number FROM shipments WHERE provider <> 'manual' AND status NOT IN ('delivered','returned_to_origin','cancelled','lost','damaged','failed','awb_assigned','pickup_scheduled') AND coalesce(last_event_at, created_at) < now() - make_interval(hours => $1) ORDER BY coalesce(last_event_at, created_at) LIMIT $2`,
        [silentHours, limit],
      ),
    )
  ).rows;
  let n = 0;
  for (const r of rows) {
    try {
      const t = await provider.track(r.tracking_number);
      const at = t.events[t.events.length - 1]?.at ?? new Date().toISOString();
      const hook: ProviderWebhook = {
        dedupeKey: createHash('sha256').update(`rec|${t.awb}|${t.currentStatus}|${at}`).digest('hex'),
        awb: t.awb,
        currentStatus: t.currentStatus,
        currentStatusId: t.currentStatusId,
        occurredAt: at,
        etd: t.etd,
        isReturn: false,
        events: t.events,
        payload: { reconciled: true },
      };
      const ev = await storeEvent(db, provider.name, hook);
      if (ev.eventId) await processShippingEvent(db, ev.eventId);
      n++;
    } catch {
      /* one bad shipment must not stop the sweep */
    }
  }
  return n;
}

// ============================================================================ bulk
export async function createBulkJob(
  c: PoolClient,
  x: Ctx,
  input: {
    orderIds: string[];
    strategy: 'cheapest' | 'fastest' | 'balanced' | 'preferred' | 'courier';
    courierId?: string;
  },
) {
  if (new Set(input.orderIds).size !== input.orderIds.length)
    throw new AppError('VALIDATION_FAILED', 'Duplicate orders in the selection', {
      fields: { orderIds: 'duplicates' },
    });
  if (input.strategy === 'courier' && !input.courierId)
    throw new AppError('VALIDATION_FAILED', 'Choose a courier', { fields: { courierId: 'required' } });
  const r = await c.query(
    `INSERT INTO shipping_bulk_jobs (created_by, strategy, courier_id, order_ids) VALUES ($1,$2,$3,$4) RETURNING id`,
    [x.adminId, input.strategy, input.courierId ?? null, input.orderIds],
  );
  await audit(c, {
    actorId: x.adminId,
    actorRole: x.role,
    action: 'shipment.bulk',
    resourceType: 'bulk_job',
    resourceId: r.rows[0].id,
    after: { count: input.orderIds.length, strategy: input.strategy },
    requestId: x.requestId,
  });
  return r.rows[0].id as string;
}

export async function getBulkJob(c: PoolClient, id: string) {
  const r = await c.query(`SELECT * FROM shipping_bulk_jobs WHERE id = $1`, [id]);
  if (r.rowCount === 0) throw new AppError('NOT_FOUND', 'Job not found');
  const j = r.rows[0];
  const results = j.results as Array<{ orderId: string; ok: boolean }>;
  return {
    id: j.id as string,
    status: j.status as string,
    strategy: j.strategy as string,
    total: (j.order_ids as string[]).length,
    completed: results.length,
    succeeded: results.filter((x) => x.ok).length,
    failed: results.filter((x) => !x.ok).length,
    results,
    createdAt: new Date(j.created_at).toISOString(),
  };
}

/** Processes a job sequentially (resumable: orders already in `results` are skipped). Never double-creates (see shipOrder). */
export async function runBulkJob(deps: ShipDeps, jobId: string): Promise<void> {
  const { db, provider } = deps;
  const claimed = await db.tx(SYSTEM, (c) =>
    c.query(
      `UPDATE shipping_bulk_jobs SET status = 'running', updated_at = now() WHERE id = $1 AND (status = 'queued' OR (status = 'running' AND updated_at < now() - interval '2 minutes')) RETURNING *`,
      [jobId],
    ),
  );
  if (claimed.rowCount === 0) return;
  const job = claimed.rows[0];
  const adminRow = (
    await db.tx(SYSTEM, (c) => c.query(`SELECT role FROM admin_users WHERE user_id = $1`, [job.created_by]))
  ).rows[0];
  const x: Ctx = { adminId: job.created_by, role: (adminRow?.role as AdminRole) ?? 'fulfillment' };
  const done = new Set((job.results as Array<{ orderId: string }>).map((r) => r.orderId));
  for (const orderId of job.order_ids as string[]) {
    if (done.has(orderId)) continue;
    let result: Record<string, unknown>;
    try {
      let courierId: string | undefined = job.courier_id ?? undefined;
      if (job.strategy !== 'courier') {
        const plan = await planShipment(db, provider, x, orderId);
        if (!plan.serviceable)
          throw new AppError('NOT_SERVICEABLE', 'The delivery PIN code is not serviceable');
        const s = await db.tx(actorOf(x), (c) => getShippingSettings(c));
        courierId = chooseCourier(plan.options, job.strategy, s.preferredCouriers)?.courierId;
      }
      const sh = await shipOrder(deps, x, orderId, { courierId });
      result = { orderId, ok: true, shipmentId: sh.id, awb: sh.awb, courier: sh.courier };
    } catch (e) {
      const ae = e instanceof AppError ? e : mapShippingError(e);
      result = { orderId, ok: false, code: ae.code, error: ae.message };
    }
    await db.tx(SYSTEM, (c) =>
      c.query(
        `UPDATE shipping_bulk_jobs SET results = results || $2::jsonb, updated_at = now() WHERE id = $1`,
        [jobId, JSON.stringify([result])],
      ),
    );
  }
  await db.tx(SYSTEM, (c) =>
    c.query(`UPDATE shipping_bulk_jobs SET status = 'done', updated_at = now() WHERE id = $1`, [jobId]),
  );
}

export async function sweepBulkJobs(deps: ShipDeps): Promise<number> {
  const ids = (
    await deps.db.tx(SYSTEM, (c) =>
      c.query(
        `SELECT id FROM shipping_bulk_jobs WHERE status = 'queued' OR (status = 'running' AND updated_at < now() - interval '2 minutes') LIMIT 5`,
      ),
    )
  ).rows.map((r) => r.id as string);
  for (const id of ids) await runBulkJob(deps, id).catch(() => undefined);
  return ids.length;
}

export { WebhookVerificationError };
