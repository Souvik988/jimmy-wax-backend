import type { PoolClient } from '@jw/database';
import { AppError } from '@jw/contracts';

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');

export interface InvoiceLine {
  description: string;
  sku: string;
  /** Harmonised System code of the variant at issue time; null when the catalogue had none. */
  hsn: string | null;
  quantity: number;
  unitPricePaise: number;
  taxablePaise: number;
  gstPaise: number;
  totalPaise: number;
}
export interface InvoiceSnapshot {
  invoiceNumber: string;
  issuedAt: string;
  orderNumber: string;
  seller: { legalName: string; gstin: string; state: string; address: string };
  buyer: { name: string; address: string; state: string; pin: string };
  placeOfSupply: string;
  supply: 'intra_state' | 'inter_state';
  gstRatePercent: number;
  priceBasis: 'inclusive' | 'exclusive';
  lines: InvoiceLine[];
  shipping: { taxablePaise: number; gstPaise: number; totalPaise: number };
  codFee: { taxablePaise: number; gstPaise: number; totalPaise: number };
  totals: {
    taxablePaise: number;
    cgstPaise: number;
    sgstPaise: number;
    igstPaise: number;
    gstPaise: number;
    grandTotalPaise: number;
  };
  currency: 'INR';
  /** True when every product line carries an HSN code (set per variant in the catalogue). */
  hsnIncluded: boolean;
}

