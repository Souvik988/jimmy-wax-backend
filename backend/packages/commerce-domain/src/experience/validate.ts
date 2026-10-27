import type { PoolClient } from '@jw/database';
import { AppError } from '@jw/contracts';
import { resolveCollectionProductIds } from '../catalogue.ts';
import { contrast, deltaE } from './color.ts';
import { parseDoc, type DocChannel, type DocKind, type DocRow } from './docs.ts';
import {
  PRICE_LITERAL,
  CLAIM_WORDS,
  VARIABLE_NAMES,
  resolveVariables,
  scanVariables,
  type StoreFacts,
} from './variables.ts';
import {
  ACTION_TYPES,
  collectFrom,
  emptyCollected,
  expectedMediaKind,
  type Collected,
  type IdUses,
  type Loc,
} from './refs.ts';
import { checkAgainstSlot, slotFor } from './slots.ts';
import { DesignSystem, deepMerge, MAX_BLOCKS, type Channel } from './schemas.ts';

export type Level = 'error' | 'warning' | 'info';
export interface Issue {
  level: Level;
  code: string;
  docKey: string;
  blockId?: string;
  path?: string;
  message: string;
  fixHint?: string;
}
export interface ValidationReport {
  errors: Issue[];
  warnings: Issue[];
  infos: Issue[];
  canPublish: boolean;
  checkedAt: string;
}

export async function loadStoreFacts(c: PoolClient): Promise<StoreFacts> {
  const r = await c.query(
    `SELECT shipping_fee_paise, free_shipping_threshold_paise, cod_fee_paise, delivery_estimate, gst_rate_bps,
            support_email, support_phone, brand_name FROM store_settings WHERE id = 1`,
  );
  const s = r.rows[0];
  if (!s) throw new AppError('POLICY_NOT_CONFIGURED', 'Store settings are missing');
  return {
    shippingFeePaise: s.shipping_fee_paise,
    freeShippingThresholdPaise: s.free_shipping_threshold_paise,
    codFeePaise: s.cod_fee_paise,
    deliveryEstimate: s.delivery_estimate,
    gstRateBps: s.gst_rate_bps,
    supportEmail: s.support_email,
    supportPhone: s.support_phone,
    brandName: s.brand_name,
  };
}

/** Normalised draft documents for a channel (+ the shared base tokens). Docs that fail to parse are reported, not thrown. */
export interface DraftSet {
  shared: unknown | null;
  tokensOverride: unknown | null;
  navigation: unknown | null;
  chrome: unknown | null;
  pages: Array<{
    key: string;
    body: {
      blocks: Array<{
        id: string;
        type: string;
        visible: boolean;
        props: Record<string, unknown>;
        rules?: { schedule?: { startAt?: string; endAt?: string } };
      }>;
      seo?: { title: string };
      nativeSections?: unknown;
    };
  }>;
  raw: DocRow[];
}

const BLOCKED_HOSTS = /^(localhost|.*\.local|.*\.internal)$/i;

export function urlProblem(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return 'not a valid URL';
  }
  if (u.protocol !== 'https:') return 'only https links are allowed';
  if (u.username || u.password) return 'links must not contain credentials';
  if (BLOCKED_HOSTS.test(u.hostname) || /^[0-9.]+$/.test(u.hostname) || u.hostname.includes(':'))
    return 'links to local or IP addresses are not allowed';
  return null;
}

export const MIN_BODY_SIZE = { app: 14, web: 16 } as const;

