import type { Channel } from './schemas.ts';

/** What a set of documents/entities points at: media, links, entities, products, copy. Used by validation AND snapshots. */
export interface Loc {
  doc: string;
  path: string;
  blockId?: string;
  blockType?: string;
}
export interface MediaUse extends Loc {
  mediaId: string;
  alt?: string;
  decorative?: boolean;
}
export interface ActionUse extends Loc {
  action: { type: string; [k: string]: unknown };
}
export interface TextUse extends Loc {
  text: string;
}
export type IdUses = Map<string, Loc[]>;

export interface Collected {
  media: MediaUse[];
  actions: ActionUse[];
  texts: TextUse[];
  careGuides: IdUses;
  faqGroups: IdUses;
  stories: IdUses;
  journal: IdUses;
  testimonials: IdUses;
  collections: IdUses;
  products: IdUses;
  categories: IdUses;
  /** testimonial block modes that need live reviews rather than ids */
  usesVerifiedReviews: boolean;
}

export const ACTION_TYPES = new Set([
  'none',
  'product',
  'collection',
  'category',
  'page',
  'screen',
  'route',
  'anchor',
  'url',
  'tel',
  'mailto',
  'whatsapp',
]);

export const emptyCollected = (): Collected => ({
  media: [],
  actions: [],
  texts: [],
  careGuides: new Map(),
  faqGroups: new Map(),
  stories: new Map(),
  journal: new Map(),
  testimonials: new Map(),
  collections: new Map(),
  products: new Map(),
  categories: new Map(),
  usesVerifiedReviews: false,
});

const push = (m: IdUses, id: string, loc: Loc) => {
  const a = m.get(id);
  if (a) a.push(loc);
  else m.set(id, [loc]);
};

const isObj = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

/** Text fields that are identifiers/enums, not authored copy. */
const NON_COPY = new Set([
  'id',
  'type',
  'kind',
  'key',
  'mediaId',
  'slug',
  'productId',
  'categoryId',
  'pageKey',
  'guideId',
  'groupId',
  'url',
  'value',
  'anchorId',
  'icon',
  'tone',
  'variant',
  'mode',
  'layout',
  'aspectRatio',
  'radius',
  'fit',
  'padding',
  'width',
  'align',
  'section',
  'n',
  'index',
  'screen',
  'path',
  'mediaKind',
  'mediaSide',
  'cardStyle',
  'card',
  'ringStyle',
  'canonical',
]);

export function collectFrom(
  c: Collected,
  doc: string,
  root: unknown,
  block?: { id: string; type: string },
  basePath = '',
): void {
  const walk = (node: unknown, path: string, key?: string): void => {
    if (typeof node === 'string') {
      if (key && !NON_COPY.has(key))
        c.texts.push({ doc, path, text: node, blockId: block?.id, blockType: block?.type });
      return;
    }
    if (Array.isArray(node)) return node.forEach((v, i) => walk(v, `${path}.${i}`, key));
    if (!isObj(node)) return;
    const loc: Loc = { doc, path, blockId: block?.id, blockType: block?.type };
    if (typeof node.mediaId === 'string')
      c.media.push({
        ...loc,
        mediaId: node.mediaId,
        alt: typeof node.alt === 'string' ? node.alt : undefined,
        decorative: node.decorative === true,
      });
    if (typeof node.type === 'string' && ACTION_TYPES.has(node.type) && !('props' in node)) {
      c.actions.push({ ...loc, action: node as ActionUse['action'] });
      if (node.type === 'product' && typeof node.productId === 'string')
        push(c.products, node.productId, loc);
      if (node.type === 'collection' && typeof node.slug === 'string') push(c.collections, node.slug, loc);
      if (node.type === 'category' && typeof node.categoryId === 'string')
        push(c.categories, node.categoryId, loc);
    }
    if (node.kind === 'collection' && typeof node.slug === 'string') push(c.collections, node.slug, loc);
    if (node.kind === 'category' && typeof node.categoryId === 'string')
      push(c.categories, node.categoryId, loc);
    if (node.kind === 'manual' && Array.isArray(node.productIds))
      (node.productIds as string[]).forEach((p) => push(c.products, p, loc));
    if (typeof node.guideId === 'string') push(c.careGuides, node.guideId, loc);
    if (typeof node.groupId === 'string') push(c.faqGroups, node.groupId, loc);
    if (typeof node.faqGroupId === 'string') push(c.faqGroups, node.faqGroupId, loc);
    if (Array.isArray(node.storyIds)) (node.storyIds as string[]).forEach((s) => push(c.stories, s, loc));
    if (Array.isArray(node.noteIds)) (node.noteIds as string[]).forEach((s) => push(c.journal, s, loc));
    if (Array.isArray(node.testimonialIds))
      (node.testimonialIds as string[]).forEach((s) => push(c.testimonials, s, loc));
    if (node.mode === 'verified_reviews') c.usesVerifiedReviews = true;
    for (const [k, v] of Object.entries(node)) walk(v, path ? `${path}.${k}` : k, k);
  };
  walk(root, basePath);
}

/** Expected media kind for a MediaRef at `path` inside block `type`. Default is image. */
export function expectedMediaKind(type: string | undefined, path: string): 'image' | 'video' | 'font' {
  const p = path.replace(/^props\./, '');
  switch (type) {
    case 'web.hero_film':
      return p === 'film.desktop' || p === 'film.mobile' ? 'video' : 'image';
    case 'web.scrub_film':
    case 'web.atelier_film':
      return p === 'film' ? 'video' : 'image';
    case 'web.promo_film':
      return p === 'video' ? 'video' : 'image';
    default:
      return 'image';
  }
}

export function pageDocsOf(channel: Channel, rows: Array<{ key: string; body: unknown }>) {
  return rows.map((r) => ({
    key: `page:${r.key}`,
    channel,
    body: r.body as {
      blocks?: Array<{ id: string; type: string; props: unknown; rules?: unknown; style?: unknown }>;
    },
  }));
}
