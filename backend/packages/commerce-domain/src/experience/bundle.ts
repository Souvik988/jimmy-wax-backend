import { createHash } from 'node:crypto';
import type { PoolClient } from '@jw/database';
import { resolveVariables, mapStrings, substitute, type StoreFacts } from './variables.ts';
import { deepMerge, type Channel } from './schemas.ts';
import type { Snapshot } from './releases.ts';

/**
 * Turns an immutable release snapshot (or a draft snapshot, for previews) into the bundle a client renders:
 * campaign overlays applied by time, facts substituted into copy, product sources resolved against LIVE catalogue
 * data, blocks the client cannot render held back, text-only testimonials for the app.
 * Runs on views only (works for the read-only experience role).
 */
export interface ClientInfo {
  platform?: 'ios' | 'android' | 'web';
  version?: string;
  build?: number;
  caps?: string[];
}

/** `app/1.2.0+15; platform=android; caps=app.hero_carousel,app.product_rail` or `web/abc123; caps=...` */
export function parseClientHeader(h: string | undefined, channel: Channel): ClientInfo {
  if (!h || h.length > 1500) return { platform: channel === 'web' ? 'web' : undefined };
  const [head, ...rest] = h.split(';').map((s) => s.trim());
  const info: ClientInfo = {};
  const m = /^(app|web)\/([\w.\-]+)(?:\+(\d+))?$/.exec(head ?? '');
  if (m && m[1] === channel) {
    info.version = m[2];
    if (m[3]) info.build = Number(m[3]);
  }
  for (const part of rest) {
    const [k, v] = part.split('=');
    if (k === 'platform' && (v === 'ios' || v === 'android' || v === 'web')) info.platform = v;
    if (k === 'caps' && v)
      info.caps = v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(0, 80);
  }
  if (channel === 'web') info.platform = 'web';
  return info;
}

export interface BundleSource {
  enabled: boolean;
  release: { id: string; number: number; label?: string; publishedAt: string | null } | null;
  snapshot: Snapshot | null;
}

type Block = {
  id: string;
  type: string;
  visible: boolean;
  props: Record<string, unknown>;
  rules?: Record<string, unknown>;
  resolved?: unknown;
};

export async function loadFacts(c: PoolClient): Promise<StoreFacts> {
  const r = await c.query(`SELECT * FROM v_public_store_settings`);
  const s = r.rows[0];
  return {
    shippingFeePaise: s?.shipping_fee_paise ?? 0,
    freeShippingThresholdPaise: s?.free_shipping_threshold_paise ?? null,
    codFeePaise: s?.cod_fee_paise ?? 0,
    deliveryEstimate: s?.delivery_estimate ?? '',
    gstRateBps: s?.gst_rate_bps ?? 0,
    supportEmail: s?.support_email ?? null,
    supportPhone: s?.support_phone ?? null,
    brandName: s?.brand_name ?? 'JIMMY WAX',
  };
}

const PRODUCTS = `SELECT product_id, (array_agg(category_id))[1] AS category_id, min(sort_order) AS sort_order,
  min(product_created_at) AS created, min(price_paise) AS price, min(name) AS name,
  bool_or(available > 0) AS in_stock, (array_agg(tags))[1] AS tags FROM v_catalog_products GROUP BY product_id`;

/**
 * Out-of-stock behaviour (contract): products that cannot be bought stay in the list - the client shows a "sold out" card -
 * but never lead it. Rails fed by a rule (collection, category, newest, bestsellers) list in-stock products first, keeping the
 * rule's order inside each group; a hand-picked (manual) list keeps the editor's order exactly. `resolved.outOfStockIds`
 * names the sold-out ones so clients do not have to look each up.
 */
export async function stockSplit(
  c: PoolClient,
  ids: string[],
  keepOrder: boolean,
): Promise<{ productIds: string[]; outOfStockIds: string[] }> {
  if (ids.length === 0) return { productIds: [], outOfStockIds: [] };
  const r = await c.query(`SELECT product_id FROM (${PRODUCTS}) p WHERE product_id = ANY($1) AND in_stock`, [
    ids,
  ]);
  const live = new Set(r.rows.map((x) => x.product_id as string));
  const out = ids.filter((i) => !live.has(i));
  return { productIds: keepOrder ? ids : [...ids.filter((i) => live.has(i)), ...out], outOfStockIds: out };
}

