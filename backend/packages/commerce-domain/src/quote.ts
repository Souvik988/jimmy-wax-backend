import type { PoolClient } from '@jw/database';
import { AppError, type PaymentMethod } from '@jw/contracts';
import { checkServiceability } from './shipping.ts';
import { lockCart } from './cart.ts';
import { cartCouponCode, evaluateCoupon, type AppliedCoupon } from './coupons.ts';
import { computeTax, shippingFor, totals, type TaxBreakdown } from './money.ts';

export interface Flags {
  checkout: boolean;
  cod: boolean;
  onlinePayments: boolean;
}

export interface Settings {
  shipping_fee_paise: number;
  free_shipping_threshold_paise: number | null;
  cod_enabled: boolean;
  cod_max_order_paise: number | null;
  checkout_enabled: boolean;
  checkout_policy_confirmed: boolean;
  checkout_authority: 'legacy_trigger' | 'express';
  online_payments_enabled: boolean;
  payment_window_minutes: number | null;
  orders_paused: boolean;
  pause_message: string;
  quote_ttl_minutes: number;
  rules_version: number;
  version: number;
  gst_rate_bps: number;
  tax_inclusive: boolean;
  cod_fee_paise: number;
  merchant_gstin: string | null;
  merchant_state: string | null;
  merchant_legal_name: string | null;
  merchant_address: string | null;
  return_window_days: number | null;
  brand_name: string;
  support_email: string | null;
  support_phone: string | null;
}

export async function loadSettings(c: PoolClient): Promise<Settings> {
  const r = await c.query<Settings>(`SELECT * FROM store_settings WHERE id = 1`);
  if (!r.rows[0]) throw new AppError('POLICY_NOT_CONFIGURED', 'Store settings are missing');
  return r.rows[0];
}

/** All merchant/ops gates. Order matters: report the most fundamental blocker first. */
export function assertCheckoutOpen(s: Settings, flags: Flags, method: PaymentMethod): void {
  if (s.checkout_authority !== 'express')
    throw new AppError('CHECKOUT_DISABLED', 'Checkout is not served by this API yet');
  if (s.orders_paused)
    throw new AppError('CHECKOUT_DISABLED', s.pause_message || 'Orders are paused for a short while', {
      paused: true,
    });
  if (!flags.checkout || !s.checkout_enabled)
    throw new AppError('CHECKOUT_DISABLED', 'Checkout is currently disabled');
  if (!s.checkout_policy_confirmed)
    throw new AppError('POLICY_NOT_CONFIGURED', 'Store policies have not been confirmed');
  if (method === 'cod' && (!flags.cod || !s.cod_enabled)) {
    throw new AppError('UNSUPPORTED_PAYMENT_METHOD', 'Cash on Delivery is not available');
  }
  if (method === 'online') {
    if (!flags.onlinePayments || !s.online_payments_enabled) {
      throw new AppError('UNSUPPORTED_PAYMENT_METHOD', 'Online payment is not available');
    }
    if (s.payment_window_minutes === null)
      throw new AppError('POLICY_NOT_CONFIGURED', 'Payment window is not configured');
  }
}

export interface QuoteLine {
  variantId: string;
  productId: string;
  sku: string;
  productName: string;
  variantTitle: string;
  assetPath: string;
  unitPricePaise: number;
  quantity: number;
  lineTotalPaise: number;
  /** Share of the coupon discount allocated to this line (0 without a coupon). */
  discountPaise?: number;
}

export interface QuoteDto {
  id: string;
  currency: 'INR';
  paymentMethod: PaymentMethod;
  lines: QuoteLine[];
  subtotalPaise: number;
  discountPaise: number;
  couponCode: string | null;
  shippingDiscountPaise: number;
  taxPaise: number;
  codFeePaise: number;
  taxInclusive: boolean;
  taxBreakdown: TaxBreakdown;
  shippingPaise: number;
  totalPaise: number;
  cartVersion: number;
  expiresAt: string;
  stockReserved: false;
}

