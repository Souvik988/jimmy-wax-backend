import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { exp } from '@jw/commerce-domain';
import { startHarness } from './harness.ts';
import { appChrome, appNav, designSystem, webChrome, webNav } from './experienceFixtures.ts';

/**
 * Golden-file contract tests for GET /v1/experience/{app,web}: a fixed release snapshot + fixed store facts + fixed clock must
 * assemble to byte-identical JSON. Any intended change to the bundle shape or behaviour shows up as a reviewable diff of
 * test/golden/*.json (regenerate with UPDATE_GOLDEN=1).
 */
const NOW = new Date('2026-10-10T10:00:00.000Z');
const MEDIA_ID = '11111111-1111-4111-8111-111111111111';
const POSTER_ID = '22222222-2222-4222-8222-222222222222';
const GOLDEN_DIR = resolve(import.meta.dirname, '../golden');

let h: Awaited<ReturnType<typeof startHarness>>;
let cat: { id: string; token: string };

const P = (n: string) => `golden-${n}`;
beforeAll(async () => {
  h = await startHarness();
  cat = await h.staff('catalog');
  await h.sup.query(
    `UPDATE store_settings SET brand_name = 'JIMMY & WAX', shipping_fee_paise = 4000, free_shipping_threshold_paise = 99900, cod_fee_paise = 2500,
            delivery_estimate = '3-6 business days', gst_rate_bps = 1800, support_email = 'care@example.test', support_phone = '+91 99999 00000'`,
  );
  for (const n of ['a', 'b', 'c']) {
    const r = await h.call('POST', '/v1/admin/products', cat.token, {
      id: P(n),
      name: `Golden ${n}`,
      categoryId: 'polish',
      tags: ['golden-set'],
      variants: [
        { id: P(n), sku: `GOLD-${n}`.toUpperCase(), title: 'Standard', pricePaise: 10000 + n.charCodeAt(0) },
      ],
    });
    expect(r.status).toBe(201);
    await h.sup.query(`UPDATE products SET active = true WHERE id = $1`, [P(n)]);
    await h.sup.query(`UPDATE product_variants SET active = true WHERE product_id = $1`, [P(n)]);
  }
  await h.fx.setStock(P('a'), 5);
  await h.fx.setStock(P('b'), 0); // sold out
  await h.fx.setStock(P('c'), 5);
  const col = await h.call('POST', '/v1/admin/collections', cat.token, {
    id: 'golden-col',
    name: 'Golden collection',
    kind: 'manual',
    productIds: [P('b'), P('a'), P('c')],
  });
  expect(col.status).toBe(201);
});
afterAll(async () => {
  await h.close();
});

