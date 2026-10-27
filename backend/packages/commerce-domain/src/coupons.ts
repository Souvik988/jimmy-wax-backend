import { z } from 'zod';
import type { PoolClient } from '@jw/database';
import { AppError, decodeCursor, encodeCursor } from '@jw/contracts';
import { audit, type AdminRole } from './admin.ts';

interface Ctx {
  adminId: string;
  role: AdminRole;
  requestId?: string;
}

export interface CouponRow {
  id: string;
  code: string;
  description: string;
  kind: 'percentage' | 'flat' | 'free_shipping';
  value_bps: number | null;
  value_paise: number | null;
  min_order_paise: number;
  max_discount_paise: number | null;
  starts_at: Date | null;
  ends_at: Date | null;
  usage_limit_total: number | null;
  usage_limit_per_customer: number;
  first_order_only: boolean;
  scope_product_ids: string[];
  active: boolean;
}

export const normaliseCode = (s: string) => s.trim().toUpperCase();
const invalid = (reason: string, message: string): never => {
  throw new AppError('COUPON_INVALID', message, { reason });
};

export interface DiscountLine {
  key: string;
  productId: string;
  amountPaise: number;
}
export interface DiscountResult {
  /** Item discount in paise (never exceeds the eligible subtotal). */
  discountPaise: number;
  /** Shipping waived by a free-shipping coupon. */
  shippingDiscountPaise: number;
  /** Per input line, same order: the part of `discountPaise` allocated to it. Sums exactly to `discountPaise`. */
  lineDiscounts: number[];
}

/** Largest-remainder split of `total` across `weights`, so the parts sum exactly to `total`. */
export function allocate(total: number, weights: number[]): number[] {
  const sum = weights.reduce((n, w) => n + w, 0);
  if (total === 0 || sum === 0) return weights.map(() => 0);
  const raw = weights.map((w) => (total * w) / sum);
  const out = raw.map(Math.floor);
  let left = total - out.reduce((n, x) => n + x, 0);
  const order = raw.map((r, i) => ({ i, f: r - Math.floor(r) })).sort((a, b) => b.f - a.f || a.i - b.i);
  for (const { i } of order) {
    if (left <= 0) break;
    if (weights[i]! > 0) {
      out[i]!++;
      left--;
    }
  }
  return out;
}

/** Pure discount maths: no database, fully deterministic. Throws COUPON_INVALID when the cart does not qualify. */
export function computeDiscount(
  coupon: Pick<
    CouponRow,
    'kind' | 'value_bps' | 'value_paise' | 'min_order_paise' | 'max_discount_paise' | 'scope_product_ids'
  >,
  lines: DiscountLine[],
  shippingPaise: number,
): DiscountResult {
  const subtotal = lines.reduce((n, l) => n + l.amountPaise, 0);
  if (subtotal < coupon.min_order_paise) {
    invalid(
      'min_order',
      `Add items worth ₹${(coupon.min_order_paise / 100).toFixed(0)} or more to use this code`,
    );
  }
  const scoped = coupon.scope_product_ids.length > 0;
  const eligible = lines.map((l) =>
    !scoped || coupon.scope_product_ids.includes(l.productId) ? l.amountPaise : 0,
  );
  const eligibleSubtotal = eligible.reduce((n, x) => n + x, 0);
  if (coupon.kind === 'free_shipping') {
    if (shippingPaise <= 0) invalid('shipping_already_free', 'Shipping is already free on this order');
    return { discountPaise: 0, shippingDiscountPaise: shippingPaise, lineDiscounts: lines.map(() => 0) };
  }
  if (eligibleSubtotal <= 0) invalid('not_applicable', 'This code does not apply to the items in your cart');
  let d =
    coupon.kind === 'percentage'
      ? Math.floor((eligibleSubtotal * coupon.value_bps!) / 10_000)
      : coupon.value_paise!;
  if (coupon.max_discount_paise !== null) d = Math.min(d, coupon.max_discount_paise);
  d = Math.min(d, eligibleSubtotal);
  if (d <= 0) invalid('no_discount', 'This code gives no discount on your cart');
  return { discountPaise: d, shippingDiscountPaise: 0, lineDiscounts: allocate(d, eligible) };
}

