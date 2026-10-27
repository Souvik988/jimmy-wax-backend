import express, { type Request, type RequestHandler } from 'express';
import { z } from 'zod';
import { AppError, PageQuery, decodeCursor, encodeCursor, trackRoutes } from '@jw/contracts';
import type { Actor } from '@jw/database';
import {
  SHIPMENT_STATUSES,
  STEP_UP,
  activateCheckout,
  audit,
  adjustStock,
  adminCancel,
  adminTransition,
  can,
  disableCheckout,
  markCodCollected,
  permissionsFor,
  processRefund,
  readiness,
  sessionIsLive,
  updateSettings,
  updateVariant,
  type AdminRole,
  type Permission,
  addShipmentEvent,
  createShipment,
  decideReturn,
  getIssuedInvoice,
  issueInvoice,
  moderateMedia,
  moderateReview,
  publishContent,
  receiveReturn,
  saveContentDraft,
  setPinPrefixes,
  pinListEtag,
  shipmentsForOrder,
} from '@jw/commerce-domain';
import type { Deps } from './app.ts';
import type { AdminKit } from './adminKit.ts';
import { registerB8 } from './adminB8Routes.ts';
import { registerB9 } from './adminB9Routes.ts';
import { registerB10 } from './adminB10Routes.ts';
import { registerB11 } from './adminB11Routes.ts';
import { registerB12 } from './adminB12Routes.ts';

declare module 'express-serve-static-core' {
  interface Request {
    admin?: { userId: string; role: AdminRole; mfa: boolean };
  }
}

const reason = z.string().trim().min(3).max(300);
/** Lists that used to be a fixed 100 rows keep that default; callers page with the opaque cursor. */
const ListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(100),
  cursor: z.string().max(300).optional(),
});

/**
 * /v1/admin/*. Every route: verified token → admin_users row (server-controlled, revocable, never from
 * client claims) → role permission → MFA step-up for sensitive actions → DB-level admin gate
 * (app.admin_role bound inside the transaction) → audit entry.
 */
