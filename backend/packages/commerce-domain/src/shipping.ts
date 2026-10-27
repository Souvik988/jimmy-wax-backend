import { createHash } from 'node:crypto';
import type { PoolClient } from '@jw/database';
import { AppError } from '@jw/contracts';
import { audit, type AdminRole } from './admin.ts';

interface Ctx {
  adminId: string;
  role: AdminRole;
  requestId?: string;
}

/**
 * Serviceability is merchant-managed data (no courier API is assumed): a PIN is deliverable when it starts with
 * one of the configured prefixes. An EMPTY list means "not configured" — nothing is assumed deliverable.
 */
export async function checkServiceability(
  c: PoolClient,
  pin: string,
): Promise<{ serviceable: boolean; reason?: 'not_configured' | 'out_of_area' }> {
  const r = await c.query<{ total: number; hit: number }>(
    `SELECT count(*)::int AS total, count(*) FILTER (WHERE $1 LIKE prefix || '%')::int AS hit FROM serviceable_pin_prefixes`,
    [pin],
  );
  const row = r.rows[0]!;
  if (row.total === 0) return { serviceable: false, reason: 'not_configured' };
  if (row.hit === 0) return { serviceable: false, reason: 'out_of_area' };
  // Optional second gate: a fresh negative verdict from the shipping provider (cached; never a network call here).
  const blocked = await c.query<{ b: boolean }>(`SELECT private.pin_provider_blocked($1) AS b`, [pin]);
  return blocked.rows[0]?.b ? { serviceable: false, reason: 'out_of_area' } : { serviceable: true };
}

export const SHIPMENT_STATUSES = [
  'label_created',
  'in_transit',
  'out_for_delivery',
  'delivered',
  'failed',
  'returned_to_origin',
] as const;
export type ShipmentStatus = (typeof SHIPMENT_STATUSES)[number];

/**
 * Legal manual tracking moves. Events only go forward (a repeat of the current status is a harmless re-scan); a failed attempt may be
 * retried. `delivered` and `returned_to_origin` are terminal (handled separately). This stops a wrong click from recording a false
 * delivery state or rewinding a shipment.
 */
export const SHIPMENT_TRANSITIONS: Readonly<Record<ShipmentStatus, readonly ShipmentStatus[]>> = {
  label_created: ['label_created', 'in_transit', 'out_for_delivery', 'failed', 'returned_to_origin'],
  in_transit: ['in_transit', 'out_for_delivery', 'delivered', 'failed', 'returned_to_origin'],
  out_for_delivery: ['out_for_delivery', 'delivered', 'failed', 'in_transit', 'returned_to_origin'],
  failed: ['failed', 'in_transit', 'out_for_delivery', 'returned_to_origin'],
  delivered: [],
  returned_to_origin: [],
};

