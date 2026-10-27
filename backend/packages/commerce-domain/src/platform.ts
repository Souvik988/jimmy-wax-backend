import { z } from 'zod';
import type { PoolClient } from '@jw/database';
import { AppError, decodeCursor, encodeCursor } from '@jw/contracts';
import { audit, type AdminRole } from './admin.ts';
import { safeCell } from './catalogue.ts';

interface Ctx {
  adminId: string;
  role: AdminRole;
  requestId?: string;
}
const iso = (d: unknown) => new Date(d as string).toISOString();

// ------------------------------------------------------------- customers
const maskEmail = (e: string | null) => {
  if (!e) return null;
  const [u = '', d = ''] = e.split('@');
  return `${u.slice(0, 1)}${'*'.repeat(Math.max(2, u.length - 1))}@${d}`;
};
const maskPhone = (p: string | null) => (p ? `${'*'.repeat(Math.max(0, p.length - 4))}${p.slice(-4)}` : null);

const customerRow = (r: Record<string, any>) => ({
  id: r.id as string,
  name: (r.full_name as string) || '',
  email: maskEmail(r.email),
  phone: maskPhone(r.phone),
  status: r.status as string,
  blocked: !!r.blocked_at,
  tags: (r.admin_tags ?? []) as string[],
  orders: Number(r.orders ?? 0),
  lifetimeSpendPaise: Number(r.spend ?? 0),
  lastOrderAt: r.last_order ? iso(r.last_order) : null,
  joinedAt: iso(r.created_at),
});

const CUSTOMER_SELECT = `
  SELECT u.id, u.email, u.status, u.created_at, coalesce(u.phone, p.phone) AS phone, p.full_name, p.admin_tags, p.blocked_at,
         s.orders, s.spend, s.last_order
    FROM auth.users u
    JOIN public.profiles p ON p.id = u.id
    LEFT JOIN LATERAL (
      SELECT count(*) AS orders, coalesce(sum(total_paise) FILTER (WHERE status NOT IN ('cancelled','expired','pending_payment')), 0) AS spend,
             max(created_at) AS last_order
        FROM public.orders o WHERE o.user_id = u.id) s ON true
   WHERE u.status <> 'deleted'
     AND NOT EXISTS (SELECT 1 FROM public.admin_users a WHERE a.user_id = u.id)`;

export async function listCustomers(
  c: PoolClient,
  f: { q?: string; tag?: string; blocked?: boolean; limit: number; cursor?: string },
) {
  const cur = decodeCursor(f.cursor, z.object({ t: z.string(), i: z.string() }));
  const q = f.q?.trim() ? `%${f.q.trim().replace(/[\\%_]/g, '\\$&')}%` : null;
  const r = await c.query(
    `${CUSTOMER_SELECT}
       AND ($1::text IS NULL OR p.full_name ILIKE $1 OR u.email ILIKE $1 OR coalesce(u.phone, p.phone) ILIKE $1)
       AND ($2::text IS NULL OR $2 = ANY(p.admin_tags))
       AND ($3::boolean IS NULL OR (p.blocked_at IS NOT NULL) = $3)
       AND ($4::timestamptz IS NULL OR (u.created_at, u.id::text) < ($4::timestamptz, $5))
     ORDER BY u.created_at DESC, u.id DESC LIMIT $6`,
    [q, f.tag ?? null, f.blocked ?? null, cur?.t ?? null, cur?.i ?? null, f.limit + 1],
  );
  const page = r.rows.slice(0, f.limit);
  const last = page[page.length - 1];
  return {
    items: page.map(customerRow),
    nextCursor:
      r.rows.length > f.limit && last ? encodeCursor({ t: iso(last.created_at), i: last.id }) : null,
  };
}

export async function getCustomer(c: PoolClient, id: string) {
  const r = await c.query(`${CUSTOMER_SELECT} AND u.id = $1`, [id]);
  if (!r.rows[0]) throw new AppError('NOT_FOUND', 'Customer not found');
  const p = (
    await c.query(`SELECT admin_notes, blocked_at, blocked_reason FROM public.profiles WHERE id = $1`, [id])
  ).rows[0];
  const orders = await c.query(
    `SELECT id, order_number, status, payment_method, total_paise, created_at FROM public.orders WHERE user_id = $1 ORDER BY created_at DESC LIMIT 25`,
    [id],
  );
  const addrs = await c.query(`SELECT count(*)::int AS n FROM public.addresses WHERE user_id = $1`, [id]);
  return {
    ...customerRow(r.rows[0]),
    notes: p.admin_notes as string,
    blockedReason: (p.blocked_reason as string | null) ?? null,
    addressCount: addrs.rows[0].n as number,
    recentOrders: orders.rows.map((o) => ({
      id: o.id as string,
      orderNumber: o.order_number as string,
      status: o.status as string,
      paymentMethod: o.payment_method as string,
      totalPaise: o.total_paise as number,
      createdAt: iso(o.created_at),
    })),
  };
}

