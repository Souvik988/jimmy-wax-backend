import { z } from 'zod';

/**
 * Typed, versioned documents for the Experience Studio. Content is DATA, never code: no HTML/CSS/JS anywhere,
 * strict objects (unknown keys are rejected), bounded strings and arrays. This is the single source of truth the
 * validator, the bundle builder and the contract fixtures share.
 */
export const SCHEMA_VERSION = 1 as const;
export type Channel = 'app' | 'web';

export const Hex = z.string().regex(/^#([0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/, 'hex colour like #C99534');
const Id = z.string().regex(/^[A-Za-z0-9_-]{4,40}$/, 'stable id');
const Slug = z
  .string()
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/)
  .min(2)
  .max(100);
const Uuid = z.string().uuid();
const Text = (max: number, min = 1) => z.string().trim().min(min).max(max);

// ------------------------------------------------------------------ shared pieces
export const MediaRef = z.strictObject({
  mediaId: Uuid,
  alt: z.string().trim().max(200).optional(),
  decorative: z.boolean().optional(),
  focal: z.strictObject({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) }).optional(),
  fit: z.enum(['cover', 'contain']).optional(),
});
export type MediaRef = z.infer<typeof MediaRef>;

export const APP_SCREENS = [
  'home',
  'categories',
  'cart',
  'orders',
  'profile',
  'wishlist',
  'search',
  'addresses',
  'care_guide',
  'help',
  'about',
] as const;
export const WEB_ROUTES = ['/', '/shop', '/ritual', '/story'] as const;

export const Action = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('none') }),
  z.strictObject({ type: z.literal('product'), productId: Slug }),
  z.strictObject({ type: z.literal('collection'), slug: Slug }),
  z.strictObject({ type: z.literal('category'), categoryId: Slug }),
  z.strictObject({ type: z.literal('page'), pageKey: z.string().regex(/^[a-z0-9:_-]{1,80}$/) }),
  z.strictObject({ type: z.literal('screen'), screen: z.enum(APP_SCREENS) }),
  z.strictObject({ type: z.literal('route'), path: z.enum(WEB_ROUTES) }),
  z.strictObject({ type: z.literal('anchor'), id: z.string().regex(/^[a-z0-9-]{1,60}$/) }),
  z.strictObject({ type: z.literal('url'), url: z.string().max(500), newTab: z.boolean().optional() }),
  z.strictObject({ type: z.literal('tel'), value: z.string().regex(/^\+?[0-9 ()-]{7,20}$/) }),
  z.strictObject({
    type: z.literal('mailto'),
    value: z
      .string()
      .max(200)
      .regex(/^[^@\s]+@[^@\s]+\.[^@\s]+$/),
  }),
  z.strictObject({ type: z.literal('whatsapp'), value: z.string().regex(/^\+?[0-9]{8,15}$/) }),
]);
export type Action = z.infer<typeof Action>;

export const VisibilityRules = z.strictObject({
  schedule: z
    .strictObject({ startAt: z.string().datetime().optional(), endAt: z.string().datetime().optional() })
    .optional(),
  platforms: z
    .array(z.enum(['ios', 'android', 'web']))
    .max(3)
    .optional(),
  appBuild: z
    .strictObject({ min: z.number().int().min(1).optional(), max: z.number().int().min(1).optional() })
    .optional(),
  auth: z.enum(['any', 'signed_out', 'signed_in']).optional(),
  storePaused: z.enum(['any', 'only_when_paused', 'hide_when_paused']).optional(),
});
export type VisibilityRules = z.infer<typeof VisibilityRules>;

export const COLOR_ROLES = [
  'bg.deep',
  'bg.base',
  'bg.raised',
  'bg.elevated',
  'bg.overlay',
  'text.primary',
  'text.secondary',
  'text.muted',
  'text.onAccent',
  'border.subtle',
  'border.strong',
  'accent.primary',
  'accent.hover',
  'accent.pressed',
  'accent.soft',
  'focus.ring',
  'state.success',
  'state.warning',
  'state.error',
  'state.info',
] as const;
export type ColorRole = (typeof COLOR_ROLES)[number];