async function findByCode(c: PoolClient, code: string, lock: boolean): Promise<CouponRow> {
  const r = await c.query<CouponRow>(`SELECT * FROM coupons WHERE code = $1 ${lock ? 'FOR UPDATE' : ''}`, [
    normaliseCode(code),
  ]);
  // Same message for unknown and inactive codes so codes cannot be enumerated.
  if (!r.rows[0] || !r.rows[0].active) return invalid('unknown', 'This code is not valid');
  return r.rows[0];
}

/** Window, usage and customer-history rules. Called at quote time and again (with the row locked) at order time. */
async function assertUsable(c: PoolClient, coupon: CouponRow, userId: string): Promise<void> {
  const now = Date.now();
  if (coupon.starts_at && coupon.starts_at.getTime() > now)
    invalid('not_started', 'This code is not active yet');
  if (coupon.ends_at && coupon.ends_at.getTime() <= now) invalid('expired', 'This code has expired');
  // All customers' redemptions are hidden from this role by RLS, so the counts come from a definer function.
  const used = await c.query('SELECT total, mine FROM private.coupon_usage($1, $2)', [coupon.id, userId]);
  if (coupon.usage_limit_total !== null && used.rows[0].total >= coupon.usage_limit_total) {
    invalid('fully_redeemed', 'This code has been fully redeemed');
  }
  if (used.rows[0].mine >= coupon.usage_limit_per_customer)
    invalid('already_used', 'You have already used this code');
  if (coupon.first_order_only) {
    const prior = await c.query(
      `SELECT 1 FROM orders WHERE user_id = $1 AND status NOT IN ('cancelled','expired') LIMIT 1`,
      [userId],
    );
    if ((prior.rowCount ?? 0) > 0) invalid('first_order_only', 'This code is for first orders only');
  }
}

export interface AppliedCoupon extends DiscountResult {
  couponId: string;
  code: string;
}

/** Quote-time evaluation (read-only). */
export async function evaluateCoupon(
  c: PoolClient,
  userId: string,
  code: string,
  lines: DiscountLine[],
  shippingPaise: number,
): Promise<AppliedCoupon> {
  const coupon = await findByCode(c, code, false);
  await assertUsable(c, coupon, userId);
  return { couponId: coupon.id, code: coupon.code, ...computeDiscount(coupon, lines, shippingPaise) };
}