/** Unmasked contact details. Every call is written to the audit log. */
export async function revealCustomer(c: PoolClient, x: Ctx, id: string, reason: string) {
  const u = (
    await c.query(
      `SELECT u.email, coalesce(u.phone, p.phone) AS phone, p.full_name FROM auth.users u JOIN public.profiles p ON p.id = u.id WHERE u.id = $1`,
      [id],
    )
  ).rows[0];
  if (!u) throw new AppError('NOT_FOUND', 'Customer not found');
  const a = await c.query(
    `SELECT recipient_name, phone, line1, landmark, city, state, postal_code FROM public.addresses WHERE user_id = $1 ORDER BY is_default DESC, created_at LIMIT 10`,
    [id],
  );
  await audit(c, {
    actorId: x.adminId,
    actorRole: x.role,
    action: 'customer.reveal',
    resourceType: 'customer',
    resourceId: id,
    reason,
    requestId: x.requestId,
  });
  return {
    name: u.full_name as string,
    email: u.email as string | null,
    phone: u.phone as string | null,
    addresses: a.rows.map((r) => ({
      name: r.recipient_name,
      phone: r.phone,
      line1: r.line1,
      landmark: r.landmark,
      city: r.city,
      state: r.state,
      pin: r.postal_code,
    })),
  };
}

export const CustomerNotesPatch = z.object({
  notes: z.string().trim().max(2000).optional(),
  tags: z
    .array(
      z
        .string()
        .trim()
        .toLowerCase()
        .regex(/^[a-z0-9][a-z0-9 _-]{0,29}$/),
    )
    .max(12)
    .optional(),
});
export async function updateCustomerNotes(
  c: PoolClient,
  x: Ctx,
  id: string,
  p: z.infer<typeof CustomerNotesPatch>,
) {
  const cur = (
    await c.query(`SELECT admin_notes, admin_tags FROM public.profiles WHERE id = $1 FOR UPDATE`, [id])
  ).rows[0];
  if (!cur) throw new AppError('NOT_FOUND', 'Customer not found');
  const tags = p.tags ? [...new Set(p.tags)] : cur.admin_tags;
  await c.query(
    `UPDATE public.profiles SET admin_notes = $2, admin_tags = $3, updated_at = now() WHERE id = $1`,
    [id, p.notes ?? cur.admin_notes, tags],
  );
  await audit(c, {
    actorId: x.adminId,
    actorRole: x.role,
    action: 'customer.notes',
    resourceType: 'customer',
    resourceId: id,
    before: { tags: cur.admin_tags },
    after: { tags },
    requestId: x.requestId,
  });
  return getCustomer(c, id);
}

export async function setCustomerBlocked(
  c: PoolClient,
  x: Ctx,
  id: string,
  blocked: boolean,
  reason: string,
) {
  const u = (await c.query(`SELECT status FROM auth.users WHERE id = $1 FOR UPDATE`, [id])).rows[0];
  if (!u) throw new AppError('NOT_FOUND', 'Customer not found');
  if ((await c.query(`SELECT 1 FROM public.admin_users WHERE user_id = $1`, [id])).rowCount) {
    throw new AppError('ILLEGAL_STATE', 'Staff accounts are managed from the team page');
  }
  if (u.status === 'deleted') throw new AppError('ILLEGAL_STATE', 'This account has been deleted');
  if (blocked) {
    await c.query(`UPDATE auth.users SET status = 'disabled', updated_at = now() WHERE id = $1`, [id]);
    await c.query(
      `UPDATE auth.refresh_tokens SET revoked_at = coalesce(revoked_at, now()) WHERE user_id = $1`,
      [id],
    );
    await c.query(`UPDATE public.profiles SET blocked_at = now(), blocked_reason = $2 WHERE id = $1`, [
      id,
      reason,
    ]);
  } else {
    await c.query(
      `UPDATE auth.users SET status = 'active', failed_logins = 0, locked_until = NULL, updated_at = now() WHERE id = $1`,
      [id],
    );
    await c.query(`UPDATE public.profiles SET blocked_at = NULL, blocked_reason = NULL WHERE id = $1`, [id]);
  }
  await audit(c, {
    actorId: x.adminId,
    actorRole: x.role,
    action: blocked ? 'customer.block' : 'customer.unblock',
    resourceType: 'customer',
    resourceId: id,
    reason,
    requestId: x.requestId,
  });
  return getCustomer(c, id);
}

export async function exportCustomersCsv(c: PoolClient, x: Ctx): Promise<string> {
  const r = await c.query(`${CUSTOMER_SELECT} ORDER BY u.created_at, u.id LIMIT 50000`);
  const out = ['id,name,email,phone,status,orders,lifetime_spend_inr,last_order_at,joined_at'];
  for (const v of r.rows) {
    out.push(
      [
        v.id,
        v.full_name,
        v.email,
        v.phone,
        v.status,
        v.orders,
        (Number(v.spend) / 100).toFixed(2),
        v.last_order ? iso(v.last_order) : '',
        iso(v.created_at),
      ]
        .map(safeCell)
        .join(','),
    );
  }
  await audit(c, {
    actorId: x.adminId,
    actorRole: x.role,
    action: 'customer.export',
    resourceType: 'customer',
    resourceId: 'all',
    after: { rows: r.rows.length },
    requestId: x.requestId,
  });
  return out.join('\n') + '\n';
}