export const BlockStyle = z.strictObject({
  background: z
    .union([
      z.strictObject({ token: z.enum(COLOR_ROLES) }),
      z.strictObject({ palette: z.string().max(40) }),
      z.strictObject({ hex: Hex }),
    ])
    .optional(),
  padding: z.enum(['none', 'sm', 'md', 'lg', 'xl']).optional(),
  width: z.enum(['contained', 'full']).optional(),
  align: z.enum(['start', 'center']).optional(),
  radius: z.enum(['none', 'frame', 'card', 'large']).optional(),
  divider: z.boolean().optional(),
  anchorId: z
    .string()
    .regex(/^[a-z0-9-]{1,60}$/)
    .optional(),
});
export type BlockStyle = z.infer<typeof BlockStyle>;

// ------------------------------------------------------------------ design system
const Bezier = z.tuple([
  z.number().min(0).max(1),
  z.number().min(-2).max(2),
  z.number().min(0).max(1),
  z.number().min(-2).max(2),
]);
const Shadow = z.strictObject({
  x: z.number().min(-40).max(40),
  y: z.number().min(-40).max(40),
  blur: z.number().min(0).max(120),
  spread: z.number().min(-40).max(40),
  color: Hex,
});
const FontRef = z.strictObject({
  family: Text(60),
  fallback: Text(120),
  mediaId: Uuid.optional(),
});
const TypeStep = z.strictObject({
  size: z.number().min(8).max(200),
  lineHeight: z.number().min(0.8).max(2.5),
  weight: z.number().int().min(100).max(900),
  tracking: z.number().min(-0.2).max(0.5),
});
const ColorRoles = z.strictObject(
  Object.fromEntries(COLOR_ROLES.map((r) => [r, Hex])) as Record<ColorRole, typeof Hex>,
);
const ButtonStyle = z.strictObject({
  background: z.enum(COLOR_ROLES),
  foreground: z.enum(COLOR_ROLES),
  border: z.enum(COLOR_ROLES).optional(),
});

