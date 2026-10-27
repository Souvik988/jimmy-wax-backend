/**
 * Seeds the Experience Studio with TODAY'S look, so release 1 reproduces what the app and website already show.
 *
 *   DATABASE_URL=postgres://jw_api_login:***@host/db  PG_ADMIN_URL=postgres://postgres:***@host/db \
 *   tsx scripts/seed-baseline-experience.ts --admin-email owner@example.com [--attest-packaging] [--dry-run] [--force-release]
 *
 * - Uploads the existing app/website pictures and films into the media library (content-addressed: re-running is safe),
 *   links app pictures to their bundled asset paths, and approves them.
 * - Saves tokens, navigation, chrome, the care guide, the testimonials and the home pages (both channels).
 * - Validates and publishes release 1 for both channels (skipped when a release already exists, unless --force-release).
 *
 * --attest-packaging records, on YOUR behalf, that generated imagery does not alter product packaging or labels
 * (the library refuses to approve generated images without it). Only pass it if that is true.
 * The testimonials below are the owner's design-reference stories already shown in the app: they are recorded as
 * "owner_supplied" with a consent note that says exactly that. Replace them with verified reviews or confirmed
 * consent before promoting them as real customer voices.
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import pg from 'pg';
import { createDb } from '@jw/database';
import { LocalDiskStorage, mediaKey, processLibraryMedia } from '@jw/integrations';
import { exp, insertMedia, reviewMedia, updateMedia } from '@jw/commerce-domain';
import {
  appChrome,
  appNav,
  designSystem,
  webChrome,
  webNav,
} from '../apps/commerce-api/test/integration/experienceFixtures.ts';

const flag = (n: string) => process.argv.includes(`--${n}`);
const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > -1 ? process.argv[i + 1] : undefined;
};
const DRY = flag('dry-run');
const ATTEST = flag('attest-packaging');
const adminEmail = arg('admin-email');
if (!adminEmail) throw new Error('--admin-email is required (an existing administrator)');
if (!process.env.DATABASE_URL || !process.env.PG_ADMIN_URL)
  throw new Error(
    'DATABASE_URL (API role) and PG_ADMIN_URL (owner, to look up the administrator) are required',
  );

const APP = process.env.APP_ASSETS ?? 'C:/Users/MSI/OneDrive/Desktop/jimmy&wax_app/assets/runtime';
const WEB = process.env.WEB_ASSETS ?? 'C:/Users/MSI/OneDrive/Desktop/jimmy_nd _wax_website/public';
const STORAGE_DIR = process.env.STORAGE_DIR ?? resolve(import.meta.dirname, '../../.data/storage');

type Prov = 'original_photo' | 'edited_photo' | 'generated';
interface Asset {
  key: string;
  file: string;
  alt: string;
  provenance: Prov;
  bundledKey?: string;
  decorative?: boolean;
  poster?: string; // key of another asset (required for video)
  role?: string;
}
const app = (rel: string) => `${APP}/${rel}`;
const web = (rel: string) => `${WEB}/${rel}`;
const bk = (rel: string) => `assets/runtime/${rel}`;

const ASSETS: Asset[] = [
  // ---- app: hero campaign art
  {
    key: 'hero1',
    file: app('banners/jimmy_wax_home_hero_shine_that_lasts_v01.jpg'),
    alt: 'Shine That Lasts. Premium care for every step',
    provenance: 'edited_photo',
    bundledKey: bk('banners/jimmy_wax_home_hero_shine_that_lasts_v01.jpg'),
  },
  {
    key: 'hero2',
    file: app('banners/jimmy_wax_home_hero_complete_leather_care_v01.jpg'),
    alt: 'Complete Leather Care. Everything your shoes need',
    provenance: 'edited_photo',
    bundledKey: bk('banners/jimmy_wax_home_hero_complete_leather_care_v01.jpg'),
  },
  {
    key: 'hero3',
    file: app('banners/jimmy_wax_home_hero_restore_protect_shine_v01.jpg'),
    alt: 'Restore. Protect. Shine. Premium leather care',
    provenance: 'edited_photo',
    bundledKey: bk('banners/jimmy_wax_home_hero_restore_protect_shine_v01.jpg'),
  },
  {
    key: 'hero4',
    file: app('banners/jimmy_wax_home_hero_premium_care_every_step_v01.jpg'),
    alt: 'Premium Care For Every Step. The complete shoe care ritual',
    provenance: 'edited_photo',
    bundledKey: bk('banners/jimmy_wax_home_hero_premium_care_every_step_v01.jpg'),
  },
  // ---- app: category shortcuts
  {
    key: 'cat-polish',
    file: app('category_experience/category_leather_polish_v01.webp'),
    alt: 'Leather polish',
    provenance: 'edited_photo',
    bundledKey: bk('category_experience/category_leather_polish_v01.webp'),
  },
  {
    key: 'cat-kits',
    file: app('category_experience/category_cleaning_kit_v01.webp'),
    alt: 'Care kits',
    provenance: 'edited_photo',
    bundledKey: bk('category_experience/category_cleaning_kit_v01.webp'),
  },
  {
    key: 'cat-acc',
    file: app('category_experience/category_brush_tools_v01.webp'),
    alt: 'Brushes and accessories',
    provenance: 'edited_photo',
    bundledKey: bk('category_experience/category_brush_tools_v01.webp'),
  },
  {
    key: 'cat-gift',
    file: app('category_experience/category_gift_packs_v01.webp'),
    alt: 'Gift packs',
    provenance: 'edited_photo',
    bundledKey: bk('category_experience/category_gift_packs_v01.webp'),
  },
  // ---- app: benefits and care ritual photography
  {
    key: 'photo-polish',
    file: app('products/twinkle_shine_polish_and_brown_shoe_v01.jpg'),
    alt: 'Twinkle Shine polish beside a brown leather shoe',
    provenance: 'original_photo',
    bundledKey: bk('products/twinkle_shine_polish_and_brown_shoe_v01.jpg'),
  },
  {
    key: 'photo-black',
    file: app('products/jimmy_wax_black_shoe_care_v01.jpg'),
    alt: 'Jimmy Wax polish beside a finished black leather shoe',
    provenance: 'original_photo',
    bundledKey: bk('products/jimmy_wax_black_shoe_care_v01.jpg'),
  },
  {
    key: 'photo-kit',
    file: app('products/jimmy_wax_complete_care_kit_v01.jpg'),
    alt: 'Jimmy Wax care kit with a brush and microfiber cloth',
    provenance: 'original_photo',
    bundledKey: bk('products/jimmy_wax_complete_care_kit_v01.jpg'),
  },
  {
    key: 'edu-sponge',
    file: app('education/twinkle_shine_apply_to_sponge_v01.jpg'),
    alt: 'Twinkle Shine polish being dispensed onto a yellow sponge',
    provenance: 'original_photo',
    bundledKey: bk('education/twinkle_shine_apply_to_sponge_v01.jpg'),
  },
  {
    key: 'edu-cloth',
    file: app('education/twinkle_shine_apply_to_cloth_v01.jpg'),
    alt: 'Buffing a leather shoe with a cloth',
    provenance: 'original_photo',
    bundledKey: bk('education/twinkle_shine_apply_to_cloth_v01.jpg'),
  },
  // ---- app: testimonial artwork
  {
    key: 'testi-hero',
    file: app('testimonials/jimmy_wax_testimonial_hero.webp'),
    alt: 'What customers say. Real people. Real shine. Real stories.',
    provenance: 'edited_photo',
    bundledKey: bk('testimonials/jimmy_wax_testimonial_hero.webp'),
  },
  {
    key: 'av1',
    file: app('testimonials/08_avatar_1.png'),
    alt: 'Avatar',
    decorative: true,
    provenance: 'illustration',
    bundledKey: bk('testimonials/08_avatar_1.png'),
  },
  {
    key: 'av2',
    file: app('testimonials/09_avatar_2.png'),
    alt: 'Avatar',
    decorative: true,
    provenance: 'illustration',
    bundledKey: bk('testimonials/09_avatar_2.png'),
  },
  {
    key: 'av3',
    file: app('testimonials/10_avatar_3.png'),
    alt: 'Avatar',
    decorative: true,
    provenance: 'illustration',
    bundledKey: bk('testimonials/10_avatar_3.png'),
  },
  {
    key: 'av4',
    file: app('testimonials/11_avatar_4.png'),
    alt: 'Avatar',
    decorative: true,
    provenance: 'illustration',
    bundledKey: bk('testimonials/11_avatar_4.png'),
  },
  // ---- website: hero film, promo film, closing picture
  {
    key: 'w-hero-poster',
    file: web('media/products/collection-still-v5.jpg'),
    alt: 'The Jimmy and Wax collection staged under the studio key light',
    provenance: 'edited_photo',
  },
  {
    key: 'w-hero-film',
    file: web('media/generated/video/desktop/hero-collection-film-v5-1080p.mp4'),
    alt: 'The Jimmy and Wax collection, in one continuous film',
    provenance: 'generated',
    decorative: true,
    poster: 'w-hero-poster',
  },
  {
    key: 'w-hero-mobile',
    file: web('media/generated/video/desktop/hero-collection-film-v5-mobile.mp4'),
    alt: 'The Jimmy and Wax collection, in one continuous film (vertical cut)',
    provenance: 'generated',
    decorative: true,
    poster: 'w-hero-poster',
  },
  {
    key: 'w-promo-poster',
    file: web('media/products/story/promo-poster-v2.jpg'),
    alt: 'The Jimmy and Wax brand film poster',
    provenance: 'edited_photo',
  },
  {
    key: 'w-promo-film',
    file: web('media/generated/video/desktop/promo-twinkle-shine-v2.mp4'),
    alt: 'The Jimmy and Wax film',
    provenance: 'generated',
    decorative: true,
    poster: 'w-promo-poster',
  },
];

const LICENSE =
  'Owner-supplied asset already shipped in the JIMMY WAX app or website; provenance recorded by the baseline seed tool, to be confirmed by the owner.';

const ids = new Map<string, string>();
const log = (...a: unknown[]) => console.log(...a);

async function main() {
  const pgc = new pg.Client({ connectionString: process.env.PG_ADMIN_URL });
  await pgc.connect();
  const who = await pgc.query(
    `SELECT a.user_id, a.role FROM admin_users a JOIN auth.users u ON u.id = a.user_id WHERE lower(u.email) = lower($1) AND NOT a.disabled`,
    [adminEmail],
  );
  await pgc.end();
  if (!who.rows[0]) throw new Error(`No active operator with email ${adminEmail}`);
  if (who.rows[0].role !== 'admin')
    throw new Error('The seeding operator must have the admin role (media approval is administrator-only)');
  const x = { adminId: who.rows[0].user_id as string, role: 'admin' as const, requestId: 'baseline-seed' };

  const db = createDb({
    url: process.env.DATABASE_URL!,
    poolMax: 4,
    statementTimeoutMs: 120_000,
    lockTimeoutMs: 5_000,
    appName: 'seed-baseline',
  });
  const actor = { kind: 'admin' as const, userId: x.adminId, role: x.role };
  const storage = new LocalDiskStorage(STORAGE_DIR);

  // ------------------------------------------------------------------ media
  for (const a of ASSETS) {
    if (!existsSync(a.file)) throw new Error(`Missing asset file: ${a.file}`);
  }
  log(`media: ${ASSETS.length} files, storage ${STORAGE_DIR}${DRY ? ' (dry run: nothing is written)' : ''}`);
  if (DRY) return void (await db.close());
  for (const a of ASSETS) {
    const buf = readFileSync(a.file);
    const processed = await processLibraryMedia(buf);
    for (const f of processed.files) await storage.put(mediaKey(processed.sha256, f.file), f.data);
    const row = await db.tx(actor, (c) =>
      insertMedia(c, x, processed, {
        filename: basename(a.file),
        alt: a.alt,
        provenance: a.provenance,
        folder: a.key.startsWith('w-') ? 'website' : 'app',
        license: LICENSE,
      }),
    );
    ids.set(a.key, row.asset.id as string);
  }
  for (const a of ASSETS) {
    const id = ids.get(a.key)!;
    await db.tx(actor, async (c) => {
      await updateMedia(c, x, id, {
        alt: a.decorative ? undefined : a.alt,
        decorative: a.decorative ?? false,
        bundledKey: a.bundledKey ?? null,
        license: LICENSE,
        provenance: a.provenance,
        ...(a.poster ? { posterMediaId: ids.get(a.poster)! } : {}),
      });
    });
  }
  for (const a of ASSETS) {
    const id = ids.get(a.key)!;
    const cur = await db.tx(actor, (c) => c.query(`SELECT approval FROM media_assets WHERE id = $1`, [id]));
    if (cur.rows[0].approval === 'approved') continue;
    if (a.provenance === 'generated' && !ATTEST) {
      log(`  not approved (needs --attest-packaging): ${a.key}`);
      continue;
    }
    await db.tx(actor, (c) =>
      reviewMedia(c, x, id, {
        approve: true,
        note: 'Baseline seed: asset already shipped to customers',
        packagingAttested: a.provenance === 'generated' ? true : undefined,
      }),
    );
  }
  const m = (key: string, alt?: string) => ({ mediaId: ids.get(key)!, ...(alt ? { alt } : {}) });

  // ----------------------------------------------------------------- content
  const consent = {
    recordedAt: new Date().toISOString(),
    note: 'Owner supplied these text testimonials as design references already shown in the app and asked for them to be kept; underlying customer consent is NOT independently verified.',
  };
  const testimonials = [
    { name: 'Rohan S.', city: 'Kolkata', quote: 'Amazing shine! My shoes look new again.', av: 'av1' },
    { name: 'Sneha P.', city: 'Mumbai', quote: 'Premium quality and very easy to use!', av: 'av2' },
    { name: 'Amit K.', city: 'Pune', quote: 'Perfect for travel! Compact and super useful.', av: 'av3' },
    { name: 'Priya M.', city: 'Bangalore', quote: 'Great quality and value for money.', av: 'av4' },
  ];
  const testimonialIds: string[] = [];
  const existing = await db.tx(actor, (c) => exp.listEntities(c, 'testimonials'));
  for (const [i, t] of testimonials.entries()) {
    const found = (existing as Array<{ id: string; name: string; quote: string }>).find(
      (e) => e.name === t.name && e.quote === t.quote,
    );
    if (found) {
      testimonialIds.push(found.id);
      continue;
    }
    const made = (await db.tx(actor, (c) =>
      exp.createEntity(c, x, 'testimonials', {
        name: t.name,
        city: t.city,
        quote: t.quote,
        rating: 5,
        source: 'owner_supplied',
        consent,
        channels: ['app'],
        avatarMediaId: ids.get(t.av),
        position: i,
        status: 'active',
      }),
    )) as { id: string };
    testimonialIds.push(made.id);
  }
  const guides = await db.tx(actor, (c) => exp.listEntities(c, 'care-guides'));
  if (!(guides as Array<{ id: string }>).some((g) => g.id === 'care-ritual')) {
    await db.tx(actor, (c) =>
      exp.createEntity(c, x, 'care-guides', {
        id: 'care-ritual',
        title: 'The care ritual',
        intro: 'Three steps to a lasting shine.',
        steps: [
          {
            label: 'Clean',
            title: 'Start with a clean slate.',
            body: 'Brush away dust. Wipe gently with a clean, dry cloth.',
            image: m('photo-kit', 'Jimmy Wax care kit with a brush and microfiber cloth'),
          },
          {
            label: 'Apply',
            title: 'A little goes a long way.',
            body: 'Use a small amount on your applicator. Spread in light, even strokes.',
            image: m('edu-sponge', 'Twinkle Shine polish being dispensed onto a yellow sponge'),
          },
          {
            label: 'Buff',
            title: 'Bring back the shine.',
            body: 'Finish with a clean, dry cloth. Buff gently for an even finish.',
            image: m('photo-black', 'Jimmy Wax polish beside a finished black leather shoe'),
          },
        ],
        status: 'active',
      }),
    );
  }

  // --------------------------------------------------------------- documents
  const save = async (
    channel: 'app' | 'web' | 'shared',
    kind: 'tokens' | 'navigation' | 'chrome' | 'page',
    key: string,
    body: unknown,
  ) => {
    await db.tx(actor, async (c) => {
      const cur = await c.query(`SELECT rev FROM exp_documents WHERE channel=$1 AND kind=$2 AND key=$3`, [
        channel,
        kind,
        key,
      ]);
      await exp.putDoc(c, x, channel, kind, key, body, cur.rows[0]?.rev ?? 0);
    });
  };
  await save('shared', 'tokens', 'base', designSystem());
  await save('app', 'navigation', 'main', appNav());
  await save('app', 'chrome', 'main', appChrome());
  await save('web', 'navigation', 'main', {
    ...webNav(),
    links: [
      { id: 'nav-shop', label: 'Shop', action: { type: 'route', path: '/shop' } },
      { id: 'nav-ritual', label: 'The ritual', action: { type: 'route', path: '/ritual' } },
      { id: 'nav-story', label: 'Our standard', action: { type: 'route', path: '/story' } },
    ],
  });
  await save('web', 'chrome', 'main', {
    ...webChrome(),
    footer: {
      tagline: 'Designed around the finishing touch — leather care staged as a quiet ritual, not a chore.',
      bottomLeft: 'Jimmy & Wax — the finishing touch',
    },
  });

  const screen = (s: string) => ({ type: 'screen', screen: s });
  const prod = (id: string) => ({ type: 'product', productId: id });
  await save('app', 'page', 'home', {
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
              image: m('hero1'),
              headline: 'Shine That Lasts',
              subhead: 'Premium care for every step',
              textInImage: true,
              action: prod('twinkle-shine-leather-polish'),
              a11yLabel: 'Shine That Lasts. Premium care for every step',
            },
            {
              id: 'slide-0002',
              image: m('hero2'),
              headline: 'Complete Leather Care',
              subhead: 'Everything your shoes need',
              textInImage: true,
              action: prod('complete-care-kit'),
              a11yLabel: 'Complete Leather Care. Everything your shoes need',
            },
            {
              id: 'slide-0003',
              image: m('hero3'),
              headline: 'Restore. Protect. Shine.',
              subhead: 'Premium leather care',
              textInImage: true,
              action: prod('black-shoe-care'),
              a11yLabel: 'Restore. Protect. Shine. Premium leather care',
            },
            {
              id: 'slide-0004',
              image: m('hero4'),
              headline: 'Premium Care For Every Step',
              subhead: 'The complete shoe care ritual',
              textInImage: true,
              action: prod('complete-care-kit'),
              a11yLabel: 'Premium Care For Every Step. The complete shoe care ritual',
            },
          ],
          aspectRatio: '3:2',
          autoplay: { enabled: false, intervalMs: 5000 },
          dots: true,
        },
      },
      {
        id: 'blk-cats-0001',
        type: 'app.category_shortcuts',
        visible: true,
        props: {
          ringStyle: 'gold_ring',
          items: [
            { id: 'cat-0001', icon: m('cat-polish'), label: 'Polish', action: screen('categories') },
            { id: 'cat-0002', icon: m('cat-kits'), label: 'Care Kits', action: screen('categories') },
            { id: 'cat-0003', icon: m('cat-acc'), label: 'Accessories', action: screen('categories') },
            { id: 'cat-0004', icon: m('cat-gift'), label: 'Gift Pack', action: screen('categories') },
          ],
        },
      },
      {
        id: 'blk-rail-0001',
        type: 'app.product_rail',
        visible: true,
        props: {
          title: 'Best Sellers',
          seeAll: screen('categories'),
          source: { kind: 'bestsellers' },
          limit: 3,
          card: 'standard',
        },
      },
      {
        id: 'blk-why-0001',
        type: 'app.benefits_row',
        visible: true,
        props: {
          title: 'Why JIMMY WAX',
          items: [
            { id: 'ben-0001', image: m('photo-polish'), label: 'Premium shine' },
            { id: 'ben-0002', image: m('photo-black'), label: 'Leather care' },
            { id: 'ben-0003', image: m('edu-sponge'), label: 'Apply evenly' },
            { id: 'ben-0004', image: m('edu-cloth'), label: 'Buff with cloth' },
          ],
        },
      },
      {
        id: 'blk-test-0001',
        type: 'app.testimonials',
        visible: true,
        props: { mode: 'curated', testimonialIds, limit: 4, heroImage: m('testi-hero') },
      },
      {
        id: 'blk-care-0001',
        type: 'app.care_ritual',
        visible: true,
        props: { guideId: 'care-ritual', cta: screen('care_guide'), secondaryCta: screen('categories') },
      },
    ],
  });

  const cta = (id: string, label: string, anchor: string, variant: 'solid' | 'ghost') => ({
    id,
    label,
    action: { type: 'anchor', id: anchor },
    variant,
  });
  await save('web', 'page', 'home', {
    schemaVersion: 1,
    seo: {
      title: 'Jimmy & Wax — Twinkle Shine leather care',
      description:
        'Leather care staged as a quiet ritual, not a chore: polish, kits and care sets for the pieces you keep.',
    },
    blocks: [
      {
        id: 'blk-hero-0001',
        type: 'web.hero_film',
        visible: true,
        props: {
          kicker: 'Jimmy & Wax · Leather care',
          headline: 'Every finish has\na final gesture.',
          subhead:
            'The complete ritual — polish, kits and care sets — staged where the light lands. Scroll to walk the table.',
          film: {
            desktop: m('w-hero-film'),
            mobile: m('w-hero-mobile'),
            poster: m('w-hero-poster', 'The Jimmy and Wax collection staged under the studio key light'),
          },
          scrubScroll: 2.6,
          ctas: [
            cta('cta-shop-001', 'Shop the objects', 'collection', 'solid'),
            cta('cta-ritual-01', 'Learn the ritual', 'ritual', 'ghost'),
          ],
        },
      },
      {
        id: 'blk-marq-0001',
        type: 'web.marquee',
        visible: true,
        props: {
          items: [
            'The finishing touch',
            'Leather',
            'Ritual',
            'Light',
            'The finishing touch',
            'Leather',
            'Ritual',
            'Light',
          ],
        },
      },
      {
        id: 'blk-chap-0001',
        type: 'web.chapter_mark',
        visible: true,
        props: { index: '01', title: 'The Collection' },
      },
      {
        id: 'blk-coll-0001',
        type: 'web.collection_grid',
        visible: true,
        props: {
          kicker: 'The tangible ritual · the collection',
          headline: 'Objects for the\nlast look.',
          subhead: 'A few objects, one finishing gesture — open any object for its full story.',
          source: {
            kind: 'manual',
            productIds: [
              'twinkle-shine-leather-polish',
              'polish-cloth-kit',
              'complete-care-kit',
              'black-shoe-care',
            ],
          },
          cardStyle: 'tilt',
          hoverFilm: true,
          limit: 12,
        },
      },
      {
        id: 'blk-promo-0001',
        type: 'web.promo_film',
        visible: true,
        props: {
          kicker: 'The film',
          headlineLines: ['Twenty seconds,', 'one final gesture.'],
          video: m('w-promo-film'),
          poster: m('w-promo-poster', 'The Jimmy and Wax brand film poster'),
          caption: 'Sound on — narrated. Cleans · Nourishes · Long-lasting shine · Premium care.',
        },
      },
      {
        id: 'blk-clos-0001',
        type: 'web.closing_cta',
        visible: true,
        props: {
          kicker: 'Built for the pieces you keep',
          headlineLines: ['Care is not', 'a shortcut.', 'It is the final', 'gesture.'],
          ctas: [
            cta('cta-shop-002', 'Shop the objects', 'collection', 'solid'),
            cta('cta-top-0001', 'Back to the beginning', 'top', 'ghost'),
          ],
          media: m('w-hero-poster', 'The Jimmy and Wax collection staged under the studio key light'),
          caption: 'The collection · staged',
          footnote: 'Jimmy & Wax · Twinkle Shine · Prices include GST',
        },
      },
    ],
  });

  // ---------------------------------------------------------------- validate + publish
  for (const ch of ['app', 'web'] as const) {
    const rep = await db.tx(actor, (c) => exp.validateChannel(c, ch));
    log(`${ch}: canPublish=${rep.canPublish} errors=${rep.errors.length} warnings=${rep.warnings.length}`);
    for (const e of rep.errors) log(`  ERROR ${e.code} ${e.docKey}: ${e.message}`);
    for (const w of rep.warnings) log(`  warn  ${w.code} ${w.docKey}: ${w.message}`);
  }
  const live = await db.tx(actor, (c) => c.query(`SELECT count(*)::int AS n FROM exp_releases`));
  if (live.rows[0].n > 0 && !flag('force-release')) {
    log(
      'A release already exists: documents saved as drafts, nothing published (use --force-release to publish anyway).',
    );
  } else {
    const out = await db.tx(actor, (c) =>
      exp.createRelease(c, x, {
        channels: ['app', 'web'],
        label: "Baseline: today's look",
        note: 'Seeded from the existing app and website content.',
        idempotencyKey: flag('force-release') ? `baseline-${Date.now()}` : 'baseline-1',
      }),
    );
    log(
      'published:',
      out.releases.map((r: { channel: string; number: number }) => `${r.channel}#${r.number}`).join(', '),
    );
  }
  await db.close();
}
main().catch((e) => {
  console.error(
    e instanceof Error ? e.message : e,
    (e as { details?: unknown }).details ? JSON.stringify((e as { details?: unknown }).details, null, 1) : '',
  );
  process.exit(1);
});