/** Order-time redemption: locks the coupon row so the total usage limit cannot be oversold by concurrent orders. */
export async function redeemCoupon(
  c: PoolClient,
  x: {
    couponId: string;
    userId: string;
    orderId: string;
    discountPaise: number;
    shippingDiscountPaise: number;
  },
): Promise<void> {
  // Serialise concurrent redemptions of one coupon (the customer role cannot row-lock coupons under RLS).
  await c.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 7))`, [x.couponId]);
  const row = (await c.query<CouponRow>(`SELECT * FROM coupons WHERE id = $1`, [x.couponId])).rows[0];
  if (!row || !row.active) invalid('unknown', 'This code is no longer valid; request a new quote');
  await assertUsable(c, row!, x.userId);
  await c.query(
    `INSERT INTO coupon_redemptions (coupon_id, order_id, user_id, discount_paise, shipping_discount_paise) VALUES ($1,$2,$3,$4,$5)`,
    [x.couponId, x.orderId, x.userId, x.discountPaise, x.shippingDiscountPaise],
  );
}

// ------------------------------------------------------------------ cart
export async function setCartCoupon(c: PoolClient, userId: string, code: string) {
  const cart = (await c.query(`SELECT id FROM carts WHERE user_id = $1 FOR UPDATE`, [userId])).rows[0];
  if (!cart) throw new AppError('ITEM_UNAVAILABLE', 'Your cart is empty');
  const lines = (
    await c.query(
      `SELECT l.variant_id AS key, v.product_id AS "productId", (v.price_paise * l.quantity)::int AS "amountPaise"
         FROM cart_lines l JOIN product_variants v ON v.id = l.variant_id WHERE l.cart_id = $1 ORDER BY l.variant_id`,
      [cart.id],
    )
  ).rows as DiscountLine[];
  if (!lines.length) throw new AppError('ITEM_UNAVAILABLE', 'Your cart is empty');
  // Shipping is judged at quote time; here only the item-side rules are previewed.
  const coupon = await findByCode(c, code, false);
  await assertUsable(c, coupon, userId);
  const preview =
    coupon.kind === 'free_shipping'
      ? { discountPaise: 0, shippingDiscountPaise: 0, lineDiscounts: [] }
      : computeDiscount(coupon, lines, 0);
  await c.query(`UPDATE carts SET coupon_code = $2, updated_at = now() WHERE id = $1`, [
    cart.id,
    coupon.code,
  ]);
  return {
    couponCode: coupon.code,
    description: coupon.description,
    kind: coupon.kind,
    discountPaise: preview.discountPaise,
    freeShipping: coupon.kind === 'free_shipping',
  };
}
export async function clearCartCoupon(c: PoolClient, userId: string): Promise<void> {
  await c.query(`UPDATE carts SET coupon_code = NULL, updated_at = now() WHERE user_id = $1`, [userId]);
}
export async function cartCouponCode(c: PoolClient, cartId: string): Promise<string | null> {
  return (
    ((await c.query(`SELECT coupon_code FROM carts WHERE id = $1`, [cartId])).rows[0]?.coupon_code as
      string | null) ?? null
  );
}

// ----------------------------------------------------------------- admin
const money = z.number().int().min(1).max(100_000_000);
const when = z.string().datetime({ offset: true }).nullable().optional();
export const CouponBase = z.object({
  code: z
    .string()
    .trim()
    .transform((s) => s.toUpperCase())
    .pipe(z.string().regex(/^[A-Z0-9][A-Z0-9_-]{2,31}$/, '3–32 characters: letters, digits, - or _')),
  description: z.string().trim().max(300).default(''),
  kind: z.enum(['percentage', 'flat', 'free_shipping']),
  valueBps: z.number().int().min(1).max(10_000).nullable().optional(),
  valuePaise: money.nullable().optional(),
  minOrderPaise: z.number().int().min(0).max(100_000_000).default(0),
  maxDiscountPaise: money.nullable().optional(),
  startsAt: when,
  endsAt: when,
  usageLimitTotal: z.number().int().min(1).max(10_000_000).nullable().optional(),
  usageLimitPerCustomer: z.number().int().min(1).max(1000).default(1),
  firstOrderOnly: z.boolean().default(false),
  scopeProductIds: z.array(z.string().min(2).max(100)).max(200).default([]),
  active: z.boolean().default(true),
});
export const CouponInput = CouponBase.superRefine((v, ctx) => {
  const bad = (path: string, message: string) => ctx.addIssue({ code: 'custom', path: [path], message });
  if (v.kind === 'percentage') {
    if (!v.valueBps) bad('valueBps', 'required for a percentage coupon');
    if (v.valuePaise) bad('valuePaise', 'not allowed for a percentage coupon');
  } else if (v.kind === 'flat') {
    if (!v.valuePaise) bad('valuePaise', 'required for a flat coupon');
    if (v.valueBps) bad('valueBps', 'not allowed for a flat coupon');
  } else if (v.valueBps || v.valuePaise) bad('valuePaise', 'a free-shipping coupon has no amount');
  if (v.startsAt && v.endsAt && Date.parse(v.endsAt) <= Date.parse(v.startsAt))
    bad('endsAt', 'must be after startsAt');
});
export type CouponInput = z.infer<typeof CouponInput>;

/** Fields that stay editable once a coupon has been redeemed; its value and type are then frozen. */
export const CouponPatch = CouponBase.partial().omit({ code: true });
export type CouponPatch = z.infer<typeof CouponPatch>;

const dto = (r: Record<string, any>) => ({
  id: r.id as string,
  code: r.code as string,
  description: r.description as string,
  kind: r.kind as string,
  valueBps: r.value_bps as number | null,
  valuePaise: r.value_paise as number | null,
  minOrderPaise: r.min_order_paise as number,
  maxDiscountPaise: r.max_discount_paise as number | null,
  startsAt: r.starts_at ? new Date(r.starts_at).toISOString() : null,
  endsAt: r.ends_at ? new Date(r.ends_at).toISOString() : null,
  usageLimitTotal: r.usage_limit_total as number | null,
  usageLimitPerCustomer: r.usage_limit_per_customer as number,
  firstOrderOnly: r.first_order_only as boolean,
  scopeProductIds: r.scope_product_ids as string[],
  active: r.active as boolean,
  redeemed: Number(r.redeemed ?? 0),
  discountGivenPaise: Number(r.discount_given ?? 0),
  status: couponStatus(r),
  createdAt: new Date(r.created_at).toISOString(),
});
function couponStatus(r: Record<string, any>): 'inactive' | 'scheduled' | 'expired' | 'exhausted' | 'live' {
  const now = Date.now();
  if (!r.active) return 'inactive';
  if (r.starts_at && new Date(r.starts_at).getTime() > now) return 'scheduled';
  if (r.ends_at && new Date(r.ends_at).getTime() <= now) return 'expired';
  if (r.usage_limit_total !== null && Number(r.redeemed ?? 0) >= r.usage_limit_total) return 'exhausted';
  return 'live';
}

const WITH_STATS = `SELECT c.*, coalesce(s.n,0) AS redeemed, coalesce(s.d,0) AS discount_given
  FROM coupons c LEFT JOIN LATERAL (SELECT count(*) AS n, sum(discount_paise + shipping_discount_paise) AS d
    FROM coupon_redemptions r WHERE r.coupon_id = c.id AND r.released_at IS NULL) s ON true`;

export async function listCoupons(c: PoolClient, q: { cursor?: string; limit: number; status?: string }) {
  const cur = decodeCursor(q.cursor, z.object({ t: z.string(), i: z.string() }));
  const r = await c.query(
    `${WITH_STATS} WHERE ($1::timestamptz IS NULL OR (c.created_at, c.id::text) < ($1::timestamptz, $2)) ORDER BY c.created_at DESC, c.id DESC LIMIT $3`,
    [cur?.t ?? null, cur?.i ?? null, q.limit + 1],
  );
  const rows = r.rows
    .slice(0, q.limit)
    .map(dto)
    .filter((x) => !q.status || x.status === q.status);
  const last = r.rows[q.limit - 1];
  return {
    items: rows,
    nextCursor:
      r.rows.length > q.limit && last
        ? encodeCursor({ t: new Date(last.created_at).toISOString(), i: last.id })
        : null,
  };
}

export async function getCoupon(c: PoolClient, id: string) {
  const r = await c.query(`${WITH_STATS} WHERE c.id = $1`, [id]);
  if (!r.rows[0]) throw new AppError('NOT_FOUND', 'Coupon not found');
  const recent = await c.query(
    `SELECT r.order_id, o.order_number, r.discount_paise, r.shipping_discount_paise, r.released_at, r.created_at
       FROM coupon_redemptions r JOIN orders o ON o.id = r.order_id WHERE r.coupon_id = $1 ORDER BY r.id DESC LIMIT 20`,
    [id],
  );
  return {
    ...dto(r.rows[0]),
    recentRedemptions: recent.rows.map((x) => ({
      orderId: x.order_id as string,
      orderNumber: x.order_number as string,
      discountPaise: x.discount_paise as number,
      shippingDiscountPaise: x.shipping_discount_paise as number,
      released: !!x.released_at,
      at: new Date(x.created_at).toISOString(),
    })),
  };
}

const COLS = (v: CouponInput) => [
  v.code,
  v.description,
  v.kind,
  v.valueBps ?? null,
  v.valuePaise ?? null,
  v.minOrderPaise,
  v.maxDiscountPaise ?? null,
  v.startsAt ?? null,
  v.endsAt ?? null,
  v.usageLimitTotal ?? null,
  v.usageLimitPerCustomer,
  v.firstOrderOnly,
  v.scopeProductIds,
  v.active,
];

export async function createCoupon(c: PoolClient, x: Ctx, v: CouponInput) {
  if (v.scopeProductIds.length) {
    const ok = await c.query(`SELECT count(*)::int AS n FROM products WHERE id = ANY($1::text[])`, [
      v.scopeProductIds,
    ]);
    if (ok.rows[0].n !== new Set(v.scopeProductIds).size) {
      throw new AppError('VALIDATION_FAILED', 'Some products in scope do not exist', {
        fields: { scopeProductIds: 'unknown product' },
      });
    }
  }
  let id: string;
  try {
    id = (
      await c.query(
        `INSERT INTO coupons (code, description, kind, value_bps, value_paise, min_order_paise, max_discount_paise, starts_at, ends_at,
            usage_limit_total, usage_limit_per_customer, first_order_only, scope_product_ids, active, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
        [...COLS(v), x.adminId],
      )
    ).rows[0].id;
  } catch (e) {
    if ((e as { code?: string }).code === '23505') {
      throw new AppError('VALIDATION_FAILED', 'That coupon code already exists', {
        fields: { code: 'already exists' },
      });
    }
    throw e;
  }
  await audit(c, {
    actorId: x.adminId,
    actorRole: x.role,
    action: 'coupon.create',
    resourceType: 'coupon',
    resourceId: id,
    after: v,
    requestId: x.requestId,
  });
  return getCoupon(c, id);
}