export async function validateChannel(
  c: PoolClient,
  channel: Channel,
  now = new Date(),
): Promise<ValidationReport> {
  const issues: Issue[] = [];
  const add = (level: Level, code: string, docKey: string, message: string, x: Partial<Issue> = {}) =>
    void issues.push({ level, code, docKey, message, ...x });
  const atLoc = (l: Loc) => ({ blockId: l.blockId, path: l.path });

  const rowsQ = await c.query(
    `SELECT * FROM exp_documents WHERE channel IN ('shared', $1) ORDER BY kind, key`,
    [channel],
  );
  const rows = rowsQ.rows as Array<{ channel: DocChannel; kind: DocKind; key: string; body: unknown }>;
  const facts = await loadStoreFacts(c);
  const vars = resolveVariables(facts);

  // ---------------------------------------------------------------- parse every document
  const parsed: Record<string, unknown> = {};
  for (const r of rows) {
    const label = `${r.kind}:${r.key}`;
    try {
      parsed[`${r.channel}/${label}`] = await parseDoc(c, r.channel, r.kind, r.key, r.body);
    } catch (e) {
      if (e instanceof AppError && e.details?.fields)
        for (const [p, m] of Object.entries(e.details.fields))
          add('error', 'schema.invalid', label, m, { path: p });
      else throw e;
    }
  }
  const get = (ch: string, kind: string, key: string) => parsed[`${ch}/${kind}:${key}`] as never;
  const shared = get('shared', 'tokens', 'base') as unknown as
    ReturnType<typeof DesignSystem.parse> | undefined;
  const override = get(channel, 'tokens', 'override') as { overrides: Record<string, unknown> } | undefined;
  const nav = get(channel, 'navigation', 'main') as Record<string, unknown> | undefined;
  const chrome = get(channel, 'chrome', 'main') as Record<string, unknown> | undefined;
  const pages = rows
    .filter((r) => r.channel === channel && r.kind === 'page' && parsed[`${channel}/page:${r.key}`])
    .map((r) => ({
      key: r.key,
      body: parsed[`${channel}/page:${r.key}`] as DraftSet['pages'][number]['body'],
    }));

  if (!shared) add('error', 'doc.missing', 'tokens:base', 'The shared design system has not been saved yet');
  if (!nav) add('error', 'doc.missing', 'navigation:main', 'Navigation has not been saved yet');
  if (!chrome) add('error', 'doc.missing', 'chrome:main', 'Chrome settings have not been saved yet');
  if (!pages.some((p) => p.key === 'home'))
    add('error', 'doc.missing', 'page:home', 'The home page has not been saved yet');

  // ------------------------------------------------------------------ collect references
  const col: Collected = emptyCollected();
  for (const p of pages) {
    const doc = `page:${p.key}`;
    const visible = p.body.blocks.filter((b) => b.visible);
    if (p.body.blocks.length === 0)
      add('warning', 'page.empty', doc, 'This page has no blocks; customers will see an empty page');
    else if (visible.length === 0)
      add('error', 'page.all_hidden', doc, 'Every block is hidden; customers would see nothing');
    if (p.body.blocks.length > MAX_BLOCKS[channel])
      add('error', 'page.over_limit', doc, `More than ${MAX_BLOCKS[channel]} blocks`);
    const seen = new Map<string, string>();
    for (const b of p.body.blocks) {
      collectFrom(col, doc, b.props, { id: b.id, type: b.type }, 'props');
      const sig = `${b.type}|${JSON.stringify(b.props)}`;
      if (seen.has(sig))
        add('info', 'block.possible_duplicate', doc, `Looks like a duplicate of block ${seen.get(sig)}`, {
          blockId: b.id,
        });
      else seen.set(sig, b.id);
      const sched = b.rules?.schedule;
      if (sched?.endAt && new Date(sched.endAt) < now)
        add('warning', 'schedule.in_past', doc, 'This block’s schedule has already ended', { blockId: b.id });
      if (sched?.startAt && sched.endAt && new Date(sched.endAt) <= new Date(sched.startAt))
        add('error', 'schema.invalid', doc, 'Schedule end must be after its start', {
          blockId: b.id,
          path: 'rules.schedule',
        });
    }
  }
  if (nav) collectFrom(col, 'navigation:main', nav);
  if (chrome) collectFrom(col, 'chrome:main', chrome);
  if (shared)
    collectFrom(col, 'tokens:base', {
      backdrop: shared.surfaces.backdrop.image ? { mediaId: shared.surfaces.backdrop.image } : undefined,
      families: shared.type.families,
    });

  // ---------------------------------------------------------------- entity second pass
  const idsOf = (m: IdUses) => [...m.keys()];
  const entityQ = async (table: string, ids: string[], cols: string) =>
    ids.length ? (await c.query(`SELECT ${cols} FROM ${table} WHERE id = ANY($1)`, [ids])).rows : [];

  const guides = await entityQ('care_guides', idsOf(col.careGuides), 'id, status, steps');
  const faqs = await entityQ('faq_groups', idsOf(col.faqGroups), 'id, status, items');
  const stories = await entityQ(
    'stories',
    idsOf(col.stories),
    'id, status, video_media_id, poster_media_id, alt',
  );
  const notes = await entityQ(
    'journal_notes',
    idsOf(col.journal),
    'id, status, image_media_id, alt, body_md, title, excerpt',
  );
  const testis = await entityQ(
    'testimonials',
    idsOf(col.testimonials),
    'id, status, source, consent, channels, avatar_media_id, video_media_id, poster_media_id, quote',
  );

  const checkEntity = (kind: string, uses: IdUses, found: Array<{ id: string; status: string }>) => {
    const map = new Map(found.map((f) => [f.id, f]));
    for (const [id, locs] of uses)
      for (const l of locs) {
        const e = map.get(id);
        if (!e) add('error', 'ref.entity_missing', l.doc, `${kind} "${id}" does not exist`, atLoc(l));
        else if (e.status !== 'active')
          add(
            'error',
            'ref.entity_inactive',
            l.doc,
            `${kind} "${id}" is ${e.status}; activate it first`,
            atLoc(l),
          );
      }
  };
  checkEntity('Care guide', col.careGuides, guides);
  checkEntity('FAQ group', col.faqGroups, faqs);
  checkEntity('Story', col.stories, stories);
  checkEntity('Journal note', col.journal, notes);
  checkEntity('Testimonial', col.testimonials, testis);

  for (const g of guides)
    (g.steps as Array<{ image: { mediaId: string; alt?: string } }>).forEach((s, i) =>
      collectFrom(col, `care_guide:${g.id}`, s.image, undefined, `steps.${i}.image`),
    );
  for (const s of stories) {
    col.media.push({
      doc: `story:${s.id}`,
      path: 'video',
      mediaId: s.video_media_id,
      decorative: true,
      blockType: 'web.reels_rail',
    });
    col.media.push({ doc: `story:${s.id}`, path: 'poster', mediaId: s.poster_media_id, alt: s.alt });
  }
  for (const n of notes)
    if (n.image_media_id)
      col.media.push({ doc: `journal:${n.id}`, path: 'image', mediaId: n.image_media_id, alt: n.alt });
  for (const t of testis) {
    for (const [p, v] of [
      ['avatar', t.avatar_media_id],
      ['poster', t.poster_media_id],
    ] as const)
      if (v) col.media.push({ doc: `testimonial:${t.id}`, path: p, mediaId: v, decorative: p === 'avatar' });
    if (t.video_media_id)
      col.media.push({
        doc: `testimonial:${t.id}`,
        path: 'video',
        mediaId: t.video_media_id,
        decorative: true,
        blockType: 'web.hero_film',
      });
    const locs = col.testimonials.get(t.id) ?? [];
    for (const l of locs) {
      if (t.source === 'placeholder')
        add(
          'error',
          'testimonial.placeholder',
          l.doc,
          'This testimonial is marked as a placeholder (design-reference text). Confirm it is genuine and record consent before publishing, or remove it.',
          atLoc(l),
        );
      if (t.source === 'owner_supplied' && !t.consent)
        add(
          'error',
          'testimonial.no_consent',
          l.doc,
          'Owner-supplied testimonials need a recorded consent note',
          atLoc(l),
        );
      if (!(t.channels as string[]).includes(channel))
        add(
          'warning',
          'entity.channel_mismatch',
          l.doc,
          'This testimonial is not enabled for this channel',
          atLoc(l),
        );
    }
    col.texts.push({ doc: `testimonial:${t.id}`, path: 'quote', text: t.quote });
  }
  for (const n of notes) {
    col.texts.push({ doc: `journal:${n.id}`, path: 'body', text: `${n.title}\n${n.excerpt}\n${n.body_md}` });
  }

  // -------------------------------------------------------------------------- media
  const mediaIds = [...new Set(col.media.map((m) => m.mediaId))];
  const mediaRows = mediaIds.length
    ? (
        await c.query(
          `SELECT id, kind, status, approval, archived_at, alt, decorative, bytes, role, provenance, width, height FROM media_assets WHERE id = ANY($1)`,
          [mediaIds],
        )
      ).rows
    : [];
  const media = new Map(mediaRows.map((m) => [m.id as string, m]));
  const bytesByDoc = new Map<string, number>();
  const videosByDoc = new Map<string, Set<string>>();
  for (const u of col.media) {
    const m = media.get(u.mediaId);
    const at = atLoc(u);
    if (!m) {
      add('error', 'ref.media_missing', u.doc, `Media ${u.mediaId} does not exist`, at);
      continue;
    }
    if (m.archived_at) add('error', 'ref.media_archived', u.doc, 'This media item is archived', at);
    if (m.status === 'processing')
      add('error', 'ref.media_processing', u.doc, 'This media item is still processing', at);
    else if (m.status !== 'ready')
      add('error', 'ref.media_missing', u.doc, 'This media item failed processing', at);
    if (m.approval !== 'approved')
      add(
        'error',
        'ref.media_unapproved',
        u.doc,
        `This media item is ${m.approval}; an administrator must approve it`,
        { ...at, fixHint: 'Approve it in the Media Library' },
      );
    const want = u.path.startsWith('tokens') ? 'font' : expectedMediaKind(u.blockType, u.path);
    const isFontRef = u.doc === 'tokens:base' && u.path.startsWith('families');
    const expect = isFontRef ? 'font' : want;
    if (m.kind !== expect && !(u.doc.startsWith('testimonial:') || u.doc.startsWith('story:')))
      add('error', 'ref.media_wrong_kind', u.doc, `Expected a ${expect} but this is a ${m.kind}`, at);
    if (m.kind === 'image') {
      const alt = (u.alt ?? m.alt ?? '').trim();
      if (!(u.decorative ?? m.decorative) && alt.length < 3)
        add('error', 'a11y.alt_missing', u.doc, 'Add alt text (or mark the image decorative)', at);
    }
    if ((m.kind === 'image' || m.kind === 'video') && u.blockType) {
      const slot = slotFor(
        u.blockType,
        u.path
          .replace(/^props\./, '')
          .replace(/\.\d+(?=\.|$)/g, '[]')
          .replace(/\[\]\./g, '[].'),
      );
      const miss = slot ? checkAgainstSlot(slot, m.width as number | null, m.height as number | null) : null;
      if (miss)
        add(
          'warning',
          miss.problem === 'too_small' ? 'media.slot_too_small' : 'media.slot_shape',
          u.doc,
          miss.detail,
          {
            ...at,
            fixHint: `This slot wants at least ${miss.slot.minWidth}${miss.slot.minHeight ? `x${miss.slot.minHeight}` : ' px wide'}, shape ${miss.slot.aspect ?? 'any'}`,
          },
        );
    }
    if (m.role === 'product_packshot' && !['original_photo', 'edited_photo'].includes(m.provenance))
      add(
        'error',
        'ref.media_unapproved',
        u.doc,
        'Product pack-shots must come from original photography',
        at,
      );
    bytesByDoc.set(u.doc, (bytesByDoc.get(u.doc) ?? 0) + Number(m.bytes));
    if (m.kind === 'video') {
      const s = videosByDoc.get(u.doc) ?? new Set<string>();
      s.add(u.mediaId);
      videosByDoc.set(u.doc, s);
    }
  }
  for (const [doc, b] of bytesByDoc)
    if (b > 40 * 1024 * 1024)
      add(
        'warning',
        'perf.page_weight',
        doc,
        `Referenced media totals ${(b / 1048576).toFixed(0)} MB; consider lighter assets`,
      );
  for (const [doc, s] of videosByDoc)
    if (s.size > 6) add('warning', 'perf.many_videos', doc, `${s.size} different videos on one page`);
  // hero film must have a distinct mobile cut
  for (const p of pages)
    for (const b of p.body.blocks)
      if (b.type === 'web.hero_film') {
        const f = b.props.film as { desktop: { mediaId: string }; mobile: { mediaId: string } };
        if (f.desktop.mediaId === f.mobile.mediaId)
          add(
            'error',
            'video.mobile_variant_missing',
            `page:${p.key}`,
            'The hero film needs a separate vertical (9:16) mobile cut',
            { blockId: b.id, path: 'props.film.mobile' },
          );
      }

  // ------------------------------------------------------------------ products / collections
  const productIds = idsOf(col.products);
  const prodRows = productIds.length
    ? (await c.query(`SELECT id, active, archived_at FROM products WHERE id = ANY($1)`, [productIds])).rows
    : [];
  const prods = new Map(prodRows.map((p) => [p.id as string, p]));
  const stockRows = productIds.length
    ? (
        await c.query(
          `SELECT v.product_id, coalesce(sum(greatest(i.on_hand - i.reserved, 0)), 0)::int AS avail FROM product_variants v LEFT JOIN inventory_positions i ON i.variant_id = v.id WHERE v.product_id = ANY($1) AND v.active GROUP BY v.product_id`,
          [productIds],
        )
      ).rows
    : [];
  const stock = new Map(stockRows.map((s) => [s.product_id as string, s.avail as number]));
  for (const [id, locs] of col.products)
    for (const l of locs) {
      const p = prods.get(id);
      if (!p) add('error', 'ref.product_missing', l.doc, `Product "${id}" does not exist`, atLoc(l));
      else if (!p.active || p.archived_at)
        add('error', 'ref.product_inactive', l.doc, `Product "${id}" is not active`, atLoc(l));
      else if ((stock.get(id) ?? 0) <= 0)
        add('warning', 'link.target_out_of_stock', l.doc, `Product "${id}" is out of stock`, atLoc(l));
    }
  const catIds = idsOf(col.categories);
  if (catIds.length) {
    const found = new Set(
      (await c.query(`SELECT id FROM categories WHERE id = ANY($1) AND active`, [catIds])).rows.map(
        (r) => r.id as string,
      ),
    );
    for (const [id, locs] of col.categories)
      if (!found.has(id))
        for (const l of locs)
          add('error', 'ref.link_invalid', l.doc, `Category "${id}" does not exist or is inactive`, atLoc(l));
  }
  for (const [slug, locs] of col.collections) {
    const k = (await c.query(`SELECT visible FROM collections WHERE id = $1`, [slug])).rows[0];
    if (!k || !k.visible) {
      for (const l of locs)
        add(
          'error',
          'ref.collection_missing',
          l.doc,
          `Collection "${slug}" does not exist or is hidden`,
          atLoc(l),
        );
      continue;
    }
    const n = (await resolveCollectionProductIds(c, slug)).length;
    for (const l of locs) {
      if (n === 0 && l.blockType)
        add(
          'warning',
          'binding.rail_empty',
          l.doc,
          `Collection "${slug}" currently has no products`,
          atLoc(l),
        );
      else if (n < 3 && l.blockType)
        add('info', 'binding.rail_sparse', l.doc, `Collection "${slug}" has only ${n} product(s)`, atLoc(l));
    }
  }

  // --------------------------------------------------------------------------- actions
  const customPages = new Set(
    (await c.query(`SELECT key FROM exp_documents WHERE channel = 'web' AND kind = 'page'`)).rows.map(
      (r) => r.key as string,
    ),
  );
  const policySlugs = new Set(
    (await c.query(`SELECT slug FROM content_pages WHERE status = 'published'`)).rows.map(
      (r) => r.slug as string,
    ),
  );
  for (const a of col.actions) {
    const t = a.action.type;
    if (!ACTION_TYPES.has(t)) continue;
    const at = atLoc(a);
    if (t === 'screen' && channel !== 'app')
      add('error', 'ref.link_invalid', a.doc, '"Open app screen" only works in the app', at);
    if ((t === 'route' || t === 'anchor') && channel !== 'web')
      add('error', 'ref.link_invalid', a.doc, 'Website routes only work on the website', at);
    if (t === 'url') {
      const prob = urlProblem(String(a.action.url));
      if (prob) add('error', 'ref.link_scheme_blocked', a.doc, `Link rejected: ${prob}`, at);
    }
    if (t === 'page') {
      const key = String(a.action.pageKey);
      if (!(customPages.has(key) || policySlugs.has(key)))
        add('error', 'ref.link_invalid', a.doc, `Page "${key}" does not exist or is not published`, at);
    }
  }

  // ----------------------------------------------------------------------------- copy
  const known = new Set<string>(VARIABLE_NAMES);
  for (const t of col.texts) {
    const at = atLoc(t);
    for (const v of scanVariables(t.text)) {
      if (!known.has(v)) add('error', 'var.unknown', t.doc, `Unknown variable {{${v}}}`, at);
      else if ((vars as Record<string, string | null>)[v] == null)
        add('error', 'var.unresolved', t.doc, `{{${v}}} has no value yet; set it in Settings`, at);
    }
    const stripped = t.text.replace(/\{\{[^}]*\}\}/g, '');
    if (PRICE_LITERAL.test(stripped))
      add(
        'warning',
        'copy.price_literal',
        t.doc,
        'This copy contains a price; use a variable such as {{store.shippingFee}} so it never goes stale',
        at,
      );
    const low = stripped.toLowerCase();
    for (const w of CLAIM_WORDS)
      if (low.includes(w))
        add('warning', 'copy.claim_unsubstantiated', t.doc, `“${w}” is a claim that usually needs evidence`, {
          ...at,
          fixHint: 'Keep supporting evidence on file, or soften the wording',
        });
    if (t.text.length > 6000) add('error', 'text.too_long', t.doc, 'Text is too long', at);
  }

  // ------------------------------------------------------------ navigation + chrome + SEO
  if (nav) {
    if (channel === 'app') {
      const tabs = (nav.bottomTabs as Array<{ key: string; visible: boolean; action?: unknown }>) ?? [];
      const vis = tabs.filter((t) => t.visible);
      if (vis.length < 3)
        add('error', 'nav.min_tabs', 'navigation:main', 'At least three bottom tabs must be visible');
      for (const need of ['cart', 'profile'])
        if (!vis.some((t) => t.key === need))
          add('error', 'nav.required_missing', 'navigation:main', `The ${need} tab is required`);
      if (tabs.some((t) => t.key === 'custom' && !t.action))
        add('error', 'nav.required_missing', 'navigation:main', 'A custom tab needs an action');
    } else {
      const links = (nav.links as unknown[]) ?? [];
      if (links.length < 2)
        add('error', 'nav.min_tabs', 'navigation:main', 'The header needs at least two links');
    }
  }
  if (channel === 'web') {
    const titles = new Map<string, string>();
    for (const p of pages) {
      if (p.key.startsWith('product:')) continue;
      const t = p.body.seo?.title?.trim();
      if (!t) add('error', 'seo.title_missing', `page:${p.key}`, 'Add an SEO title for this page');
      else if (titles.has(t.toLowerCase()))
        add(
          'error',
          'seo.title_duplicate',
          `page:${p.key}`,
          `Same SEO title as page "${titles.get(t.toLowerCase())}"`,
        );
      else titles.set(t.toLowerCase(), p.key);
    }
  }

  // ------------------------------------------------------------------------- tokens
  if (shared) {
    const resolved = override ? (deepMerge(shared, override.overrides) as typeof shared) : shared;
    const R = resolved.color.roles;
    const need = (fg: string, bg: string, min: number, label: string, code = 'a11y.contrast_fail') => {
      const cr = contrast(fg, bg);
      if (cr !== null && cr < min)
        add(
          'error',
          code,
          'tokens:' + (override ? 'override' : 'base'),
          `${label}: contrast ${cr.toFixed(2)}:1 is below ${min}:1`,
          { fixHint: 'Pick a lighter text colour or darker background' },
        );
    };
    for (const bg of ['bg.base', 'bg.raised', 'bg.elevated'] as const) {
      need(R['text.primary'], R[bg], 4.5, `text.primary on ${bg}`);
      need(R['text.secondary'], R[bg], 4.5, `text.secondary on ${bg}`);
    }
    need(R['text.onAccent'], R['accent.primary'], 4.5, 'text.onAccent on accent.primary');
    need(R['focus.ring'], R['bg.base'], 3, 'focus.ring on bg.base');
    for (const s of ['state.success', 'state.error', 'state.warning', 'state.info'] as const)
      need(R[s], R['bg.base'], 4.5, `${s} on bg.base`);
    const scale = resolved.type.scale;
    if (scale.body.size < MIN_BODY_SIZE[channel])
      add(
        'error',
        'a11y.font_too_small',
        'tokens:base',
        `Body text must be at least ${MIN_BODY_SIZE[channel]}${channel === 'app' ? 'sp' : 'px'}`,
      );
    if (scale.label.size < 11 || scale.small.size < 11)
      add('error', 'a11y.font_too_small', 'tokens:base', 'Labels and small text must be at least 11');
    if (resolved.components.button.minHeight < 44 || resolved.components.input.minHeight < 44)
      add('error', 'a11y.target_too_small', 'tokens:base', 'Buttons and inputs must be at least 44 high');
    const palette = new Set(Object.values(resolved.color.palette).map((h) => h.toLowerCase()));
    for (const [name, g] of Object.entries(resolved.color.gradients))
      if (g.stops.some((s) => !palette.has(s.color.toLowerCase())))
        add(
          'warning',
          'token.gradient_off_palette',
          'tokens:base',
          `Gradient "${name}" uses colours outside the brand palette`,
        );
    if (override)
      for (const role of Object.keys(R) as Array<keyof typeof R>) {
        const d = deltaE(shared.color.roles[role], R[role]);
        if (d !== null && d > 8)
          add(
            'info',
            'channel.token_diverged',
            'tokens:override',
            `${role} differs from the shared brand colour (ΔE ${d.toFixed(0)})`,
          );
      }
  }

  // ---------------------------------------------------------------- campaign overlaps
  const camps = (
    await c.query(
      `SELECT id, name, starts_at, ends_at FROM exp_campaigns WHERE status = 'active' AND ${channel} IS NOT NULL ORDER BY starts_at`,
    )
  ).rows;
  for (let i = 1; i < camps.length; i++)
    if (new Date(camps[i].starts_at) < new Date(camps[i - 1].ends_at))
      add(
        'error',
        'schedule.overlap',
        'campaigns',
        `Campaigns "${camps[i - 1].name}" and "${camps[i].name}" overlap`,
      );

  const errors = issues.filter((i) => i.level === 'error');
  return {
    errors,
    warnings: issues.filter((i) => i.level === 'warning'),
    infos: issues.filter((i) => i.level === 'info'),
    canPublish: errors.length === 0,
    checkedAt: now.toISOString(),
  };
}