// ------------------------------------------------------------ order notes
export async function listOrderNotes(c: PoolClient, orderId: string) {
  const r = await c.query(
    `SELECT id, author_id, author_role, body, created_at FROM public.order_notes WHERE order_id = $1 ORDER BY id DESC LIMIT 200`,
    [orderId],
  );
  return r.rows.map((n) => ({
    id: Number(n.id),
    authorId: n.author_id as string,
    authorRole: n.author_role as string,
    body: n.body as string,
    createdAt: iso(n.created_at),
  }));
}
export async function addOrderNote(c: PoolClient, x: Ctx, orderId: string, body: string) {
  if ((await c.query(`SELECT 1 FROM public.orders WHERE id = $1`, [orderId])).rowCount === 0)
    throw new AppError('NOT_FOUND', 'Order not found');
  await c.query(
    `INSERT INTO public.order_notes (order_id, author_id, author_role, body) VALUES ($1,$2,$3,$4)`,
    [orderId, x.adminId, x.role, body],
  );
  return listOrderNotes(c, orderId);
}

export const ORDER_EXPORT_MAX_ROWS = 50_000;
export async function exportOrdersCsv(
  c: PoolClient,
  x: Ctx,
  f: { from: string; to: string },
): Promise<string> {
  const r = await c.query(
    `SELECT o.order_number, o.created_at, o.status, o.payment_method, o.payment_status, o.subtotal_paise, o.discount_paise, o.coupon_code,
            o.shipping_paise, o.cod_fee_paise, o.tax_paise, o.total_paise, o.address_snapshot->>'city' AS city, o.address_snapshot->>'state' AS state, o.address_snapshot->>'pin' AS pin
       FROM public.orders o WHERE o.created_at >= $1::timestamptz AND o.created_at < $2::timestamptz ORDER BY o.created_at LIMIT ${ORDER_EXPORT_MAX_ROWS + 1}`,
    [f.from, f.to],
  );
  // Never truncate silently: a cut-off export looks complete and misleads reconciliation.
  if (r.rows.length > ORDER_EXPORT_MAX_ROWS)
    throw new AppError(
      'VALIDATION_FAILED',
      `More than ${ORDER_EXPORT_MAX_ROWS} orders in this range; choose a shorter range`,
      { fields: { to: 'range too large' } },
    );
  const inr = (p: number) => (p / 100).toFixed(2);
  const out = [
    'order_number,placed_at,status,payment_method,payment_status,subtotal_inr,discount_inr,coupon,shipping_inr,cod_fee_inr,gst_inr,total_inr,city,state,pin',
  ];
  for (const o of r.rows) {
    out.push(
      [
        o.order_number,
        iso(o.created_at),
        o.status,
        o.payment_method,
        o.payment_status,
        inr(o.subtotal_paise),
        inr(o.discount_paise),
        o.coupon_code,
        inr(o.shipping_paise),
        inr(o.cod_fee_paise),
        inr(o.tax_paise),
        inr(o.total_paise),
        o.city,
        o.state,
        o.pin,
      ]
        .map(safeCell)
        .join(','),
    );
  }
  await audit(c, {
    actorId: x.adminId,
    actorRole: x.role,
    action: 'orders.export',
    resourceType: 'order',
    resourceId: 'range',
    after: { ...f, rows: r.rows.length },
    requestId: x.requestId,
  });
  return out.join('\n') + '\n';
}

/** Data for a printable packing slip (the dashboard renders it). Customer contact is shown because the courier needs it. */
export async function packingSlip(c: PoolClient, orderId: string) {
  const o = (await c.query(`SELECT * FROM public.orders WHERE id = $1`, [orderId])).rows[0];
  if (!o) throw new AppError('NOT_FOUND', 'Order not found');
  const items = (
    await c.query(
      `SELECT sku, product_name, variant_title, quantity FROM public.order_items WHERE order_id = $1 ORDER BY id`,
      [orderId],
    )
  ).rows;
  const st = (
    await c.query(`SELECT brand_name, support_phone, support_email FROM public.store_settings WHERE id = 1`)
  ).rows[0];
  const a = o.address_snapshot as Record<string, string>;
  return {
    orderNumber: o.order_number as string,
    placedAt: iso(o.created_at),
    paymentMethod: o.payment_method as string,
    collectOnDeliveryPaise: o.payment_method === 'cod' ? (o.total_paise as number) : 0,
    shipTo: {
      name: a.name,
      phone: a.phone,
      address: a.address,
      landmark: a.landmark,
      city: a.city,
      state: a.state,
      pin: a.pin,
    },
    items: items.map((i) => ({
      sku: i.sku as string,
      name: `${i.product_name} (${i.variant_title})`,
      quantity: i.quantity as number,
    })),
    from: {
      brand: st.brand_name as string,
      phone: st.support_phone as string | null,
      email: st.support_email as string | null,
    },
  };
}

