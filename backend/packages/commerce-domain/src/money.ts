import { createHash } from 'node:crypto';

/** All money is integer paise (INR minor units). Never floats. */

export function assertPaise(n: number, label = 'amount'): number {
  if (!Number.isSafeInteger(n) || n < 0) throw new RangeError(`${label} must be a non-negative safe integer`);
  return n;
}

/**
 * Splits `total` across `weights` using largest-remainder so the parts ALWAYS sum to `total`
 * (deterministic: ties broken by lower index). Used for discount/tax/refund line allocation.
 */
export function allocateProportional(total: number, weights: number[]): number[] {
  assertPaise(total, 'total');
  const sum = weights.reduce((a, b) => a + b, 0);
  if (weights.length === 0) return [];
  if (sum <= 0) throw new RangeError('weights must sum to a positive value');
  const raw = weights.map((w) => (total * w) / sum);
  const floors = raw.map(Math.floor);
  let remainder = total - floors.reduce((a, b) => a + b, 0);
  const order = raw
    .map((r, i) => ({ i, frac: r - Math.floor(r) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (const { i } of order) {
    if (remainder <= 0) break;
    floors[i] = (floors[i] ?? 0) + 1;
    remainder -= 1;
  }
  return floors;
}

export interface PricingPolicy {
  shippingFeePaise: number;
  freeShippingThresholdPaise: number | null;
  codMaxOrderPaise: number | null;
}

export function shippingFor(subtotalPaise: number, p: PricingPolicy): number {
  return p.freeShippingThresholdPaise !== null && subtotalPaise >= p.freeShippingThresholdPaise
    ? 0
    : p.shippingFeePaise;
}

/** GST contained in a tax-INCLUSIVE amount: round-half-up(gross × r / (10000 + r)), integer arithmetic only. */
export function gstIncluded(grossPaise: number, rateBps: number): number {
  assertPaise(grossPaise);
  const d = 10000 + rateBps;
  return Math.floor((grossPaise * rateBps * 2 + d) / (2 * d));
}
/** GST to ADD on a tax-EXCLUSIVE amount: round-half-up(net × r / 10000). */
export function gstExclusive(netPaise: number, rateBps: number): number {
  assertPaise(netPaise);
  return Math.floor((netPaise * rateBps * 2 + 10000) / 20000);
}

export interface TaxPart {
  taxablePaise: number;
  taxPaise: number;
}
export interface TaxBreakdown {
  rateBps: number;
  inclusive: boolean;
  lines: Array<TaxPart & { key: string }>;
  shipping: TaxPart;
  codFee: TaxPart;
  totalTaxPaise: number;
}

/**
 * Per-component GST (items, shipping, COD handling fee). Each component is taxed on its own amount, so the
 * breakdown reconciles exactly: sum(components) == totalTaxPaise, and for inclusive pricing
 * taxable + tax == the displayed amount for every component.
 */
export function computeTax(input: {
  lines: Array<{ key: string; amountPaise: number }>;
  shippingPaise: number;
  codFeePaise: number;
  rateBps: number;
  inclusive: boolean;
}): TaxBreakdown {
  const part = (amount: number): TaxPart => {
    if (input.inclusive) {
      const tax = gstIncluded(amount, input.rateBps);
      return { taxablePaise: amount - tax, taxPaise: tax };
    }
    return { taxablePaise: amount, taxPaise: gstExclusive(amount, input.rateBps) };
  };
  const lines = input.lines.map((l) => ({ key: l.key, ...part(l.amountPaise) }));
  const shipping = part(input.shippingPaise);
  const codFee = part(input.codFeePaise);
  const totalTaxPaise = lines.reduce((n, l) => n + l.taxPaise, 0) + shipping.taxPaise + codFee.taxPaise;
  return { rateBps: input.rateBps, inclusive: input.inclusive, lines, shipping, codFee, totalTaxPaise };
}

export function totals(
  subtotal: number,
  discount: number,
  shipping: number,
  codFee: number,
  tax: number,
  inclusive: boolean,
) {
  if (discount > subtotal) throw new RangeError('discount exceeds subtotal');
  return {
    subtotal,
    discount,
    shipping,
    codFee,
    tax,
    total: subtotal - discount + shipping + codFee + (inclusive ? 0 : tax),
  };
}

/** Stable JSON (sorted keys) → sha256 hex; for idempotency request hashing. */
export function canonicalHash(value: unknown): string {
  const canon = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(canon)
      : v && typeof v === 'object'
        ? Object.fromEntries(
            Object.entries(v as Record<string, unknown>)
              .sort(([a], [b]) => (a < b ? -1 : 1))
              .map(([k, x]) => [k, canon(x)]),
          )
        : v;
  return createHash('sha256')
    .update(JSON.stringify(canon(value)))
    .digest('hex');
}