export async function createShipment(
  c: PoolClient,
  x: Ctx,
  orderId: string,
  input: {
    courier: string;
    trackingNumber: string;
    trackingUrl?: string | null;
    package?: { weightGrams: number; lengthMm: number; widthMm: number; heightMm: number };
    overrideReason?: string;
  },
) {
  if (input.package && !input.overrideReason?.trim())
    throw new AppError('VALIDATION_FAILED', 'Say why the package differs from the catalogue', {
      fields: { overrideReason: 'required when a package is given' },
    });
  const o = await c.query(`SELECT * FROM orders WHERE id = $1 FOR UPDATE`, [orderId]);
  if (o.rowCount === 0) throw new AppError('NOT_FOUND', 'Order not found');
  const order = o.rows[0];
  if (order.status !== 'processing') {
    throw new AppError('ILLEGAL_STATE', 'Mark the order "processing" before creating its shipment');
  }
  const dup = await c.query(
    `SELECT 1 FROM shipments WHERE order_id = $1 AND status NOT IN ('failed','returned_to_origin')`,
    [orderId],
  );
  if (dup.rowCount) throw new AppError('ILLEGAL_STATE', 'This order already has an active shipment');
  const s = await c.query(
    `INSERT INTO shipments (order_id, courier, tracking_number, tracking_url, created_by, package, package_override_reason) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [
      orderId,
      input.courier.trim(),
      input.trackingNumber.trim(),
      input.trackingUrl ?? null,
      x.adminId,
      input.package ? JSON.stringify(input.package) : null,
      input.package ? input.overrideReason!.trim() : null,
    ],
  );
  const sh = s.rows[0];
  await c.query(
    `INSERT INTO shipment_events (shipment_id, status, description, created_by) VALUES ($1,'label_created','Handed to courier',$2)`,
    [sh.id, x.adminId],
  );
  await c.query(`UPDATE orders SET status = 'shipped' WHERE id = $1`, [orderId]);
  await c.query(
    `INSERT INTO outbox (aggregate_type, aggregate_id, event_type, payload) VALUES ('order',$1,'order.shipped',$2)`,
    [
      orderId,
      {
        orderId,
        userId: order.user_id,
        courier: sh.courier,
        trackingNumber: sh.tracking_number,
        trackingUrl: sh.tracking_url,
      },
    ],
  );
  await audit(c, {
    actorId: x.adminId,
    actorRole: x.role,
    action: 'shipment.create',
    resourceType: 'order',
    resourceId: orderId,
    after: {
      courier: sh.courier,
      trackingNumber: sh.tracking_number,
      package: input.package ?? null,
      overrideReason: input.package ? input.overrideReason : undefined,
    },
    requestId: x.requestId,
  });
  return { id: sh.id as string, orderId, status: 'label_created' };
}

const ORDER_STATUS_FOR: Partial<Record<ShipmentStatus, string>> = {
  out_for_delivery: 'out_for_delivery',
  delivered: 'delivered',
};

export async function addShipmentEvent(
  c: PoolClient,
  x: Ctx,
  shipmentId: string,
  input: { status: ShipmentStatus; description?: string; occurredAt?: string },
) {
  const s = await c.query(`SELECT * FROM shipments WHERE id = $1 FOR UPDATE`, [shipmentId]);
  if (s.rowCount === 0) throw new AppError('NOT_FOUND', 'Shipment not found');
  const sh = s.rows[0];
  if (['delivered', 'returned_to_origin'].includes(sh.status)) {
    throw new AppError('ILLEGAL_STATE', 'This shipment is already closed');
  }
  const allowed = SHIPMENT_TRANSITIONS[sh.status as ShipmentStatus];
  if (allowed && !allowed.includes(input.status))
    throw new AppError('ILLEGAL_STATE', `A shipment that is "${sh.status}" cannot move to "${input.status}"`);
  const o = await c.query(`SELECT * FROM orders WHERE id = $1 FOR UPDATE`, [sh.order_id]);
  const order = o.rows[0];
  await c.query(
    `INSERT INTO shipment_events (shipment_id, status, description, occurred_at, created_by)
     VALUES ($1,$2,$3,coalesce($4::timestamptz, now()),$5)`,
    [shipmentId, input.status, input.description ?? '', input.occurredAt ?? null, x.adminId],
  );
  await c.query(`UPDATE shipments SET status = $2, updated_at = now() WHERE id = $1`, [
    shipmentId,
    input.status,
  ]);
  const to = ORDER_STATUS_FOR[input.status];
  if (to && order.status !== to && order.status !== 'delivered') {
    // The order state-machine trigger rejects anything illegal (e.g. delivered from processing).
    await c.query(`UPDATE orders SET status = $2 WHERE id = $1`, [order.id, to]);
    await c.query(
      `INSERT INTO outbox (aggregate_type, aggregate_id, event_type, payload) VALUES ('order',$1,$2,$3)`,
      [order.id, `order.${to}`, { orderId: order.id, userId: order.user_id }],
    );
  }
  await audit(c, {
    actorId: x.adminId,
    actorRole: x.role,
    action: 'shipment.event',
    resourceType: 'shipment',
    resourceId: shipmentId,
    before: { status: sh.status },
    after: { status: input.status },
    requestId: x.requestId,
  });
}

export async function shipmentsForOrder(c: PoolClient, orderId: string) {
  const s = await c.query(`SELECT * FROM shipments WHERE order_id = $1 ORDER BY created_at`, [orderId]);
  const out = [];
  for (const sh of s.rows) {
    const ev = await c.query(
      `SELECT status, description, occurred_at FROM shipment_events WHERE shipment_id = $1 ORDER BY occurred_at, id`,
      [sh.id],
    );
    out.push({
      id: sh.id as string,
      courier: sh.courier as string,
      trackingNumber: sh.tracking_number as string,
      trackingUrl: (sh.tracking_url as string | null) ?? null,
      status: sh.status as string,
      package:
        (sh.package as { weightGrams: number; lengthMm: number; widthMm: number; heightMm: number } | null) ??
        null,
      packageOverrideReason: (sh.package_override_reason as string | null) ?? null,
      events: ev.rows.map((e) => ({
        status: e.status as string,
        description: e.description as string,
        occurredAt: new Date(e.occurred_at).toISOString(),
      })),
    });
  }
  return out;
}

/** Fingerprint of the allow-list; a write must echo it so it can never silently overwrite someone else's edit. */
export async function pinListEtag(c: PoolClient): Promise<string> {
  const rows = await c.query(
    `SELECT prefix, coalesce(note, '') AS note FROM serviceable_pin_prefixes ORDER BY prefix`,
  );
  return createHash('sha256').update(JSON.stringify(rows.rows)).digest('hex');
}

export async function setPinPrefixes(
  c: PoolClient,
  x: Ctx,
  add: string[],
  remove: string[],
  note: string | undefined,
  guard: { expectedEtag: string; reason: string },
) {
  await c.query(`LOCK TABLE serviceable_pin_prefixes IN SHARE ROW EXCLUSIVE MODE`);
  if ((await pinListEtag(c)) !== guard.expectedEtag)
    throw new AppError(
      'CART_VERSION_CONFLICT',
      'The delivery-area list changed since you loaded it; reload and retry',
    );
  const beforeRows = (await c.query(`SELECT prefix FROM serviceable_pin_prefixes ORDER BY prefix`)).rows.map(
    (r) => r.prefix as string,
  );
  for (const p of add) {
    await c.query(
      `INSERT INTO serviceable_pin_prefixes (prefix, note) VALUES ($1,$2) ON CONFLICT (prefix) DO UPDATE SET note = excluded.note`,
      [p, note ?? null],
    );
  }
  for (const p of remove) await c.query(`DELETE FROM serviceable_pin_prefixes WHERE prefix = $1`, [p]);
  // Serviceability changes affect outstanding quotes' validity: bump the rules version.
  await c.query(
    `UPDATE store_settings SET rules_version = rules_version + 1, version = version + 1, updated_at = now() WHERE id = 1`,
  );
  await audit(c, {
    actorId: x.adminId,
    actorRole: x.role,
    action: 'shipping.pins',
    resourceType: 'store_settings',
    resourceId: '1',
    reason: guard.reason,
    before: { prefixCount: beforeRows.length },
    after: {
      add,
      remove,
      prefixCount: (await c.query(`SELECT count(*)::int AS n FROM serviceable_pin_prefixes`)).rows[0].n,
    },
    requestId: x.requestId,
  });
}