export const DesignSystem = z.strictObject({
  schemaVersion: z.literal(SCHEMA_VERSION),
  color: z.strictObject({
    roles: ColorRoles,
    palette: z
      .record(z.string().regex(/^[a-z][a-z0-9_]{0,30}$/), Hex)
      .refine((o) => Object.keys(o).length <= 40, 'at most 40 palette colours'),
    gradients: z
      .record(
        z.string().regex(/^[a-z][a-z0-9_]{0,30}$/),
        z.strictObject({
          angle: z.number().min(0).max(360),
          stops: z
            .array(z.strictObject({ at: z.number().min(0).max(1), color: Hex }))
            .min(2)
            .max(5),
        }),
      )
      .refine((o) => Object.keys(o).length <= 12, 'at most 12 gradients'),
  }),
  type: z.strictObject({
    families: z.strictObject({ display: FontRef, body: FontRef, mono: FontRef.optional() }),
    scale: z.strictObject({
      hero: TypeStep,
      h1: TypeStep,
      h2: TypeStep,
      h3: TypeStep,
      body: TypeStep,
      small: TypeStep,
      label: TypeStep,
    }),
  }),
  space: z.strictObject({
    unit: z.literal(4),
    steps: z.array(z.number().int().min(0).max(400)).min(4).max(16),
  }),
  radius: z.strictObject({
    frame: z.number().min(0).max(40),
    card: z.number().min(0).max(40),
    control: z.number().min(0).max(40),
    large: z.number().min(0).max(60),
    hero: z.number().min(0).max(60),
    pill: z.literal(999),
  }),
  elevation: z.strictObject({ raised: Shadow, overlay: Shadow }),
  motion: z.strictObject({
    durations: z.strictObject({
      fast: z.number().int().min(100).max(800),
      medium: z.number().int().min(100).max(800),
      slow: z.number().int().min(100).max(800),
    }),
    easings: z.strictObject({ standard: Bezier, emphasis: Bezier, curtain: Bezier }),
    intensity: z.enum(['calm', 'standard', 'cinematic']),
  }),
  components: z.strictObject({
    button: z.strictObject({
      minHeight: z.number().min(24).max(80),
      shape: z.enum(['pill', 'rounded']),
      variants: z.strictObject({ primary: ButtonStyle, secondary: ButtonStyle, ghost: ButtonStyle }),
    }),
    card: z.strictObject({
      radius: z.enum(['card', 'large']),
      border: z.boolean(),
      elevation: z.enum(['none', 'raised']),
    }),
    input: z.strictObject({ minHeight: z.number().min(24).max(80), radius: z.literal('control') }),
    chip: z.strictObject({ radius: z.enum(['pill', 'control']) }),
    bottomNav: z.strictObject({
      style: z.enum(['plain', 'pill']),
      activeColor: z.enum(COLOR_ROLES),
      background: z.enum(COLOR_ROLES),
      backgroundOpacity: z.number().min(0).max(1),
    }),
    header: z.strictObject({
      background: z.union([z.enum(COLOR_ROLES), z.literal('transparent')]),
      blurOnScroll: z.boolean(),
    }),
    imageFrame: z.strictObject({ radius: z.enum(['frame', 'card']) }),
  }),
  surfaces: z.strictObject({
    backdrop: z.strictObject({
      kind: z.enum(['image', 'solid', 'gradient']),
      image: Uuid.optional(),
      tint: Hex,
      tintOpacity: z.number().min(0).max(1),
    }),
    grain: z.strictObject({ enabled: z.boolean(), opacity: z.number().min(0).max(0.5) }),
  }),
});
export type DesignSystem = z.infer<typeof DesignSystem>;

/** A channel override: only the keys present differ from the shared base (absent key = inherit). */
export const TokensOverrideDoc = z.strictObject({ overrides: z.record(z.string(), z.unknown()) });

// ------------------------------------------------------------------ blocks
const Heading = Text(120, 3);
const Cta = z.strictObject({
  id: Id,
  label: Text(30, 2),
  action: Action,
  variant: z.enum(['solid', 'ghost']).default('solid'),
});
const Source = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('collection'), slug: Slug }),
  z.strictObject({ kind: z.literal('category'), categoryId: Slug }),
  z.strictObject({ kind: z.literal('manual'), productIds: z.array(Slug).min(1).max(24) }),
  z.strictObject({ kind: z.literal('bestsellers') }),
  z.strictObject({ kind: z.literal('newest') }),
]);
export type ProductSource = z.infer<typeof Source>;
const Ratio = z.enum(['3:2', '16:9', '4:3', '1:1', '4:5', '21:9']);
const Icon = z.enum([
  'truck',
  'shield',
  'refresh',
  'lock',
  'sparkles',
  'heart',
  'star',
  'gift',
  'leaf',
  'clock',
]);
const Radius = z.enum(['none', 'frame', 'card', 'large']);
const Lines = z.array(Text(80)).min(1).max(4);

const arr = <T extends z.ZodType>(t: T, min: number, max: number) => z.array(t).min(min).max(max);

export interface BlockDef {
  channel: Channel;
  schema: z.ZodType;
  /** Maximum instances per page. */
  max: number;
  /** Capability level: clients advertise the block types they can render. */
  minBuild?: number;
}

const app = (schema: z.ZodType, max: number): BlockDef => ({ channel: 'app', schema, max });
const web = (schema: z.ZodType, max: number): BlockDef => ({ channel: 'web', schema, max });
const so = z.strictObject;