export async function updateCoupon(c: PoolClient, x: Ctx, id: string, p: CouponPatch) {
  const cur = (await c.query<CouponRow>(`SELECT * FROM coupons WHERE id = $1 FOR UPDATE`, [id])).rows[0];
  if (!cur) throw new AppError('NOT_FOUND', 'Coupon not found');
  const used = (await c.query(`SELECT count(*)::int AS n FROM coupon_redemptions WHERE coupon_id = $1`, [id]))
    .rows[0].n;
  if (used > 0 && (p.kind !== undefined || p.valueBps !== undefined || p.valuePaise !== undefined)) {
    throw new AppError(
      'ILLEGAL_STATE',
      "A redeemed coupon's type and value cannot change; create a new coupon instead",
    );
  }
  const merged = CouponInput.parse({
    code: cur.code,
    description: p.description ?? cur.description,
    kind: p.kind ?? cur.kind,
    valueBps: p.valueBps === undefined ? cur.value_bps : p.valueBps,
    valuePaise: p.valuePaise === undefined ? cur.value_paise : p.valuePaise,
    minOrderPaise: p.minOrderPaise ?? cur.min_order_paise,
    maxDiscountPaise: p.maxDiscountPaise === undefined ? cur.max_discount_paise : p.maxDiscountPaise,
    startsAt: p.startsAt === undefined ? (cur.starts_at?.toISOString() ?? null) : p.startsAt,
    endsAt: p.endsAt === undefined ? (cur.ends_at?.toISOString() ?? null) : p.endsAt,
    usageLimitTotal: p.usageLimitTotal === undefined ? cur.usage_limit_total : p.usageLimitTotal,
    usageLimitPerCustomer: p.usageLimitPerCustomer ?? cur.usage_limit_per_customer,
    firstOrderOnly: p.firstOrderOnly ?? cur.first_order_only,
    scopeProductIds: p.scopeProductIds ?? cur.scope_product_ids,
    active: p.active ?? cur.active,
  });
  await c.query(
    `UPDATE coupons SET description=$2, kind=$3, value_bps=$4, value_paise=$5, min_order_paise=$6, max_discount_paise=$7, starts_at=$8, ends_at=$9,
            usage_limit_total=$10, usage_limit_per_customer=$11, first_order_only=$12, scope_product_ids=$13, active=$14, updated_at=now()
      WHERE id = $1`,
    [id, ...COLS(merged).slice(1)],
  );
  await audit(c, {
    actorId: x.adminId,
    actorRole: x.role,
    action: 'coupon.update',
    resourceType: 'coupon',
    resourceId: id,
    before: dto(cur),
    after: p,
    requestId: x.requestId,
  });
  return getCoupon(c, id);
}

