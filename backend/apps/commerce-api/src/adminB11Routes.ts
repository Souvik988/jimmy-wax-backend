import type { Request } from 'express';
import { z } from 'zod';
import { AppError, PageQuery } from '@jw/contracts';
import {
  AppVersionPatch,
  can,
  CustomerNotesPatch,
  FlagInput,
  RangeQuery,
  StoreStatusPatch,
  addOrderNote,
  adminHealth,
  analyticsCsv,
  customerAnalytics,
  deleteFlag,
  exportCustomersCsv,
  exportOrdersCsv,
  geoAnalytics,
  getCustomer,
  getStoreStatus,
  gstAnalytics,
  gstr1Report,
  gstr1Csv,
  integrationStatus,
  listAppVersions,
  listCustomers,
  listFlags,
  listOrderNotes,
  packingSlip,
  productAnalytics,
  queueEmail,
  recordIntegrationCheck,
  returnsAnalytics,
  revealCustomer,
  salesAnalytics,
  setAppVersion,
  setCustomerBlocked,
  setStoreStatus,
  shippingAnalytics,
  updateCustomerNotes,
  upsertFlag,
  type IntegrationFacts,
} from '@jw/commerce-domain';
import { SmtpEmailSender } from '@jw/integrations';
import type { AdminKit } from './adminKit.ts';

const reason = z.string().trim().min(3).max(300);
const bool = z.enum(['true', 'false']).transform((v) => v === 'true');