export const BLOCKS: Record<string, BlockDef> = {
  'app.hero_carousel': app(
    so({
      slides: arr(
        so({
          id: Id,
          image: MediaRef,
          headline: Text(80).optional(),
          subhead: Text(120).optional(),
          textInImage: z.boolean().default(true),
          action: Action,
          a11yLabel: Text(160, 3),
        }),
        1,
        8,
      ),
      aspectRatio: Ratio.default('3:2'),
      autoplay: so({ enabled: z.boolean(), intervalMs: z.number().int().min(3000).max(15000) }).default({
        enabled: false,
        intervalMs: 5000,
      }),
      dots: z.boolean().default(true),
    }),
    2,
  ),
  'app.category_shortcuts': app(
    so({
      items: arr(so({ id: Id, icon: MediaRef, label: Text(24), action: Action }), 3, 5),
      ringStyle: z.enum(['gold_ring', 'plain']).default('gold_ring'),
    }),
    1,
  ),
  'app.product_rail': app(
    so({
      title: Text(60, 2),
      seeAll: Action.optional(),
      source: Source,
      limit: z.number().int().min(1).max(24).default(10),
      card: z.enum(['standard', 'compact']).default('standard'),
    }),
    6,
  ),
  'app.benefits_row': app(
    so({ title: Text(60).optional(), items: arr(so({ id: Id, image: MediaRef, label: Text(40, 2) }), 3, 5) }),
    2,
  ),
  'app.testimonials': app(
    so({
      mode: z.enum(['verified_reviews', 'curated']),
      testimonialIds: z.array(Uuid).max(8).default([]),
      limit: z.number().int().min(1).max(8).default(4),
      heroImage: MediaRef.optional(),
    }),
    1,
  ),
  'app.care_ritual': app(so({ guideId: Slug, cta: Action, secondaryCta: Action.optional() }), 1),
  'app.promo_cards': app(
    so({
      cards: arr(
        so({ id: Id, image: MediaRef, headline: Text(80).optional(), ctaLabel: Text(24, 2), action: Action }),
        1,
        6,
      ),
    }),
    2,
  ),
  'app.announcement_bar': app(
    so({
      text: Text(160, 3),
      action: Action.optional(),
      tone: z.enum(['info', 'promo', 'warning']).default('info'),
      dismissible: z.boolean().default(true),
    }),
    1,
  ),
  'app.banner': app(
    so({
      image: MediaRef,
      action: Action,
      aspectRatio: Ratio.default('16:9'),
      radius: Radius.default('card'),
    }),
    10,
  ),
  'app.rich_text': app(so({ markdown: z.string().trim().min(1).max(4000) }), 10),
  'app.faq': app(so({ groupId: Slug }), 3),
  'app.trust_strip': app(so({ items: arr(so({ id: Id, icon: Icon, label: Text(60) }), 3, 4) }), 2),
  'app.spacer': app(so({ height: z.number().int().min(8).max(64) }), 10),

  'web.hero_film': web(
    so({
      kicker: Text(60).optional(),
      headline: Heading,
      subhead: Text(240).optional(),
      film: so({ desktop: MediaRef, mobile: MediaRef, poster: MediaRef }),
      scrubScroll: z.number().min(1).max(4).default(2.6),
      ctas: z.array(Cta).max(2).default([]),
    }),
    1,
  ),
  'web.marquee': web(so({ items: arr(Text(40), 4, 12) }), 2),
  'web.chapter_mark': web(so({ index: Text(4), title: Text(60, 2) }), 8),
  'web.collection_grid': web(
    so({
      kicker: Text(60).optional(),
      headline: Heading,
      subhead: Text(300).optional(),
      source: Source,
      cardStyle: z.enum(['tilt', 'plain']).default('tilt'),
      hoverFilm: z.boolean().default(false),
      limit: z.number().int().min(1).max(24).default(12),
    }),
    3,
  ),
  'web.ritual_steps': web(
    so({
      kicker: Text(60).optional(),
      headline: Heading,
      subhead: Text(300).optional(),
      guideId: Slug.optional(),
      steps: arr(
        so({ id: Id, n: Text(4), title: Text(60, 2), body: Text(300, 3), image: MediaRef }),
        3,
        5,
      ).optional(),
    }).refine((v) => !!v.guideId !== !!v.steps, 'provide either guideId or steps'),
    1,
  ),
  'web.scrub_film': web(
    so({
      film: MediaRef,
      poster: MediaRef,
      label: Text(160, 3),
      beats: arr(so({ id: Id, title: Text(40, 2), body: Text(200, 3) }), 2, 5),
    }),
    2,
  ),
  'web.media_split': web(
    so({
      mediaKind: z.enum(['image', 'video']),
      media: MediaRef,
      poster: MediaRef.optional(),
      kicker: Text(60).optional(),
      headline: Heading,
      body: Text(500, 3),
      cta: so({ label: Text(30, 2), action: Action }).optional(),
      mediaSide: z.enum(['left', 'right']).default('left'),
    }),
    4,
  ),
  'web.standards_grid': web(
    so({
      kicker: Text(60).optional(),
      headline: Heading,
      subhead: Text(300).optional(),
      items: arr(so({ id: Id, n: Text(4), title: Text(60, 2), body: Text(300, 3), image: MediaRef }), 3, 4),
    }),
    2,
  ),
  'web.evidence_rail': web(
    so({
      kicker: Text(60).optional(),
      headline: Heading,
      items: arr(so({ id: Id, image: MediaRef, caption: Text(80, 2) }), 4, 10),
    }),
    2,
  ),
  'web.atelier_film': web(
    so({
      film: MediaRef,
      poster: MediaRef,
      label: Text(160, 3),
      kicker: Text(60).optional(),
      headlineLines: Lines,
    }),
    2,
  ),
  'web.reels_rail': web(so({ title: Text(80).optional(), storyIds: arr(Uuid, 3, 12) }), 1),
  'web.journal_stack': web(
    so({
      noteIds: arr(Slug, 1, 6),
      finale: so({
        kicker: Text(60).optional(),
        title: Text(80, 2),
        excerpt: Text(300),
        image: MediaRef,
      }).optional(),
    }),
    1,
  ),
  'web.promo_film': web(
    so({
      kicker: Text(60).optional(),
      headlineLines: arr(Text(80), 1, 3),
      video: MediaRef,
      poster: MediaRef,
      caption: Text(240).optional(),
    }),
    2,
  ),
  'web.closing_cta': web(
    so({
      kicker: Text(60).optional(),
      headlineLines: Lines,
      ctas: z.array(Cta).max(2).default([]),
      media: MediaRef,
      caption: Text(120).optional(),
      footnote: Text(240).optional(),
    }),
    1,
  ),
  'web.testimonials': web(
    so({ testimonialIds: arr(Uuid, 1, 12), layout: z.enum(['grid', 'carousel']).default('grid') }),
    1,
  ),
  'web.rich_text': web(so({ markdown: z.string().trim().min(1).max(6000) }), 10),
  'web.image': web(so({ image: MediaRef, action: Action.optional(), caption: Text(160).optional() }), 10),
  'web.product_grid': web(
    so({
      title: Text(80, 2),
      source: Source,
      columns: z.number().int().min(2).max(4).default(3),
      limit: z.number().int().min(1).max(24).default(9),
    }),
    4,
  ),
  'web.faq': web(so({ groupId: Slug }), 3),
  'web.announcement_bar': web(
    so({
      text: Text(160, 3),
      action: Action.optional(),
      tone: z.enum(['info', 'promo', 'warning']).default('info'),
      dismissible: z.boolean().default(true),
    }),
    1,
  ),
  'web.spacer': web(so({ height: z.number().int().min(8).max(160) }), 10),
};

