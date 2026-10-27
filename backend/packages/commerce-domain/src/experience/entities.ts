import { z } from 'zod';
import type { PoolClient } from '@jw/database';
import { AppError } from '@jw/contracts';
import { audit, type AdminRole } from '../admin.ts';
import { Action, MediaRef } from './schemas.ts';

interface Ctx {
  adminId: string;
  role: AdminRole;
  requestId?: string;
}

const Slug = z
  .string()
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/)
  .min(2)
  .max(80);
const T = (max: number, min = 1) => z.string().trim().min(min).max(max);
const Status = z.enum(['draft', 'active', 'archived']);
const Channels = z
  .array(z.enum(['app', 'web']))
  .min(1)
  .max(2);
const Uuid = z.string().uuid();

export const ENTITY_SCHEMAS = {
  'care-guides': z.strictObject({
    id: Slug.optional(),
    title: T(160, 2),
    intro: T(600, 0).default(''),
    steps: z
      .array(z.strictObject({ label: T(20), title: T(80, 2), body: T(300, 3), image: MediaRef }))
      .min(1)
      .max(8),
    cta: Action.nullable().optional(),
    status: Status.optional(),
  }),
  stories: z.strictObject({
    title: T(120, 2),
    line: T(240, 0).default(''),
    videoMediaId: Uuid,
    posterMediaId: Uuid,
    alt: T(300, 3),
    productId: Slug.nullable().optional(),
    position: z.number().int().min(0).max(1000).default(0),
    status: Status.optional(),
  }),
  journal: z.strictObject({
    id: Slug.optional(),
    kicker: T(60, 0).default(''),
    readMinutes: z.number().int().min(1).max(60).default(2),
    title: T(160, 2),
    excerpt: T(400, 0).default(''),
    imageMediaId: Uuid.nullable().optional(),
    alt: T(300, 0).default(''),
    bodyMd: T(20000, 0).default(''),
    productId: Slug.nullable().optional(),
    publishedAt: z.string().datetime().nullable().optional(),
    status: Status.optional(),
  }),
  testimonials: z.strictObject({
    name: T(80, 2),
    city: T(80).nullable().optional(),
    avatarMediaId: Uuid.nullable().optional(),
    quote: T(600, 10),
    rating: z.number().int().min(1).max(5).default(5),
    source: z.enum(['verified_review', 'owner_supplied', 'placeholder']).default('placeholder'),
    consent: z
      .strictObject({ recordedAt: z.string().datetime(), note: T(300, 5) })
      .nullable()
      .optional(),
    channels: Channels.default(['app', 'web']),
    // text-only in the app; the website may show a video testimonial
    videoMediaId: Uuid.nullable().optional(),
    posterMediaId: Uuid.nullable().optional(),
    position: z.number().int().min(0).max(1000).default(0),
    status: Status.optional(),
  }),
  'faq-groups': z.strictObject({
    id: Slug.optional(),
    title: T(120, 2),
    items: z
      .array(z.strictObject({ q: T(160, 3), aMd: T(1500, 3) }))
      .min(1)
      .max(40),
    status: Status.optional(),
  }),
  announcements: z.strictObject({
    text: T(200, 3),
    action: Action.nullable().optional(),
    tone: z.enum(['info', 'promo', 'warning']).default('info'),
    startsAt: z.string().datetime().nullable().optional(),
    endsAt: z.string().datetime().nullable().optional(),
    channels: Channels.default(['app', 'web']),
    status: Status.optional(),
  }),
} as const;
export type EntityName = keyof typeof ENTITY_SCHEMAS;
export const ENTITY_NAMES = Object.keys(ENTITY_SCHEMAS) as EntityName[];