const media = {
  [MEDIA_ID]: {
    id: MEDIA_ID,
    kind: 'image',
    url: '/v1/media/aaaa/orig.webp',
    width: 1600,
    height: 1000,
    alt: 'A leather boot being polished',
    decorative: false,
    variants: [{ url: '/v1/media/aaaa/w640.webp', width: 640 }],
    poster: null,
    bundledKey: 'assets/runtime/banners/hero.jpg',
  },
  [POSTER_ID]: {
    id: POSTER_ID,
    kind: 'image',
    url: '/v1/media/bbbb/orig.webp',
    width: 1920,
    height: 1080,
    alt: 'Poster',
    decorative: false,
    variants: [],
    poster: null,
    bundledKey: null,
  },
};
const rail = (id: string, source: unknown, limit = 6) => ({
  id,
  type: 'app.product_rail',
  visible: true,
  props: { title: 'Rail', source, limit, card: 'standard' },
});
const snapshot = (channel: 'app' | 'web') => {
  const docs: Record<string, unknown> =
    channel === 'app'
      ? {
          'tokens:base': designSystem(),
          'navigation:main': appNav(),
          'chrome:main': appChrome(),
          'page:home': {
            schemaVersion: 1,
            blocks: [
              {
                id: 'blk-hero-0001',
                type: 'app.hero_carousel',
                visible: true,
                props: {
                  slides: [
                    {
                      id: 'slide-0001',
                      image: { mediaId: MEDIA_ID, alt: 'Shine' },
                      textInImage: true,
                      action: { type: 'screen', screen: 'categories' },
                      a11yLabel: 'Shine that lasts',
                    },
                  ],
                  aspectRatio: '3:2',
                  autoplay: { enabled: false, intervalMs: 5000 },
                  dots: true,
                },
              },
              {
                id: 'blk-ann-0001',
                type: 'app.announcement_bar',
                visible: true,
                props: {
                  text: 'Delivery {{store.deliveryEstimate}} · free above {{store.freeShippingThreshold}}',
                  tone: 'info',
                  dismissible: true,
                },
              },
              rail('blk-rail-0001', { kind: 'collection', slug: 'golden-col' }),
              rail('blk-rail-0002', { kind: 'manual', productIds: [P('b'), P('a'), 'does-not-exist'] }),
              { id: 'blk-hid-0001', type: 'app.spacer', visible: false, props: { height: 16 } },
              {
                id: 'blk-late-0001',
                type: 'app.banner',
                visible: true,
                rules: { schedule: { startAt: '2027-01-01T00:00:00.000Z' } },
                props: {
                  image: { mediaId: MEDIA_ID, alt: 'Later' },
                  action: { type: 'none' },
                  aspectRatio: '16:9',
                  radius: 'card',
                },
              },
            ],
          },
          'page:product': {
            schemaVersion: 1,
            nativeSections: [
              { key: 'gallery', visible: true },
              { key: 'reviews', visible: false },
            ],
            blocks: [],
          },
        }
      : {
          'tokens:base': designSystem(),
          'navigation:main': webNav(),
          'chrome:main': webChrome(),
          'page:home': {
            schemaVersion: 1,
            seo: {
              title: 'Jimmy & Wax',
              description: 'Leather care staged as a quiet ritual, not a chore, for the pieces you keep.',
              noindex: false,
              structuredData: { organization: true, product: false, breadcrumb: false },
            },
            blocks: [
              {
                id: 'blk-grid-0001',
                type: 'web.product_grid',
                visible: true,
                props: {
                  title: 'Golden picks',
                  source: { kind: 'collection', slug: 'golden-col' },
                  columns: 3,
                  limit: 9,
                },
              },
              {
                id: 'blk-img-0001',
                type: 'web.image',
                visible: true,
                props: { image: { mediaId: MEDIA_ID, alt: 'Boot' }, caption: 'Care by {{brand.name}}' },
              },
            ],
          },
          'page:custom:story-extra': {
            schemaVersion: 1,
            title: 'Extra story',
            seo: {
              title: 'Extra story page',
              description: 'A custom page served from the Studio, with its own search appearance settings.',
              noindex: false,
              structuredData: { organization: true, product: false, breadcrumb: false },
            },
            blocks: [
              {
                id: 'blk-rt-0001',
                type: 'web.rich_text',
                visible: true,
                props: { markdown: 'Support: {{store.supportEmail}}' },
              },
            ],
          },
          [`page:product:${P('a')}`]: {
            schemaVersion: 1,
            nativeSections: [{ key: 'related', visible: false }],
            blocks: [],
          },
        };
  return {
    schemaVersion: 1 as const,
    channel: channel,
    builtAt: NOW.toISOString(),
    docs,
    entities: {
      careGuides: {},
      faqGroups: {},
      stories: {},
      journal: {},
      testimonials: {},
      announcements: [
        { id: 'ann-1', text: 'Welcome to {{brand.name}}', tone: 'info', startsAt: null, endsAt: null },
      ],
    },
    media,
    collections: {},
    campaigns: [
      {
        id: 'c0000000-0000-4000-8000-000000000001',
        name: 'Active glow',
        startsAt: '2026-10-01T00:00:00.000Z',
        endsAt: '2026-10-31T00:00:00.000Z',
        overlay: {
          tokens: { color: { roles: { 'accent.primary': '#F5C968' } } },
          announcement: { text: 'Festival offers are live', tone: 'promo' },
        },
      },
      {
        id: 'c0000000-0000-4000-8000-000000000002',
        name: 'Next month',
        startsAt: '2026-11-01T00:00:00.000Z',
        endsAt: '2026-11-30T00:00:00.000Z',
        overlay: { announcement: { text: 'Not yet', tone: 'info' } },
      },
    ],
  };
};