export async function resolveProductIds(
  c: PoolClient,
  src: Record<string, unknown>,
  limit: number,
): Promise<string[]> {
  const kind = src.kind as string;
  const lim = Math.max(1, Math.min(48, limit));
  if (kind === 'manual') {
    const ids = src.productIds as string[];
    const r = await c.query(`SELECT product_id FROM (${PRODUCTS}) p WHERE product_id = ANY($1)`, [ids]);
    const live = new Set(r.rows.map((x) => x.product_id as string));
    return ids.filter((i) => live.has(i)).slice(0, lim);
  }
  if (kind === 'category') {
    const r = await c.query(
      `SELECT product_id FROM (${PRODUCTS}) p WHERE category_id = $1 ORDER BY sort_order, product_id LIMIT $2`,
      [src.categoryId, lim],
    );
    return r.rows.map((x) => x.product_id as string);
  }
  if (kind === 'newest') {
    const r = await c.query(
      `SELECT product_id FROM (${PRODUCTS}) p ORDER BY created DESC, product_id LIMIT $1`,
      [lim],
    );
    return r.rows.map((x) => x.product_id as string);
  }
  if (kind === 'bestsellers') {
    const r = await c.query(
      `SELECT p.product_id FROM (${PRODUCTS}) p LEFT JOIN v_product_sales s ON s.product_id = p.product_id
        ORDER BY coalesce(s.units_90d, 0) DESC, p.sort_order, p.product_id LIMIT $1`,
      [lim],
    );
    return r.rows.map((x) => x.product_id as string);
  }
  if (kind === 'collection') {
    const live = await c.query(`SELECT id, kind, rule FROM v_collections WHERE id = $1`, [src.slug]);
    if (!live.rows[0]) return [];
    if (live.rows[0].kind === 'manual') {
      const items = await c.query(
        `SELECT i.product_id FROM v_collection_items i JOIN (${PRODUCTS}) p ON p.product_id = i.product_id WHERE i.collection_id = $1 ORDER BY i.position LIMIT $2`,
        [src.slug, lim],
      );
      return items.rows.map((x) => x.product_id as string);
    }
    const rule = live.rows[0].rule as {
      categoryIds?: string[];
      tags?: string[];
      inStockOnly?: boolean;
      sort?: string;
      limit?: number;
    };
    const args: unknown[] = [];
    const w: string[] = [];
    if (rule.categoryIds?.length) w.push(`category_id = ANY($${args.push(rule.categoryIds)})`);
    if (rule.tags?.length) w.push(`tags && $${args.push(rule.tags)}`);
    if (rule.inStockOnly) w.push('in_stock');
    const order =
      (
        { newest: 'created DESC', price_asc: 'price ASC', price_desc: 'price DESC', name: 'name' } as Record<
          string,
          string
        >
      )[rule.sort ?? 'newest'] ?? 'created DESC';
    args.push(Math.min(lim, rule.limit ?? lim));
    const r = await c.query(
      `SELECT product_id FROM (${PRODUCTS}) p ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY ${order}, product_id LIMIT $${args.length}`,
      args,
    );
    return r.rows.map((x) => x.product_id as string);
  }
  return [];
}

const within = (rules: Record<string, unknown> | undefined, now: Date, client: ClientInfo): boolean => {
  if (!rules) return true;
  const sched = rules.schedule as { startAt?: string; endAt?: string } | undefined;
  if (sched?.startAt && new Date(sched.startAt) > now) return false;
  if (sched?.endAt && new Date(sched.endAt) < now) return false;
  const platforms = rules.platforms as string[] | undefined;
  if (platforms?.length && client.platform && !platforms.includes(client.platform)) return false;
  const build = rules.appBuild as { min?: number; max?: number } | undefined;
  if (build && client.build !== undefined) {
    if (build.min !== undefined && client.build < build.min) return false;
    if (build.max !== undefined && client.build > build.max) return false;
  }
  return true;
};

