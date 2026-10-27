import { randomUUID, timingSafeEqual } from 'node:crypto';
import express, { type NextFunction, type Request, type Response } from 'express';
import helmet from 'helmet';
import { z, ZodError } from 'zod';
import type { AppConfig } from '@jw/config';
import {
  AddressInput,
  AppError,
  CancelOrderRequest,
  CartLineMutation,
  CartMergeRequest,
  CreateOrderRequest,
  CreatePaymentAttemptRequest,
  ConfirmPaymentRequest,
  ApplyCouponRequest,
  CreateQuoteRequest,
  PageQuery,
  decodeCursor,
  encodeCursor,
  trackRoutes,
  type ErrorBody,
  type ErrorCode,
} from '@jw/contracts';
import { PG, pgCode, type Db } from '@jw/database';
import type {
  EmailSender,
  ObjectStorage,
  PaymentGateway,
  ShippingProvider,
  SmsSender,
} from '@jw/integrations';
import { WebhookVerificationError } from '@jw/integrations';
import { recordEmailEvents } from '@jw/commerce-domain';
import {
  cancelOrder,
  createGuestCart,
  exp,
  createPaymentAttempt,
  confirmPaymentAttempt,
  confirmCheckoutReturn,
  signHostedToken,
  verifyHostedToken,
  loadHostedCheckout,
  orderIdForProviderOrder,
  createQuote,
  getCart,
  ingestShippingWebhook,
  ingestWebhook,
  processShippingEvent,
  loadOrder,
  maskPhoneE164,
  mergeGuestCart,
  placeOrder,
  processPaymentEvent,
  setLine,
  setCartCoupon,
  clearCartCoupon,
  type Flags,
} from '@jw/commerce-domain';
import type { Logger } from '@jw/observability';
import { httpDuration, registry } from '@jw/observability';
import { MemoryStore, limiter, type LimitStore } from './rateLimit.ts';
import type { Principal, TokenService } from './auth.ts';
import { authRouter, type LimitBy } from './authRoutes.ts';
import { serviceRouter } from './serviceRoutes.ts';
import { adminRouter } from './adminRoutes.ts';

export interface Deps {
  config: AppConfig;
  db: Db;
  tokens: TokenService;
  storage: ObjectStorage;
  /** null = no SMS provider configured (only the demo number can sign in by phone). */
  sms?: SmsSender | null;
  gateway: PaymentGateway | null;
  /** null = manual shipments only. */
  shipping?: ShippingProvider | null;
  /** Used for template test-sends and the SMTP probe; the worker owns real delivery. */
  email?: EmailSender | null;
  logger: Logger;
  limits?: LimitStore;
  /** Allows tests to disable per-IP limits for load generation. */
  rateLimitsEnabled?: boolean;
}

declare module 'express-serve-static-core' {
  interface Request {
    id: string;
    principal?: Principal;
  }
}

const uuidParam = z.string().uuid();
const variantParam = z
  .string()
  .regex(/^[a-z0-9-]+$/)
  .max(100);

function parse<T>(schema: z.ZodType<T>, data: unknown): T {
  const r = schema.safeParse(data);
  if (!r.success) {
    const fields: Record<string, string> = {};
    for (const i of r.error.issues) fields[i.path.join('.') || '_'] = i.message;
    throw new AppError('VALIDATION_FAILED', 'Some fields are invalid', { fields });
  }
  return r.data;
}