async function build(channel: 'app' | 'web', header?: string) {
  const client = exp.parseClientHeader(header, channel);
  const src = {
    enabled: true,
    release: {
      id: 'r0000000-0000-4000-8000-000000000001',
      number: 7,
      label: 'Golden',
      publishedAt: '2026-10-09T09:00:00.000Z',
    },
    snapshot: snapshot(channel) as never,
  };
  return h.db.tx({ kind: 'anonymous' }, (c) => exp.assembleBundle(c, channel, src, client, NOW));
}

function golden(name: string, actual: unknown) {
  const file = resolve(GOLDEN_DIR, `${name}.json`);
  const text = `${JSON.stringify(actual, null, 2)}\n`;
  if (process.env.UPDATE_GOLDEN === '1') {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
    return;
  }
  expect(text, `golden file ${name}.json differs - review and regenerate with UPDATE_GOLDEN=1`).toBe(
    readFileSync(file, 'utf8'),
  );
}

describe('experience bundle golden files', () => {
  it('app bundle: facts substituted, schedule/visibility applied, campaigns by time, sources resolved with out-of-stock rule', async () => {
    const out = await build(
      'app',
      'app/1.4.0+22; platform=android; caps=app.hero_carousel,app.announcement_bar,app.product_rail,app.spacer,app.banner',
    );
    golden('bundle-app', { etag: out.etag, bundle: out.bundle });
    const home = (
      out.bundle as unknown as {
        pages: {
          home: {
            blocks: Array<{ id: string; resolved?: { productIds: string[]; outOfStockIds: string[] } }>;
          };
        };
      }
    ).pages.home.blocks;
    expect(home.map((b) => b.id)).toEqual([
      'blk-hero-0001',
      'blk-ann-0001',
      'blk-rail-0001',
      'blk-rail-0002',
    ]);
    expect(home[2]!.resolved).toEqual({ productIds: [P('a'), P('c'), P('b')], outOfStockIds: [P('b')] }); // sold-out b moved last
    expect(home[3]!.resolved).toEqual({ productIds: [P('b'), P('a')], outOfStockIds: [P('b')] }); // manual keeps the editor order, unknown id dropped
  });

  it('app bundle for an older build holds back block types it cannot draw', async () => {
    const out = await build('app', 'app/1.0.0+3; platform=ios; caps=app.hero_carousel');
    golden('bundle-app-lean', { etag: out.etag, bundle: out.bundle });
    const b = out.bundle as unknown as {
      pages: { home: { blocks: Array<{ type: string }> } };
      diagnostics: { heldBack: Record<string, number> };
    };
    expect(b.pages.home.blocks.map((x) => x.type)).toEqual(['app.hero_carousel']);
    expect(b.diagnostics.heldBack).toEqual({ 'app.announcement_bar': 1, 'app.product_rail': 2 });
  });

  it('web bundle: seo on every page, custom: and product: pages, native section visibility, media with bundledKey', async () => {
    const out = await build('web', 'web/abc123');
    golden('bundle-web', { etag: out.etag, bundle: out.bundle });
    const pages = (
      out.bundle as unknown as { pages: Record<string, { seo?: unknown; nativeSections?: unknown }> }
    ).pages;
    expect(Object.keys(pages).sort()).toEqual(['custom:story-extra', 'home', `product:${P('a')}`]);
    expect(pages.home!.seo).toBeDefined();
    expect(pages['custom:story-extra']!.seo).toBeDefined();
    expect(pages[`product:${P('a')}`]!.nativeSections).toEqual([{ key: 'related', visible: false }]);
  });

  it('kill switch and empty states: enabled:false carries no pages', async () => {
    const out = await h.db.tx({ kind: 'anonymous' }, (c) =>
      exp.assembleBundle(c, 'web', { enabled: false, release: null, snapshot: null }, {}, NOW),
    );
    expect(out.bundle).toMatchObject({ enabled: false, pages: {} });
  });
});
