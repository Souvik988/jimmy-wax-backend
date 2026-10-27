/**
 * Facts in copy: prices, fees and policy wording are never typed into content. Authors write {{store.shippingFee}}
 * and the API substitutes the CURRENT value at request time, so the app, the website and checkout cannot disagree.
 */
export const VARIABLE_NAMES = [
  'store.shippingFee',
  'store.freeShippingThreshold',
  'store.codFee',
  'store.deliveryEstimate',
  'store.gstRate',
  'store.supportEmail',
  'store.supportPhone',
  'brand.name',
] as const;
export type VariableName = (typeof VARIABLE_NAMES)[number];

export interface StoreFacts {
  shippingFeePaise: number;
  freeShippingThresholdPaise: number | null;
  codFeePaise: number;
  deliveryEstimate: string;
  gstRateBps: number;
  supportEmail: string | null;
  supportPhone: string | null;
  brandName: string;
}

export const formatInr = (paise: number): string => {
  const rupees = paise / 100;
  return `₹${rupees.toLocaleString('en-IN', { minimumFractionDigits: paise % 100 ? 2 : 0, maximumFractionDigits: 2 })}`;
};

/** Variables whose fact is not configured resolve to null (the validator reports them; they never render blank). */
export function resolveVariables(f: StoreFacts): Record<VariableName, string | null> {
  return {
    'store.shippingFee': formatInr(f.shippingFeePaise),
    'store.freeShippingThreshold':
      f.freeShippingThresholdPaise == null ? null : formatInr(f.freeShippingThresholdPaise),
    'store.codFee': formatInr(f.codFeePaise),
    'store.deliveryEstimate': f.deliveryEstimate || null,
    'store.gstRate': `${(f.gstRateBps / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}%`,
    'store.supportEmail': f.supportEmail,
    'store.supportPhone': f.supportPhone,
    'brand.name': f.brandName,
  };
}

const VAR = /\{\{\s*([A-Za-z0-9_.]+)\s*\}\}/g;

export function scanVariables(text: string): string[] {
  return [...text.matchAll(VAR)].map((m) => m[1]!);
}

export function substitute(text: string, vars: Record<string, string | null>): string {
  return text.replace(VAR, (whole, name: string) => vars[name] ?? whole);
}

/** Deep-maps every string in a JSON value (used to substitute variables across a whole bundle). */
export function mapStrings<T>(value: T, fn: (s: string) => string): T {
  if (typeof value === 'string') return fn(value) as T;
  if (Array.isArray(value)) return value.map((v) => mapStrings(v, fn)) as T;
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, mapStrings(v, fn)]),
    ) as T;
  return value;
}

/** A currency literal in authored copy usually means a fact that should be a variable. */
export const PRICE_LITERAL = /(₹|rs\.?|inr)\s?\d/i;

/** Words that usually need substantiation; a warning, never a block. Owners can record evidence and proceed. */
export const CLAIM_WORDS = [
  'certified',
  'guaranteed',
  'guarantee',
  '100%',
  'best in',
  'waterproof',
  'dermatolog',
  'clinically',
  'scientifically',
  'permanent',
  'lifetime',
];