export async function createQuote(
  c: PoolClient,
  userId: string,
  input: { addressId: string; paymentMethod: PaymentMethod; couponCode?: string },
  deps: { flags: Flags },
): Promise<QuoteDto> {
  const s = await loadSettings(c);
  assertCheckoutOpen(s, deps.flags, input.paymentMethod);

  const addr = await c.query(`SELECT * FROM addresses WHERE id = $1 AND user_id = $2`, [
    input.addressId,
    userId,
  ]);
  if (addr.rowCount === 0) throw new AppError('NOT_FOUND', 'Address not found');
  const a = addr.rows[0];
  const sv = await checkServiceability(c, a.postal_code);
  if (!sv.serviceable) {
    throw new AppError(
      sv.reason === 'not_configured' ? 'POLICY_NOT_CONFIGURED' : 'NOT_SERVICEABLE',
      sv.reason === 'not_configured'
        ? 'Delivery serviceability is not configured'
        : 'We do not deliver to this PIN code yet',
    );
  }

  const cart = await lockCart(c, { userId }, false);
  if (!cart) throw new AppError('ITEM_UNAVAILABLE', 'Your cart is empty');

  const rows = await c.query(
    `SELECT l.variant_id, l.quantity, v.product_id, v.sku, v.title, v.price_paise, v.active AS v_active,
            p.name, p.active AS p_active, coalesce(i.on_hand - i.reserved, 0) AS available,
            (SELECT pm.asset_path FROM product_media pm WHERE pm.product_id = p.id ORDER BY pm.position LIMIT 1) AS asset_path
       FROM cart_lines l
       JOIN product_variants v ON v.id = l.variant_id
       JOIN products p ON p.id = v.product_id
       LEFT JOIN inventory_positions i ON i.variant_id = l.variant_id
      WHERE l.cart_id = $1 ORDER BY l.variant_id`,
    [cart.id],
  );
  if (rows.rowCount === 0) throw new AppError('ITEM_UNAVAILABLE', 'Your cart is empty');

  // Never silently buy a valid subset: report every problem line and stop.
  const unavailable = rows.rows.filter((x) => !x.v_active || !x.p_active || !x.asset_path);
  if (unavailable.length) {
    throw new AppError('ITEM_UNAVAILABLE', 'Some items are no longer available', {
      lines: unavailable.map((x) => ({ variantId: x.variant_id })),
    });
  }
  const short = rows.rows.filter((x) => Number(x.available) < x.quantity);
  if (short.length) {
    throw new AppError('STOCK_SHORTAGE', 'Some items do not have enough stock', {
      lines: short.map((x) => ({
        variantId: x.variant_id,
        requested: x.quantity,
        available: Number(x.available),
      })),
    });
  }

  const lines: QuoteLine[] = rows.rows.map((x) => ({
    variantId: x.variant_id,
    productId: x.product_id,
    sku: x.sku,
    productName: x.name,
    variantTitle: x.title,
    assetPath: x.asset_path,
    unitPricePaise: x.price_paise,
    quantity: x.quantity,
    lineTotalPaise: x.price_paise * x.quantity,
  }));
  const subtotal = lines.reduce((n, l) => n + l.lineTotalPaise, 0);
  if (input.paymentMethod === 'cod' && s.cod_max_order_paise !== null && subtotal > s.cod_max_order_paise) {
    throw new AppError('UNSUPPORTED_PAYMENT_METHOD', 'This order exceeds the Cash on Delivery limit');
  }
  const shipping = shippingFor(subtotal, {
    shippingFeePaise: s.shipping_fee_paise,
    freeShippingThresholdPaise: s.free_shipping_threshold_paise,
    codMaxOrderPaise: s.cod_max_order_paise,
  });
  const codFee = input.paymentMethod === 'cod' ? s.cod_fee_paise : 0;
  // Coupon: item discount is allocated per line so GST is charged on what the customer actually pays.
  const code = input.couponCode ?? (await cartCouponCode(c, cart.id));
  let applied: AppliedCoupon | null = null;
  if (code) {
    applied = await evaluateCoupon(
      c,
      userId,
      code,
      lines.map((l) => ({ key: l.variantId, productId: l.productId, amountPaise: l.lineTotalPaise })),
      shipping,
    );
    lines.forEach((l, i) => {
      l.discountPaise = applied!.lineDiscounts[i] ?? 0;
    });
  }
  const discount = applied?.discountPaise ?? 0;
  const shipDiscount = applied?.shippingDiscountPaise ?? 0;
  const netShipping = shipping - shipDiscount;
  const taxBreakdown = computeTax({
    lines: lines.map((l) => ({ key: l.variantId, amountPaise: l.lineTotalPaise - (l.discountPaise ?? 0) })),
    shippingPaise: netShipping,
    codFeePaise: codFee,
    rateBps: s.gst_rate_bps,
    inclusive: s.tax_inclusive,
  });
  const t = totals(subtotal, discount, netShipping, codFee, taxBreakdown.totalTaxPaise, s.tax_inclusive);

  const snapshot = {
    name: a.recipient_name,
    phone: a.phone,
    address: a.line1,
    landmark: a.landmark,
    city: a.city,
    state: a.state,
    pin: a.postal_code,
  };
  const q = await c.query(
    `INSERT INTO checkout_quotes
       (user_id, cart_id, cart_version, address_id, address_snapshot, payment_method, lines,
        subtotal_paise, discount_paise, tax_paise, shipping_paise, total_paise, rules_version, cod_fee_paise,
        tax_inclusive, tax_breakdown, coupon_id, coupon_code, shipping_discount_paise, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$18,$19,$20, now() + make_interval(mins => $17))
     RETURNING id, expires_at`,
    [
      userId,
      cart.id,
      cart.version,
      input.addressId,
      snapshot,
      input.paymentMethod,
      JSON.stringify(lines),
      t.subtotal,
      t.discount,
      t.tax,
      t.shipping,
      t.total,
      s.rules_version,
      t.codFee,
      s.tax_inclusive,
      JSON.stringify(taxBreakdown),
      s.quote_ttl_minutes,
      applied?.couponId ?? null,
      applied?.code ?? null,
      shipDiscount,
    ],
  );
  return {
    id: q.rows[0].id,
    currency: 'INR',
    paymentMethod: input.paymentMethod,
    lines,
    subtotalPaise: t.subtotal,
    discountPaise: t.discount,
    couponCode: applied?.code ?? null,
    shippingDiscountPaise: shipDiscount,
    taxPaise: t.tax,
    codFeePaise: t.codFee,
    taxInclusive: s.tax_inclusive,
    taxBreakdown,
    shippingPaise: t.shipping,
    totalPaise: t.total,
    cartVersion: cart.version,
    expiresAt: new Date(q.rows[0].expires_at).toISOString(),
    stockReserved: false,
  };
}
