import express, { type Request, type RequestHandler } from 'express';
import { z } from 'zod';
import { AppError, PageQuery, decodeCursor, encodeCursor, trackRoutes } from '@jw/contracts';
import {
  attachReviewMedia,
  createReview,
  invoiceHtml,
  issueInvoice,
  requestReturn,
  shipmentsForOrder,
} from '@jw/commerce-domain';
import { ImageRejected, sanitizeImage } from '@jw/integrations';
import type { Deps } from './app.ts';

type Lim = (name: string, windowMs: number, max: number, byUser?: boolean) => RequestHandler;

const uuid = z.string().uuid();
const slug = z
  .string()
  .regex(/^[a-z0-9-]+$/)
  .max(100);
function parse<T>(schema: z.ZodType<T>, v: unknown): T {
  const r = schema.safeParse(v);
  if (!r.success) {
    throw new AppError('VALIDATION_FAILED', 'Invalid request', {
      fields: Object.fromEntries(r.error.issues.map((i) => [i.path.join('.') || '_', i.message])),
    });
  }
  return r.data;
}

/** Customer-facing service routes (all behind requireAuth): tracking, returns, invoices, reviews, devices, notifications. */
export function serviceRouter(deps: Deps, lim: Lim, routeTable: string[]) {
  const { db, storage } = deps;
  const r = trackRoutes(express.Router(), '/v1', routeTable);
  const actor = (req: Request) => ({ kind: 'customer' as const, userId: req.principal!.userId });
  const uid = (req: Request) => req.principal!.userId;

  // ----- shipment tracking (events are merchant-entered facts, never invented)
  r.get('/orders/:id/shipments', lim('acct', 60_000, 120, true), async (req, res) => {
    const id = parse(uuid, req.params.id);
    const items = await db.tx(actor(req), async (c) => {
      const o = await c.query(`SELECT 1 FROM orders WHERE id = $1 AND user_id = $2`, [id, uid(req)]);
      if (o.rowCount === 0) throw new AppError('NOT_FOUND', 'Order not found');
      return shipmentsForOrder(c, id);
    });
    res.json({ items });
  });

  // ----- returns
  r.post('/orders/:id/returns', lim('returns', 3600_000, 10, true), async (req, res) => {
    const id = parse(uuid, req.params.id);
    const b = parse(
      z.object({
        reason: z.string().trim().min(3).max(500),
        items: z
          .array(
            z.object({ orderItemId: z.number().int().positive(), quantity: z.number().int().min(1).max(99) }),
          )
          .min(1)
          .max(20),
      }),
      req.body,
    );
    res.status(201).json(await db.tx(actor(req), (c) => requestReturn(c, uid(req), id, b.items, b.reason)));
  });
  r.get('/orders/:id/returns', lim('acct', 60_000, 120, true), async (req, res) => {
    const id = parse(uuid, req.params.id);
    const rows = await db.tx(actor(req), (c) =>
      c.query(
        `SELECT id, status, reason, decision_note, created_at FROM returns WHERE order_id = $1 AND user_id = $2 ORDER BY created_at DESC`,
        [id, uid(req)],
      ),
    );
    res.json({
      items: rows.rows.map((x) => ({
        id: x.id,
        status: x.status,
        reason: x.reason,
        decisionNote: x.decision_note,
        createdAt: new Date(x.created_at).toISOString(),
      })),
    });
  });

  // ----- invoices (generated on demand, issued exactly once)
  const loadInvoice = async (req: Request) => {
    const id = parse(uuid, req.params.id);
    return db.tx(actor(req), async (c) => {
      const o = await c.query(`SELECT 1 FROM orders WHERE id = $1 AND user_id = $2`, [id, uid(req)]);
      if (o.rowCount === 0) throw new AppError('NOT_FOUND', 'Order not found');
      return issueInvoice(c, id);
    });
  };
  r.get('/orders/:id/invoice', lim('invoice', 60_000, 30, true), async (req, res) => {
    res.json(await loadInvoice(req));
  });
  r.get('/orders/:id/invoice.html', lim('invoice', 60_000, 30, true), async (req, res) => {
    const snap = await loadInvoice(req);
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'");
    res.type('html').send(invoiceHtml(snap));
  });

  // ----- reviews (verified purchasers only; photos sanitised and quarantined until a moderator approves)
  r.post('/products/:id/reviews', lim('review', 3600_000, 10, true), async (req, res) => {
    const pid = parse(slug, req.params.id);
    const b = parse(
      z.object({
        rating: z.number().int().min(1).max(5),
        title: z.string().trim().min(1).max(120),
        body: z.string().trim().min(1).max(3000),
      }),
      req.body,
    );
    res.status(201).json(await db.tx(actor(req), (c) => createReview(c, uid(req), pid, b)));
  });
  r.get('/me/reviews', lim('acct', 60_000, 60, true), async (req, res) => {
    const rows = await db.tx(actor(req), async (c) => {
      const rv = await c.query(
        `SELECT id, product_id, rating, title, body, status, moderation_note, created_at FROM reviews WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`,
        [uid(req)],
      );
      const media = await c.query(
        `SELECT m.id, m.review_id, m.status FROM review_media m JOIN reviews r ON r.id = m.review_id WHERE r.user_id = $1`,
        [uid(req)],
      );
      return { rv: rv.rows, media: media.rows };
    });
    res.json({
      items: rows.rv.map((x) => ({
        id: x.id,
        productId: x.product_id,
        rating: x.rating,
        title: x.title,
        body: x.body,
        status: x.status,
        moderationNote: x.moderation_note,
        createdAt: new Date(x.created_at).toISOString(),
        photos: rows.media.filter((m) => m.review_id === x.id).map((m) => ({ id: m.id, status: m.status })),
      })),
    });
  });
  r.post(
    '/reviews/:id/photos',
    lim('upload', 3600_000, 20, true),
    express.raw({
      type: ['image/jpeg', 'image/png', 'image/webp', 'application/octet-stream'],
      limit: '5mb',
    }),
    async (req, res) => {
      const id = parse(uuid, req.params.id);
      if (!Buffer.isBuffer(req.body) || req.body.length === 0)
        throw new AppError('VALIDATION_FAILED', 'Send the image as the request body');
      let img;
      try {
        img = await sanitizeImage(req.body);
      } catch (e) {
        if (e instanceof ImageRejected)
          throw new AppError('VALIDATION_FAILED', e.message, { fields: { image: e.message } });
        throw e;
      }
      res.status(201).json(await db.tx(actor(req), (c) => attachReviewMedia(c, storage, uid(req), id, img)));
    },
  );
  r.get('/reviews/:id/photos/:mediaId', lim('acct', 60_000, 120, true), async (req, res) => {
    const id = parse(uuid, req.params.id);
    const mid = parse(uuid, req.params.mediaId);
    const m = await db.tx(actor(req), (c) =>
      c.query(
        `SELECT m.original_key, m.mime FROM review_media m JOIN reviews r ON r.id = m.review_id WHERE m.id = $1 AND r.id = $2 AND r.user_id = $3`,
        [mid, id, uid(req)],
      ),
    );
    if (!m.rows[0]) throw new AppError('NOT_FOUND', 'Photo not found');
    const data = await storage.get(m.rows[0].original_key);
    if (!data) throw new AppError('NOT_FOUND', 'Photo not found');
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.type(m.rows[0].mime).send(data);
  });

  // ----- device registration (push delivery is not configured; tokens are stored for when it is)
  r.post('/devices', lim('acct', 60_000, 30, true), async (req, res) => {
    const b = parse(
      z.object({ platform: z.enum(['android', 'ios', 'web']), token: z.string().min(16).max(4096) }),
      req.body,
    );
    // A token belongs to ONE account: re-registering on a shared phone moves it to the signed-in user.
    await db.tx({ kind: 'system', reason: 'device_reassign' }, (c) =>
      c.query(`DELETE FROM device_tokens WHERE token = $1 AND user_id <> $2`, [b.token, uid(req)]),
    );
    await db.tx(actor(req), (c) =>
      c.query(
        `INSERT INTO device_tokens (user_id, platform, token) VALUES ($1,$2,$3) ON CONFLICT (token) DO UPDATE SET last_seen_at = now(), platform = $2`,
        [uid(req), b.platform, b.token],
      ),
    );
    res.status(204).end();
  });
  r.delete('/devices/:token', lim('acct', 60_000, 30, true), async (req, res) => {
    await db.tx(actor(req), (c) =>
      c.query(`DELETE FROM device_tokens WHERE token = $1 AND user_id = $2`, [
        String(req.params.token),
        uid(req),
      ]),
    );
    res.status(204).end();
  });

  // ----- in-app notifications
  r.get('/notifications', lim('acct', 60_000, 120, true), async (req, res) => {
    const q = parse(PageQuery, req.query);
    const cur = decodeCursor(q.cursor, z.object({ t: z.string(), i: z.string().uuid() }));
    const rows = await db.tx(actor(req), (c) =>
      c.query(
        `SELECT id, kind, title, body, data, read_at, created_at FROM notifications WHERE user_id = $1
          AND ($2::timestamptz IS NULL OR (created_at, id) < ($2::timestamptz, $3::uuid)) ORDER BY created_at DESC, id DESC LIMIT $4`,
        [uid(req), cur?.t ?? null, cur?.i ?? null, q.limit + 1],
      ),
    );
    const page = rows.rows.slice(0, q.limit);
    const last = page[page.length - 1];
    res.json({
      items: page.map((n) => ({
        id: n.id,
        kind: n.kind,
        title: n.title,
        body: n.body,
        data: n.data,
        read: !!n.read_at,
        createdAt: new Date(n.created_at).toISOString(),
      })),
      nextCursor:
        rows.rows.length > q.limit && last
          ? encodeCursor({ t: new Date(last.created_at).toISOString(), i: last.id })
          : null,
    });
  });
  r.post('/notifications/:id/read', lim('acct', 60_000, 120, true), async (req, res) => {
    const id = parse(uuid, req.params.id);
    await db.tx(actor(req), (c) =>
      c.query(`UPDATE notifications SET read_at = coalesce(read_at, now()) WHERE id = $1 AND user_id = $2`, [
        id,
        uid(req),
      ]),
    );
    res.status(204).end();
  });

  return r;
}