// ------------------------------------------------------------- store pause
export async function getStoreStatus(c: PoolClient) {
  const s = (
    await c.query(
      `SELECT orders_paused, pause_message, checkout_enabled, checkout_policy_confirmed, checkout_authority, cod_enabled, online_payments_enabled FROM public.store_settings WHERE id = 1`,
    )
  ).rows[0];
  return {
    ordersPaused: s.orders_paused as boolean,
    pauseMessage: s.pause_message as string,
    checkoutOpen: !!(
      s.checkout_enabled &&
      s.checkout_policy_confirmed &&
      s.checkout_authority === 'express' &&
      !s.orders_paused
    ),
    codEnabled: s.cod_enabled as boolean,
    onlinePaymentsEnabled: s.online_payments_enabled as boolean,
  };
}
export const StoreStatusPatch = z.object({
  ordersPaused: z.boolean(),
  pauseMessage: z.string().trim().max(300).default(''),
});
export async function setStoreStatus(c: PoolClient, x: Ctx, p: z.infer<typeof StoreStatusPatch>) {
  const before = await getStoreStatus(c);
  // Pausing never changes rules_version: quotes stay valid, but placing an order is refused while paused.
  await c.query(
    `UPDATE public.store_settings SET orders_paused = $1, pause_message = $2, version = version + 1, updated_at = now() WHERE id = 1`,
    [p.ordersPaused, p.pauseMessage],
  );
  await audit(c, {
    actorId: x.adminId,
    actorRole: x.role,
    action: p.ordersPaused ? 'store.pause' : 'store.resume',
    resourceType: 'store_settings',
    resourceId: '1',
    before,
    after: p,
    requestId: x.requestId,
  });
  return getStoreStatus(c);
}

