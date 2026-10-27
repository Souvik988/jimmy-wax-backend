import type { PoolClient } from '@jw/database';
import { AppError } from '@jw/contracts';

/**
 * GSTR-1 working paper (tables 7 and 12) built from stored order tax breakdowns.
 * It is a preparation aid for the owner's accountant, NOT a filing: credit notes for refunds, B2B invoices, exports and
 * nil-rated supplies are out of scope and the report says so. Amounts are integer paise until the CSV edge.
 */

/** GST state / UT codes (the first two digits of a GSTIN) by the names customers type. Lowercased, punctuation stripped. */
const STATE_CODES: Record<string, string> = {
  'jammu and kashmir': '01',
  'himachal pradesh': '02',
  punjab: '03',
  chandigarh: '04',
  uttarakhand: '05',
  haryana: '06',
  delhi: '07',
  rajasthan: '08',
  'uttar pradesh': '09',
  bihar: '10',
  sikkim: '11',
  'arunachal pradesh': '12',
  nagaland: '13',
  manipur: '14',
  mizoram: '15',
  tripura: '16',
  meghalaya: '17',
  assam: '18',
  'west bengal': '19',
  jharkhand: '20',
  odisha: '21',
  orissa: '21',
  chhattisgarh: '22',
  'madhya pradesh': '23',
  gujarat: '24',
  'dadra and nagar haveli and daman and diu': '26',
  'daman and diu': '26',
  'dadra and nagar haveli': '26',
  maharashtra: '27',
  'andhra pradesh': '37',
  karnataka: '29',
  goa: '30',
  lakshadweep: '31',
  kerala: '32',
  'tamil nadu': '33',
  puducherry: '34',
  pondicherry: '34',
  'andaman and nicobar islands': '35',
  telangana: '36',
  ladakh: '38',
};
const STATE_NAMES: Record<string, string> = {
  '01': 'Jammu & Kashmir',
  '02': 'Himachal Pradesh',
  '03': 'Punjab',
  '04': 'Chandigarh',
  '05': 'Uttarakhand',
  '06': 'Haryana',
  '07': 'Delhi',
  '08': 'Rajasthan',
  '09': 'Uttar Pradesh',
  '10': 'Bihar',
  '11': 'Sikkim',
  '12': 'Arunachal Pradesh',
  '13': 'Nagaland',
  '14': 'Manipur',
  '15': 'Mizoram',
  '16': 'Tripura',
  '17': 'Meghalaya',
  '18': 'Assam',
  '19': 'West Bengal',
  '20': 'Jharkhand',
  '21': 'Odisha',
  '22': 'Chhattisgarh',
  '23': 'Madhya Pradesh',
  '24': 'Gujarat',
  '26': 'Dadra & Nagar Haveli and Daman & Diu',
  '27': 'Maharashtra',
  '29': 'Karnataka',
  '30': 'Goa',
  '31': 'Lakshadweep',
  '32': 'Kerala',
  '33': 'Tamil Nadu',
  '34': 'Puducherry',
  '35': 'Andaman & Nicobar Islands',
  '36': 'Telangana',
  '37': 'Andhra Pradesh',
  '38': 'Ladakh',
};