export function createApp(deps: Deps) {
  const { config, db, logger } = deps;
  const flags: Flags = {
    checkout: config.FEATURE_CHECKOUT,
    cod: config.FEATURE_COD,
    onlinePayments: config.FEATURE_ONLINE_PAYMENTS,
  };
  const store = deps.limits ?? new MemoryStore();
  const rl = deps.rateLimitsEnabled ?? true;
  const lim = (name: string, windowMs: number, max: number, byUser = false): express.RequestHandler =>
    rl
      ? limiter(store, {
          name,
          windowMs,
          max,
          key: byUser ? (r) => r.principal?.userId ?? r.ip ?? 'x' : undefined,
        })
      : (_q, _s, n) => n();

  const limitBy: LimitBy = (name, windowMs, max, key) =>
    rl ? limiter(store, { name, windowMs, max, key }) : (_q, _s, n) => n();

  const routeTable: string[] = [];
  const app = express();
  app.locals.routeTable = routeTable;
  app.disable('x-powered-by');
  app.set('trust proxy', config.TRUST_PROXY_HOPS);
  app.use(helmet({ contentSecurityPolicy: false })); // JSON API: no HTML served

  // request id + timing + structured access log (no bodies, no auth headers)
  app.use((req, res, next) => {
    const incoming = req.header('x-request-id');
    req.id = incoming && /^[A-Za-z0-9._-]{8,64}$/.test(incoming) ? incoming : randomUUID();
    res.setHeader('X-Request-Id', req.id);
    const start = process.hrtime.bigint();
    res.on('finish', () => {
      const route = req.route?.path ? `${req.baseUrl}${req.route.path}` : 'unmatched';
      httpDuration.observe(
        { method: req.method, route, status: String(res.statusCode) },
        Number(process.hrtime.bigint() - start) / 1e9,
      );
      logger.info({ requestId: req.id, method: req.method, route, status: res.statusCode }, 'request');
    });
    next();
  });

  const origins = new Set(
    config.CORS_ORIGINS.split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
  app.use((req, res, next) => {
    const o = req.header('origin');
    if (o && origins.has(o)) {
      res.setHeader('Access-Control-Allow-Origin', o);
      res.setHeader('Vary', 'Origin');
      res.setHeader(
        'Access-Control-Allow-Headers',
        'authorization,content-type,idempotency-key,x-guest-cart-token,x-request-id,x-jw-client,if-none-match,range',
      );
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    }
    if (req.method === 'OPTIONS') return void res.status(204).end();
    next();
  });

  // ---- health (not under /v1, never authenticated, never touches business tables)
  app.get('/healthz', (_q, res) => void res.json({ status: 'ok' }));
  app.get('/readyz', async (_q, res) => {
    try {
      await db.pool.query('SELECT 1');
      res.json({ status: 'ready' });
    } catch {
      res.status(503).json({ status: 'not_ready' });
    }
  });
  // Prometheus scrape. Never public: with METRICS_TOKEN it needs `Authorization: Bearer <token>`; in production without a token it does not exist.
  app.get('/metrics', async (req, res) => {
    const token = config.METRICS_TOKEN;
    if (!token && config.NODE_ENV === 'production')
      return void res
        .status(404)
        .json({ error: { code: 'NOT_FOUND', message: 'Not found', requestId: req.id, retryable: false } });
    if (token) {
      const given = Buffer.from((req.header('authorization') ?? '').replace(/^Bearer\s+/i, ''));
      const want = Buffer.from(token);
      if (given.length !== want.length || !timingSafeEqual(given, want))
        return void res.status(401).json({
          error: {
            code: 'UNAUTHENTICATED',
            message: 'Metrics token required',
            requestId: req.id,
            retryable: false,
          },
        });
    }
    res.setHeader('Content-Type', registry.contentType);
    res.setHeader('Cache-Control', 'no-store');
    res.end(await registry.metrics());
  });

  // ---- webhooks: RAW body (signature is over the exact bytes), before any JSON parser
  routeTable.push('POST /v1/webhooks/{provider}');
  app.post(
    '/v1/webhooks/:provider',
    lim('webhook', 60_000, 600),
    express.raw({ type: () => true, limit: '256kb' }),
    async (req, res) => {
      // Shipping provider webhooks share the endpoint: same raw-body rule, different verification.
      if (deps.shipping && deps.shipping.name === req.params.provider) {
        let intake;
        try {
          intake = await ingestShippingWebhook(db, deps.shipping, req.body as Buffer, req.headers);
        } catch (e) {
          if (e instanceof WebhookVerificationError)
            throw new AppError('UNAUTHENTICATED', 'Invalid webhook credentials');
          throw e;
        }
        res.status(200).json({ received: true, duplicate: intake.duplicate });
        if (intake.eventId !== null)
          processShippingEvent(db, intake.eventId).catch((err) =>
            logger.error(
              { err: String(err), eventId: intake.eventId },
              'shipping event apply failed; sweep will retry',
            ),
          );
        return;
      }
      // Email provider bounce / complaint callbacks (shared-secret bearer token, JSON { events: [{ type, email, detail? }] }).
      if (req.params.provider === 'email') {
        const token = config.EMAIL_WEBHOOK_TOKEN;
        if (!token) throw new AppError('NOT_FOUND', 'Unknown provider');
        const given = Buffer.from((req.header('authorization') ?? '').replace(/^Bearer\s+/i, ''));
        const want = Buffer.from(token);
        if (given.length !== want.length || !timingSafeEqual(given, want))
          throw new AppError('UNAUTHENTICATED', 'Invalid webhook credentials');
        let parsed: unknown;
        try {
          parsed = JSON.parse((req.body as Buffer).toString('utf8'));
        } catch {
          throw new AppError('VALIDATION_FAILED', 'Body must be JSON', { fields: { body: 'invalid JSON' } });
        }
        const events = parse(
          z.object({
            events: z
              .array(
                z.object({
                  type: z.string().max(40),
                  email: z.string().max(320),
                  detail: z.string().max(300).optional(),
                }),
              )
              .max(500),
          }),
          parsed,
        ).events;
        const suppressed = await db.tx({ kind: 'system', reason: 'email-webhook' }, (c) =>
          recordEmailEvents(c, events),
        );
        return void res.status(200).json({ received: true, suppressed });
      }
      const gw = deps.gateway;
      if (!gw || gw.name !== req.params.provider) throw new AppError('NOT_FOUND', 'Unknown provider');
      let intake;
      try {
        intake = await ingestWebhook(db, gw, req.body as Buffer, req.headers);
      } catch (e) {
        if (e instanceof WebhookVerificationError) throw new AppError('UNAUTHENTICATED', 'Invalid signature');
        throw e;
      }
      // Durable intake done → safe to acknowledge. Apply now (best effort); the worker sweep guarantees it.
      res.status(200).json({ received: true, duplicate: intake.duplicate });
      if (intake.eventId !== null) {
        processPaymentEvent(db, intake.eventId).catch((err) =>
          logger.error(
            { err: String(err), eventId: intake.eventId },
            'webhook apply failed; sweep will retry',
          ),
        );
      }
    },
  );

  // ---- hosted (redirect) checkout. The provider POSTs the browser back as a form (no session, no JSON);
  // we verify the signature + provider status ourselves, then send the customer to the website (303) or, for the
  // app (`?c=app`), to its deep link / a "return to the app" page. Destinations come only from configuration.
  const hostedSecret = () =>
    config.RAZORPAY_KEY_SECRET ??
    config.RAZORPAY_WEBHOOK_SECRET ??
    (config.NODE_ENV === 'production' ? '' : 'dev-hosted-link');
  const apiOrigin = (req: Request) =>
    (config.PUBLIC_API_ORIGIN ?? `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
  const esc = (v: string) =>
    v.replace(
      /[&<>"']/g,
      (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!,
    );

  // Signed hand-off page for the mobile app: auto-submits the form to the provider's hosted page.
  routeTable.push('GET /v1/payments/{provider}/start');
  app.get('/v1/payments/:provider/start', lim('webhook', 60_000, 60), async (req, res) => {
    const gw = deps.gateway;
    const secret = hostedSecret();
    if (!gw || gw.name !== req.params.provider || !secret) throw new AppError('NOT_FOUND', 'Route not found');
    const orderId = verifyHostedToken(secret, String(req.query.t ?? ''));
    const data = orderId ? await loadHostedCheckout(db, gw, orderId) : null;
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (!data) {
      res
        .status(410)
        .type('html')
        .send(
          '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Payment link expired</title><body style="font-family:sans-serif;padding:24px"><h2>This payment link has expired</h2><p>Go back to the app and tap Pay again.</p>',
        );
      return;
    }
    const nonce = randomUUID().replace(/-/g, '');
    res.setHeader(
      'Content-Security-Policy',
      `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; form-action https://api.razorpay.com; base-uri 'none'`,
    );
    const fields: Record<string, string> = {
      key_id: data.keyId,
      order_id: data.providerOrderId,
      name: data.brandName,
      description: `Order ${data.orderNumber}`,
      callback_url: `${apiOrigin(req)}/v1/payments/${gw.name}/return?c=app`,
    };
    if (data.name) fields['prefill[name]'] = data.name;
    if (data.contact) fields['prefill[contact]'] = data.contact;
    if (data.email) fields['prefill[email]'] = data.email;
    const inputs = Object.entries(fields)
      .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`)
      .join('');
    res
      .status(200)
      .type('html')
      .send(
        `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Redirecting to payment</title><body style="font-family:sans-serif;padding:24px"><p>Taking you to the secure payment page&hellip;</p><form id="f" method="POST" action="https://api.razorpay.com/v1/checkout/embedded">${inputs}<noscript><button type="submit">Continue to payment</button></noscript></form><script nonce="${nonce}">document.getElementById('f').submit()</script>`,
      );
  });

  routeTable.push('POST /v1/payments/{provider}/return');
  app.post(
    '/v1/payments/:provider/return',
    lim('webhook', 60_000, 120),
    express.urlencoded({ extended: false, limit: '16kb' }),
    async (req, res) => {
      const gw = deps.gateway;
      const origin = (
        config.STOREFRONT_ORIGIN ?? (config.NODE_ENV === 'production' ? '' : 'http://localhost:5174')
      ).replace(/\/$/, '');
      if (!gw || gw.name !== req.params.provider || !origin)
        throw new AppError('NOT_FOUND', 'Route not found');
      const fromApp = req.query.c === 'app';
      const body = (req.body ?? {}) as Record<string, unknown>;
      const field = (k: string) => (typeof body[k] === 'string' ? (body[k] as string).slice(0, 300) : '');
      const back = (orderId: string | null, state: 'paid' | 'pending' | 'failed') => {
        if (fromApp) {
          if (config.APP_RETURN_URL) {
            const q = `${orderId ? `order=${orderId}&` : ''}pay=${state}`;
            return res.redirect(303, `${config.APP_RETURN_URL}?${q}`);
          }
          const msg =
            state === 'paid'
              ? 'Payment received. You can close this tab and return to the app.'
              : state === 'pending'
                ? 'We are confirming your payment. Return to the app; it will update shortly.'
                : 'The payment was not completed. Return to the app to try again.';
          res.setHeader('Cache-Control', 'no-store');
          return res
            .status(200)
            .type('html')
            .send(
              `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Payment</title><body style="font-family:sans-serif;padding:24px"><h2>${esc(msg)}</h2>`,
            );
        }
        return res.redirect(
          303,
          `${origin}/orders${orderId ? `/${orderId}` : ''}?pay=${state}${state === 'paid' ? '&placed=1' : ''}`,
        );
      };
      const providerOrderId = field('razorpay_order_id');
      const providerPaymentId = field('razorpay_payment_id');
      const signature = field('razorpay_signature');
      if (providerOrderId && providerPaymentId && signature) {
        try {
          const r = await confirmCheckoutReturn(db, gw, { providerOrderId, providerPaymentId, signature });
          return back(r?.orderId ?? null, r?.paymentStatus === 'paid' ? 'paid' : 'pending');
        } catch (e) {
          logger.warn({ err: String(e) }, 'payment return rejected');
          return back(null, 'failed');
        }
      }
      // Cancelled or failed at the provider: the error metadata names the provider order; we resolve our own order from it.
      let failedOrder: string | null = null;
      try {
        const meta = JSON.parse(field('error[metadata]') || '{}') as { order_id?: string };
        if (typeof meta.order_id === 'string')
          failedOrder = await orderIdForProviderOrder(db, gw.name, meta.order_id);
      } catch {
        /* unparseable metadata: land on the order list */
      }
      return back(failedOrder, 'failed');
    },
  );

  // Studio documents are larger than ordinary API bodies (a page document may be up to ~250 KB).
  app.use('/v1/admin/experience', express.json({ limit: '512kb' }));
  app.use('/v1/admin/content-library', express.json({ limit: '256kb' }));
  app.use(express.json({ limit: '32kb' }));

  // ---- authentication
  const requireAuth: express.RequestHandler = async (req, _res, next) => {
    const h = req.header('authorization');
    if (!h?.startsWith('Bearer ')) throw new AppError('UNAUTHENTICATED', 'Sign in to continue');
    req.principal = await deps.tokens.verify(h.slice(7));
    next();
  };
  const actor = (req: Request) => ({ kind: 'customer' as const, userId: req.principal!.userId });
  const uid = (req: Request) => req.principal!.userId;
  const guestToken = (req: Request) => {
    const t = req.header('x-guest-cart-token');
    if (!t || t.length < 20 || t.length > 200)
      throw new AppError('UNAUTHENTICATED', 'Guest cart token required');
    return t;
  };

  const v1 = trackRoutes(express.Router(), '/v1', routeTable);
  app.use('/v1', v1);

  // ---- guest cart (anonymous). Token is an unguessable bearer secret, stored hashed.
  v1.post('/guest-carts', lim('guest-create', 60_000, 20), async (_req, res) => {
    const out = await db.tx({ kind: 'anonymous' }, (c) => createGuestCart(c));
    res.status(201).json({ guestCartToken: out.token, cart: out.cart });
  });
  v1.get('/guest-cart', lim('guest', 60_000, 120), async (req, res) => {
    const t = guestToken(req);
    res.json(await db.tx({ kind: 'anonymous' }, (c) => getCart(c, { guestToken: t })));
  });
  v1.put('/guest-cart/lines/:variantId', lim('guest', 60_000, 120), async (req, res) => {
    const t = guestToken(req);
    const body = parse(CartLineMutation, req.body);
    const variantId = parse(variantParam, req.params.variantId);
    res.json(
      await db.tx({ kind: 'anonymous' }, (c) =>
        setLine(c, { guestToken: t }, variantId, body.quantity, body.expectedVersion),
      ),
    );
  });

  // ---- own identity API (public + a few bearer routes)
  v1.use('/auth', authRouter(deps, limitBy, requireAuth, routeTable));

  // Draft/release preview for the Studio (no login: a short-lived, channel-scoped, revocable token is the credential).
  // Always no-store and noindex; it can only ever read the experience documents the token's channel owns.
  v1.get(
    '/experience/:channel/preview',
    limitBy('preview', 60_000, 60, (q) => `ip:${q.ip ?? 'x'}`),
    async (req, res) => {
      const channel = parse(z.enum(['app', 'web']), req.params.channel);
      const token = String(req.query.token ?? req.header('x-preview-token') ?? '');
      if (token.length < 20 || token.length > 100)
        throw new AppError('UNAUTHENTICATED', 'Preview link is invalid or has expired');
      const client = exp.parseClientHeader(req.header('x-jw-client'), channel);
      const out = await db.tx({ kind: 'system', reason: 'experience-preview' }, async (c) => {
        const t = await exp.resolvePreviewToken(c, channel, token);
        if (!t) throw new AppError('UNAUTHENTICATED', 'Preview link is invalid or has expired');
        let source: exp.BundleSource;
        if (t.releaseId) {
          const r = await exp.releaseSnapshot(c, t.releaseId);
          if (!r) throw new AppError('NOT_FOUND', 'Release not found');
          source = {
            enabled: true,
            release: {
              id: r.row.id,
              number: r.row.number,
              label: r.row.label,
              publishedAt: r.row.activatedAt ?? r.row.scheduledAt,
            },
            snapshot: r.snapshot,
          };
        } else {
          source = {
            enabled: true,
            release: { id: 'draft', number: 0, label: 'Draft preview', publishedAt: null },
            snapshot: await exp.buildSnapshot(c, channel),
          };
        }
        return exp.assembleBundle(c, channel, source, client);
      });
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Robots-Tag', 'noindex');
      res.json({ ...out.bundle, preview: true });
    },
  );

  // ---- everything below needs a verified user
  v1.use(requireAuth);
  v1.use(serviceRouter(deps, lim, routeTable));

  v1.use('/admin', adminRouter(deps, lim, routeTable));

  // profile
  v1.get('/me', lim('acct', 60_000, 120, true), async (req, res) => {
    const out = await db.tx(actor(req), async (c) => {
      const p = await c.query(`SELECT id, full_name, phone FROM profiles WHERE id = $1`, [uid(req)]);
      const pref = await c.query(
        `SELECT order_updates, offers_and_care_tips FROM notification_preferences WHERE user_id = $1`,
        [uid(req)],
      );
      const acct = await c.query(
        `SELECT email, phone, email_verified_at, is_demo FROM auth.users WHERE id = $1`,
        [uid(req)],
      );
      return { p: p.rows[0], pref: pref.rows[0], acct: acct.rows[0] };
    });
    res.json({
      id: uid(req),
      fullName: out.p?.full_name ?? '',
      email: out.acct?.email ?? null,
      // the sign-in number is returned masked; the profile phone is the one the customer typed themselves
      accountPhone: out.acct?.phone ? maskPhoneE164(out.acct.phone) : null,
      emailVerified: !!out.acct?.email_verified_at,
      demo: !!out.acct?.is_demo,
      phone: out.p?.phone ?? null,
      preferences: {
        orderUpdates: out.pref?.order_updates ?? true,
        offersAndCareTips: out.pref?.offers_and_care_tips ?? false,
      },
    });
  });
  v1.patch('/me', lim('acct', 60_000, 60, true), async (req, res) => {
    const body = parse(
      z.object({
        fullName: z.string().trim().max(120).optional(),
        phone: z
          .string()
          .regex(/^[0-9+() -]{7,20}$/)
          .nullable()
          .optional(),
      }),
      req.body,
    );
    await db.tx(actor(req), (c) =>
      c.query(
        `INSERT INTO profiles (id, full_name, phone) VALUES ($1, coalesce($2,''), $3)
         ON CONFLICT (id) DO UPDATE SET full_name = coalesce($2, profiles.full_name), phone = CASE WHEN $4 THEN $3 ELSE profiles.phone END, updated_at = now()`,
        [uid(req), body.fullName ?? null, body.phone ?? null, body.phone !== undefined],
      ),
    );
    res.status(204).end();
  });
  v1.put('/me/preferences', lim('acct', 60_000, 60, true), async (req, res) => {
    const b = parse(z.object({ orderUpdates: z.boolean(), offersAndCareTips: z.boolean() }), req.body);
    await db.tx(actor(req), (c) =>
      c.query(
        `INSERT INTO notification_preferences (user_id, order_updates, offers_and_care_tips) VALUES ($1,$2,$3)
         ON CONFLICT (user_id) DO UPDATE SET order_updates = $2, offers_and_care_tips = $3, updated_at = now()`,
        [uid(req), b.orderUpdates, b.offersAndCareTips],
      ),
    );
    res.status(204).end();
  });

  // addresses
  const addrDto = (r: Record<string, unknown>) => ({
    id: r.id,
    recipientName: r.recipient_name,
    phone: r.phone,
    line1: r.line1,
    landmark: r.landmark,
    city: r.city,
    state: r.state,
    postalCode: r.postal_code,
    isDefault: r.is_default,
  });
  v1.get('/addresses', lim('acct', 60_000, 120, true), async (req, res) => {
    const r = await db.tx(actor(req), (c) =>
      c.query(
        `SELECT * FROM addresses WHERE user_id = $1 ORDER BY is_default DESC, created_at, id LIMIT 50`,
        [uid(req)],
      ),
    );
    res.json({ items: r.rows.map(addrDto) });
  });
  v1.post('/addresses', lim('acct', 60_000, 30, true), async (req, res) => {
    const a = parse(AddressInput, req.body);
    const row = await db.tx(actor(req), async (c) => {
      const count = await c.query(`SELECT count(*)::int n FROM addresses WHERE user_id = $1`, [uid(req)]);
      if (count.rows[0].n >= 20) throw new AppError('VALIDATION_FAILED', 'Address limit reached');
      if (a.isDefault)
        await c.query(`UPDATE addresses SET is_default = false WHERE user_id = $1 AND is_default`, [
          uid(req),
        ]);
      return (
        await c.query(
          `INSERT INTO addresses (user_id, recipient_name, phone, line1, landmark, city, state, postal_code, is_default)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
          [
            uid(req),
            a.recipientName,
            a.phone,
            a.line1,
            a.landmark,
            a.city,
            a.state,
            a.postalCode,
            a.isDefault,
          ],
        )
      ).rows[0];
    });
    res.status(201).json(addrDto(row));
  });
  v1.put('/addresses/:id', lim('acct', 60_000, 30, true), async (req, res) => {
    const id = parse(uuidParam, req.params.id);
    const a = parse(AddressInput, req.body);
    const row = await db.tx(actor(req), async (c) => {
      if (a.isDefault)
        await c.query(
          `UPDATE addresses SET is_default = false WHERE user_id = $1 AND is_default AND id <> $2`,
          [uid(req), id],
        );
      return (
        await c.query(
          `UPDATE addresses SET recipient_name=$3, phone=$4, line1=$5, landmark=$6, city=$7, state=$8, postal_code=$9, is_default=$10, updated_at=now()
          WHERE id = $1 AND user_id = $2 RETURNING *`,
          [
            id,
            uid(req),
            a.recipientName,
            a.phone,
            a.line1,
            a.landmark,
            a.city,
            a.state,
            a.postalCode,
            a.isDefault,
          ],
        )
      ).rows[0];
    });
    if (!row) throw new AppError('NOT_FOUND', 'Address not found');
    res.json(addrDto(row));
  });
  v1.delete('/addresses/:id', lim('acct', 60_000, 30, true), async (req, res) => {
    const id = parse(uuidParam, req.params.id);
    const r = await db.tx(actor(req), (c) =>
      c.query(`DELETE FROM addresses WHERE id = $1 AND user_id = $2`, [id, uid(req)]),
    );
    if (r.rowCount === 0) throw new AppError('NOT_FOUND', 'Address not found');
    res.status(204).end();
  });

  // cart
  v1.get('/cart', lim('cart', 60_000, 120, true), async (req, res) => {
    res.json(await db.tx(actor(req), (c) => getCart(c, { userId: uid(req) })));
  });
  v1.put('/cart/lines/:variantId', lim('cart', 60_000, 120, true), async (req, res) => {
    const body = parse(CartLineMutation, req.body);
    const variantId = parse(variantParam, req.params.variantId);
    res.json(
      await db.tx(actor(req), (c) =>
        setLine(c, { userId: uid(req) }, variantId, body.quantity, body.expectedVersion),
      ),
    );
  });
  v1.post('/cart/coupon', lim('cart', 60_000, 60, true), async (req, res) => {
    const b = parse(ApplyCouponRequest, req.body);
    res.json(await db.tx(actor(req), (c) => setCartCoupon(c, uid(req), b.code)));
  });
  v1.delete('/cart/coupon', lim('cart', 60_000, 60, true), async (req, res) => {
    await db.tx(actor(req), (c) => clearCartCoupon(c, uid(req)));
    res.status(204).end();
  });
  v1.post('/cart/merge', lim('cart-merge', 60_000, 10, true), async (req, res) => {
    const b = parse(CartMergeRequest, req.body);
    res.json(await db.tx(actor(req), (c) => mergeGuestCart(c, uid(req), b.guestCartToken)));
  });

  // wishlist (idempotent add/remove by product id)
  v1.get('/wishlist', lim('acct', 60_000, 120, true), async (req, res) => {
    const q = parse(PageQuery, req.query);
    const cur = decodeCursor(q.cursor, z.object({ t: z.string(), p: z.string() }));
    const r = await db.tx(actor(req), (c) =>
      c.query(
        `SELECT product_id, created_at FROM wishlist_items WHERE user_id = $1
           AND ($2::timestamptz IS NULL OR (created_at, product_id) < ($2::timestamptz, $3))
         ORDER BY created_at DESC, product_id DESC LIMIT $4`,
        [uid(req), cur?.t ?? null, cur?.p ?? null, q.limit + 1],
      ),
    );
    const page = r.rows.slice(0, q.limit);
    const last = page[page.length - 1];
    res.json({
      items: page.map((x) => ({ productId: x.product_id, addedAt: new Date(x.created_at).toISOString() })),
      nextCursor:
        r.rows.length > q.limit && last
          ? encodeCursor({ t: new Date(last.created_at).toISOString(), p: last.product_id })
          : null,
    });
  });
  v1.put('/wishlist/:productId', lim('acct', 60_000, 120, true), async (req, res) => {
    const pid = parse(variantParam, req.params.productId);
    const r = await db.tx(actor(req), (c) =>
      c.query(
        `INSERT INTO wishlist_items (user_id, product_id) SELECT $1, id FROM products WHERE id = $2 AND active ON CONFLICT DO NOTHING RETURNING 1`,
        [uid(req), pid],
      ),
    );
    if (r.rowCount === 0) {
      const exists = await db.tx(actor(req), (c) =>
        c.query(`SELECT 1 FROM wishlist_items WHERE user_id = $1 AND product_id = $2`, [uid(req), pid]),
      );
      if (exists.rowCount === 0) throw new AppError('NOT_FOUND', 'Product not found');
    }
    res.status(204).end();
  });
  v1.delete('/wishlist/:productId', lim('acct', 60_000, 120, true), async (req, res) => {
    const pid = parse(variantParam, req.params.productId);
    await db.tx(actor(req), (c) =>
      c.query(`DELETE FROM wishlist_items WHERE user_id = $1 AND product_id = $2`, [uid(req), pid]),
    );
    res.status(204).end();
  });

  // checkout
  v1.post('/checkout/quotes', lim('checkout', 60_000, 30, true), async (req, res) => {
    const b = parse(CreateQuoteRequest, req.body);
    const q = await db.tx(actor(req), (c) => createQuote(c, uid(req), b, { flags }));
    res.status(201).json(q);
  });
  v1.post('/orders', lim('checkout', 60_000, 20, true), async (req, res) => {
    const key = req.header('idempotency-key');
    if (!key || !/^[A-Za-z0-9._:-]{8,100}$/.test(key))
      throw new AppError('VALIDATION_FAILED', 'Idempotency-Key header (8-100 chars) is required', {
        fields: { 'Idempotency-Key': 'required' },
      });
    const b = parse(CreateOrderRequest, req.body);
    const out = await db.tx(actor(req), (c) =>
      placeOrder(c, uid(req), { quoteId: b.quoteId, idempotencyKey: key }, { flags }),
    );
    if (out.replayed) res.setHeader('Idempotent-Replayed', 'true');
    res.status(out.status).json(out.body);
  });
  v1.get('/orders', lim('acct', 60_000, 120, true), async (req, res) => {
    const q = parse(PageQuery, req.query);
    const cur = decodeCursor(q.cursor, z.object({ t: z.string(), i: z.string().uuid() }));
    const r = await db.tx(actor(req), (c) =>
      c.query(
        `SELECT id, order_number, status, payment_status, payment_method, total_paise, created_at FROM orders
          WHERE user_id = $1 AND ($2::timestamptz IS NULL OR (created_at, id) < ($2::timestamptz, $3::uuid))
          ORDER BY created_at DESC, id DESC LIMIT $4`,
        [uid(req), cur?.t ?? null, cur?.i ?? null, q.limit + 1],
      ),
    );
    const page = r.rows.slice(0, q.limit);
    const last = page[page.length - 1];
    res.json({
      items: page.map((o) => ({
        id: o.id,
        orderNumber: o.order_number,
        status: o.status,
        paymentStatus: o.payment_status,
        paymentMethod: o.payment_method,
        totalPaise: o.total_paise,
        currency: 'INR',
        createdAt: new Date(o.created_at).toISOString(),
      })),
      nextCursor:
        r.rows.length > q.limit && last
          ? encodeCursor({ t: new Date(last.created_at).toISOString(), i: last.id })
          : null,
    });
  });
  v1.get('/orders/:id', lim('acct', 60_000, 120, true), async (req, res) => {
    const id = parse(uuidParam, req.params.id);
    res.json(await db.tx(actor(req), (c) => loadOrder(c, id, uid(req))));
  });
  v1.post('/orders/:id/cancel', lim('checkout', 60_000, 20, true), async (req, res) => {
    const id = parse(uuidParam, req.params.id);
    const b = parse(CancelOrderRequest, req.body);
    res.json(await db.tx(actor(req), (c) => cancelOrder(c, uid(req), id, b.reason)));
  });
  v1.post('/orders/:id/payment-attempts', lim('checkout', 60_000, 20, true), async (req, res) => {
    if (!deps.gateway || !flags.onlinePayments)
      throw new AppError('UNSUPPORTED_PAYMENT_METHOD', 'Online payment is not available');
    const id = parse(uuidParam, req.params.id);
    parse(CreatePaymentAttemptRequest, req.body ?? {});
    const key = req.header('idempotency-key') ?? randomUUID();
    res.status(201).json(await createPaymentAttempt(db, deps.gateway, uid(req), id, key));
  });
  v1.post('/orders/:id/payment-attempts/confirm', lim('checkout', 60_000, 30, true), async (req, res) => {
    if (!deps.gateway || !flags.onlinePayments)
      throw new AppError('UNSUPPORTED_PAYMENT_METHOD', 'Online payment is not available');
    const id = parse(uuidParam, req.params.id);
    const b = parse(ConfirmPaymentRequest, req.body);
    res.json(await confirmPaymentAttempt(db, deps.gateway, uid(req), id, b));
  });
  v1.post('/orders/:id/payment-link', lim('checkout', 60_000, 20, true), async (req, res) => {
    if (!deps.gateway || !flags.onlinePayments)
      throw new AppError('UNSUPPORTED_PAYMENT_METHOD', 'Online payment is not available');
    const secret = hostedSecret();
    if (!secret) throw new AppError('UNSUPPORTED_PAYMENT_METHOD', 'Online payment is not available');
    const id = parse(uuidParam, req.params.id);
    const key = req.header('idempotency-key') ?? randomUUID();
    const attempt = await createPaymentAttempt(db, deps.gateway, uid(req), id, key);
    const expiresAtSec = Math.floor(Date.now() / 1000) + 600;
    const token = signHostedToken(secret, id, expiresAtSec);
    res.status(201).json({
      url: `${apiOrigin(req)}/v1/payments/${deps.gateway.name}/start?t=${token}`,
      expiresAt: new Date(expiresAtSec * 1000).toISOString(),
      attempt,
    });
  });
  v1.get('/orders/:id/payment', lim('acct', 60_000, 120, true), async (req, res) => {
    const id = parse(uuidParam, req.params.id);
    const r = await db.tx(actor(req), async (c) => {
      const o = await c.query(
        `SELECT id, status, payment_status FROM orders WHERE id = $1 AND user_id = $2`,
        [id, uid(req)],
      );
      if (o.rowCount === 0) throw new AppError('NOT_FOUND', 'Order not found');
      const a = await c.query(
        `SELECT id, status, amount_paise, created_at FROM payment_attempts WHERE order_id = $1 ORDER BY created_at DESC LIMIT 10`,
        [id],
      );
      return { order: o.rows[0], attempts: a.rows };
    });
    // Server-confirmed state only: clients must never infer "paid" from an SDK callback.
    res.json({
      orderId: id,
      orderStatus: r.order.status,
      paymentStatus: r.order.payment_status,
      attempts: r.attempts.map((a) => ({
        id: a.id,
        status: a.status,
        amountPaise: a.amount_paise,
        createdAt: new Date(a.created_at).toISOString(),
      })),
    });
  });

  // ---- 404 + error mapping
  app.use((_req, _res, next) => next(new AppError('NOT_FOUND', 'Route not found')));
  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    let e: AppError;
    if (err instanceof AppError) e = err;
    else if (err instanceof ZodError) e = new AppError('VALIDATION_FAILED', 'Invalid request');
    else if ((err as { type?: string }).type === 'entity.too.large')
      e = new AppError('PAYLOAD_TOO_LARGE', 'Request body too large');
    else if ((err as { type?: string }).type === 'entity.parse.failed')
      e = new AppError('VALIDATION_FAILED', 'Malformed JSON');
    else if (pgCode(err) === PG.lockNotAvailable || (err as { code?: string }).code === '57014')
      e = new AppError('UNAVAILABLE', 'The system is busy; retry shortly');
    else if (pgCode(err) === PG.deadlock || pgCode(err) === PG.serialization)
      e = new AppError('UNAVAILABLE', 'Conflicting update; retry');
    else {
      logger.error(
        {
          requestId: req.id,
          err:
            err instanceof Error
              ? {
                  name: err.name,
                  message: err.message,
                  stack: err.stack,
                  pg: {
                    code: pgCode(err),
                    table: (err as { table?: string }).table,
                    constraint: (err as { constraint?: string }).constraint,
                    routine: (err as { routine?: string }).routine,
                    where: (err as { where?: string }).where,
                  },
                }
              : String(err),
        },
        'unhandled error',
      );
      e = new AppError('INTERNAL', 'Something went wrong');
    }
    const body: ErrorBody = {
      error: {
        code: e.code as ErrorCode,
        message: e.message,
        requestId: req.id,
        retryable: e.retryable,
        ...(e.details?.fields ? { fields: e.details.fields } : {}),
        ...(e.details?.lines ? { lines: e.details.lines } : {}),
        ...(e.details?.reason ? { reason: e.details.reason } : {}),
        ...(e.details?.paused ? { paused: true } : {}),
      },
    };
    if (e.status === 429 || e.status === 503) res.setHeader('Retry-After', '2');
    res.status(e.status).json(body);
  });

  return app;
}