/** Customers, order extras, exports, analytics, store status, app versions, flags, integrations, health (phase B11). */
export function registerB11(k: AdminKit) {
  const { r, db, need, actor, ctx, parse, uuid, config, storage } = k;
  const tx = <T>(req: Request, fn: Parameters<typeof db.tx<T>>[1]) => db.tx(actor(req), fn);
  const mfa = (req: Request) => {
    if (config.ADMIN_REQUIRE_MFA && !req.admin!.mfa)
      throw new AppError('MFA_REQUIRED', 'Re-authenticate with MFA to perform this action');
  };
  const csv = (res: import('express').Response, name: string, body: string) => {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(body);
  };

  // ---------------------------------------------------------------- customers
  r.get('/customers', need('customers:read'), async (req, res) => {
    const q = parse(
      PageQuery.extend({
        q: z.string().trim().max(100).optional(),
        tag: z.string().max(30).optional(),
        blocked: bool.optional(),
      }),
      req.query,
    );
    res.json(
      await tx(req, (c) =>
        listCustomers(c, { q: q.q, tag: q.tag, blocked: q.blocked, limit: q.limit, cursor: q.cursor }),
      ),
    );
  });
  r.get('/customers/:id', need('customers:read'), async (req, res) => {
    res.json(await tx(req, (c) => getCustomer(c, uuid(req.params.id))));
  });
  // Unmasking is a deliberate, audited act.
  r.post('/customers/:id/reveal', need('customers:read'), async (req, res) => {
    const b = parse(z.object({ reason }), req.body);
    res.json(await tx(req, (c) => revealCustomer(c, ctx(req), uuid(req.params.id), b.reason)));
  });
  r.patch('/customers/:id', need('customers:write'), async (req, res) => {
    res.json(
      await tx(req, (c) =>
        updateCustomerNotes(c, ctx(req), uuid(req.params.id), parse(CustomerNotesPatch, req.body)),
      ),
    );
  });
  r.post('/customers/:id/block', need('customers:write'), async (req, res) => {
    mfa(req);
    const b = parse(z.object({ blocked: z.boolean(), reason }), req.body);
    res.json(await tx(req, (c) => setCustomerBlocked(c, ctx(req), uuid(req.params.id), b.blocked, b.reason)));
  });
  r.get('/exports/customers.csv', need('customers:export'), async (req, res) => {
    csv(res, 'jimmywax-customers.csv', await tx(req, (c) => exportCustomersCsv(c, ctx(req))));
  });

  // ------------------------------------------------------------- order extras
  r.get('/orders/:id/notes', need('orders:read'), async (req, res) => {
    res.json({ items: await tx(req, (c) => listOrderNotes(c, uuid(req.params.id))) });
  });
  r.post('/orders/:id/notes', need('orders:read'), async (req, res) => {
    const b = parse(z.object({ body: z.string().trim().min(1).max(2000) }), req.body);
    res
      .status(201)
      .json({ items: await tx(req, (c) => addOrderNote(c, ctx(req), uuid(req.params.id), b.body)) });
  });
  r.get('/orders/:id/packing-slip', need('orders:fulfil'), async (req, res) => {
    res.json(await tx(req, (c) => packingSlip(c, uuid(req.params.id))));
  });
  r.post('/orders/:id/resend-confirmation', need('orders:fulfil'), async (req, res) => {
    const id = uuid(req.params.id);
    const out = await tx(req, async (c) => {
      const o = (
        await c.query(
          `SELECT o.order_number, o.total_paise, o.payment_method, u.email FROM orders o JOIN auth.users u ON u.id = o.user_id WHERE o.id = $1`,
          [id],
        )
      ).rows[0];
      if (!o) throw new AppError('NOT_FOUND', 'Order not found');
      if (!o.email) throw new AppError('ILLEGAL_STATE', 'This customer has no email address on file');
      await queueEmail(c, {
        dedupeKey: `resend:${id}:${Math.floor(Date.now() / 60_000)}`,
        to: o.email,
        template: 'order.placed',
        payload: { orderNumber: o.order_number, totalPaise: o.total_paise, paymentMethod: o.payment_method },
      });
      return { queued: true };
    });
    res.status(202).json(out);
  });
  r.get('/exports/orders.csv', need('orders:read'), async (req, res) => {
    mfa(req);
    const q = parse(z.object({ from: z.string().date(), to: z.string().date() }), req.query);
    if (Date.parse(q.to) <= Date.parse(q.from) || Date.parse(q.to) - Date.parse(q.from) > 400 * 86_400_000)
      throw new AppError('VALIDATION_FAILED', 'Choose a range of at most 400 days', {
        fields: { to: 'invalid range' },
      });
    csv(
      res,
      `jimmywax-orders-${q.from}-${q.to}.csv`,
      await tx(req, (c) =>
        exportOrdersCsv(c, ctx(req), { from: `${q.from}T00:00:00Z`, to: `${q.to}T00:00:00Z` }),
      ),
    );
  });

  // --------------------------------------------------------------- analytics
  const A = {
    sales: salesAnalytics,
    products: productAnalytics,
    customers: customerAnalytics,
    shipping: shippingAnalytics,
    returns: returnsAnalytics,
    geo: geoAnalytics,
    gst: gstAnalytics,
  } as const;
  const tableOf = (name: keyof typeof A, d: any): Array<Record<string, unknown>> =>
    ({
      sales: d.series,
      products: d.items,
      customers: d.topCustomers,
      shipping: d.byCourier,
      returns: d.byStatus,
      geo: d.byState,
      gst: d.months,
    })[name] ?? [];
  for (const name of Object.keys(A) as Array<keyof typeof A>) {
    r.get(`/analytics/${name}`, need('analytics:read'), async (req, res) => {
      const q = parse(RangeQuery.extend({ format: z.enum(['json', 'csv']).default('json') }), req.query);
      const d = await tx(req, (c) => (A[name] as (c: any, q: unknown) => Promise<unknown>)(c, q));
      if (q.format === 'csv') return csv(res, `jimmywax-${name}.csv`, analyticsCsv(tableOf(name, d)));
      res.json(d);
    });
  }

  // GSTR-1 working paper (tables 7 and 12) for one IST month; CSV downloads one table in the offline-tool column layout.
  r.get('/analytics/gstr1', need('analytics:read'), async (req, res) => {
    const q = parse(
      z.object({
        month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
        format: z.enum(['json', 'csv']).default('json'),
        table: z.enum(['b2cs', 'hsn']).default('b2cs'),
      }),
      req.query,
    );
    const report = await tx(req, (c) => gstr1Report(c, q.month));
    if (q.format === 'csv')
      return csv(res, `jimmywax-gstr1-${q.table}-${q.month}.csv`, gstr1Csv(report, q.table));
    res.json(report);
  });

  // ------------------------------------------------------------- store status
  r.get('/store-status', need('settings:read'), async (req, res) => {
    res.json(await tx(req, (c) => getStoreStatus(c)));
  });
  // Like the checkout kill switch, pausing is not step-up gated: stopping sales must always be fast.
  r.put(
    '/store-status',
    (req, _res, next) =>
      can(req.admin!.role, 'settings:write') ? next() : next(new AppError('FORBIDDEN', 'Not allowed')),
    async (req, res) => {
      res.json(await tx(req, (c) => setStoreStatus(c, ctx(req), parse(StoreStatusPatch, req.body))));
    },
  );

  // ------------------------------------------------------------- app versions
  r.get('/app-versions', need('settings:read'), async (req, res) => {
    res.json({ items: await tx(req, (c) => listAppVersions(c)) });
  });
  r.put('/app-versions/:platform', need('settings:write'), async (req, res) => {
    const platform = parse(z.enum(['android', 'ios']), req.params.platform);
    res.json(await tx(req, (c) => setAppVersion(c, ctx(req), platform, parse(AppVersionPatch, req.body))));
  });

  // ------------------------------------------------------------ feature flags
  r.get('/flags', need('settings:read'), async (req, res) => {
    res.json({ items: await tx(req, (c) => listFlags(c)) });
  });
  r.put('/flags/:key', need('flags:manage'), async (req, res) => {
    const b = parse(FlagInput.omit({ key: true }), req.body);
    const key = parse(FlagInput.shape.key, req.params.key);
    res.json(await tx(req, (c) => upsertFlag(c, ctx(req), { ...b, key })));
  });
  r.delete('/flags/:key', need('flags:manage'), async (req, res) => {
    await tx(req, (c) => deleteFlag(c, ctx(req), parse(FlagInput.shape.key, req.params.key)));
    res.status(204).end();
  });

  // ------------------------------------------------------------- integrations
  const facts = (): IntegrationFacts => ({
    razorpay: {
      configured: k.deps.gateway?.name === 'razorpay',
      mode:
        config.PAYMENT_PROVIDER === 'razorpay'
          ? String(config.RAZORPAY_KEY_ID).startsWith('rzp_live')
            ? 'live'
            : 'test'
          : 'none',
    },
    sms: { configured: !!k.deps.sms, provider: config.SMS_PROVIDER },
    smtp: { configured: !!config.SMTP_HOST, host: config.SMTP_HOST ? '(set)' : undefined },
    shipping: { configured: !!k.deps.shipping, provider: k.deps.shipping?.name ?? 'manual' },
    storage: { configured: true, driver: config.STORAGE_DRIVER === 's3' ? 's3' : 'local-disk' },
    maps: { configured: !!process.env.OLA_MAPS_API_KEY },
  });
  r.get('/integrations', need('integrations:read'), async (req, res) => {
    res.json({ items: await tx(req, (c) => integrationStatus(c, facts())) });
  });
  r.post('/integrations/:name/test', need('integrations:manage'), async (req, res) => {
    const name = parse(z.enum(['razorpay', 'sms', 'smtp', 'shipping', 'storage', 'maps']), req.params.name);
    let ok = false;
    let detail = '';
    try {
      if (name === 'storage') {
        const key = `probe/${ctx(req).requestId}.txt`;
        await storage.put(key, Buffer.from('ok'));
        const back = await storage.get(key);
        await storage.delete(key);
        ok = back?.toString() === 'ok';
        detail = ok ? 'Wrote, read and deleted a probe object' : 'Probe object did not read back';
      } else if (name === 'shipping') {
        if (!k.deps.shipping) detail = 'No shipping provider configured (manual shipments)';
        else {
          const [wallet, pickups] = await Promise.all([
            k.deps.shipping.walletBalancePaise(),
            k.deps.shipping.listPickupLocations(),
          ]);
          ok = true;
          detail = `${k.deps.shipping.name}: wallet ${wallet === null ? 'n/a' : `₹${(wallet / 100).toFixed(2)}`}, ${pickups.length} pickup location(s)`;
        }
      } else if (name === 'smtp') {
        const sender = k.deps.email;
        if (!sender || !(sender instanceof SmtpEmailSender))
          detail = 'SMTP is not configured; emails are only logged';
        else {
          const me = await tx(
            req,
            async (c) =>
              (await c.query(`SELECT email FROM auth.users WHERE id = $1`, [req.admin!.userId])).rows[0]
                ?.email as string | undefined,
          );
          if (!me) detail = 'Your account has no email to send a test to';
          else {
            await sender.send({ to: me, subject: 'JIMMY WAX test email', text: 'SMTP is working.' });
            ok = true;
            detail = 'Test email sent to your own address';
          }
        }
      } else {
        detail = facts()[name].configured
          ? 'Credentials are present, but no safe live probe exists; verify with a real test transaction'
          : 'Not configured';
      }
    } catch (e) {
      detail = `Failed: ${(e as Error).message}`.slice(0, 300);
    }
    await tx(req, (c) => recordIntegrationCheck(c, ctx(req), name, ok, detail));
    res.json({ name, ok, detail });
  });

  // ------------------------------------------------------------------ health
  r.get('/health', need('ops:read'), async (req, res) => {
    const h = await tx(req, (c) => adminHealth(c));
    res.json({
      ...h,
      provider: k.deps.shipping?.name ?? 'manual',
      paymentProvider: k.deps.gateway?.name ?? 'none',
      alerts: [
        ...(h.outbox.dead ? [`${h.outbox.dead} dead-lettered event(s)`] : []),
        ...(h.email.failed ? [`${h.email.failed} failed email(s)`] : []),
        ...(h.stuckShipmentRequests ? [`${h.stuckShipmentRequests} stuck shipment request(s)`] : []),
        ...(h.lowStockVariants ? [`${h.lowStockVariants} low-stock variant(s)`] : []),
      ],
    });
  });
}