interface Def {
  table: string;
  slugId: boolean;
  map: Record<string, string>;
  json: string[];
  order: string;
}
const DEFS: Record<EntityName, Def> = {
  'care-guides': {
    table: 'care_guides',
    slugId: true,
    map: { id: 'id', title: 'title', intro: 'intro', steps: 'steps', cta: 'cta', status: 'status' },
    json: ['steps', 'cta'],
    order: 'title',
  },
  stories: {
    table: 'stories',
    slugId: false,
    map: {
      id: 'id',
      title: 'title',
      line: 'line',
      videoMediaId: 'video_media_id',
      posterMediaId: 'poster_media_id',
      alt: 'alt',
      productId: 'product_id',
      position: 'position',
      status: 'status',
    },
    json: [],
    order: 'position, created_at',
  },
  journal: {
    table: 'journal_notes',
    slugId: true,
    map: {
      id: 'id',
      kicker: 'kicker',
      readMinutes: 'read_minutes',
      title: 'title',
      excerpt: 'excerpt',
      imageMediaId: 'image_media_id',
      alt: 'alt',
      bodyMd: 'body_md',
      productId: 'product_id',
      publishedAt: 'published_at',
      status: 'status',
    },
    json: [],
    order: 'published_at DESC NULLS LAST, created_at DESC',
  },
  testimonials: {
    table: 'testimonials',
    slugId: false,
    map: {
      id: 'id',
      name: 'name',
      city: 'city',
      avatarMediaId: 'avatar_media_id',
      quote: 'quote',
      rating: 'rating',
      source: 'source',
      consent: 'consent',
      channels: 'channels',
      videoMediaId: 'video_media_id',
      posterMediaId: 'poster_media_id',
      position: 'position',
      status: 'status',
    },
    json: ['consent'],
    order: 'position, created_at',
  },
  'faq-groups': {
    table: 'faq_groups',
    slugId: true,
    map: { id: 'id', title: 'title', items: 'items', status: 'status' },
    json: ['items'],
    order: 'title',
  },
  announcements: {
    table: 'announcements',
    slugId: false,
    map: {
      id: 'id',
      text: 'text',
      action: 'action',
      tone: 'tone',
      startsAt: 'starts_at',
      endsAt: 'ends_at',
      channels: 'channels',
      status: 'status',
    },
    json: ['action'],
    order: 'created_at DESC',
  },
};

const dto = (def: Def, r: Record<string, unknown>) => {
  const o: Record<string, unknown> = {};
  for (const [camel, snake] of Object.entries(def.map)) {
    const v = r[snake];
    o[camel] = v instanceof Date ? v.toISOString() : (v ?? null);
  }
  o.rev = r.rev;
  o.updatedAt = new Date(r.updated_at as string).toISOString();
  return o;
};

const known = (name: string): EntityName => {
  if (!(name in ENTITY_SCHEMAS)) throw new AppError('NOT_FOUND', 'Unknown content type');
  return name as EntityName;
};

function checkRules(name: EntityName, v: Record<string, unknown>) {
  if (name === 'testimonials') {
    if (v.source === 'owner_supplied' && !v.consent)
      throw new AppError(
        'VALIDATION_FAILED',
        'A recorded consent note is required for owner-supplied testimonials',
        { fields: { consent: 'required for owner_supplied' } },
      );
    if (v.videoMediaId && !v.posterMediaId)
      throw new AppError('VALIDATION_FAILED', 'A video testimonial needs a poster image', {
        fields: { posterMediaId: 'required with video' },
      });
  }
  if (
    name === 'announcements' &&
    v.startsAt &&
    v.endsAt &&
    new Date(v.endsAt as string) <= new Date(v.startsAt as string)
  )
    throw new AppError('VALIDATION_FAILED', 'End must be after start', {
      fields: { endsAt: 'must be after startsAt' },
    });
}

const fkError = (e: unknown): never => {
  const code = (e as { code?: string }).code;
  if (code === '23503')
    throw new AppError('VALIDATION_FAILED', 'A referenced media item or product does not exist', {
      fields: { reference: 'unknown media or product id' },
    });
  if (code === '23505')
    throw new AppError('VALIDATION_FAILED', 'An item with this id already exists', {
      fields: { id: 'already exists' },
    });
  throw e;
};

export async function listEntities(c: PoolClient, name: string, status?: string) {
  const def = DEFS[known(name)];
  const r = await c.query(
    `SELECT * FROM ${def.table} ${status ? 'WHERE status = $1' : ''} ORDER BY ${def.order}`,
    status ? [status] : [],
  );
  return r.rows.map((x) => dto(def, x));
}

export async function getEntity(c: PoolClient, name: string, id: string) {
  const def = DEFS[known(name)];
  const r = await c.query(`SELECT * FROM ${def.table} WHERE id = $1`, [id]);
  if (r.rowCount === 0) throw new AppError('NOT_FOUND', 'Not found');
  return dto(def, r.rows[0]);
}