// ------------------------------------------------------------ app versions
const semver = z.string().regex(/^[0-9]+\.[0-9]+\.[0-9]+$/, 'use x.y.z');
export const AppVersionPatch = z.object({
  latestVersion: semver,
  minSupportedVersion: semver,
  storeUrl: z
    .string()
    .trim()
    .max(300)
    .refine((u) => u === '' || /^https:\/\//.test(u), 'must be https')
    .default(''),
  message: z.string().trim().max(300).default(''),
});
export const cmpVersion = (a: string, b: string) => {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (x[i]! !== y[i]!) return x[i]! < y[i]! ? -1 : 1;
  return 0;
};
const versionDto = (r: Record<string, any>) => ({
  platform: r.platform as string,
  latestVersion: r.latest_version as string,
  minSupportedVersion: r.min_supported_version as string,
  storeUrl: r.store_url as string,
  message: r.message as string,
  updatedAt: iso(r.updated_at),
});
export async function listAppVersions(c: PoolClient) {
  return (await c.query(`SELECT * FROM public.app_versions ORDER BY platform`)).rows.map(versionDto);
}
export async function setAppVersion(
  c: PoolClient,
  x: Ctx,
  platform: 'android' | 'ios',
  p: z.infer<typeof AppVersionPatch>,
) {
  if (cmpVersion(p.minSupportedVersion, p.latestVersion) > 0) {
    throw new AppError(
      'VALIDATION_FAILED',
      'The minimum supported version cannot be newer than the latest version',
      { fields: { minSupportedVersion: 'must be <= latestVersion' } },
    );
  }
  const before = (
    await c.query(`SELECT * FROM public.app_versions WHERE platform = $1 FOR UPDATE`, [platform])
  ).rows[0];
  if (!before) throw new AppError('NOT_FOUND', 'Unknown platform');
  await c.query(
    `UPDATE public.app_versions SET latest_version=$2, min_supported_version=$3, store_url=$4, message=$5, updated_by=$6, updated_at=now() WHERE platform=$1`,
    [platform, p.latestVersion, p.minSupportedVersion, p.storeUrl, p.message, x.adminId],
  );
  await audit(c, {
    actorId: x.adminId,
    actorRole: x.role,
    action: 'app_version.set',
    resourceType: 'app_version',
    resourceId: platform,
    before: versionDto(before),
    after: p,
    requestId: x.requestId,
  });
  return versionDto(
    (await c.query(`SELECT * FROM public.app_versions WHERE platform = $1`, [platform])).rows[0],
  );
}
/** What the app asks on launch: nothing, a soft nudge, or a hard stop. */
export async function versionCheck(c: PoolClient, platform: 'android' | 'ios', current: string) {
  const r = (await c.query(`SELECT * FROM public.app_versions WHERE platform = $1`, [platform])).rows[0];
  if (!r) throw new AppError('NOT_FOUND', 'Unknown platform');
  const status =
    cmpVersion(current, r.min_supported_version) < 0
      ? 'force_update'
      : cmpVersion(current, r.latest_version) < 0
        ? 'update_available'
        : 'ok';
  return {
    status,
    latestVersion: r.latest_version as string,
    minSupportedVersion: r.min_supported_version as string,
    storeUrl: r.store_url as string,
    message: r.message as string,
  };
}

// ----------------------------------------------------------- feature flags
export const FlagInput = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_.-]{1,63}$/),
  description: z.string().trim().max(200).default(''),
  enabled: z.boolean(),
  rolloutPercent: z.number().int().min(0).max(100).default(100),
});
const flagDto = (r: Record<string, any>) => ({
  key: r.key as string,
  description: r.description as string,
  enabled: r.enabled as boolean,
  rolloutPercent: r.rollout_percent as number,
  updatedAt: iso(r.updated_at),
});
export async function listFlags(c: PoolClient) {
  return (await c.query(`SELECT * FROM public.feature_flags ORDER BY key`)).rows.map(flagDto);
}
export async function upsertFlag(c: PoolClient, x: Ctx, f: z.infer<typeof FlagInput>) {
  const before = (await c.query(`SELECT * FROM public.feature_flags WHERE key = $1`, [f.key])).rows[0];
  await c.query(
    `INSERT INTO public.feature_flags (key, description, enabled, rollout_percent, updated_by) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (key) DO UPDATE SET description = excluded.description, enabled = excluded.enabled, rollout_percent = excluded.rollout_percent, updated_by = excluded.updated_by, updated_at = now()`,
    [f.key, f.description, f.enabled, f.rolloutPercent, x.adminId],
  );
  await audit(c, {
    actorId: x.adminId,
    actorRole: x.role,
    action: 'flag.set',
    resourceType: 'feature_flag',
    resourceId: f.key,
    before: before ? flagDto(before) : null,
    after: f,
    requestId: x.requestId,
  });
  return flagDto((await c.query(`SELECT * FROM public.feature_flags WHERE key = $1`, [f.key])).rows[0]);
}
export async function deleteFlag(c: PoolClient, x: Ctx, key: string) {
  const r = await c.query(`DELETE FROM public.feature_flags WHERE key = $1 RETURNING key`, [key]);
  if (!r.rowCount) throw new AppError('NOT_FOUND', 'Flag not found');
  await audit(c, {
    actorId: x.adminId,
    actorRole: x.role,
    action: 'flag.delete',
    resourceType: 'feature_flag',
    resourceId: key,
    requestId: x.requestId,
  });
}
/** Deterministic per-user bucket so a rollout percentage is stable for a given customer. */
export function inRollout(key: string, subject: string, percent: number): boolean {
  let h = 2166136261;
  for (const ch of `${key}:${subject}`) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  return h % 100 < percent;
}
export async function publicFlags(c: PoolClient, subject: string): Promise<Record<string, boolean>> {
  const rows = (await c.query(`SELECT key, enabled, rollout_percent FROM public.feature_flags`)).rows;
  return Object.fromEntries(
    rows.map((r) => [r.key, !!r.enabled && inRollout(r.key, subject, r.rollout_percent)]),
  );
}

// ----------------------------------------------------------- integrations
export interface IntegrationFacts {
  razorpay: { configured: boolean; mode: 'live' | 'test' | 'none' };
  sms: { configured: boolean; provider: string };
  smtp: { configured: boolean; host?: string };
  shipping: { configured: boolean; provider: string };
  storage: { configured: boolean; driver: string };
  maps: { configured: boolean };
}
export async function integrationStatus(c: PoolClient, facts: IntegrationFacts) {
  const last = (
    await c.query(
      `SELECT DISTINCT ON (integration) integration, ok, detail, checked_at FROM public.integration_checks ORDER BY integration, id DESC`,
    )
  ).rows;
  const byName = new Map(last.map((r) => [r.integration as string, r]));
  return (Object.keys(facts) as Array<keyof IntegrationFacts>).map((name) => {
    const l = byName.get(name);
    return {
      name,
      configured: facts[name].configured,
      facts: Object.fromEntries(Object.entries(facts[name]).filter(([k]) => k !== 'configured')),
      lastCheck: l ? { ok: l.ok as boolean, detail: l.detail as string, at: iso(l.checked_at) } : null,
    };
  });
}
export async function recordIntegrationCheck(
  c: PoolClient,
  x: Ctx,
  integration: string,
  ok: boolean,
  detail: string,
) {
  await c.query(
    `INSERT INTO public.integration_checks (integration, ok, detail, checked_by) VALUES ($1,$2,$3,$4)`,
    [integration, ok, detail.slice(0, 500), x.adminId],
  );
  await audit(c, {
    actorId: x.adminId,
    actorRole: x.role,
    action: 'integration.test',
    resourceType: 'integration',
    resourceId: integration,
    after: { ok },
    requestId: x.requestId,
  });
}