/** Aggregates for the dashboard: what coupons cost and earn. */
export async function couponAnalytics(c: PoolClient) {
  const t = (
    await c.query(
      `SELECT count(*)::int AS redemptions, coalesce(sum(r.discount_paise),0)::bigint AS discount, coalesce(sum(r.shipping_discount_paise),0)::bigint AS ship,
              coalesce(sum(o.total_paise),0)::bigint AS revenue
         FROM coupon_redemptions r JOIN orders o ON o.id = r.order_id WHERE r.released_at IS NULL`,
    )
  ).rows[0];
  const top = await c.query(
    `SELECT cp.code, count(*)::int AS redemptions, sum(r.discount_paise + r.shipping_discount_paise)::bigint AS cost
       FROM coupon_redemptions r JOIN coupons cp ON cp.id = r.coupon_id WHERE r.released_at IS NULL GROUP BY cp.code ORDER BY redemptions DESC, cp.code LIMIT 10`,
  );
  return {
    redemptions: t.redemptions as number,
    discountGivenPaise: Number(t.discount) + Number(t.ship),
    orderRevenuePaise: Number(t.revenue),
    top: top.rows.map((x) => ({
      code: x.code as string,
      redemptions: x.redemptions as number,
      costPaise: Number(x.cost),
    })),
  };
}
