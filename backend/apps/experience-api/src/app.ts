import express from 'express';
import helmet from 'helmet';
import { z } from 'zod';
import { AppError, PageQuery, decodeCursor, encodeCursor, trackRoutes, type ErrorBody } from '@jw/contracts';
import type { Db } from '@jw/database';
import { MEDIA_FILE, MIME_BY_EXT, mediaKey, type ObjectStorage } from '@jw/integrations';
import { exp, versionCheck } from '@jw/commerce-domain';
import type { Logger } from '@jw/observability';

/**
 * Public, cacheable shopping reads. Reads curated database VIEWS through a read-only role; it can
 * never write and never sees customer data. Freshness policy (documented in CONTRACT_DECISIONS):
 *   catalog/prices/availability/settings: public, max-age=30s, stale-while-revalidate=60s.
 * Quotes and checkout always re-validate against the authoritative write path.
 */
export interface ExperienceDeps {
  db: Db;
  logger: Logger;
  ttlMs?: number;
  /** Needed only to serve approved review photos. */
  storage?: ObjectStorage;
  /** Browser origins (the website) allowed to read cross-origin. */
  corsOrigins?: string[];
  /** Development bridge only (MEDIA_PUBLIC_ALLOW_UNAPPROVED): serve draft/rejected media, uncached. Never true in production. */
  allowUnapprovedMedia?: boolean;
  /** True when the commerce API can take online payments (FEATURE_ONLINE_PAYMENTS and a payment provider). */
  onlinePaymentsEnabled?: boolean;
}

/** Single-flight micro-cache: concurrent identical requests share ONE database query (stampede protection). */
class SingleFlightCache {
  private entries = new Map<string, { at: number; value: unknown }>();
  private inflight = new Map<string, Promise<unknown>>();
  constructor(
    private ttlMs: number,
    private max = 500,
  ) {}
  async get<T>(key: string, load: () => Promise<T>): Promise<T> {
    const hit = this.entries.get(key);
    if (hit && Date.now() - hit.at < this.ttlMs) return hit.value as T;
    let p = this.inflight.get(key) as Promise<T> | undefined;
    if (!p) {
      p = load()
        .then((v) => {
          if (this.entries.size >= this.max) this.entries.delete(this.entries.keys().next().value as string);
          this.entries.set(key, { at: Date.now(), value: v });
          return v;
        })
        .finally(() => this.inflight.delete(key));
      this.inflight.set(key, p);
    }
    return p;
  }
}