// ---------------------------------------------------------------- analytics
export const RangeQuery = z.object({
  from: z.string().date().optional(),
  to: z.string().date().optional(),
  bucket: z.enum(['day', 'week', 'month']).default('day'),
});
/** Half-open [from, to) in UTC. Defaults to the last 30 days. */
export function resolveRange(q: { from?: string; to?: string }) {
  const to = q.to
    ? new Date(`${q.to}T00:00:00Z`)
    : new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate() + 1));
  const from = q.from ? new Date(`${q.from}T00:00:00Z`) : new Date(to.getTime() - 30 * 86_400_000);
  if (!(from < to) || to.getTime() - from.getTime() > 400 * 86_400_000) {
    throw new AppError('VALIDATION_FAILED', 'Choose a date range of at most 400 days', {
      fields: { from: 'invalid range' },
    });
  }
  return { from: from.toISOString(), to: to.toISOString() };
}
/** Orders that count as sales: accepted and not cancelled/expired/unpaid-online. Returns are shown separately. */
const SOLD = `o.status IN ('placed','confirmed','processing','shipped','out_for_delivery','delivered')`;

export const ANALYTICS_DEFINITIONS = {
  sales:
    'Orders in status placed→delivered. Revenue = order total incl. GST, shipping and COD fee. Cancelled, expired, unpaid and returned orders are excluded.',
  aov: 'Average order value = revenue ÷ orders.',
  newVsReturning: 'A customer is "new" in a period if their first-ever sold order falls in it.',
  returnRate: 'Orders that ended in "returned" ÷ delivered + returned orders in the period.',
  gst: "Taxable value and GST summed from each order's stored tax breakdown (items, shipping, COD fee) — the same figures printed on invoices.",
} as const;

export async function salesAnalytics(c: PoolClient, q: z.infer<typeof RangeQuery>) {
  const { from, to } = resolveRange(q);
  const series = await c.query(
    `SELECT date_trunc($3, o.created_at AT TIME ZONE 'Asia/Kolkata')::date AS bucket, count(*)::int AS orders,
            sum(o.subtotal_paise)::bigint AS subtotal, sum(o.discount_paise)::bigint AS discount, sum(o.shipping_paise)::bigint AS shipping,
            sum(o.tax_paise)::bigint AS tax, sum(o.total_paise)::bigint AS revenue
       FROM public.orders o WHERE ${SOLD} AND o.created_at >= $1 AND o.created_at < $2 GROUP BY 1 ORDER BY 1`,
    [from, to, q.bucket],
  );
  const methods = await c.query(
    `SELECT o.payment_method AS method, count(*)::int AS orders, sum(o.total_paise)::bigint AS revenue
       FROM public.orders o WHERE ${SOLD} AND o.created_at >= $1 AND o.created_at < $2 GROUP BY 1 ORDER BY 1`,
    [from, to],
  );
  const num = (v: unknown) => Number(v ?? 0);
  const rows = series.rows.map((r) => ({
    bucket: new Date(r.bucket).toISOString().slice(0, 10),
    orders: r.orders as number,
    subtotalPaise: num(r.subtotal),
    discountPaise: num(r.discount),
    shippingPaise: num(r.shipping),
    taxPaise: num(r.tax),
    revenuePaise: num(r.revenue),
    aovPaise: r.orders ? Math.round(num(r.revenue) / r.orders) : 0,
  }));
  const orders = rows.reduce((n, r) => n + r.orders, 0);
  const revenue = rows.reduce((n, r) => n + r.revenuePaise, 0);
  return {
    range: { from, to },
    definitions: { sales: ANALYTICS_DEFINITIONS.sales, aov: ANALYTICS_DEFINITIONS.aov },
    totals: {
      orders,
      revenuePaise: revenue,
      aovPaise: orders ? Math.round(revenue / orders) : 0,
      discountPaise: rows.reduce((n, r) => n + r.discountPaise, 0),
    },
    series: rows,
    byPaymentMethod: methods.rows.map((m) => ({
      method: m.method as string,
      orders: m.orders as number,
      revenuePaise: num(m.revenue),
    })),
  };
}

export async function productAnalytics(c: PoolClient, q: z.infer<typeof RangeQuery>) {
  const { from, to } = resolveRange(q);
  const r = await c.query(
    `SELECT i.product_id, i.product_name, sum(i.quantity)::int AS units, sum(i.line_total_paise - i.discount_paise)::bigint AS revenue, count(DISTINCT o.id)::int AS orders
       FROM public.order_items i JOIN public.orders o ON o.id = i.order_id
      WHERE ${SOLD} AND o.created_at >= $1 AND o.created_at < $2 GROUP BY i.product_id, i.product_name ORDER BY units DESC, i.product_id LIMIT 100`,
    [from, to],
  );
  return {
    range: { from, to },
    definitions: {
      sales: ANALYTICS_DEFINITIONS.sales,
      revenue: 'Line total after any coupon share, before shipping and COD fee.',
    },
    items: r.rows.map((x) => ({
      productId: x.product_id as string,
      name: x.product_name as string,
      units: x.units as number,
      orders: x.orders as number,
      revenuePaise: Number(x.revenue),
    })),
  };
}