export const PDP_SECTIONS = [
  'gallery',
  'description',
  'key_benefits',
  'suitable_surfaces',
  'box_contents',
  'info_card',
  'delivery_estimate',
  'reviews',
  'related',
  'pairings',
] as const;

/** Blocks allowed on the narrower app templates. */
const APP_TEMPLATE_BLOCKS = new Set([
  'app.banner',
  'app.rich_text',
  'app.product_rail',
  'app.faq',
  'app.trust_strip',
  'app.spacer',
  'app.announcement_bar',
]);
export const APP_PAGES = ['home', 'category', 'product', 'cart'] as const;
export const WEB_FIXED_PAGES = ['home', 'shop', 'product', 'ritual', 'story'] as const;

export const MAX_BLOCKS = { app: 30, web: 40 } as const;

export const Seo = so({
  title: Text(70, 3),
  description: Text(160, 50),
  canonical: z.string().max(300).optional(),
  noindex: z.boolean().default(false),
  ogImage: MediaRef.optional(),
  structuredData: so({ organization: z.boolean(), product: z.boolean(), breadcrumb: z.boolean() }).default({
    organization: true,
    product: false,
    breadcrumb: false,
  }),
});

export const BlockEnvelope = so({
  id: Id,
  type: z.string().max(60),
  visible: z.boolean(),
  rules: VisibilityRules.optional(),
  style: BlockStyle.optional(),
  props: z.unknown(),
});
export type Block = {
  id: string;
  type: string;
  visible: boolean;
  rules?: VisibilityRules;
  style?: BlockStyle;
  props: Record<string, unknown>;
};