export function stateCodeFor(name: unknown): string | null {
  if (typeof name !== 'string') return null;
  const key = name
    .toLowerCase()
    .replace(/&/gu, ' and ')
    .replace(/[^a-z ]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  return STATE_CODES[key] ?? null;
}
export const stateLabel = (code: string): string => `${code}-${STATE_NAMES[code] ?? 'Unknown'}`;
export const merchantStateCode = (gstin: string | null | undefined): string | null =>
  gstin && /^[0-9]{2}[0-9A-Z]{13}$/u.test(gstin.trim().toUpperCase()) ? gstin.trim().slice(0, 2) : null;

/** Splits tax into central + state halves that always add back to the exact total (the odd paisa goes to state tax). */
export function splitTax(
  taxPaise: number,
  interState: boolean,
): { igst: number; cgst: number; sgst: number } {
  if (interState) return { igst: taxPaise, cgst: 0, sgst: 0 };
  const cgst = Math.floor(taxPaise / 2);
  return { igst: 0, cgst, sgst: taxPaise - cgst };
}

/** Shares an amount across weights so the parts add back to exactly the amount (largest weight absorbs the rounding). */
export function allocateByWeight(total: number, weights: number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (weights.length === 0) return [];
  if (sum <= 0) {
    const even = Math.floor(total / weights.length);
    return weights.map((_, i) => (i === weights.length - 1 ? total - even * (weights.length - 1) : even));
  }
  const parts = weights.map((w) => Math.floor((total * w) / sum));
  const rest = total - parts.reduce((a, b) => a + b, 0);
  const biggest = weights.indexOf(Math.max(...weights));
  parts[biggest] = (parts[biggest] ?? 0) + rest;
  return parts;
}

export interface B2csRow {
  placeOfSupply: string;
  rateBps: number;
  taxablePaise: number;
  igstPaise: number;
  cgstPaise: number;
  sgstPaise: number;
  orders: number;
}
export interface HsnRow {
  hsn: string;
  description: string;
  uqc: 'PCS';
  quantity: number;
  totalValuePaise: number;
  taxablePaise: number;
  igstPaise: number;
  cgstPaise: number;
  sgstPaise: number;
  rateBps: number;
}
export interface Gstr1Report {
  month: string;
  merchantStateCode: string | null;
  orders: number;
  b2cs: B2csRow[];
  hsn: HsnRow[];
  totals: { taxablePaise: number; igstPaise: number; cgstPaise: number; sgstPaise: number };
  warnings: string[];
}

const monthRange = (month: string): { from: Date; to: Date } => {
  const m = /^(\d{4})-(0[1-9]|1[0-2])$/u.exec(month);
  if (!m)
    throw new AppError('VALIDATION_FAILED', 'Use a month like 2026-10', { fields: { month: 'YYYY-MM' } });
  const y = Number(m[1]);
  const mo = Number(m[2]);
  // India Standard Time (UTC+5:30) month boundaries
  const from = new Date(Date.UTC(y, mo - 1, 1) - 5.5 * 3600_000);
  const to = new Date(Date.UTC(mo === 12 ? y + 1 : y, mo === 12 ? 0 : mo, 1) - 5.5 * 3600_000);
  return { from, to };
};

type TaxPart = { taxablePaise: number; taxPaise: number };
interface OrderRow {
  id: string;
  address_snapshot: { state?: string } | null;
  tax_breakdown: {
    rateBps: number;
    lines: Array<TaxPart & { key: string }>;
    shipping: TaxPart;
    codFee: TaxPart;
  };
}

export async function gstr1Report(c: PoolClient, month: string): Promise<Gstr1Report> {
  const { from, to } = monthRange(month);
  const settings = (await c.query(`SELECT merchant_gstin FROM public.store_settings WHERE id = 1`))
    .rows[0] as { merchant_gstin: string | null } | undefined;
  const home = merchantStateCode(settings?.merchant_gstin);
  const warnings: string[] = [
    'Working paper for your accountant, not a filing: credit notes for refunds, B2B invoices, exports and nil-rated supplies are not included.',
    'Shipping and COD handling fees are taxed at the order rate and included in table 7; table 12 lists goods only.',
  ];
  if (!home)
    warnings.push(
      'Merchant GSTIN is not set (or invalid) in store settings, so every sale is shown as inter-state (IGST). Set it to get CGST/SGST splits.',
    );

  const orders = (
    await c.query(
      `SELECT o.id, o.address_snapshot, o.tax_breakdown FROM public.orders o
      WHERE o.status IN ('placed','confirmed','processing','shipped','out_for_delivery','delivered') AND o.tax_breakdown IS NOT NULL
        AND o.created_at >= $1 AND o.created_at < $2 ORDER BY o.created_at`,
      [from, to],
    )
  ).rows as OrderRow[];

  const b2cs = new Map<string, B2csRow>();
  const hsn = new Map<string, HsnRow>();
  let unknownState = 0;
  let missingHsn = 0;

  for (const o of orders) {
    const code = stateCodeFor(o.address_snapshot?.state);
    if (!code) unknownState += 1;
    const place = code ?? home ?? '00';
    const interState = home === null ? true : place !== home;
    const rateBps = o.tax_breakdown.rateBps;
    const parts: TaxPart[] = [...o.tax_breakdown.lines, o.tax_breakdown.shipping, o.tax_breakdown.codFee];
    const taxable = parts.reduce((a, p) => a + (p?.taxablePaise ?? 0), 0);
    const tax = parts.reduce((a, p) => a + (p?.taxPaise ?? 0), 0);
    const split = splitTax(tax, interState);
    const key = `${place}|${rateBps}`;
    const row = b2cs.get(key) ?? {
      placeOfSupply: stateLabel(place),
      rateBps,
      taxablePaise: 0,
      igstPaise: 0,
      cgstPaise: 0,
      sgstPaise: 0,
      orders: 0,
    };
    row.taxablePaise += taxable;
    row.igstPaise += split.igst;
    row.cgstPaise += split.cgst;
    row.sgstPaise += split.sgst;
    row.orders += 1;
    b2cs.set(key, row);

    for (const line of o.tax_breakdown.lines) {
      const items = (
        await c.query(
          `SELECT oi.quantity, oi.unit_price_paise, oi.product_name, v.hsn_code FROM public.order_items oi LEFT JOIN public.product_variants v ON v.id = oi.variant_id
          WHERE oi.order_id = $1 AND oi.product_id = $2 ORDER BY oi.id`,
          [o.id, line.key],
        )
      ).rows as Array<{
        quantity: number;
        unit_price_paise: number;
        product_name: string;
        hsn_code: string | null;
      }>;
      if (items.length === 0) continue;
      const weights = items.map((i) => i.quantity * i.unit_price_paise);
      const taxableShares = allocateByWeight(line.taxablePaise, weights);
      const taxShares = allocateByWeight(line.taxPaise, weights);
      items.forEach((item, index) => {
        const code8 = item.hsn_code?.trim() || 'NOT SET';
        if (!item.hsn_code) missingHsn += 1;
        const s = splitTax(taxShares[index] ?? 0, interState);
        const hKey = `${code8}|${rateBps}`;
        const h = hsn.get(hKey) ?? {
          hsn: code8,
          description: item.product_name,
          uqc: 'PCS' as const,
          quantity: 0,
          totalValuePaise: 0,
          taxablePaise: 0,
          igstPaise: 0,
          cgstPaise: 0,
          sgstPaise: 0,
          rateBps,
        };
        h.quantity += item.quantity;
        h.taxablePaise += taxableShares[index] ?? 0;
        h.totalValuePaise += (taxableShares[index] ?? 0) + (taxShares[index] ?? 0);
        h.igstPaise += s.igst;
        h.cgstPaise += s.cgst;
        h.sgstPaise += s.sgst;
        hsn.set(hKey, h);
      });
    }
  }
  if (unknownState > 0)
    warnings.push(
      `${unknownState} order(s) have a delivery state that could not be matched to a GST state code; they were treated as ${home ? 'home-state' : 'unknown'} supplies. Review them.`,
    );
  if (missingHsn > 0)
    warnings.push(
      `${missingHsn} order line(s) have no HSN code on the product variant (shown as "NOT SET" in table 12). Add HSN codes in the catalogue.`,
    );

  const rows = [...b2cs.values()].sort(
    (a, b) => a.placeOfSupply.localeCompare(b.placeOfSupply) || a.rateBps - b.rateBps,
  );
  const totals = rows.reduce(
    (t, r) => ({
      taxablePaise: t.taxablePaise + r.taxablePaise,
      igstPaise: t.igstPaise + r.igstPaise,
      cgstPaise: t.cgstPaise + r.cgstPaise,
      sgstPaise: t.sgstPaise + r.sgstPaise,
    }),
    { taxablePaise: 0, igstPaise: 0, cgstPaise: 0, sgstPaise: 0 },
  );
  return {
    month,
    merchantStateCode: home,
    orders: orders.length,
    b2cs: rows,
    hsn: [...hsn.values()].sort((a, b) => a.hsn.localeCompare(b.hsn) || a.rateBps - b.rateBps),
    totals,
    warnings,
  };
}

const rupees = (paise: number): string => (paise / 100).toFixed(2);
const cell = (v: string | number): string => {
  const s = String(v);
  const g = /^[=+\-@\t\r]/u.test(s) ? `'${s}` : s;
  return /[",\n\r]/u.test(g) ? `"${g.replace(/"/gu, '""')}"` : g;
};

/** Column layout follows the GST offline-tool sheets (b2cs, hsn) so the rows can be pasted across. */
export function gstr1Csv(report: Gstr1Report, table: 'b2cs' | 'hsn'): string {
  if (table === 'b2cs') {
    const head = [
      'Type',
      'Place Of Supply',
      'Rate',
      'Applicable % of Tax Rate',
      'Taxable Value',
      'Cess Amount',
      'E-Commerce GSTIN',
      'Integrated Tax',
      'Central Tax',
      'State/UT Tax',
      'Orders',
    ];
    return (
      [
        head.join(','),
        ...report.b2cs.map((r) =>
          [
            'OE',
            r.placeOfSupply,
            (r.rateBps / 100).toFixed(2),
            '',
            rupees(r.taxablePaise),
            '0.00',
            '',
            rupees(r.igstPaise),
            rupees(r.cgstPaise),
            rupees(r.sgstPaise),
            r.orders,
          ]
            .map(cell)
            .join(','),
        ),
      ].join('\r\n') + '\r\n'
    );
  }
  const head = [
    'HSN',
    'Description',
    'UQC',
    'Total Quantity',
    'Total Value',
    'Taxable Value',
    'Integrated Tax Amount',
    'Central Tax Amount',
    'State/UT Tax Amount',
    'Cess Amount',
    'Rate',
  ];
  return (
    [
      head.join(','),
      ...report.hsn.map((r) =>
        [
          r.hsn,
          r.description,
          `${r.uqc}-PIECES`,
          r.quantity,
          rupees(r.totalValuePaise),
          rupees(r.taxablePaise),
          rupees(r.igstPaise),
          rupees(r.cgstPaise),
          rupees(r.sgstPaise),
          '0.00',
          (r.rateBps / 100).toFixed(2),
        ]
          .map(cell)
          .join(','),
      ),
    ].join('\r\n') + '\r\n'
  );
}