export async function customerAnalytics(c: PoolClient, q: z.infer<typeof RangeQuery>) {
  const { from, to } = resolveRange(q);
  const r = (
    await c.query(
      `WITH first_sale AS (SELECT user_id, min(created_at) AS first_at FROM public.orders o WHERE ${SOLD} GROUP BY user_id),
            buyers AS (SELECT DISTINCT o.user_id FROM public.orders o WHERE ${SOLD} AND o.created_at >= $1 AND o.created_at < $2)
       SELECT (SELECT count(*) FROM auth.users u WHERE u.created_at >= $1 AND u.created_at < $2 AND NOT EXISTS (SELECT 1 FROM public.admin_users a WHERE a.user_id = u.id))::int AS signups,
              (SELECT count(*) FROM buyers b JOIN first_sale f USING (user_id) WHERE f.first_at >= $1 AND f.first_at < $2)::int AS new_buyers,
              (SELECT count(*) FROM buyers b JOIN first_sale f USING (user_id) WHERE f.first_at < $1)::int AS returning_buyers,
              (SELECT count(*) FROM auth.users WHERE status = 'active')::int AS active_accounts`,
      [from, to],
    )
  ).rows[0];
  const top = await c.query(
    `SELECT o.user_id, p.full_name, count(*)::int AS orders, sum(o.total_paise)::bigint AS spend
       FROM public.orders o JOIN public.profiles p ON p.id = o.user_id WHERE ${SOLD} AND o.created_at >= $1 AND o.created_at < $2
      GROUP BY o.user_id, p.full_name ORDER BY spend DESC LIMIT 10`,
    [from, to],
  );
  return {
    range: { from, to },
    definitions: { newVsReturning: ANALYTICS_DEFINITIONS.newVsReturning },
    signups: r.signups as number,
    newBuyers: r.new_buyers as number,
    returningBuyers: r.returning_buyers as number,
    activeAccounts: r.active_accounts as number,
    topCustomers: top.rows.map((x) => ({
      customerId: x.user_id as string,
      name: x.full_name as string,
      orders: x.orders as number,
      spendPaise: Number(x.spend),
    })),
  };
}

export async function shippingAnalytics(c: PoolClient, q: z.infer<typeof RangeQuery>) {
  const { from, to } = resolveRange(q);
  const by = await c.query(
    `SELECT s.status, count(*)::int AS n FROM public.shipments s WHERE s.created_at >= $1 AND s.created_at < $2 AND NOT s.is_return GROUP BY 1 ORDER BY 1`,
    [from, to],
  );
  const t = (
    await c.query(
      `SELECT avg(extract(epoch FROM (d.at - s.created_at)) / 86400)::float AS avg_days, coalesce(sum(s.charges_paise),0)::bigint AS charges, coalesce(sum(s.ndr_count),0)::int AS ndr
         FROM public.shipments s LEFT JOIN LATERAL (SELECT min(occurred_at) AS at FROM public.shipment_events e WHERE e.shipment_id = s.id AND e.status = 'delivered') d ON true
        WHERE s.created_at >= $1 AND s.created_at < $2 AND NOT s.is_return AND (d.at IS NOT NULL OR true)`,
      [from, to],
    )
  ).rows[0];
  const couriers = await c.query(
    `SELECT s.courier, count(*)::int AS shipments, count(*) FILTER (WHERE s.status = 'delivered')::int AS delivered
       FROM public.shipments s WHERE s.created_at >= $1 AND s.created_at < $2 AND NOT s.is_return GROUP BY 1 ORDER BY shipments DESC, 1`,
    [from, to],
  );
  return {
    range: { from, to },
    byStatus: by.rows.map((x) => ({ status: x.status as string, shipments: x.n as number })),
    avgDaysToDeliver: t.avg_days === null ? null : Math.round(t.avg_days * 10) / 10,
    shippingChargesPaise: Number(t.charges),
    ndrAttempts: t.ndr as number,
    byCourier: couriers.rows.map((x) => ({
      courier: x.courier as string,
      shipments: x.shipments as number,
      delivered: x.delivered as number,
    })),
  };
}

export async function returnsAnalytics(c: PoolClient, q: z.infer<typeof RangeQuery>) {
  const { from, to } = resolveRange(q);
  const by = await c.query(
    `SELECT status, count(*)::int AS n FROM public.returns WHERE created_at >= $1 AND created_at < $2 GROUP BY 1 ORDER BY 1`,
    [from, to],
  );
  const o = (
    await c.query(
      `SELECT count(*) FILTER (WHERE status = 'delivered')::int AS delivered, count(*) FILTER (WHERE status = 'returned')::int AS returned
         FROM public.orders WHERE created_at >= $1 AND created_at < $2`,
      [from, to],
    )
  ).rows[0];
  const denom = o.delivered + o.returned;
  return {
    range: { from, to },
    definitions: { returnRate: ANALYTICS_DEFINITIONS.returnRate },
    byStatus: by.rows.map((x) => ({ status: x.status as string, returns: x.n as number })),
    returnRate: denom ? Math.round((o.returned / denom) * 1000) / 10 : null,
  };
}