export const PageDoc = so({
  schemaVersion: z.literal(SCHEMA_VERSION),
  title: Text(120).optional(),
  seo: Seo.optional(),
  nativeSections: z
    .array(so({ key: z.enum(PDP_SECTIONS), visible: z.boolean() }))
    .max(10)
    .optional(),
  blocks: z.array(BlockEnvelope).max(40),
});
export type PageDoc = {
  schemaVersion: 1;
  title?: string;
  seo?: z.infer<typeof Seo>;
  nativeSections?: Array<{ key: string; visible: boolean }>;
  blocks: Block[];
};

export function isPageKeyValid(channel: Channel, key: string): boolean {
  if (channel === 'app') return (APP_PAGES as readonly string[]).includes(key);
  return (
    (WEB_FIXED_PAGES as readonly string[]).includes(key) ||
    /^custom:[a-z0-9-]{2,60}$/.test(key) ||
    /^product:[a-z0-9-]{2,100}$/.test(key)
  );
}

export function blockAllowedOnPage(channel: Channel, pageKey: string, type: string): boolean {
  const def = BLOCKS[type];
  if (!def || def.channel !== channel) return false;
  if (channel === 'app' && pageKey !== 'home') return APP_TEMPLATE_BLOCKS.has(type);
  return true;
}

// ------------------------------------------------------------------ navigation + chrome
const NavIcon = z.enum([
  'home',
  'grid',
  'bag',
  'receipt',
  'user',
  'heart',
  'search',
  'gift',
  'star',
  'help',
  'info',
  'bell',
]);
export const AppNavigation = so({
  schemaVersion: z.literal(SCHEMA_VERSION),
  bottomTabs: arr(
    so({
      key: z.enum(['home', 'categories', 'cart', 'orders', 'profile', 'custom']),
      label: Text(14, 2),
      icon: NavIcon,
      visible: z.boolean(),
      action: Action.optional(),
    }),
    3,
    5,
  ),
  profileMenu: z
    .array(
      so({
        id: Id,
        label: Text(40, 2),
        icon: NavIcon,
        action: Action,
        section: z.enum(['account', 'help', 'legal', 'custom']),
      }),
    )
    .max(20),
});
const NavLink = so({ id: Id, label: Text(30, 2), action: Action });
export const WebNavigation = so({
  schemaVersion: z.literal(SCHEMA_VERSION),
  links: arr(NavLink, 2, 8),
  footerColumns: z.array(so({ id: Id, title: Text(30, 2), links: arr(NavLink, 1, 8) })).max(4),
  cart: so({ label: Text(20, 2) }),
});