export async function assembleBundle(
  c: PoolClient,
  channel: Channel,
  src: BundleSource,
  client: ClientInfo,
  now = new Date(),
) {
  if (!src.enabled || !src.snapshot || !src.release) {
    const base = {
      schemaVersion: 1,
      channel,
      enabled: false,
      release: src.release,
      pages: {},
      generatedAt: now.toISOString(),
    };
    return {
      bundle: base,
      etag: `"${createHash('sha256')
        .update(JSON.stringify({ ...base, generatedAt: '' }))
        .digest('hex')
        .slice(0, 32)}"`,
    };
  }
  const snap = src.snapshot;
  const facts = await loadFacts(c);
  const vars = resolveVariables(facts);
  const sub = <T>(v: T): T => mapStrings(v, (s) => substitute(s, vars));

  // ------- campaign overlays active now (tokens + announcement + extra hero slide)
  const active = snap.campaigns.filter((k) => new Date(k.startsAt) <= now && now < new Date(k.endsAt));
  let tokens = deepMerge(
    snap.docs['tokens:base'] as Record<string, unknown>,
    (snap.docs['tokens:override'] as { overrides?: unknown } | undefined)?.overrides,
  );
  for (const k of active) tokens = deepMerge(tokens, (k.overlay as { tokens?: unknown } | null)?.tokens);

  const heldBack: Record<string, number> = {};
  const caps = client.caps ? new Set(client.caps) : null;
  const pages: Record<string, unknown> = {};
  for (const [key, body] of Object.entries(snap.docs)) {
    if (!key.startsWith('page:')) continue;
    const page = body as { blocks: Block[] };
    const out: Block[] = [];
    for (const b of page.blocks) {
      if (!b.visible || !within(b.rules, now, client)) continue;
      if (caps && !caps.has(b.type)) {
        heldBack[b.type] = (heldBack[b.type] ?? 0) + 1;
        continue;
      }
      const resolved: Record<string, unknown> = {};
      const props = b.props as Record<string, unknown>;
      if (props.source) {
        const src = props.source as Record<string, unknown>;
        const split = await stockSplit(
          c,
          await resolveProductIds(c, src, Number(props.limit ?? 12)),
          src.kind === 'manual',
        );
        resolved.productIds = split.productIds;
        resolved.outOfStockIds = split.outOfStockIds;
      }
      if (b.type === 'app.testimonials' && props.mode === 'verified_reviews') {
        const r = await c.query(
          `SELECT product_id, rating, title, body, created_at FROM v_approved_reviews WHERE rating >= 4 AND length(body) >= 20 ORDER BY created_at DESC LIMIT $1`,
          [Number(props.limit ?? 4)],
        );
        resolved.reviews = r.rows.map((x) => ({
          productId: x.product_id,
          rating: x.rating,
          title: x.title,
          body: x.body,
          author: 'Verified buyer',
          createdAt: new Date(x.created_at).toISOString(),
        }));
      }
      const { rules: r0, ...rest } = b;
      const keep: Record<string, unknown> | undefined = r0
        ? { auth: r0.auth, storePaused: r0.storePaused }
        : undefined;
      out.push({
        ...rest,
        ...(keep && (keep.auth || keep.storePaused) ? { rules: keep } : {}),
        ...(Object.keys(resolved).length ? { resolved } : {}),
      } as Block);
    }
    pages[key.slice(5)] = { ...page, blocks: out };
  }
  // extra hero slide from a campaign (app only)
  for (const k of active) {
    const slide = (k.overlay as { extraHeroSlide?: Record<string, unknown> } | null)?.extraHeroSlide;
    const home = pages.home as { blocks: Block[] } | undefined;
    const hero = home?.blocks.find((b) => b.type === 'app.hero_carousel');
    if (slide && hero)
      (hero.props.slides as unknown[]).unshift({
        id: `camp-${k.id.slice(0, 8)}`,
        textInImage: true,
        ...slide,
      });
  }

  // ------- content (text-only testimonials in the app)
  const testimonials = Object.fromEntries(
    Object.entries(snap.entities.testimonials).map(([id, t]) => {
      const tt = { ...(t as Record<string, unknown>) };
      if (channel === 'app') {
        delete tt.videoMediaId;
        delete tt.posterMediaId;
      }
      return [id, tt];
    }),
  );
  const nowIso = now.getTime();
  const announcements = [
    ...snap.entities.announcements.filter((a) => {
      const x = a as { startsAt: string | null; endsAt: string | null };
      return (
        (!x.startsAt || new Date(x.startsAt).getTime() <= nowIso) &&
        (!x.endsAt || new Date(x.endsAt).getTime() > nowIso)
      );
    }),
    ...active.flatMap((k) => {
      const a = (k.overlay as { announcement?: Record<string, unknown> } | null)?.announcement;
      return a ? [{ id: `camp-${k.id}`, ...a }] : [];
    }),
  ];

  const bundle = {
    schemaVersion: 1,
    channel,
    enabled: true,
    release: src.release,
    tokens,
    navigation: sub(snap.docs['navigation:main']),
    chrome: sub(snap.docs['chrome:main']),
    pages: sub(pages),
    content: sub({
      careGuides: snap.entities.careGuides,
      faqGroups: snap.entities.faqGroups,
      stories: snap.entities.stories,
      journal: snap.entities.journal,
      testimonials,
      announcements,
    }),
    media: snap.media,
    variables: Object.fromEntries(Object.entries(vars).filter(([, v]) => v != null)) as Record<
      string,
      string
    >,
    diagnostics: { heldBack, activeCampaigns: active.map((k) => k.id) },
    minClient: {},
    generatedAt: now.toISOString(),
  };
  const etag = `"${createHash('sha256')
    .update(JSON.stringify({ ...bundle, generatedAt: '' }))
    .digest('hex')
    .slice(0, 32)}"`;
  return { bundle, etag };
}

export async function loadEffective(c: PoolClient, channel: Channel): Promise<BundleSource> {
  const r = await c.query(`SELECT * FROM v_exp_effective WHERE channel = $1`, [channel]);
  const x = r.rows[0];
  if (!x) return { enabled: false, release: null, snapshot: null };
  return {
    enabled: x.enabled,
    release: x.release_id
      ? {
          id: x.release_id,
          number: x.number,
          label: x.label,
          publishedAt: x.published_at ? new Date(x.published_at).toISOString() : null,
        }
      : null,
    snapshot: (x.snapshot as Snapshot | null) ?? null,
  };
}