/** Indian financial year label for a date in IST (April–March), e.g. "2026-27". */
export function financialYear(d: Date): string {
  const ist = new Date(d.getTime() + 5.5 * 3600 * 1000);
  const y = ist.getUTCFullYear();
  const start = ist.getUTCMonth() >= 3 ? y : y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

/**
 * Issues (once) the GST invoice for an order. Numbers are consecutive per financial year: the counter row is
 * locked and incremented in the SAME transaction as the invoice insert, so a rolled-back attempt never burns a number.
 * Refuses until the merchant's GST profile is complete — nothing is invented.
 */
export async function issueInvoice(c: PoolClient, orderId: string): Promise<InvoiceSnapshot> {
  const existing = await c.query(`SELECT snapshot FROM invoices WHERE order_id = $1`, [orderId]);
  if (existing.rows[0]) return existing.rows[0].snapshot as InvoiceSnapshot;

  const st = (await c.query(`SELECT * FROM store_settings WHERE id = 1`)).rows[0];
  if (!st.merchant_gstin || !st.merchant_legal_name || !st.merchant_state || !st.merchant_address) {
    throw new AppError('POLICY_NOT_CONFIGURED', 'The seller GST details are not configured yet');
  }
  const o = (await c.query(`SELECT * FROM orders WHERE id = $1 FOR UPDATE`, [orderId])).rows[0];
  if (!o) throw new AppError('NOT_FOUND', 'Order not found');
  if (
    !['confirmed', 'processing', 'shipped', 'out_for_delivery', 'delivered', 'returned'].includes(o.status)
  ) {
    throw new AppError('ILLEGAL_STATE', 'An invoice is available once the order is confirmed');
  }
  const items = (
    await c.query(
      `SELECT i.*, v.hsn_code FROM order_items i LEFT JOIN product_variants v ON v.id = i.variant_id WHERE i.order_id = $1 ORDER BY i.id`,
      [orderId],
    )
  ).rows;
  const tb = o.tax_breakdown as {
    rateBps: number;
    inclusive: boolean;
    lines: Array<{ key: string; taxablePaise: number; taxPaise: number }>;
    shipping: { taxablePaise: number; taxPaise: number };
    codFee: { taxablePaise: number; taxPaise: number };
  };
  if (!tb?.lines)
    throw new AppError('ILLEGAL_STATE', 'This order has no tax breakdown (placed before GST was configured)');

  const addr = o.address_snapshot as Record<string, string>;
  const intra = norm(addr.state ?? '') === norm(st.merchant_state);
  const taxOf = new Map(tb.lines.map((l) => [l.key, l]));
  const lines: InvoiceLine[] = items.map((i) => {
    const t = taxOf.get(i.variant_id)!;
    return {
      description: `${i.product_name} (${i.variant_title})`,
      sku: i.sku,
      hsn: (i.hsn_code as string | null)?.trim() || null,
      quantity: i.quantity,
      unitPricePaise: i.unit_price_paise,
      taxablePaise: t.taxablePaise,
      gstPaise: t.taxPaise,
      totalPaise: t.taxablePaise + t.taxPaise,
    };
  });
  const part = (p: { taxablePaise: number; taxPaise: number }) => ({
    taxablePaise: p.taxablePaise,
    gstPaise: p.taxPaise,
    totalPaise: p.taxablePaise + p.taxPaise,
  });
  const shipping = part(tb.shipping);
  const codFee = part(tb.codFee);
  const gst = lines.reduce((n, l) => n + l.gstPaise, 0) + shipping.gstPaise + codFee.gstPaise;
  const taxable = lines.reduce((n, l) => n + l.taxablePaise, 0) + shipping.taxablePaise + codFee.taxablePaise;
  const cgst = intra ? Math.floor(gst / 2) : 0;
  const sgst = intra ? gst - cgst : 0;

  const issuedAt = new Date();
  const fy = financialYear(issuedAt);
  const ctr = await c.query(
    `INSERT INTO invoice_counters (fy, last_number) VALUES ($1, 1) ON CONFLICT (fy) DO UPDATE SET last_number = invoice_counters.last_number + 1 RETURNING last_number`,
    [fy],
  );
  const invoiceNumber = `${st.invoice_prefix}/${fy}/${String(ctr.rows[0].last_number).padStart(6, '0')}`;
  const snap: InvoiceSnapshot = {
    invoiceNumber,
    issuedAt: issuedAt.toISOString(),
    orderNumber: o.order_number,
    seller: {
      legalName: st.merchant_legal_name,
      gstin: st.merchant_gstin,
      state: st.merchant_state,
      address: st.merchant_address,
    },
    buyer: {
      name: addr.name ?? '',
      address: [addr.address, addr.landmark, addr.city].filter(Boolean).join(', '),
      state: addr.state ?? '',
      pin: addr.pin ?? '',
    },
    placeOfSupply: addr.state ?? '',
    supply: intra ? 'intra_state' : 'inter_state',
    gstRatePercent: tb.rateBps / 100,
    priceBasis: tb.inclusive ? 'inclusive' : 'exclusive',
    lines,
    shipping,
    codFee,
    totals: {
      taxablePaise: taxable,
      cgstPaise: cgst,
      sgstPaise: sgst,
      igstPaise: intra ? 0 : gst,
      gstPaise: gst,
      grandTotalPaise: o.total_paise,
    },
    currency: 'INR',
    hsnIncluded: lines.length > 0 && lines.every((l) => l.hsn),
  };
  await c.query(`INSERT INTO invoices (order_id, invoice_number, issued_at, snapshot) VALUES ($1,$2,$3,$4)`, [
    orderId,
    invoiceNumber,
    issuedAt,
    JSON.stringify(snap),
  ]);
  return snap;
}

/** The already-issued invoice for an order, or null. Never issues (DASH-BR-008: reading must have no side effect). */
export async function getIssuedInvoice(c: PoolClient, orderId: string): Promise<InvoiceSnapshot | null> {
  const r = await c.query(`SELECT snapshot FROM invoices WHERE order_id = $1`, [orderId]);
  return (r.rows[0]?.snapshot as InvoiceSnapshot | undefined) ?? null;
}

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const money = (p: number) =>
  `₹${(p / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Printable HTML (all dynamic values escaped). Served with a locked-down CSP by the API. */
export function invoiceHtml(s: InvoiceSnapshot): string {
  const rows = s.lines
    .map(
      (l) =>
        `<tr><td>${esc(l.description)}<br><small>${esc(l.sku)}</small></td><td>${l.hsn ? esc(l.hsn) : ''}</td><td class=n>${l.quantity}</td><td class=n>${money(l.taxablePaise)}</td><td class=n>${money(l.gstPaise)}</td><td class=n>${money(l.totalPaise)}</td></tr>`,
    )
    .join('');
  const extra = (label: string, p: { taxablePaise: number; gstPaise: number; totalPaise: number }) =>
    p.totalPaise > 0
      ? `<tr><td>${label}</td><td></td><td class=n>1</td><td class=n>${money(p.taxablePaise)}</td><td class=n>${money(p.gstPaise)}</td><td class=n>${money(p.totalPaise)}</td></tr>`
      : '';
  const taxRows =
    s.supply === 'intra_state'
      ? `<tr><td colspan=5>CGST (${s.gstRatePercent / 2}%)</td><td class=n>${money(s.totals.cgstPaise)}</td></tr><tr><td colspan=5>SGST (${s.gstRatePercent / 2}%)</td><td class=n>${money(s.totals.sgstPaise)}</td></tr>`
      : `<tr><td colspan=5>IGST (${s.gstRatePercent}%)</td><td class=n>${money(s.totals.igstPaise)}</td></tr>`;
  return `<!doctype html><html lang=en><head><meta charset=utf-8><title>Tax Invoice ${esc(s.invoiceNumber)}</title>
<style>body{font:14px system-ui,sans-serif;margin:24px;color:#111}h1{font-size:20px}table{border-collapse:collapse;width:100%;margin:12px 0}th,td{border:1px solid #bbb;padding:6px 8px;text-align:left;vertical-align:top}.n{text-align:right}.grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}small{color:#555}</style></head><body>
<h1>Tax Invoice</h1><p><b>${esc(s.invoiceNumber)}</b> · ${esc(s.issuedAt.slice(0, 10))} · Order ${esc(s.orderNumber)}</p>
<div class=grid><div><b>Sold by</b><br>${esc(s.seller.legalName)}<br>${esc(s.seller.address)}<br>${esc(s.seller.state)}<br>GSTIN: ${esc(s.seller.gstin)}</div>
<div><b>Billed / shipped to</b><br>${esc(s.buyer.name)}<br>${esc(s.buyer.address)}<br>${esc(s.buyer.state)} ${esc(s.buyer.pin)}<br>Place of supply: ${esc(s.placeOfSupply)}</div></div>
<table><thead><tr><th>Item</th><th>HSN</th><th class=n>Qty</th><th class=n>Taxable value</th><th class=n>GST</th><th class=n>Amount</th></tr></thead><tbody>${rows}${extra('Delivery charge', s.shipping)}${extra('Cash on delivery handling fee', s.codFee)}</tbody>
<tfoot><tr><td colspan=5>Total taxable value</td><td class=n>${money(s.totals.taxablePaise)}</td></tr>${taxRows}<tr><td colspan=5><b>Grand total (${s.priceBasis === 'inclusive' ? 'inclusive of GST' : 'GST added'})</b></td><td class=n><b>${money(s.totals.grandTotalPaise)}</b></td></tr></tfoot></table>
<p><small>This is a computer-generated invoice.</small></p></body></html>`;
}