export async function createEntity(c: PoolClient, x: Ctx, name: string, body: unknown) {
  const n = known(name);
  const def = DEFS[n];
  const parsed = ENTITY_SCHEMAS[n].safeParse(body);
  if (!parsed.success)
    throw new AppError('VALIDATION_FAILED', 'Invalid content', {
      fields: Object.fromEntries(parsed.error.issues.map((i) => [i.path.join('.') || '_', i.message])),
    });
  const v = parsed.data as Record<string, unknown>;
  checkRules(n, v);
  const cols: string[] = [];
  const args: unknown[] = [];
  for (const [camel, snake] of Object.entries(def.map)) {
    if (camel === 'id' && !def.slugId) continue;
    const val = v[camel];
    if (val === undefined) continue;
    cols.push(snake);
    args.push(def.json.includes(camel) ? (val === null ? null : JSON.stringify(val)) : val);
  }
  if (def.slugId && !v.id)
    throw new AppError('VALIDATION_FAILED', 'An id (slug) is required', { fields: { id: 'required' } });
  try {
    const r = await c.query(
      `INSERT INTO ${def.table} (${cols.join(',')}) VALUES (${args.map((_, i) => `$${i + 1}`).join(',')}) RETURNING *`,
      args,
    );
    await audit(c, {
      actorId: x.adminId,
      actorRole: x.role,
      action: `content.${n}.create`,
      resourceType: n,
      resourceId: String(r.rows[0].id),
      requestId: x.requestId,
    });
    return dto(def, r.rows[0]);
  } catch (e) {
    return fkError(e);
  }
}

export async function updateEntity(
  c: PoolClient,
  x: Ctx,
  name: string,
  id: string,
  body: unknown,
  expectedRev: number,
) {
  const n = known(name);
  const def = DEFS[n];
  const schema = (ENTITY_SCHEMAS[n] as z.ZodObject).partial();
  const parsed = schema.safeParse(body);
  if (!parsed.success)
    throw new AppError('VALIDATION_FAILED', 'Invalid content', {
      fields: Object.fromEntries(parsed.error.issues.map((i) => [i.path.join('.') || '_', i.message])),
    });
  const cur = await c.query(`SELECT * FROM ${def.table} WHERE id = $1 FOR UPDATE`, [id]);
  if (cur.rowCount === 0) throw new AppError('NOT_FOUND', 'Not found');
  if (cur.rows[0].rev !== expectedRev)
    throw new AppError('ETAG_MISMATCH', 'This item changed since you loaded it', {
      lines: [dto(def, cur.rows[0])],
    });
  const v = parsed.data as Record<string, unknown>;
  const merged = { ...dto(def, cur.rows[0]), ...v };
  checkRules(n, merged);
  const sets: string[] = [];
  const args: unknown[] = [id];
  for (const [camel, snake] of Object.entries(def.map)) {
    if (camel === 'id') continue;
    const val = v[camel];
    if (val === undefined) continue;
    args.push(def.json.includes(camel) ? (val === null ? null : JSON.stringify(val)) : val);
    sets.push(`${snake} = $${args.length}`);
  }
  if (!sets.length) return dto(def, cur.rows[0]);
  try {
    const r = await c.query(
      `UPDATE ${def.table} SET ${sets.join(', ')}, rev = rev + 1, updated_at = now() WHERE id = $1 RETURNING *`,
      args,
    );
    await audit(c, {
      actorId: x.adminId,
      actorRole: x.role,
      action: `content.${n}.update`,
      resourceType: n,
      resourceId: id,
      after: v,
      requestId: x.requestId,
    });
    return dto(def, r.rows[0]);
  } catch (e) {
    return fkError(e);
  }
}

export async function deleteEntity(c: PoolClient, x: Ctx, name: string, id: string) {
  const n = known(name);
  const def = DEFS[n];
  const cur = await c.query(`SELECT status FROM ${def.table} WHERE id = $1 FOR UPDATE`, [id]);
  if (cur.rowCount === 0) throw new AppError('NOT_FOUND', 'Not found');
  if (cur.rows[0].status !== 'draft')
    throw new AppError('ILLEGAL_STATE', 'Only drafts can be deleted; archive the item instead');
  const used = await c.query(`SELECT 1 FROM exp_documents WHERE body::text LIKE $1 LIMIT 1`, [`%${id}%`]);
  if (used.rowCount)
    throw new AppError('ILLEGAL_STATE', 'This item is referenced by a page; remove it there first');
  await c.query(`DELETE FROM ${def.table} WHERE id = $1`, [id]);
  await audit(c, {
    actorId: x.adminId,
    actorRole: x.role,
    action: `content.${n}.delete`,
    resourceType: n,
    resourceId: id,
    requestId: x.requestId,
  });
}

/** Slug-keyed entities use text ids; the rest use uuids (route params are validated accordingly). */
export const entityUsesSlug = (name: string): boolean => DEFS[known(name)].slugId;