/** If-None-Match may carry several validators, weak (W/) ones after a CDN recompresses, or "*". */
export function etagMatches(header: string | undefined, etag: string): boolean {
  if (!header) return false;
  if (header.trim() === '*') return true;
  const bare = (v: string) => v.trim().replace(/^W\//, '');
  return header.split(',').some((v) => bare(v) === bare(etag));
}

const slug = z
  .string()
  .regex(/^[a-z0-9-]+$/)
  .max(100);

export function createExperienceApp({
  db,
  logger,
  ttlMs = 5000,
  storage,
  corsOrigins = [],
  allowUnapprovedMedia = false,
  onlinePaymentsEnabled = false,
}: ExperienceDeps) {
  const app = express();
  app.disable('x-powered-by');
  // Public, credential-less reads: browsers (the website) may call them from the configured origins only.
  const allowed = new Set(corsOrigins);
  app.use((req, res, next) => {
    const o = req.header('origin');
    if (o && allowed.has(o)) {
      res.setHeader('Access-Control-Allow-Origin', o);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'if-none-match,x-jw-client,range,x-request-id');
      res.setHeader('Access-Control-Allow-Methods', 'GET,HEAD,OPTIONS');
      res.setHeader('Access-Control-Expose-Headers', 'etag,content-range,accept-ranges');
      res.setHeader('Access-Control-Max-Age', '600');
    }
    if (req.method === 'OPTIONS') return void res.status(204).end();
    next();
  });
  app.use(helmet({ contentSecurityPolicy: false }));
  const cache = new SingleFlightCache(ttlMs);
  const read = <T>(fn: (c: import('@jw/database').PoolClient) => Promise<T>) =>
    db.tx({ kind: 'anonymous' }, fn);
  const pub: express.RequestHandler = (_q, res, next) => {
    res.setHeader('Cache-Control', 'public, max-age=30, stale-while-revalidate=60');
    next();
  };

  app.get('/healthz', (_q, res) => void res.json({ status: 'ok' }));
  app.get('/readyz', async (_q, res) => {
    try {
      await db.pool.query('SELECT 1');
      res.json({ status: 'ready' });
    } catch {
      res.status(503).json({ status: 'not_ready' });
    }
  });

  const dto = (x: Record<string, unknown>) => ({
    id: x.product_id,
    categoryId: x.category_id,
    name: x.name,
    subtitle: x.subtitle,
    description: x.description,
    keyBenefits: x.key_benefits,
    suitableSurfaces: x.suitable_surfaces,
    boxContents: x.box_contents,
    variant: {
      id: x.variant_id,
      sku: x.sku,
      title: x.variant_title,
      pricePaise: x.price_paise,
      comparePaise: x.compare_at_price_paise,
      currency: 'INR',
      available: Number(x.available) > 0,
      // exact counts are capped so the public API does not leak inventory depth
      availableQuantity: Math.min(Number(x.available), 10),
    },
    variants: x.variants ?? [],
    // Library-backed images carry a public URL (relative to the API origin); legacy entries keep only `assetPath`.
    media: ((x.media as Array<{ assetPath: string; alt: string }> | null) ?? []).map((m) => ({
      ...m,
      url: m.assetPath.startsWith('/v1/media/') ? m.assetPath : null,
    })),
    tags: x.tags ?? [],
    seo: { title: x.seo_title ?? null, description: x.seo_description ?? null },
  });

  const routeTable: string[] = [];
  app.locals.routeTable = routeTable;
  const v1 = trackRoutes(express.Router(), '/v1', routeTable);
  app.use('/v1', pub, v1);

  v1.get('/store-settings', async (_q, res) => {
    const r = await cache.get('settings', () =>
      read((c) => c.query(`SELECT * FROM v_public_store_settings`)),
    );
    const s = r.rows[0];
    if (!s) throw new AppError('POLICY_NOT_CONFIGURED', 'Store settings are not configured');
    res.json({
      shippingFeePaise: s.shipping_fee_paise,
      freeShippingThresholdPaise: s.free_shipping_threshold_paise,
      codEnabled: s.cod_enabled,
      codMaxOrderPaise: s.cod_max_order_paise,
      codFeePaise: s.cod_fee_paise,
      onlinePaymentsEnabled,
      gstRateBps: s.gst_rate_bps,
      taxInclusive: s.tax_inclusive,
      checkoutOpen: s.checkout_open,
      ordersPaused: s.orders_paused,
      pauseMessage: s.orders_paused ? s.pause_message : '',
      brandName: s.brand_name,
      supportEmail: s.support_email,
      supportPhone: s.support_phone,
      deliveryEstimate: s.delivery_estimate,
      currency: 'INR',
    });
  });

  // Launch-time gate: ok / update_available / force_update. Short-cached; the app must treat failure as 'ok'.
  v1.get('/app/version-check', async (req, res) => {
    const platform = req.query.platform;
    const version = req.query.version;
    if (
      (platform !== 'android' && platform !== 'ios') ||
      typeof version !== 'string' ||
      !/^[0-9]+.[0-9]+.[0-9]+$/.test(version)
    ) {
      throw new AppError('VALIDATION_FAILED', 'platform (android|ios) and version (x.y.z) are required', {
        fields: { platform: 'required', version: 'required' },
      });
    }
    res.json(
      await cache.get(`version:${platform}:${version}`, async () =>
        read((c) => versionCheck(c, platform, version)),
      ),
    );
  });

  // Delivery-area check. serviceable is null when no delivery area is configured yet (clients must not claim either way).
  v1.get('/serviceability/:pin', async (req, res) => {
    const pin = String(req.params.pin);
    if (!/^[1-9][0-9]{5}$/.test(pin))
      throw new AppError('VALIDATION_FAILED', 'A PIN code has 6 digits', { fields: { pin: 'invalid' } });
    const r = await cache.get(`pin:${pin}`, () =>
      read((c) => c.query('SELECT public.pin_serviceable($1) AS ok', [pin])),
    );
    const e = await cache.get('settings', () =>
      read((c) => c.query('SELECT * FROM v_public_store_settings')),
    );
    res.json({
      pin,
      serviceable: r.rows[0].ok as boolean | null,
      deliveryEstimate: r.rows[0].ok ? (e.rows[0]?.delivery_estimate ?? null) : null,
    });
  });

  v1.get('/categories', async (_q, res) => {
    const r = await cache.get('categories', () =>
      read((c) => c.query(`SELECT * FROM v_categories ORDER BY sort_order, id`)),
    );
    res.json({ items: r.rows.map((x) => ({ id: x.id, name: x.name })) });
  });

  v1.get('/products', async (req, res) => {
    const q = PageQuery.extend({
      category: slug.optional(),
      q: z.string().trim().min(2).max(60).optional(),
    }).safeParse(req.query);
    if (!q.success)
      throw new AppError('VALIDATION_FAILED', 'Invalid query', {
        fields: Object.fromEntries(q.error.issues.map((i) => [i.path.join('.'), i.message])),
      });
    const { limit, cursor, category, q: term } = q.data;
    // Batch lookup used by Studio rails: ?ids=a,b,c (max 48), answered in the requested order, no paging.
    const idsRaw = typeof req.query.ids === 'string' ? req.query.ids : undefined;
    if (idsRaw !== undefined) {
      const ids = idsRaw
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      const ok = ids.length > 0 && ids.length <= 48 && ids.every((i) => slug.safeParse(i).success);
      if (!ok)
        throw new AppError('VALIDATION_FAILED', 'ids must be 1–48 product ids', {
          fields: { ids: 'invalid' },
        });
      const found = await cache.get(`ids:${ids.join(',')}`, () =>
        read((c) => c.query(`SELECT * FROM v_catalog_products WHERE product_id = ANY($1)`, [ids])),
      );
      const byId = new Map(found.rows.map((x) => [x.product_id as string, x]));
      res.json({ items: ids.flatMap((i) => (byId.has(i) ? [dto(byId.get(i)!)] : [])), nextCursor: null });
      return;
    }
    const cur = decodeCursor(cursor, z.object({ s: z.number().int(), id: z.string() }));
    const like = term ? `%${term.replace(/[%_\\]/g, (m) => '\\' + m)}%` : null;
    const rows = await cache.get(`p:${category ?? ''}:${term ?? ''}:${cursor ?? ''}:${limit}`, () =>
      read((c) =>
        c.query(
          `SELECT * FROM v_catalog_products
            WHERE ($1::text IS NULL OR category_id = $1)
              AND ($2::text IS NULL OR name ILIKE $2 OR subtitle ILIKE $2 OR description ILIKE $2)
              AND ($3::int IS NULL OR (sort_order, product_id) > ($3::int, $4::text))
            ORDER BY sort_order, product_id LIMIT $5`,
          [category ?? null, like, cur?.s ?? null, cur?.id ?? null, limit + 1],
        ),
      ),
    );
    const page = rows.rows.slice(0, limit);
    const last = page[page.length - 1];
    res.json({
      items: page.map(dto),
      nextCursor:
        rows.rows.length > limit && last ? encodeCursor({ s: last.sort_order, id: last.product_id }) : null,
    });
  });

  v1.get('/products/:id', async (req, res) => {
    const id = slug.safeParse(req.params.id);
    if (!id.success) throw new AppError('NOT_FOUND', 'Product not found');
    const r = await cache.get(`p1:${id.data}`, () =>
      read((c) => c.query(`SELECT * FROM v_catalog_products WHERE product_id = $1`, [id.data])),
    );
    if (!r.rows[0]) throw new AppError('NOT_FOUND', 'Product not found');
    res.json(dto(r.rows[0]));
  });

  v1.get('/products/:id/reviews', async (req, res) => {
    const id = slug.safeParse(req.params.id);
    const q = PageQuery.safeParse(req.query);
    if (!id.success || !q.success) throw new AppError('VALIDATION_FAILED', 'Invalid request');
    const cur = decodeCursor(q.data.cursor, z.object({ t: z.string(), i: z.string().uuid() }));
    const rows = await read((c) =>
      c.query(
        `SELECT * FROM v_approved_reviews WHERE product_id = $1 AND ($2::timestamptz IS NULL OR (created_at, id) < ($2::timestamptz, $3::uuid))
          ORDER BY created_at DESC, id DESC LIMIT $4`,
        [id.data, cur?.t ?? null, cur?.i ?? null, q.data.limit + 1],
      ),
    );
    const page = rows.rows.slice(0, q.data.limit);
    const last = page[page.length - 1];
    const media = page.length
      ? await read((c) =>
          c.query(
            `SELECT id, review_id, width, height FROM v_approved_review_media WHERE review_id = ANY($1::uuid[])`,
            [page.map((p) => p.id)],
          ),
        )
      : { rows: [] as Array<{ id: string; review_id: string; width: number; height: number }> };
    res.json({
      items: page.map((x) => ({
        id: x.id,
        rating: x.rating,
        title: x.title,
        body: x.body,
        verifiedPurchase: x.verified_purchase,
        createdAt: new Date(x.created_at).toISOString(),
        photos: media.rows
          .filter((m) => m.review_id === x.id)
          .map((m) => ({ id: m.id, url: `/v1/media/reviews/${m.id}`, width: m.width, height: m.height })),
      })),
      nextCursor:
        rows.rows.length > q.data.limit && last
          ? encodeCursor({ t: new Date(last.created_at).toISOString(), i: last.id })
          : null,
    });
  });

  // Approved review photos only (sanitised WebP derivatives). Immutable, so CDN-cacheable for a long time.
  v1.get('/media/reviews/:id', async (req, res) => {
    const id = z.string().uuid().safeParse(req.params.id);
    if (!id.success || !storage) throw new AppError('NOT_FOUND', 'Photo not found');
    const r = await read((c) =>
      c.query(`SELECT public_key FROM v_approved_review_media WHERE id = $1`, [id.data]),
    );
    const data = r.rows[0] ? await storage.get(r.rows[0].public_key) : null;
    if (!data) throw new AppError('NOT_FOUND', 'Photo not found');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.type('image/webp').send(data);
  });

  // Published policy / care-guide pages (versioned in the admin console).
  v1.get('/content', async (_q, res) => {
    const r = await cache.get('content', () =>
      read((c) =>
        c.query(`SELECT slug, kind, title, version, published_at FROM v_content_pages ORDER BY slug`),
      ),
    );
    res.json({
      items: r.rows.map((x) => ({
        slug: x.slug,
        kind: x.kind,
        title: x.title,
        version: x.version,
        publishedAt: new Date(x.published_at).toISOString(),
      })),
    });
  });
  v1.get('/content/:slug', async (req, res) => {
    const s = z
      .string()
      .regex(/^[a-z0-9-]{2,60}$/)
      .safeParse(req.params.slug);
    if (!s.success) throw new AppError('NOT_FOUND', 'Page not found');
    const r = await cache.get(`c:${s.data}`, () =>
      read((c) => c.query(`SELECT * FROM v_content_pages WHERE slug = $1`, [s.data])),
    );
    const x = r.rows[0];
    if (!x) throw new AppError('NOT_FOUND', 'Page not found');
    res.json({
      slug: x.slug,
      kind: x.kind,
      title: x.title,
      bodyMd: x.body_md,
      version: x.version,
      publishedAt: new Date(x.published_at).toISOString(),
    });
  });

  // Home composition: categories + the catalogue in display order + store policy (one cacheable call).
  v1.get('/home', async (_q, res) => {
    const out = await cache.get('home', async () => {
      const [cats, prods, st] = await Promise.all([
        read((c) => c.query(`SELECT * FROM v_categories ORDER BY sort_order, id`)),
        read((c) => c.query(`SELECT * FROM v_catalog_products ORDER BY sort_order, product_id LIMIT 12`)),
        read((c) => c.query(`SELECT * FROM v_public_store_settings`)),
      ]);
      return { cats: cats.rows, prods: prods.rows, st: st.rows[0] };
    });
    res.json({
      categories: out.cats.map((x) => ({ id: x.id, name: x.name })),
      products: out.prods.map(dto),
      store: out.st
        ? {
            deliveryEstimate: out.st.delivery_estimate,
            checkoutOpen: out.st.checkout_open,
            shippingFeePaise: out.st.shipping_fee_paise,
            freeShippingThresholdPaise: out.st.free_shipping_threshold_paise,
            codEnabled: out.st.cod_enabled,
            codFeePaise: out.st.cod_fee_paise,
            onlinePaymentsEnabled,
            currency: 'INR',
          }
        : null,
    });
  });

  // ---------------------------------------------------------------- Experience Studio (published)
  /**
   * The bundle the app/website render. Immutable release snapshot + live facts (variables, product availability,
   * campaign windows). ETag/304 supported; short TTL means a publish or rollback is visible within ~a minute.
   * `enabled:false` is the kill switch: clients fall back to their bundled defaults.
   */
  v1.get('/experience/:channel', async (req, res) => {
    const ch = z.enum(['app', 'web']).safeParse(req.params.channel);
    if (!ch.success) throw new AppError('NOT_FOUND', 'Unknown channel');
    const client = exp.parseClientHeader(req.header('x-jw-client'), ch.data);
    const key = `x:${ch.data}:${client.platform ?? ''}:${client.build ?? ''}:${(client.caps ?? []).join(',')}`;
    const out = await cache.get(key, () =>
      read(async (c) => exp.assembleBundle(c, ch.data, await exp.loadEffective(c, ch.data), client)),
    );
    res.setHeader('Cache-Control', 'public, max-age=60, stale-while-revalidate=300');
    res.setHeader('Vary', 'X-JW-Client');
    res.setHeader('ETag', out.etag);
    if (etagMatches(req.header('if-none-match'), out.etag)) {
      res.status(304).end();
      return;
    }
    res.json(out.bundle);
  });

  // Content-addressed media (sha256 in the path ⇒ immutable). Supports Range for video seeking.
  v1.get('/media/:sha/:file', async (req, res) => {
    const sha = /^[0-9a-f]{64}$/.exec(String(req.params.sha));
    const file = String(req.params.file);
    if (!sha || !storage || !MEDIA_FILE.test(file)) throw new AppError('NOT_FOUND', 'Media not found');
    // Only approved, ready, non-archived library assets are public (DASH-BR-042). Anything else is indistinguishable from missing.
    const approved = await cache.get(
      `media:${sha[0]}`,
      async () =>
        (await read((c) => c.query('SELECT 1 FROM v_public_media WHERE sha256 = $1', [sha[0]]))).rowCount ===
        1,
    );
    if (!approved && !allowUnapprovedMedia) throw new AppError('NOT_FOUND', 'Media not found');
    const data = await storage.get(mediaKey(sha[0], file));
    if (!data) throw new AppError('NOT_FOUND', 'Media not found');
    res.setHeader('Content-Type', MIME_BY_EXT[file.split('.').pop() ?? ''] ?? 'application/octet-stream');
    res.setHeader('Cache-Control', approved ? 'public, max-age=31536000, immutable' : 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.setHeader('Accept-Ranges', 'bytes');
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.header('range') ?? '');
    if (range && (range[1] || range[2])) {
      const size = data.length;
      let start = range[1] ? Number(range[1]) : size - Number(range[2]);
      let end = range[1] && range[2] ? Number(range[2]) : size - 1;
      start = Math.max(0, start);
      end = Math.min(size - 1, end);
      if (start > end || start >= size) {
        res.status(416).setHeader('Content-Range', `bytes */${size}`).end();
        return;
      }
      res
        .status(206)
        .setHeader('Content-Range', `bytes ${start}-${end}/${size}`)
        .setHeader('Content-Length', String(end - start + 1));
      res.end(data.subarray(start, end + 1));
      return;
    }
    res.send(data);
  });

  v1.get('/collections/:slug', async (req, res) => {
    const s = slug.safeParse(req.params.slug);
    if (!s.success) throw new AppError('NOT_FOUND', 'Collection not found');
    const r = await cache.get(`col:${s.data}`, () =>
      read((c) => c.query(`SELECT * FROM v_collections WHERE id = $1`, [s.data])),
    );
    const k = r.rows[0];
    if (!k) throw new AppError('NOT_FOUND', 'Collection not found');
    res.json({
      id: k.id,
      name: k.name,
      description: k.description,
      seo: { title: k.seo_title, description: k.seo_description },
    });
  });
  v1.get('/collections/:slug/products', async (req, res) => {
    const s = slug.safeParse(req.params.slug);
    if (!s.success) throw new AppError('NOT_FOUND', 'Collection not found');
    const out = await cache.get(`colp:${s.data}`, () =>
      read(async (c) => {
        const ids = await exp.resolveProductIds(c, { kind: 'collection', slug: s.data }, 48);
        if (!ids.length) return [] as Array<Record<string, unknown>>;
        const rows = await c.query(`SELECT * FROM v_catalog_products WHERE product_id = ANY($1)`, [ids]);
        const byId = new Map(rows.rows.map((x) => [x.product_id as string, x]));
        return ids.flatMap((i) => (byId.has(i) ? [byId.get(i)!] : []));
      }),
    );
    const coll = await cache.get(`col:${s.data}`, () =>
      read((c) => c.query(`SELECT 1 FROM v_collections WHERE id = $1`, [s.data])),
    );
    if (!coll.rows[0]) throw new AppError('NOT_FOUND', 'Collection not found');
    res.json({ items: out.map(dto), nextCursor: null });
  });

  app.use((_q, _s, next) => next(new AppError('NOT_FOUND', 'Route not found')));
  app.use((err: unknown, req: express.Request, res: express.Response, _n: express.NextFunction) => {
    const e = err instanceof AppError ? err : new AppError('INTERNAL', 'Something went wrong');
    if (!(err instanceof AppError)) logger.error({ err: String(err) }, 'unhandled error');
    const body: ErrorBody = {
      error: {
        code: e.code,
        message: e.message,
        requestId: String(req.header('x-request-id') ?? ''),
        retryable: e.retryable,
        ...(e.details?.fields ? { fields: e.details.fields } : {}),
      },
    };
    res.setHeader('Cache-Control', 'no-store');
    res.status(e.status).json(body);
  });
  return app;
}