export function adminRouter(
  deps: Deps,
  lim: (name: string, windowMs: number, max: number, byUser?: boolean) => RequestHandler,
  routeTable: string[],
) {
  const { db, config } = deps;
  const r = trackRoutes(express.Router(), '/v1/admin', routeTable);

  r.use(async (req, _res, next) => {
    const row = await db.tx({ kind: 'customer', userId: req.principal!.userId }, (c) =>
      c.query(`SELECT role, disabled FROM admin_users WHERE user_id = $1`, [req.principal!.userId]),
    );
    const a = row.rows[0];
    if (!(await db.tx({ kind: 'anonymous' }, (c) => sessionIsLive(c, req.principal!.sid)))) {
      throw new AppError('UNAUTHENTICATED', 'Your session has ended; sign in again');
    }
    if (!a || a.disabled) throw new AppError('FORBIDDEN', 'You do not have access to the operator console');
    req.admin = { userId: req.principal!.userId, role: a.role, mfa: req.principal!.aal === 'aal2' };
    next();
  });
  const readLimit = lim('admin-read', 60_000, config.ADMIN_RATE_READ_PER_MIN, true);
  const writeLimit = lim('admin-write', 60_000, config.ADMIN_RATE_WRITE_PER_MIN, true);
  r.use((req, res, next) =>
    (req.method === 'GET' || req.method === 'HEAD' ? readLimit : writeLimit)(req, res, next),
  );

  const need =
    (p: Permission): RequestHandler =>
    (req, _res, next) => {
      if (!can(req.admin!.role, p))
        throw new AppError('FORBIDDEN', `Your role (${req.admin!.role}) cannot do this`);
      if (config.ADMIN_REQUIRE_MFA && STEP_UP.includes(p) && !req.admin!.mfa) {
        throw new AppError('MFA_REQUIRED', 'Re-authenticate with MFA to perform this action');
      }
      next();
    };
  const actor = (req: Request): Actor => ({
    kind: 'admin',
    userId: req.admin!.userId,
    role: req.admin!.role,
  });
  const ctx = (req: Request) => ({ adminId: req.admin!.userId, role: req.admin!.role, requestId: req.id });
  const parse = <T>(s: z.ZodType<T>, v: unknown): T => {
    const p = s.safeParse(v);
    if (!p.success)
      throw new AppError('VALIDATION_FAILED', 'Invalid request', {
        fields: Object.fromEntries(p.error.issues.map((i) => [i.path.join('.') || '_', i.message])),
      });
    return p.data;
  };
  const uuid = (v: unknown) => parse(z.string().uuid(), v);
  const slug = (v: unknown) =>
    parse(
      z
        .string()
        .regex(/^[a-z0-9-]+$/)
        .max(100),
      v,
    );
  const iso = (d: unknown) => new Date(d as string).toISOString();

  r.get('/me', (req, res) => {
    res.json({
      userId: req.admin!.userId,
      role: req.admin!.role,
      permissions: permissionsFor(req.admin!.role),
      mfa: req.admin!.mfa,
    });
  });

  // -------- dashboard: every figure is derived from rows; definitions are returned with the data
  r.get('/dashboard', need('orders:read'), async (req, res) => {
    const d = await db.tx(actor(req), async (c) => {
      const orders = await c.query(
        `SELECT status, count(*)::int n, coalesce(sum(total_paise),0)::bigint total
           FROM orders WHERE created_at >= (date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') - interval '29 days') AT TIME ZONE 'Asia/Kolkata'
          GROUP BY status`,
      );
      const low = await c.query(
        `SELECT count(*)::int n FROM inventory_positions i WHERE low_stock_threshold IS NOT NULL AND on_hand - reserved <= low_stock_threshold`,
      );
      const ex = await c.query(`SELECT count(*)::int n FROM orders WHERE payment_status = 'exception'`);
      const ob =
        await c.query(`SELECT count(*) FILTER (WHERE published_at IS NULL AND dead_at IS NULL)::int pending, count(*) FILTER (WHERE dead_at IS NOT NULL)::int dead,
                                       coalesce(extract(epoch FROM now() - min(created_at) FILTER (WHERE published_at IS NULL AND dead_at IS NULL)),0)::int oldest_s FROM outbox`);
      const rf = await c.query(`SELECT count(*)::int n FROM refunds WHERE status IN ('requested','pending')`);
      return {
        orders: orders.rows,
        low: low.rows[0].n,
        exceptions: ex.rows[0].n,
        outbox: ob.rows[0],
        refundsOpen: rf.rows[0].n,
      };
    });
    res.json({
      definitions: {
        window: 'last 30 calendar days, Asia/Kolkata',
        currency: 'INR (paise)',
        ordersByStatus: 'orders created in window, grouped by current status; totals include shipping',
      },
      ordersByStatus: d.orders.map((o) => ({ status: o.status, count: o.n, totalPaise: Number(o.total) })),
      lowStockVariants: d.low,
      paymentExceptions: d.exceptions,
      refundsOpen: d.refundsOpen,
      outbox: {
        pending: d.outbox.pending,
        deadLetters: d.outbox.dead,
        oldestPendingSeconds: d.outbox.oldest_s,
      },
    });
  });

  // -------- orders
  r.get('/orders', need('orders:read'), async (req, res) => {
    const q = parse(
      PageQuery.extend({
        status: z.string().optional(),
        paymentStatus: z.string().optional(),
        q: z.string().max(40).optional(),
      }),
      req.query,
    );
    const cur = decodeCursor(q.cursor, z.object({ t: z.string(), i: z.string().uuid() }));
    const rows = await db.tx(actor(req), (c) =>
      c.query(
        `SELECT id, order_number, status, payment_status, payment_method, total_paise, created_at, version,
                (SELECT u.is_demo FROM auth.users u WHERE u.id = orders.user_id) AS demo FROM orders
          WHERE ($1::text IS NULL OR status = $1) AND ($2::text IS NULL OR payment_status = $2)
            AND ($3::text IS NULL OR order_number ILIKE $3 || '%')
            AND ($4::timestamptz IS NULL OR (created_at, id) < ($4::timestamptz, $5::uuid))
          ORDER BY created_at DESC, id DESC LIMIT $6`,
        [
          q.status ?? null,
          q.paymentStatus ?? null,
          q.q ? q.q.replace(/[%_\\]/g, '') : null,
          cur?.t ?? null,
          cur?.i ?? null,
          q.limit + 1,
        ],
      ),
    );
    const page = rows.rows.slice(0, q.limit);
    const last = page[page.length - 1];
    res.json({
      items: page.map((o) => ({
        id: o.id,
        orderNumber: o.order_number,
        status: o.status,
        paymentStatus: o.payment_status,
        paymentMethod: o.payment_method,
        totalPaise: o.total_paise,
        createdAt: iso(o.created_at),
        version: o.version,
        demo: !!o.demo,
      })),
      nextCursor:
        rows.rows.length > q.limit && last ? encodeCursor({ t: iso(last.created_at), i: last.id }) : null,
    });
  });
  r.get('/orders/:id', need('orders:read'), async (req, res) => {
    const id = uuid(req.params.id);
    const out = await db.tx(actor(req), async (c) => {
      const o = await c.query(`SELECT * FROM orders WHERE id = $1`, [id]);
      if (o.rowCount === 0) throw new AppError('NOT_FOUND', 'Order not found');
      const items = await c.query(`SELECT * FROM order_items WHERE order_id = $1 ORDER BY id`, [id]);
      const att = await c.query(
        `SELECT id, status, amount_paise, provider, provider_order_id, created_at FROM payment_attempts WHERE order_id = $1 ORDER BY created_at`,
        [id],
      );
      const rf = await c.query(
        `SELECT id, status, amount_paise, reason, created_at FROM refunds WHERE order_id = $1 ORDER BY created_at`,
        [id],
      );
      const hist = await c.query(
        `SELECT from_status, to_status, occurred_at FROM order_status_history WHERE order_id = $1 ORDER BY id`,
        [id],
      );
      const rets = await c.query(
        `SELECT id, status, reason, created_at FROM returns WHERE order_id = $1 ORDER BY created_at`,
        [id],
      );
      const mail = await c.query(
        `SELECT e.template, e.status, e.created_at FROM outbox o JOIN email_outbox e ON e.dedupe_key = o.event_type || ':' || o.id
          WHERE o.aggregate_type = 'order' AND o.aggregate_id = $1 ORDER BY e.id`,
        [id],
      );
      const shipments = await shipmentsForOrder(c, id);
      return {
        o: o.rows[0],
        items: items.rows,
        att: att.rows,
        rf: rf.rows,
        hist: hist.rows,
        rets: rets.rows,
        mail: mail.rows,
        shipments,
      };
    });
    const x = out.o;
    // support role sees a redacted address (no phone / street line)
    const addr =
      can(req.admin!.role, 'orders:fulfil') || req.admin!.role === 'admin'
        ? x.address_snapshot
        : {
            name: x.address_snapshot.name,
            city: x.address_snapshot.city,
            state: x.address_snapshot.state,
            pin: x.address_snapshot.pin,
          };
    const tb = (x.tax_breakdown ?? {}) as {
      rateBps?: number;
      lines?: Array<{ key: string; taxablePaise: number; taxPaise: number }>;
      shipping?: { taxablePaise: number; taxPaise: number };
      codFee?: { taxablePaise: number; taxPaise: number };
    };
    const taxByVariant = new Map((tb.lines ?? []).map((l) => [l.key, l]));
    res.json({
      id: x.id,
      customerId: can(req.admin!.role, 'customers:read') ? x.user_id : null,
      couponCode: x.coupon_code ?? null,
      shippingDiscountPaise: x.shipping_discount_paise ?? 0,
      orderNumber: x.order_number,
      status: x.status,
      paymentStatus: x.payment_status,
      paymentMethod: x.payment_method,
      version: x.version,
      subtotalPaise: x.subtotal_paise,
      discountPaise: x.discount_paise,
      taxPaise: x.tax_paise,
      shippingPaise: x.shipping_paise,
      codFeePaise: x.cod_fee_paise,
      taxInclusive: x.tax_inclusive,
      totalPaise: x.total_paise,
      currency: 'INR',
      address: addr,
      createdAt: iso(x.created_at),
      allocation: {
        taxRateBps: tb.rateBps ?? null,
        shipping: {
          taxablePaise: tb.shipping?.taxablePaise ?? 0,
          taxPaise: tb.shipping?.taxPaise ?? 0,
          totalPaise: x.shipping_paise,
        },
        codFee: {
          taxablePaise: tb.codFee?.taxablePaise ?? 0,
          taxPaise: tb.codFee?.taxPaise ?? 0,
          totalPaise: x.cod_fee_paise,
        },
      },
      statusHistory: out.hist.map((h) => ({ from: h.from_status, to: h.to_status, at: iso(h.occurred_at) })),
      shipments: out.shipments,
      returns: out.rets.map((q) => ({
        id: q.id,
        status: q.status,
        reason: q.reason,
        createdAt: iso(q.created_at),
      })),
      messages: out.mail.map((m) => ({
        template: m.template,
        status: m.status,
        createdAt: iso(m.created_at),
      })),
      lines: out.items.map((i) => ({
        id: Number(i.id),
        productId: i.product_id,
        variantId: i.variant_id,
        discountPaise: i.discount_paise ?? 0,
        taxablePaise: taxByVariant.get(i.variant_id)?.taxablePaise ?? null,
        taxPaise: taxByVariant.get(i.variant_id)?.taxPaise ?? null,
        sku: i.sku,
        productName: i.product_name,
        variantTitle: i.variant_title,
        unitPricePaise: i.unit_price_paise,
        quantity: i.quantity,
        lineTotalPaise: i.line_total_paise,
      })),
      paymentAttempts: out.att.map((a) => ({
        id: a.id,
        status: a.status,
        amountPaise: a.amount_paise,
        provider: a.provider,
        createdAt: iso(a.created_at),
      })),
      refunds: out.rf.map((f) => ({
        id: f.id,
        status: f.status,
        amountPaise: f.amount_paise,
        reason: f.reason,
      })),
    });
  });
  r.post('/orders/:id/status', need('orders:fulfil'), async (req, res) => {
    const b = parse(
      z.object({
        to: z.enum(['confirmed', 'processing', 'shipped', 'out_for_delivery', 'delivered', 'returned']),
        expectedVersion: z.number().int(),
        reason: reason.optional(),
      }),
      req.body,
    );
    res.json(
      await db.tx(actor(req), (c) =>
        adminTransition(c, ctx(req), uuid(req.params.id), b.to, b.expectedVersion, b.reason),
      ),
    );
  });
  r.post('/orders/:id/cancel', need('orders:cancel'), async (req, res) => {
    const b = parse(z.object({ reason, expectedVersion: z.number().int() }), req.body);
    res.json(
      await db.tx(actor(req), (c) =>
        adminCancel(c, ctx(req), uuid(req.params.id), b.reason, b.expectedVersion),
      ),
    );
  });
  r.post('/orders/:id/cod-collected', need('orders:fulfil'), async (req, res) => {
    const b = parse(z.object({ expectedVersion: z.number().int() }), req.body);
    await db.tx(actor(req), (c) => markCodCollected(c, ctx(req), uuid(req.params.id), b.expectedVersion));
    res.status(204).end();
  });

  // -------- inventory
  r.get('/inventory', need('inventory:read'), async (req, res) => {
    const rows = await db.tx(actor(req), (c) =>
      c.query(`SELECT v.id, v.sku, p.name, v.title, i.on_hand, i.reserved, i.low_stock_threshold, i.version FROM inventory_positions i
                 JOIN product_variants v ON v.id = i.variant_id JOIN products p ON p.id = v.product_id ORDER BY p.sort_order, v.id`),
    );
    res.json({
      items: rows.rows.map((x) => ({
        variantId: x.id,
        sku: x.sku,
        name: x.name,
        variantTitle: x.title,
        onHand: x.on_hand,
        reserved: x.reserved,
        available: x.on_hand - x.reserved,
        lowStockThreshold: x.low_stock_threshold,
        version: x.version,
      })),
    });
  });
  r.get('/inventory/:variantId/movements', need('inventory:read'), async (req, res) => {
    const q = parse(PageQuery, req.query);
    const cur = decodeCursor(q.cursor, z.object({ id: z.number() }));
    const rows = await db.tx(actor(req), (c) =>
      c.query(
        `SELECT * FROM inventory_movements WHERE variant_id = $1 AND ($2::bigint IS NULL OR id < $2) ORDER BY id DESC LIMIT $3`,
        [slug(req.params.variantId), cur?.id ?? null, q.limit + 1],
      ),
    );
    const page = rows.rows.slice(0, q.limit);
    res.json({
      items: page.map((m) => ({
        id: Number(m.id),
        kind: m.kind,
        deltaOnHand: m.delta_on_hand,
        deltaReserved: m.delta_reserved,
        reason: m.reason,
        refType: m.ref_type,
        createdAt: iso(m.created_at),
      })),
      nextCursor: rows.rows.length > q.limit ? encodeCursor({ id: Number(page[page.length - 1]!.id) }) : null,
    });
  });
  r.post('/inventory/:variantId/adjust', need('inventory:write'), async (req, res) => {
    const b = parse(
      z.object({ delta: z.number().int(), reason, expectedVersion: z.number().int() }),
      req.body,
    );
    res.json(
      await db.tx(actor(req), (c) =>
        adjustStock(c, ctx(req), slug(req.params.variantId), b.delta, b.reason, b.expectedVersion),
      ),
    );
  });

  // -------- catalog
  r.get('/catalog/variants', need('catalog:read'), async (req, res) => {
    // Optional product filter and keyset paging keep a large catalogue cheap; without them the first 500 variants are returned.
    const q = parse(
      z.object({
        productId: z
          .string()
          .regex(/^[a-z0-9-]+$/)
          .max(100)
          .optional(),
        limit: z.coerce.number().int().min(1).max(1000).default(500),
        cursor: z.string().max(300).optional(),
      }),
      req.query,
    );
    const cur = decodeCursor(q.cursor, z.object({ o: z.number().int(), i: z.string() }));
    const found = await db.tx(actor(req), (c) =>
      c.query(
        `SELECT v.id, v.product_id, v.sku, v.title, v.price_paise, v.compare_at_price_paise, v.active, v.updated_at, v.hsn_code, p.name, p.sort_order
           FROM product_variants v JOIN products p ON p.id = v.product_id
          WHERE ($1::text IS NULL OR v.product_id = $1) AND ($2::int IS NULL OR (p.sort_order, v.id) > ($2::int, $3::text))
          ORDER BY p.sort_order, v.id LIMIT $4`,
        [q.productId ?? null, cur?.o ?? null, cur?.i ?? null, q.limit + 1],
      ),
    );
    const rows = { rows: found.rows.slice(0, q.limit) };
    const tail = rows.rows[rows.rows.length - 1];
    res.json({
      nextCursor:
        found.rows.length > q.limit && tail ? encodeCursor({ o: tail.sort_order, i: tail.id }) : null,
      items: rows.rows.map((v) => ({
        id: v.id,
        productId: v.product_id,
        hsnCode: v.hsn_code ?? null,
        sku: v.sku,
        name: v.name,
        title: v.title,
        pricePaise: v.price_paise,
        comparePaise: v.compare_at_price_paise,
        active: v.active,
        updatedAt: iso(v.updated_at),
      })),
    });
  });
  r.patch('/catalog/variants/:id', need('catalog:write'), async (req, res) => {
    const b = parse(
      z.object({
        pricePaise: z.number().int().min(0).max(100_000_000).optional(),
        comparePaise: z.number().int().min(0).max(100_000_000).nullable().optional(),
        active: z.boolean().optional(),
        title: z.string().trim().min(1).max(80).optional(),
        sku: z.string().trim().min(2).max(60).optional(),
        weightGrams: z.number().int().min(1).max(50_000).nullable().optional(),
        lengthMm: z.number().int().min(1).max(2000).nullable().optional(),
        widthMm: z.number().int().min(1).max(2000).nullable().optional(),
        heightMm: z.number().int().min(1).max(2000).nullable().optional(),
        hsnCode: z
          .string()
          .regex(/^[0-9]{4,8}$/, '4-8 digits')
          .nullable()
          .optional(),
        barcode: z.string().trim().min(4).max(40).nullable().optional(),
        costPricePaise: z.number().int().min(0).nullable().optional(),
        lowStockThreshold: z.number().int().min(0).max(100_000).optional(),
        reason,
        expectedUpdatedAt: z.string(),
      }),
      req.body,
    );
    const v = await db.tx(actor(req), (c) => updateVariant(c, ctx(req), slug(req.params.id), b));
    res.json({
      id: v.id,
      pricePaise: v.price_paise,
      comparePaise: v.compare_at_price_paise,
      active: v.active,
      updatedAt: iso(v.updated_at),
    });
  });

  // -------- settings + activation
  const env = () => ({
    paymentProvider: config.PAYMENT_PROVIDER,
    flags: {
      checkout: config.FEATURE_CHECKOUT,
      cod: config.FEATURE_COD,
      onlinePayments: config.FEATURE_ONLINE_PAYMENTS,
    },
  });
  r.get('/settings', need('settings:read'), async (req, res) => {
    const out = await db.tx(actor(req), (c) => readiness(c, env()));
    const s = out.settings;
    res.json({
      settings: {
        shippingFeePaise: s.shipping_fee_paise,
        freeShippingThresholdPaise: s.free_shipping_threshold_paise,
        codEnabled: s.cod_enabled,
        codMaxOrderPaise: s.cod_max_order_paise,
        onlinePaymentsEnabled: s.online_payments_enabled,
        paymentWindowMinutes: s.payment_window_minutes,
        checkoutEnabled: s.checkout_enabled,
        checkoutPolicyConfirmed: s.checkout_policy_confirmed,
        checkoutAuthority: s.checkout_authority,
        codFeePaise: s.cod_fee_paise,
        gstRateBps: s.gst_rate_bps,
        taxInclusive: s.tax_inclusive,
        returnWindowDays: s.return_window_days,
        merchantLegalName: s.merchant_legal_name,
        merchantGstin: s.merchant_gstin,
        merchantState: s.merchant_state,
        merchantAddress: s.merchant_address,
        brandName: s.brand_name,
        supportEmail: s.support_email,
        supportPhone: s.support_phone,
        ordersPaused: s.orders_paused,
        pauseMessage: s.pause_message,
        version: s.version,
      },
      readiness: { allOk: out.allOk, checks: out.checks },
    });
  });
  r.patch('/settings', need('settings:write'), async (req, res) => {
    const b = parse(
      z.object({
        expectedVersion: z.number().int(),
        reason,
        shippingFeePaise: z.number().int().min(0).optional(),
        freeShippingThresholdPaise: z.number().int().min(0).nullable().optional(),
        codEnabled: z.boolean().optional(),
        codMaxOrderPaise: z.number().int().min(0).nullable().optional(),
        onlinePaymentsEnabled: z.boolean().optional(),
        paymentWindowMinutes: z.number().int().min(5).max(1440).nullable().optional(),
        deliveryEstimate: z.string().max(100).optional(),
        codFeePaise: z.number().int().min(0).max(100000).optional(),
        gstRateBps: z.number().int().min(0).max(4000).optional(),
        taxInclusive: z.boolean().optional(),
        returnWindowDays: z.number().int().min(1).max(90).nullable().optional(),
        merchantLegalName: z.string().trim().min(2).max(200).nullable().optional(),
        merchantGstin: z
          .string()
          .trim()
          .toUpperCase()
          .regex(/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/, 'Invalid GSTIN format')
          .nullable()
          .optional(),
        merchantState: z.string().trim().min(2).max(60).nullable().optional(),
        merchantAddress: z.string().trim().min(5).max(400).nullable().optional(),
        brandName: z.string().trim().min(2).max(80).optional(),
        supportEmail: z.string().trim().email().max(160).nullable().optional(),
        supportPhone: z
          .string()
          .trim()
          .regex(/^[0-9+() -]{7,20}$/, 'Invalid phone')
          .nullable()
          .optional(),
      }),
      req.body,
    );
    await db.tx(actor(req), (c) =>
      updateSettings(c, ctx(req), b.expectedVersion, b.reason, {
        shipping_fee_paise: b.shippingFeePaise,
        free_shipping_threshold_paise: b.freeShippingThresholdPaise,
        cod_enabled: b.codEnabled,
        cod_max_order_paise: b.codMaxOrderPaise,
        online_payments_enabled: b.onlinePaymentsEnabled,
        payment_window_minutes: b.paymentWindowMinutes,
        delivery_estimate: b.deliveryEstimate,
        cod_fee_paise: b.codFeePaise,
        gst_rate_bps: b.gstRateBps,
        tax_inclusive: b.taxInclusive,
        return_window_days: b.returnWindowDays,
        merchant_legal_name: b.merchantLegalName,
        merchant_gstin: b.merchantGstin,
        merchant_state: b.merchantState,
        merchant_address: b.merchantAddress,
        brand_name: b.brandName,
        support_email: b.supportEmail,
        support_phone: b.supportPhone,
      }),
    );
    res.status(204).end();
  });
  r.post('/checkout/activate', need('settings:write'), async (req, res) => {
    const b = parse(
      z.object({ confirm: z.literal(true), reason, expectedVersion: z.number().int() }),
      req.body,
    );
    await db.tx(actor(req), (c) => activateCheckout(c, ctx(req), b.expectedVersion, b.reason, env()));
    res.status(204).end();
  });
  // Kill switch: deliberately NOT step-up gated; stopping sales must always be fast.
  r.post(
    '/checkout/disable',
    (req, _res, next) =>
      can(req.admin!.role, 'settings:write') ? next() : next(new AppError('FORBIDDEN', 'Not allowed')),
    async (req, res) => {
      const b = parse(z.object({ reason }), req.body);
      await db.tx(actor(req), (c) => disableCheckout(c, ctx(req), b.reason));
      res.status(204).end();
    },
  );

  // -------- payments / refunds
  r.get('/refunds', need('payments:read'), async (req, res) => {
    const q = parse(ListQuery.extend({ status: z.string().max(30).optional() }), req.query);
    const cur = decodeCursor(q.cursor, z.object({ t: z.string(), i: z.string().uuid() }));
    const rows = await db.tx(actor(req), (c) =>
      c.query(
        `SELECT id, order_id, amount_paise, status, reason, created_at,
                EXISTS (SELECT 1 FROM payment_attempts pa WHERE pa.order_id = refunds.order_id AND pa.status = 'captured') AS has_captured FROM refunds
          WHERE ($1::text IS NULL OR status = $1) AND ($2::timestamptz IS NULL OR (created_at, id) < ($2::timestamptz, $3::uuid))
          ORDER BY created_at DESC, id DESC LIMIT $4`,
        [q.status ?? null, cur?.t ?? null, cur?.i ?? null, q.limit + 1],
      ),
    );
    const page = rows.rows.slice(0, q.limit);
    const last = page[page.length - 1];
    const key = config.RAZORPAY_KEY_ID ?? '';
    res.json({
      items: page.map((f) => ({
        id: f.id,
        orderId: f.order_id,
        amountPaise: f.amount_paise,
        status: f.status,
        reason: f.reason,
        createdAt: iso(f.created_at),
        // Whether "process" can succeed right now, and if not why - so a read-only role never has to probe by trying.
        processable:
          !!deps.gateway && f.has_captured && ['requested', 'pending', 'failed'].includes(f.status),
        blockedReason:
          f.status === 'processed'
            ? 'already_processed'
            : !deps.gateway
              ? 'no_gateway'
              : !f.has_captured
                ? 'no_online_payment'
                : null,
      })),
      nextCursor:
        rows.rows.length > q.limit && last ? encodeCursor({ t: iso(last.created_at), i: last.id }) : null,
      // Display-safe: tells finance whether "process" can work. Never contains keys.
      paymentCapability: {
        configured: !!deps.gateway,
        provider: deps.gateway?.name ?? null,
        mode: !deps.gateway
          ? null
          : config.PAYMENT_PROVIDER === 'razorpay'
            ? /^rzp_live_/.test(key)
              ? 'live'
              : 'test'
            : 'test',
      },
    });
  });
  r.post('/refunds/:id/process', need('refunds:write'), async (req, res) => {
    if (!deps.gateway) throw new AppError('UNSUPPORTED_PAYMENT_METHOD', 'No payment provider is configured');
    res.json(await processRefund(db, deps.gateway, ctx(req), uuid(req.params.id)));
  });

  // -------- operations: queue visibility + replay, audit
  r.get('/ops/outbox', need('ops:read'), async (req, res) => {
    const state = parse(z.enum(['pending', 'dead']).default('dead'), req.query.state);
    const rows = await db.tx(actor(req), (c) =>
      c.query(
        `SELECT id, event_type, aggregate_id, attempts, last_error, created_at, dead_at FROM outbox WHERE ${state === 'dead' ? 'dead_at IS NOT NULL' : 'published_at IS NULL AND dead_at IS NULL'} ORDER BY id DESC LIMIT 100`,
      ),
    );
    res.json({
      items: rows.rows.map((o) => ({
        id: Number(o.id),
        eventType: o.event_type,
        aggregateId: o.aggregate_id,
        attempts: o.attempts,
        lastError: o.last_error,
        createdAt: iso(o.created_at),
        dead: !!o.dead_at,
      })),
    });
  });
  r.post('/ops/outbox/:id/replay', need('ops:replay'), async (req, res) => {
    const id = parse(z.coerce.number().int().positive(), req.params.id);
    const b = parse(z.object({ reason }), req.body);
    await db.tx(actor(req), async (c) => {
      const u = await c.query(
        `UPDATE outbox SET dead_at = NULL, attempts = 0, available_at = now(), claimed_by = NULL, claim_expires_at = NULL WHERE id = $1 AND dead_at IS NOT NULL RETURNING id`,
        [id],
      );
      if (u.rowCount === 0) throw new AppError('ILLEGAL_STATE', 'Only dead-lettered events can be replayed');
      await audit(c, {
        actorId: req.admin!.userId,
        actorRole: req.admin!.role,
        requestId: req.id,
        action: 'outbox.replay',
        resourceType: 'outbox',
        resourceId: String(id),
        reason: b.reason,
      });
    });
    res.status(204).end();
  });
  r.get('/audit', need('audit:read'), async (req, res) => {
    const rt = parse(z.string().max(40).optional(), req.query.resourceType);
    const rows = await db.tx(actor(req), (c) =>
      c.query(
        `SELECT * FROM audit_log WHERE ($1::text IS NULL OR resource_type = $1) ORDER BY id DESC LIMIT 100`,
        [rt ?? null],
      ),
    );
    res.json({
      items: rows.rows.map((a) => ({
        id: Number(a.id),
        actorId: a.actor_id,
        actorRole: a.actor_role,
        action: a.action,
        resourceType: a.resource_type,
        resourceId: a.resource_id,
        reason: a.reason,
        before: a.before,
        after: a.after,
        requestId: a.request_id,
        createdAt: iso(a.created_at),
      })),
    });
  });

  // -------- shipping, returns, invoices
  r.get('/orders/:id/shipments', need('orders:read'), async (req, res) => {
    const id = uuid(req.params.id);
    res.json({ items: await db.tx(actor(req), (c) => shipmentsForOrder(c, id)) });
  });
  r.post('/orders/:id/shipments', need('orders:fulfil'), async (req, res) => {
    const b = parse(
      z.object({
        courier: z.string().trim().min(2).max(80),
        trackingNumber: z.string().trim().min(3).max(80),
        trackingUrl: z.string().url().startsWith('https://').nullable().optional(),
        // optional package snapshot when the parcel differs from the catalogue; then a reason is mandatory
        package: z
          .object({
            weightGrams: z.number().int().min(1).max(50000),
            lengthMm: z.number().int().min(1).max(2000),
            widthMm: z.number().int().min(1).max(2000),
            heightMm: z.number().int().min(1).max(2000),
          })
          .optional(),
        overrideReason: z.string().trim().min(3).max(200).optional(),
      }),
      req.body,
    );
    res.status(201).json(await db.tx(actor(req), (c) => createShipment(c, ctx(req), uuid(req.params.id), b)));
  });
  r.post('/shipments/:id/events', need('orders:fulfil'), async (req, res) => {
    const b = parse(
      z.object({
        status: z.enum(SHIPMENT_STATUSES),
        description: z.string().trim().max(300).optional(),
        occurredAt: z.string().datetime().optional(),
      }),
      req.body,
    );
    await db.tx(actor(req), (c) => addShipmentEvent(c, ctx(req), uuid(req.params.id), b));
    res.status(204).end();
  });
  r.get('/shipping/pins', need('orders:read'), async (req, res) => {
    const rows = await db.tx(actor(req), (c) =>
      c.query(`SELECT prefix, note FROM serviceable_pin_prefixes ORDER BY prefix`),
    );
    res.json({ items: rows.rows, etag: await db.tx(actor(req), (c) => pinListEtag(c)) });
  });
  r.put('/shipping/pins', need('settings:write'), async (req, res) => {
    const pin = z.string().regex(/^[0-9]{3,6}$/);
    const b = parse(
      z.object({
        add: z.array(pin).max(2000).default([]),
        remove: z.array(pin).max(2000).default([]),
        note: z.string().max(100).optional(),
        expectedEtag: z.string().length(64),
        reason,
      }),
      req.body,
    );
    await db.tx(actor(req), (c) =>
      setPinPrefixes(c, ctx(req), b.add, b.remove, b.note, {
        expectedEtag: b.expectedEtag,
        reason: b.reason,
      }),
    );
    res.status(204).end();
  });

  r.get('/returns', need('orders:read'), async (req, res) => {
    const status = parse(
      z.enum(['requested', 'approved', 'rejected', 'received', 'closed']).optional(),
      req.query.status,
    );
    const lq = parse(ListQuery, req.query);
    const cur = decodeCursor(lq.cursor, z.object({ t: z.string(), i: z.string().uuid() }));
    const out = await db.tx(actor(req), async (c) => ({
      rows: await c.query(
        `SELECT r.id, r.order_id, r.status, r.reason, r.created_at, o.order_number,
                (SELECT json_agg(json_build_object('sku', i.sku, 'name', i.product_name, 'quantity', ri.quantity))
                   FROM return_items ri JOIN order_items i ON i.id = ri.order_item_id WHERE ri.return_id = r.id) AS items
           FROM returns r JOIN orders o ON o.id = r.order_id
          WHERE ($1::text IS NULL OR r.status = $1) AND ($2::timestamptz IS NULL OR (r.created_at, r.id) < ($2::timestamptz, $3::uuid))
          ORDER BY r.created_at DESC, r.id DESC LIMIT $4`,
        [status ?? null, cur?.t ?? null, cur?.i ?? null, lq.limit + 1],
      ),
      window: (await c.query(`SELECT return_window_days FROM store_settings WHERE id = 1`)).rows[0]
        ?.return_window_days as number | null | undefined,
    }));
    const rows = { rows: out.rows.rows.slice(0, lq.limit) };
    const lastRow = rows.rows[rows.rows.length - 1];
    res.json({
      // Non-sensitive store policy, readable by every role that can read returns (DASH-BR-013).
      returnPolicy: { returnWindowDays: out.window ?? null, configured: out.window != null },
      nextCursor:
        out.rows.rows.length > lq.limit && lastRow
          ? encodeCursor({ t: iso(lastRow.created_at), i: lastRow.id })
          : null,
      items: rows.rows.map((x) => ({
        id: x.id,
        orderId: x.order_id,
        orderNumber: x.order_number,
        status: x.status,
        reason: x.reason,
        items: x.items ?? [],
        createdAt: iso(x.created_at),
      })),
    });
  });
  r.post('/returns/:id/decide', need('orders:fulfil'), async (req, res) => {
    const b = parse(z.object({ approve: z.boolean(), note: z.string().trim().min(3).max(300) }), req.body);
    await db.tx(actor(req), (c) => decideReturn(c, ctx(req), uuid(req.params.id), b.approve, b.note));
    res.status(204).end();
  });
  // Receiving restocks inventory, so it needs the inventory write permission and the same step-up as a manual stock adjustment.
  r.post('/returns/:id/receive', need('orders:fulfil'), need('inventory:write'), async (req, res) => {
    res.json(await db.tx(actor(req), (c) => receiveReturn(c, ctx(req), uuid(req.params.id))));
  });
  // Reading an invoice never issues one (DASH-BR-008). Roles that cannot fulfil orders get the buyer street address withheld.
  r.get('/orders/:id/invoice', need('orders:read'), async (req, res) => {
    const id = uuid(req.params.id);
    const snap = await db.tx(actor(req), (c) => getIssuedInvoice(c, id));
    if (!snap) throw new AppError('NOT_FOUND', 'No invoice has been issued for this order yet');
    res.json(
      can(req.admin!.role, 'orders:fulfil') ? snap : { ...snap, buyer: { ...snap.buyer, address: '' } },
    );
  });
  // Issues the GST invoice exactly once (immutable number). Needs fulfil permission, step-up and a reason; repeating returns the
  // original with 200.
  r.post('/orders/:id/invoice', need('orders:fulfil'), async (req, res) => {
    if (config.ADMIN_REQUIRE_MFA && !req.admin!.mfa)
      throw new AppError('MFA_REQUIRED', 'Re-authenticate with MFA to perform this action');
    const b = parse(z.object({ reason }), req.body);
    const id = uuid(req.params.id);
    const out = await db.tx(actor(req), async (c) => {
      const existing = await getIssuedInvoice(c, id);
      if (existing) return { snap: existing, created: false };
      const snap = await issueInvoice(c, id);
      await audit(c, {
        actorId: req.admin!.userId,
        actorRole: req.admin!.role,
        action: 'invoice.issue',
        resourceType: 'order',
        resourceId: id,
        reason: b.reason,
        after: { invoiceNumber: snap.invoiceNumber },
        requestId: req.id,
      });
      return { snap, created: true };
    });
    res.status(out.created ? 201 : 200).json(out.snap);
  });

  // -------- reviews moderation
  r.get('/reviews', need('reviews:moderate'), async (req, res) => {
    const status = parse(z.enum(['pending', 'approved', 'rejected']).default('pending'), req.query.status);
    const rows = await db.tx(actor(req), async (c) => {
      const rv = await c.query(
        `SELECT r.id, r.product_id, r.rating, r.title, r.body, r.status, r.verified_purchase, r.created_at FROM reviews r WHERE r.status = $1 ORDER BY r.created_at LIMIT 100`,
        [status],
      );
      const m = await c.query(
        `SELECT id, review_id, status, width, height FROM review_media WHERE review_id = ANY($1::uuid[])`,
        [rv.rows.map((x) => x.id)],
      );
      return { rv: rv.rows, m: m.rows };
    });
    res.json({
      items: rows.rv.map((x) => ({
        id: x.id,
        productId: x.product_id,
        rating: x.rating,
        title: x.title,
        body: x.body,
        status: x.status,
        verifiedPurchase: x.verified_purchase,
        createdAt: iso(x.created_at),
        photos: rows.m
          .filter((p) => p.review_id === x.id)
          .map((p) => ({ id: p.id, status: p.status, width: p.width, height: p.height })),
      })),
    });
  });
  r.post('/reviews/:id/moderate', need('reviews:moderate'), async (req, res) => {
    const b = parse(
      z.object({ approve: z.boolean(), note: z.string().trim().max(300).default('') }),
      req.body,
    );
    await db.tx(actor(req), (c) => moderateReview(c, ctx(req), uuid(req.params.id), b.approve, b.note));
    res.status(204).end();
  });
  r.post('/review-media/:id/moderate', need('reviews:moderate'), async (req, res) => {
    const b = parse(z.object({ approve: z.boolean() }), req.body);
    await db.tx(actor(req), (c) => moderateMedia(c, deps.storage, ctx(req), uuid(req.params.id), b.approve));
    res.status(204).end();
  });
  r.get('/review-media/:id/image', need('reviews:moderate'), async (req, res) => {
    const m = await db.tx(actor(req), (c) =>
      c.query(`SELECT original_key, mime FROM review_media WHERE id = $1`, [uuid(req.params.id)]),
    );
    const data = m.rows[0] ? await deps.storage.get(m.rows[0].original_key) : null;
    if (!data) throw new AppError('NOT_FOUND', 'Photo not found');
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.type(m.rows[0].mime).send(data);
  });

  // -------- policy / care-guide content
  r.get('/content', need('catalog:read'), async (req, res) => {
    const rows = await db.tx(actor(req), (c) =>
      c.query(`SELECT slug, kind, title, version, status, updated_at FROM content_pages ORDER BY slug`),
    );
    res.json({
      items: rows.rows.map((x) => ({
        slug: x.slug,
        kind: x.kind,
        title: x.title,
        version: x.version,
        status: x.status,
        updatedAt: iso(x.updated_at),
      })),
    });
  });
  r.get('/content/:slug', need('catalog:read'), async (req, res) => {
    const row = await db.tx(actor(req), (c) =>
      c.query(`SELECT * FROM content_pages WHERE slug = $1`, [slug(req.params.slug)]),
    );
    if (!row.rows[0]) throw new AppError('NOT_FOUND', 'Page not found');
    const x = row.rows[0];
    res.json({
      slug: x.slug,
      kind: x.kind,
      title: x.title,
      bodyMd: x.body_md,
      version: x.version,
      status: x.status,
    });
  });
  r.put('/content/:slug', need('catalog:write'), async (req, res) => {
    const b = parse(
      z.object({
        kind: z.enum(['policy', 'care_guide', 'page']),
        title: z.string().trim().min(2).max(160),
        bodyMd: z.string().min(1).max(60000),
        expectedVersion: z.number().int().optional(),
      }),
      req.body,
    );
    const s = parse(z.string().regex(/^[a-z0-9-]{2,60}$/), req.params.slug);
    res.json(await db.tx(actor(req), (c) => saveContentDraft(c, ctx(req), s, b)));
  });
  r.post('/content/:slug/publish', need('catalog:write'), async (req, res) => {
    await db.tx(actor(req), (c) => publishContent(c, ctx(req), slug(req.params.slug)));
    res.status(204).end();
  });

  const kit: AdminKit = {
    r,
    deps,
    db,
    config,
    storage: deps.storage,
    lim,
    need,
    actor,
    ctx,
    parse,
    uuid,
    slug,
    iso,
  };
  registerB8(kit);
  registerB9(kit);
  registerB10(kit);
  registerB11(kit);
  registerB12(kit);

  return r;
}