export const BRAND_SLOTS = [
  'mascot.welcome',
  'mascot.otp',
  'mascot.signed_in',
  'mascot.order_placed',
  'mascot.empty_cart',
  'mascot.empty_orders',
  'mascot.cheer',
  'state.empty_cart',
  'state.empty_wishlist',
  'state.no_orders',
  'state.generic_error',
  'state.no_connection',
  'state.tracking_pending',
  'backdrop.surface',
  'backdrop.order_success',
  'splash.scene',
  'category.all_banner',
  'category.browse_hero',
  'category.empty',
  'logo.wordmark',
  'logo.mark',
  'favicon',
  'og.default',
] as const;
const Slots = z.partialRecord(z.enum(BRAND_SLOTS), MediaRef).default({});

export const AppChrome = so({
  schemaVersion: z.literal(SCHEMA_VERSION),
  header: so({ showDeliverTo: z.boolean(), searchPlaceholder: Text(40, 3) }),
  splash: so({ wordmark: z.boolean() }),
  storePausedMessage: Text(160).optional(),
  help: so({
    faqGroupId: Slug.optional(),
    supportEmail: z.string().max(200).optional(),
    supportPhone: z.string().max(20).optional(),
    whatsapp: z.string().max(20).optional(),
  }),
  slots: Slots,
});
export const WebChrome = so({
  schemaVersion: z.literal(SCHEMA_VERSION),
  brand: so({ wordmark: Text(40, 2), mark: Text(2) }),
  veil: so({
    enabled: z.boolean(),
    mark: Text(2),
    name: Text(40, 2),
    subline: Text(60).optional(),
    durationMs: z.number().int().min(500).max(3000),
  }),
  effects: so({
    grain: z.boolean(),
    cursor: z.boolean(),
    smoothScroll: so({ enabled: z.boolean(), speedCap: z.number().min(0.2).max(3) }),
  }),
  seoDefaults: so({ titleTemplate: Text(80, 3), description: Text(160, 50) }),
  footer: so({ tagline: Text(200), bottomLeft: Text(120).optional(), bottomRight: Text(200).optional() }),
  slots: Slots,
});

export const DOC_SCHEMAS = {
  tokens: (channel: string) => (channel === 'shared' ? DesignSystem : TokensOverrideDoc),
  navigation: (channel: string) => (channel === 'app' ? AppNavigation : WebNavigation),
  chrome: (channel: string) => (channel === 'app' ? AppChrome : WebChrome),
  page: () => PageDoc,
} as const;

export const DOC_KEYS = { tokens: ['base', 'override'], navigation: ['main'], chrome: ['main'] } as const;

/** Is `sub` a structural subset of `sup`? (override keys must exist in the base) */
export function isSubset(sub: unknown, sup: unknown): boolean {
  if (sub === null || typeof sub !== 'object' || Array.isArray(sub)) return true;
  if (sup === null || typeof sup !== 'object' || Array.isArray(sup)) return false;
  return Object.entries(sub as Record<string, unknown>).every(
    ([k, v]) => k in (sup as Record<string, unknown>) && isSubset(v, (sup as Record<string, unknown>)[k]),
  );
}

export function deepMerge<T>(base: T, over: unknown): T {
  if (over === undefined) return base;
  if (
    over === null ||
    typeof over !== 'object' ||
    Array.isArray(over) ||
    base === null ||
    typeof base !== 'object' ||
    Array.isArray(base)
  )
    return over as T;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(over as Record<string, unknown>)) out[k] = deepMerge(out[k], v);
  return out as T;
}