export async function geoAnalytics(c: PoolClient, q: z.infer<typeof RangeQuery>) {
  const { from, to } = resolveRange(q);
  const st = await c.query(
    `SELECT o.address_snapshot->>'state' AS state, count(*)::int AS orders, sum(o.total_paise)::bigint AS revenue
       FROM public.orders o WHERE ${SOLD} AND o.created_at >= $1 AND o.created_at < $2 GROUP BY 1 ORDER BY orders DESC, 1 LIMIT 50`,
    [from, to],
  );
  const ct = await c.query(
    `SELECT o.address_snapshot->>'city' AS city, o.address_snapshot->>'state' AS state, count(*)::int AS orders
       FROM public.orders o WHERE ${SOLD} AND o.created_at >= $1 AND o.created_at < $2 GROUP BY 1, 2 ORDER BY orders DESC, 1 LIMIT 25`,
    [from, to],
  );
  return {
    range: { from, to },
    byState: st.rows.map((x) => ({
      state: x.state as string,
      orders: x.orders as number,
      revenuePaise: Number(x.revenue),
    })),
    topCities: ct.rows.map((x) => ({
      city: x.city as string,
      state: x.state as string,
      orders: x.orders as number,
    })),
  };
}

export async function gstAnalytics(c: PoolClient, q: z.infer<typeof RangeQuery>) {
  const { from, to } = resolveRange(q);
  const r = await c.query(
    `SELECT to_char(o.created_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM') AS month, count(*)::int AS orders,
            coalesce(sum(t.taxable),0)::bigint AS taxable, coalesce(sum(o.tax_paise),0)::bigint AS gst
       FROM public.orders o
       CROSS JOIN LATERAL (SELECT
           coalesce((SELECT sum((l->>'taxablePaise')::bigint) FROM jsonb_array_elements(o.tax_breakdown->'lines') l), 0)
           + coalesce((o.tax_breakdown->'shipping'->>'taxablePaise')::bigint, 0)
           + coalesce((o.tax_breakdown->'codFee'->>'taxablePaise')::bigint, 0) AS taxable) t
      WHERE ${SOLD} AND o.tax_breakdown IS NOT NULL AND o.created_at >= $1 AND o.created_at < $2 GROUP BY 1 ORDER BY 1`,
    [from, to],
  );
  return {
    range: { from, to },
    definitions: { gst: ANALYTICS_DEFINITIONS.gst },
    months: r.rows.map((x) => ({
      month: x.month as string,
      orders: x.orders as number,
      taxablePaise: Number(x.taxable),
      gstPaise: Number(x.gst),
    })),
  };
}

/** Flattens an analytics result's main table into CSV (formula-guarded). */
export function analyticsCsv(rows: Array<Record<string, unknown>>): string {
  if (!rows.length) return '\n';
  const cols = Object.keys(rows[0]!);
  return [cols.join(','), ...rows.map((r) => cols.map((k) => safeCell(r[k])).join(','))].join('\n') + '\n';
}

// ---------------------------------------------------------------- health
export async function adminHealth(c: PoolClient) {
  const q = async (sql: string) => (await c.query(sql)).rows[0];
  const [outbox, email, shipEvents, bulk, stuckShip, lowStock] = await Promise.all([
    q(
      `SELECT count(*) FILTER (WHERE dead_at IS NOT NULL)::int AS dead, count(*) FILTER (WHERE published_at IS NULL AND dead_at IS NULL)::int AS pending FROM public.outbox`,
    ),
    q(
      `SELECT count(*) FILTER (WHERE status = 'failed')::int AS failed, count(*) FILTER (WHERE status = 'pending')::int AS pending FROM public.email_outbox`,
    ),
    q(
      `SELECT count(*) FILTER (WHERE processed_at IS NULL)::int AS unprocessed FROM public.shipping_provider_events`,
    ),
    q(
      `SELECT count(*) FILTER (WHERE status IN ('queued','running'))::int AS active FROM public.shipping_bulk_jobs`,
    ),
    q(
      `SELECT count(*)::int AS n FROM public.shipment_requests WHERE state NOT IN ('done','failed','cancelled') AND updated_at < now() - interval '15 minutes'`,
    ),
    q(
      `SELECT count(*)::int AS n FROM public.inventory_positions i JOIN public.product_variants v ON v.id = i.variant_id WHERE v.active AND i.on_hand - i.reserved <= coalesce(i.low_stock_threshold, 0)`,
    ),
  ]);
  return {
    outbox: { dead: outbox.dead as number, pending: outbox.pending as number },
    email: { failed: email.failed as number, pending: email.pending as number },
    shippingEvents: { unprocessed: shipEvents.unprocessed as number },
    bulkJobs: { active: bulk.active as number },
    stuckShipmentRequests: stuckShip.n as number,
    lowStockVariants: lowStock.n as number,
  };
}
