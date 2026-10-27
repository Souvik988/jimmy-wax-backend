import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { PoolClient } from '@jw/database';
import { AppError, decodeCursor, encodeCursor } from '@jw/contracts';
import { audit, type AdminRole } from './admin.ts';

interface Ctx {
  adminId: string;
  role: AdminRole;
  requestId?: string;
}

const fail = (fields: Record<string, string>): never => {
  throw new AppError('VALIDATION_FAILED', 'Some fields are invalid', { fields });
};

export const SlugId = z
  .string()
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'lowercase letters, digits and hyphens')
  .min(2)
  .max(100);
const optInt = (min: number, max: number) => z.number().int().min(min).max(max).nullable().optional();

export const VariantInput = z.object({
  id: SlugId,
  sku: z.string().trim().min(2).max(60),
  title: z.string().trim().min(1).max(80).default('Default'),
  pricePaise: z.number().int().min(0).max(100_000_000),
  compareAtPricePaise: z.number().int().min(0).max(100_000_000).nullable().optional(),
  active: z.boolean().default(true),
  weightGrams: optInt(1, 50_000),
  lengthMm: optInt(1, 2000),
  widthMm: optInt(1, 2000),
  heightMm: optInt(1, 2000),
  hsnCode: z
    .string()
    .regex(/^[0-9]{4,8}$/, '4–8 digits')
    .nullable()
    .optional(),
  barcode: z.string().trim().min(4).max(40).nullable().optional(),
  costPricePaise: z.number().int().min(0).nullable().optional(),
  lowStockThreshold: optInt(0, 100_000),
});
export type VariantInput = z.infer<typeof VariantInput>;

export const ProductInput = z.object({
  id: SlugId.optional(),
  name: z.string().trim().min(2).max(160),
  subtitle: z.string().trim().max(200).default(''),
  description: z.string().trim().max(5000).default(''),
  categoryId: SlugId,
  keyBenefits: z.array(z.string().trim().min(1).max(120)).max(10).default([]),
  suitableSurfaces: z.string().trim().max(1000).nullable().optional(),
  boxContents: z.string().trim().max(1000).nullable().optional(),
  tags: z.array(z.string().trim().toLowerCase().min(1).max(40)).max(20).default([]),
  seoTitle: z.string().trim().max(120).nullable().optional(),
  seoDescription: z.string().trim().max(320).nullable().optional(),
  active: z.boolean().default(true),
  sortOrder: z.number().int().min(0).max(100000).default(0),
  variants: z.array(VariantInput).min(1).max(20),
  media: z
    .array(z.object({ mediaId: z.string().uuid(), alt: z.string().trim().min(1).max(200) }))
    .max(12)
    .default([]),
});
export type ProductInput = z.infer<typeof ProductInput>;

export const ProductPatch = z.object({
  name: z.string().trim().min(2).max(160).optional(),
  subtitle: z.string().trim().max(200).optional(),
  description: z.string().trim().max(5000).optional(),
  categoryId: SlugId.optional(),
  keyBenefits: z.array(z.string().trim().min(1).max(120)).max(10).optional(),
  suitableSurfaces: z.string().trim().max(1000).nullable().optional(),
  boxContents: z.string().trim().max(1000).nullable().optional(),
  tags: z.array(z.string().trim().toLowerCase().min(1).max(40)).max(20).optional(),
  seoTitle: z.string().trim().max(120).nullable().optional(),
  seoDescription: z.string().trim().max(320).nullable().optional(),
  active: z.boolean().optional(),
  sortOrder: z.number().int().min(0).max(100000).optional(),
  expectedVersion: z.number().int().min(1),
});

export const slugify = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);

// -------------------------------------------------------------------- reads
interface ListFilter {
  q?: string;
  categoryId?: string;
  status?: 'active' | 'inactive' | 'archived';
  stock?: 'low' | 'out';
  limit: number;
  cursor?: string;
}
const Cur = z.object({ s: z.number().int(), id: z.string() });

const VARIANT_JSON = `jsonb_build_object('id', v.id, 'sku', v.sku, 'title', v.title, 'pricePaise', v.price_paise,
  'compareAtPricePaise', v.compare_at_price_paise, 'active', v.active,
  'weightGrams', v.weight_grams, 'lengthMm', v.length_mm, 'widthMm', v.width_mm, 'heightMm', v.height_mm,
  'hsnCode', v.hsn_code, 'barcode', v.barcode, 'costPricePaise', v.cost_price_paise,
  'onHand', coalesce(i.on_hand, 0), 'reserved', coalesce(i.reserved, 0), 'lowStockThreshold', i.low_stock_threshold)`;

function dto(r: Record<string, unknown>, withCost: boolean) {
  const variants = ((r.variants as Array<Record<string, unknown>> | null) ?? []).map((v) => {
    const { costPricePaise: _c, ...rest } = v;
    return withCost ? v : rest;
  });
  return {
    id: r.id as string,
    name: r.name as string,
    subtitle: r.subtitle as string,
    description: r.description as string,
    categoryId: r.category_id as string,
    categoryName: r.category_name as string | undefined,
    keyBenefits: r.key_benefits as string[],
    suitableSurfaces: (r.suitable_surfaces as string | null) ?? null,
    boxContents: (r.box_contents as string | null) ?? null,
    tags: r.tags as string[],
    seoTitle: (r.seo_title as string | null) ?? null,
    seoDescription: (r.seo_description as string | null) ?? null,
    active: r.active as boolean,
    archived: r.archived_at != null,
    sortOrder: r.sort_order as number,
    version: r.version as number,
    image: (r.image as string | null) ?? null,
    variants,
    media: (r.media as unknown[] | undefined) ?? undefined,
    updatedAt: new Date(r.updated_at as string).toISOString(),
  };
}

export async function listProducts(c: PoolClient, f: ListFilter, withCost: boolean) {
  const cur = decodeCursor(f.cursor, Cur);
  const args: unknown[] = [];
  const w: string[] = [];
  const add = (v: unknown) => (args.push(v), `$${args.length}`);
  if (f.q) {
    const p = add(`%${f.q.replace(/[%_\\]/g, (m) => '\\' + m)}%`);
    w.push(
      `(p.name ILIKE ${p} OR p.id ILIKE ${p} OR EXISTS (SELECT 1 FROM product_variants v WHERE v.product_id = p.id AND (v.sku ILIKE ${p} OR v.barcode ILIKE ${p})))`,
    );
  }
  if (f.categoryId) w.push(`p.category_id = ${add(f.categoryId)}`);
  if (f.status === 'archived') w.push('p.archived_at IS NOT NULL');
  else {
    w.push('p.archived_at IS NULL');
    if (f.status === 'active') w.push('p.active');
    if (f.status === 'inactive') w.push('NOT p.active');
  }
  if (f.stock === 'out')
    w.push(
      `NOT EXISTS (SELECT 1 FROM product_variants v JOIN inventory_positions i ON i.variant_id = v.id WHERE v.product_id = p.id AND i.on_hand - i.reserved > 0)`,
    );
  if (f.stock === 'low')
    w.push(
      `EXISTS (SELECT 1 FROM product_variants v JOIN inventory_positions i ON i.variant_id = v.id WHERE v.product_id = p.id AND i.low_stock_threshold IS NOT NULL AND i.on_hand - i.reserved <= i.low_stock_threshold)`,
    );
  if (cur) w.push(`(p.sort_order, p.id) > (${add(cur.s)}, ${add(cur.id)})`);
  const lim = add(f.limit + 1);
  const r = await c.query(
    `SELECT p.*, cat.name AS category_name,
            (SELECT jsonb_agg(${VARIANT_JSON} ORDER BY v.id) FROM product_variants v
               LEFT JOIN inventory_positions i ON i.variant_id = v.id WHERE v.product_id = p.id) AS variants,
            (SELECT m.asset_path FROM product_media m WHERE m.product_id = p.id ORDER BY m.position LIMIT 1) AS image
       FROM products p JOIN categories cat ON cat.id = p.category_id
      ${w.length ? 'WHERE ' + w.join(' AND ') : ''}
      ORDER BY p.sort_order, p.id LIMIT ${lim}`,
    args,
  );
  const rows = r.rows.slice(0, f.limit);
  const last = rows[rows.length - 1];
  return {
    items: rows.map((x) => dto(x, withCost)),
    nextCursor:
      r.rows.length > f.limit && last
        ? encodeCursor({ s: last.sort_order as number, id: last.id as string })
        : null,
  };
}

export async function getProduct(c: PoolClient, id: string, withCost: boolean) {
  const r = await c.query(
    `SELECT p.*, cat.name AS category_name,
            (SELECT jsonb_agg(${VARIANT_JSON} ORDER BY v.id) FROM product_variants v
               LEFT JOIN inventory_positions i ON i.variant_id = v.id WHERE v.product_id = p.id) AS variants,
            (SELECT jsonb_agg(jsonb_build_object('position', m.position, 'assetPath', m.asset_path, 'alt', m.alt_text, 'mediaId', m.media_id)
                              ORDER BY m.position) FROM product_media m WHERE m.product_id = p.id) AS media
       FROM products p JOIN categories cat ON cat.id = p.category_id WHERE p.id = $1`,
    [id],
  );
  if (r.rowCount === 0) throw new AppError('NOT_FOUND', 'Product not found');
  return dto(r.rows[0], withCost);
}

// ------------------------------------------------------------------- writes
async function assertCategory(c: PoolClient, id: string) {
  const r = await c.query(`SELECT 1 FROM categories WHERE id = $1`, [id]);
  if (r.rowCount === 0) fail({ categoryId: 'unknown category' });
}

/** Library media → catalogue image path. Only ready, non-archived images may be attached. */
async function mediaPath(c: PoolClient, mediaId: string): Promise<string> {
  const r = await c.query(
    `SELECT sha256, variants, status, archived_at, kind FROM media_assets WHERE id = $1`,
    [mediaId],
  );
  const m = r.rows[0];
  if (!m || m.kind !== 'image' || m.status !== 'ready' || m.archived_at)
    fail({ media: `unusable media ${mediaId}` });
  const names = (m.variants as Array<{ file: string; width: number }>).map((v) => v.file);
  const file = names.includes('w1080.webp') ? 'w1080.webp' : 'orig.webp';
  return `/v1/media/${m.sha256 as string}/${file}`;
}

async function writeVariant(c: PoolClient, productId: string, v: VariantInput, x: Ctx) {
  if (v.costPricePaise != null && x.role !== 'admin')
    throw new AppError('FORBIDDEN', 'Only administrators may set cost prices');
  if (v.compareAtPricePaise != null && v.compareAtPricePaise < v.pricePaise)
    fail({ [`variant.${v.id}.compareAtPricePaise`]: 'must be at least the selling price' });
  try {
    await c.query(
      `INSERT INTO product_variants (id, product_id, sku, title, price_paise, compare_at_price_paise, active,
         weight_grams, length_mm, width_mm, height_mm, hsn_code, barcode, cost_price_paise)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [
        v.id,
        productId,
        v.sku,
        v.title,
        v.pricePaise,
        v.compareAtPricePaise ?? null,
        v.active,
        v.weightGrams ?? null,
        v.lengthMm ?? null,
        v.widthMm ?? null,
        v.heightMm ?? null,
        v.hsnCode ?? null,
        v.barcode ?? null,
        v.costPricePaise ?? null,
      ],
    );
  } catch (e) {
    if ((e as { code?: string }).code === '23505') fail({ [`variant.${v.id}`]: 'id or SKU already exists' });
    throw e;
  }
  if (v.lowStockThreshold != null)
    await c.query(`UPDATE inventory_positions SET low_stock_threshold = $2 WHERE variant_id = $1`, [
      v.id,
      v.lowStockThreshold,
    ]);
}

export async function createProduct(c: PoolClient, x: Ctx, input: ProductInput) {
  const id = input.id ?? slugify(input.name);
  if (id.length < 2) fail({ id: 'could not derive an id from the name' });
  await assertCategory(c, input.categoryId);
  try {
    await c.query(
      `INSERT INTO products (id, category_id, name, subtitle, description, key_benefits, suitable_surfaces, box_contents,
         tags, seo_title, seo_description, active, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [
        id,
        input.categoryId,
        input.name,
        input.subtitle,
        input.description,
        input.keyBenefits,
        input.suitableSurfaces ?? null,
        input.boxContents ?? null,
        input.tags,
        input.seoTitle ?? null,
        input.seoDescription ?? null,
        input.active,
        input.sortOrder,
      ],
    );
  } catch (e) {
    if ((e as { code?: string }).code === '23505') fail({ id: 'a product with this id already exists' });
    throw e;
  }
  for (const v of input.variants) await writeVariant(c, id, v, x);
  await replaceMedia(c, id, input.media);
  await audit(c, {
    actorId: x.adminId,
    actorRole: x.role,
    action: 'product.create',
    resourceType: 'product',
    resourceId: id,
    after: { name: input.name, variants: input.variants.map((v) => v.id) },
    requestId: x.requestId,
  });
  return getProduct(c, id, x.role === 'admin');
}

async function replaceMedia(
  c: PoolClient,
  productId: string,
  items: Array<{ mediaId: string; alt: string }>,
) {
  await c.query(`DELETE FROM product_media WHERE product_id = $1`, [productId]);
  let pos = 0;
  for (const m of items) {
    await c.query(
      `INSERT INTO product_media (product_id, asset_path, alt_text, position, media_id) VALUES ($1,$2,$3,$4,$5)`,
      [productId, await mediaPath(c, m.mediaId), m.alt, pos++, m.mediaId],
    );
  }
}

export async function setProductMedia(
  c: PoolClient,
  x: Ctx,
  productId: string,
  items: Array<{ mediaId: string; alt: string }>,
) {
  const p = await c.query(`SELECT 1 FROM products WHERE id = $1 FOR UPDATE`, [productId]);
  if (p.rowCount === 0) throw new AppError('NOT_FOUND', 'Product not found');
  await replaceMedia(c, productId, items);
  await c.query(`UPDATE products SET version = version + 1, updated_at = now() WHERE id = $1`, [productId]);
  await audit(c, {
    actorId: x.adminId,
    actorRole: x.role,
    action: 'product.media',
    resourceType: 'product',
    resourceId: productId,
    after: { media: items.map((m) => m.mediaId) },
    requestId: x.requestId,
  });
  return getProduct(c, productId, x.role === 'admin');
}

const COLS: Record<string, string> = {
  name: 'name',
  subtitle: 'subtitle',
  description: 'description',
  categoryId: 'category_id',
  keyBenefits: 'key_benefits',
  suitableSurfaces: 'suitable_surfaces',
  boxContents: 'box_contents',
  tags: 'tags',
  seoTitle: 'seo_title',
  seoDescription: 'seo_description',
  active: 'active',
  sortOrder: 'sort_order',
};

export async function updateProduct(c: PoolClient, x: Ctx, id: string, patch: z.infer<typeof ProductPatch>) {
  const cur = await c.query(`SELECT * FROM products WHERE id = $1 FOR UPDATE`, [id]);
  if (cur.rowCount === 0) throw new AppError('NOT_FOUND', 'Product not found');
  if (cur.rows[0].version !== patch.expectedVersion)
    throw new AppError('CART_VERSION_CONFLICT', 'This product changed since you opened it; reload and retry');
  if (cur.rows[0].archived_at) throw new AppError('ILLEGAL_STATE', 'Restore the product before editing it');
  if (patch.categoryId) await assertCategory(c, patch.categoryId);
  const sets: string[] = [];
  const args: unknown[] = [id];
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  for (const [k, col] of Object.entries(COLS)) {
    const v = (patch as Record<string, unknown>)[k];
    if (v === undefined) continue;
    args.push(v);
    sets.push(`${col} = $${args.length}`);
    before[k] = cur.rows[0][col];
    after[k] = v;
  }
  if (sets.length === 0) return getProduct(c, id, x.role === 'admin');
  await c.query(
    `UPDATE products SET ${sets.join(', ')}, version = version + 1, updated_at = now() WHERE id = $1`,
    args,
  );
  await audit(c, {
    actorId: x.adminId,
    actorRole: x.role,
    action: 'product.update',
    resourceType: 'product',
    resourceId: id,
    before,
    after,
    requestId: x.requestId,
  });
  return getProduct(c, id, x.role === 'admin');
}

/** Required alongside a new variant: the product version the operator was looking at, and why. */
export const VariantAddGuard = z.object({
  expectedVersion: z.number().int().min(0),
  reason: z.string().trim().min(3).max(300),
});

export async function addVariant(
  c: PoolClient,
  x: Ctx,
  productId: string,
  v: VariantInput,
  guard: z.infer<typeof VariantAddGuard>,
) {
  const p = await c.query(`SELECT version, archived_at FROM products WHERE id = $1 FOR UPDATE`, [productId]);
  if (p.rowCount === 0) throw new AppError('NOT_FOUND', 'Product not found');
  if (p.rows[0].version !== guard.expectedVersion)
    throw new AppError('CART_VERSION_CONFLICT', 'This product changed since you opened it; reload and retry');
  if (p.rows[0].archived_at)
    throw new AppError('ILLEGAL_STATE', 'Restore the product before adding a variant');
  await writeVariant(c, productId, v, x);
  await c.query(`UPDATE products SET version = version + 1, updated_at = now() WHERE id = $1`, [productId]);
  await audit(c, {
    actorId: x.adminId,
    actorRole: x.role,
    action: 'variant.create',
    resourceType: 'variant',
    resourceId: v.id,
    reason: guard.reason,
    before: { productVersion: guard.expectedVersion },
    after: { productId, sku: v.sku, productVersion: guard.expectedVersion + 1 },
    requestId: x.requestId,
  });
  return getProduct(c, productId, x.role === 'admin');
}

/**
 * Admin-side idempotency for create operations (same `idempotency_keys` table the checkout uses). The claim and the work share one
 * transaction, so a failed attempt releases the key. Same key + same body replays the stored response; same key + different body is refused.
 * With no key the work simply runs (existing clients keep working); the dashboard always sends one.
 */
export async function adminIdempotent<T>(
  c: PoolClient,
  x: Ctx,
  operation: string,
  key: string | undefined,
  body: unknown,
  run: () => Promise<T>,
): Promise<{ body: T; replayed: boolean }> {
  if (!key) return { body: await run(), replayed: false };
  if (key.length < 8 || key.length > 128 || !/^[A-Za-z0-9_.:-]+$/.test(key))
    throw new AppError(
      'VALIDATION_FAILED',
      'Idempotency-Key must be 8-128 characters (letters, digits, _ . : -)',
      { fields: { 'Idempotency-Key': 'invalid' } },
    );
  const scope = `admin:${x.adminId}:${operation}`;
  const requestHash = createHash('sha256').update(JSON.stringify(body)).digest('hex');
  const claim = await c.query(
    `INSERT INTO idempotency_keys (scope, key, request_hash) VALUES ($1,$2,$3) ON CONFLICT (scope, key) DO NOTHING RETURNING 1`,
    [scope, key, requestHash],
  );
  if (claim.rowCount === 0) {
    const prior = (
      await c.query(
        `SELECT request_hash, state, response_body FROM idempotency_keys WHERE scope = $1 AND key = $2`,
        [scope, key],
      )
    ).rows[0];
    if (prior.request_hash !== requestHash)
      throw new AppError(
        'DUPLICATE_REQUEST_MISMATCH',
        'This idempotency key was already used with a different request',
      );
    if (prior.state !== 'completed')
      throw new AppError('REQUEST_IN_PROGRESS', 'The original request is still being processed');
    return { body: prior.response_body as T, replayed: true };
  }
  const result = await run();
  await c.query(
    `UPDATE idempotency_keys SET state = 'completed', response_status = 201, response_body = $3, completed_at = now() WHERE scope = $1 AND key = $2`,
    [scope, key, JSON.stringify(result)],
  );
  return { body: result, replayed: false };
}

/** Orders keep immutable snapshots, so a product is archived (hidden, restorable), never deleted. */
export const ArchiveGuard = z.object({
  expectedVersion: z.number().int().min(0),
  reason: z.string().trim().min(3).max(300),
});

export async function archiveProduct(
  c: PoolClient,
  x: Ctx,
  id: string,
  archive: boolean,
  guard: z.infer<typeof ArchiveGuard>,
) {
  const cur = await c.query(`SELECT version, active, archived_at FROM products WHERE id = $1 FOR UPDATE`, [
    id,
  ]);
  if (cur.rowCount === 0) throw new AppError('NOT_FOUND', 'Product not found');
  const row = cur.rows[0] as { version: number; active: boolean; archived_at: Date | null };
  if (row.version !== guard.expectedVersion)
    throw new AppError('CART_VERSION_CONFLICT', 'This product changed since you opened it; reload and retry');
  if (archive && row.archived_at) throw new AppError('ILLEGAL_STATE', 'This product is already archived');
  if (!archive && !row.archived_at) throw new AppError('ILLEGAL_STATE', 'This product is not archived');
  await c.query(
    `UPDATE products SET archived_at = ${archive ? 'now()' : 'NULL'}, active = ${archive ? 'false' : 'active'},
            version = version + 1, updated_at = now() WHERE id = $1`,
    [id],
  );
  await audit(c, {
    actorId: x.adminId,
    actorRole: x.role,
    action: archive ? 'product.archive' : 'product.restore',
    resourceType: 'product',
    resourceId: id,
    reason: guard.reason,
    before: { archived: Boolean(row.archived_at), active: row.active, version: row.version },
    after: { archived: archive, active: archive ? false : row.active, version: row.version + 1 },
    requestId: x.requestId,
  });
  return getProduct(c, id, x.role === 'admin');
}

export async function duplicateProduct(c: PoolClient, x: Ctx, id: string, newId?: string) {
  const src = await getProduct(c, id, x.role === 'admin');
  // A product can be copied many times: without an explicit id take the first free `-copy`, `-copy-2`, ... and give the copy's
  // SKUs a suffix that cannot collide with an earlier copy (the unique SKU used to make a second copy fail).
  let nid = newId;
  let copyNo = 1;
  if (!nid) {
    for (; copyNo <= 50; copyNo += 1) {
      const candidate = (copyNo === 1 ? `${id}-copy` : `${id}-copy-${copyNo}`).slice(0, 100);
      if ((await c.query(`SELECT 1 FROM products WHERE id = $1`, [candidate])).rowCount === 0) {
        nid = candidate;
        break;
      }
    }
    if (!nid)
      throw new AppError(
        'VALIDATION_FAILED',
        'This product already has many copies; choose an id for the new one',
        { fields: { id: 'choose a new id' } },
      );
  }
  const skuSuffix =
    copyNo === 1 && !newId
      ? 'COPY'
      : newId
        ? `C${createHash('sha1').update(nid).digest('hex').slice(0, 5).toUpperCase()}`
        : `COPY${copyNo}`;
  const input: ProductInput = {
    id: nid,
    name: `${src.name} (copy)`,
    subtitle: src.subtitle,
    description: src.description,
    categoryId: src.categoryId,
    keyBenefits: src.keyBenefits,
    suitableSurfaces: src.suitableSurfaces,
    boxContents: src.boxContents,
    tags: src.tags,
    seoTitle: src.seoTitle,
    seoDescription: src.seoDescription,
    active: false, // a copy is never live until a human reviews it
    sortOrder: src.sortOrder,
    variants: (src.variants as Array<Record<string, unknown>>).map((v, n) => ({
      id: `${nid}-${n + 1}`.slice(0, 100),
      sku: `${String(v.sku).slice(0, 60 - skuSuffix.length - 4)}-${skuSuffix}${n + 1}`,
      title: v.title as string,
      pricePaise: v.pricePaise as number,
      compareAtPricePaise: (v.compareAtPricePaise as number | null) ?? null,
      active: false,
      weightGrams: (v.weightGrams as number | null) ?? null,
      lengthMm: (v.lengthMm as number | null) ?? null,
      widthMm: (v.widthMm as number | null) ?? null,
      heightMm: (v.heightMm as number | null) ?? null,
      hsnCode: (v.hsnCode as string | null) ?? null,
      barcode: null,
      costPricePaise: x.role === 'admin' ? ((v.costPricePaise as number | null) ?? null) : null,
    })),
    media: ((src.media as Array<{ mediaId: string | null; alt: string }> | undefined) ?? [])
      .filter((m) => m.mediaId)
      .map((m) => ({ mediaId: m.mediaId as string, alt: m.alt })),
  };
  return createProduct(c, x, input);
}

// --------------------------------------------------------------- categories
const CategoryInput = z.object({
  id: SlugId.optional(),
  name: z.string().trim().min(2).max(80),
  description: z.string().trim().max(500).default(''),
  imageMediaId: z.string().uuid().nullable().optional(),
  seoTitle: z.string().trim().max(120).nullable().optional(),
  seoDescription: z.string().trim().max(320).nullable().optional(),
  active: z.boolean().default(true),
  sortOrder: z.number().int().min(0).max(100000).optional(),
});
export { CategoryInput };

const catDto = (r: Record<string, unknown>) => ({
  id: r.id as string,
  name: r.name as string,
  description: r.description as string,
  imageMediaId: (r.image_media_id as string | null) ?? null,
  seoTitle: (r.seo_title as string | null) ?? null,
  seoDescription: (r.seo_description as string | null) ?? null,
  active: r.active as boolean,
  sortOrder: r.sort_order as number,
  /** Live (non-archived) products. Deleting needs this AND archivedProductCount to be 0. */
  productCount: (r.product_count as number | undefined) ?? undefined,
  archivedProductCount: (r.archived_product_count as number | undefined) ?? undefined,
  /** Revision for guarded writes: send it back as expectedRev. */
  rev: (r.rev as number | undefined) ?? 1,
  updatedAt: r.updated_at ? new Date(r.updated_at as string).toISOString() : null,
});

export async function listCategoriesAdmin(c: PoolClient) {
  const r = await c.query(
    `SELECT c.*, (SELECT count(*)::int FROM products p WHERE p.category_id = c.id AND p.archived_at IS NULL) AS product_count,
            (SELECT count(*)::int FROM products p WHERE p.category_id = c.id AND p.archived_at IS NOT NULL) AS archived_product_count
       FROM categories c ORDER BY c.sort_order, c.id`,
  );
  return r.rows.map(catDto);
}

export async function createCategory(c: PoolClient, x: Ctx, input: z.infer<typeof CategoryInput>) {
  const id = input.id ?? slugify(input.name);
  const next = await c.query(`SELECT coalesce(max(sort_order), 0) + 1 AS n FROM categories`);
  try {
    await c.query(
      `INSERT INTO categories (id, name, description, image_media_id, seo_title, seo_description, active, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        id,
        input.name,
        input.description,
        input.imageMediaId ?? null,
        input.seoTitle ?? null,
        input.seoDescription ?? null,
        input.active,
        input.sortOrder ?? next.rows[0].n,
      ],
    );
  } catch (e) {
    if ((e as { code?: string }).code === '23505')
      fail({ name: 'a category with this name or id already exists' });
    throw e;
  }
  await audit(c, {
    actorId: x.adminId,
    actorRole: x.role,
    action: 'category.create',
    resourceType: 'category',
    resourceId: id,
    after: { name: input.name },
    requestId: x.requestId,
  });
  return (await listCategoriesAdmin(c)).find((k) => k.id === id)!;
}

export async function updateCategory(
  c: PoolClient,
  x: Ctx,
  id: string,
  patch: Partial<z.infer<typeof CategoryInput>>,
  expectedRev: number,
) {
  const cur = await c.query(`SELECT * FROM categories WHERE id = $1 FOR UPDATE`, [id]);
  if (cur.rowCount === 0) throw new AppError('NOT_FOUND', 'Category not found');
  if (cur.rows[0].rev !== expectedRev)
    throw new AppError(
      'CART_VERSION_CONFLICT',
      'This category changed since you loaded it; reload and try again',
      { lines: [catDto(cur.rows[0])] },
    );
  const map: Record<string, string> = {
    name: 'name',
    description: 'description',
    imageMediaId: 'image_media_id',
    seoTitle: 'seo_title',
    seoDescription: 'seo_description',
    active: 'active',
    sortOrder: 'sort_order',
  };
  const sets: string[] = [];
  const args: unknown[] = [id];
  for (const [k, col] of Object.entries(map)) {
    const v = (patch as Record<string, unknown>)[k];
    if (v === undefined) continue;
    args.push(v);
    sets.push(`${col} = $${args.length}`);
  }
  if (sets.length) {
    try {
      const r = await c.query(
        `UPDATE categories SET ${sets.join(', ')}, rev = rev + 1, updated_at = now() WHERE id = $1`,
        args,
      );
      if (r.rowCount === 0) throw new AppError('NOT_FOUND', 'Category not found');
    } catch (e) {
      if ((e as { code?: string }).code === '23505')
        fail({ name: 'a category with this name already exists' });
      throw e;
    }
    await audit(c, {
      actorId: x.adminId,
      actorRole: x.role,
      action: 'category.update',
      resourceType: 'category',
      resourceId: id,
      before: Object.fromEntries(Object.keys(patch).map((k) => [k, cur.rows[0][map[k] ?? k]])),
      after: patch,
      requestId: x.requestId,
    });
  }
  const found = (await listCategoriesAdmin(c)).find((k) => k.id === id);
  if (!found) throw new AppError('NOT_FOUND', 'Category not found');
  return found;
}

export async function reorderCategories(
  c: PoolClient,
  x: Ctx,
  ids: string[],
  expectedRevs: Record<string, number>,
) {
  const all = await c.query(`SELECT id, rev, sort_order FROM categories FOR UPDATE`);
  const have = new Set(all.rows.map((r) => r.id as string));
  if (ids.length !== have.size || ids.some((i) => !have.has(i)) || new Set(ids).size !== ids.length)
    fail({ order: 'must list every category exactly once' });
  const stale = all.rows.filter((r) => expectedRevs[r.id as string] !== r.rev).map((r) => r.id as string);
  if (stale.length)
    throw new AppError(
      'CART_VERSION_CONFLICT',
      'The category list changed since you loaded it; reload and try again',
      { fields: Object.fromEntries(stale.map((i) => [i, 'changed'])) },
    );
  for (const [n, id] of ids.entries())
    await c.query(`UPDATE categories SET sort_order = $2, rev = rev + 1, updated_at = now() WHERE id = $1`, [
      id,
      n + 1,
    ]);
  await audit(c, {
    actorId: x.adminId,
    actorRole: x.role,
    action: 'category.reorder',
    resourceType: 'category',
    resourceId: 'all',
    before: {
      order: [...all.rows]
        .sort((a, b) => (a.sort_order as number) - (b.sort_order as number))
        .map((r) => r.id as string),
    },
    after: { order: ids },
    requestId: x.requestId,
  });
  return listCategoriesAdmin(c);
}

export async function deleteCategory(c: PoolClient, x: Ctx, id: string) {
  const blockers = await c.query(
    `SELECT id, name, (archived_at IS NOT NULL) AS archived FROM products WHERE category_id = $1 ORDER BY id LIMIT 50`,
    [id],
  );
  if (blockers.rowCount)
    throw new AppError(
      'ILLEGAL_STATE',
      'Move this category’s products to another category first (archived products count too)',
      {
        lines: blockers.rows.map((p) => ({ type: 'product', id: p.id, label: p.name, archived: p.archived })),
      },
    );
  const r = await c.query(`DELETE FROM categories WHERE id = $1`, [id]);
  if (r.rowCount === 0) throw new AppError('NOT_FOUND', 'Category not found');
  await audit(c, {
    actorId: x.adminId,
    actorRole: x.role,
    action: 'category.delete',
    resourceType: 'category',
    resourceId: id,
    requestId: x.requestId,
  });
}

// -------------------------------------------------------------- collections
export const CollectionRule = z.object({
  categoryIds: z.array(SlugId).max(20).optional(),
  tags: z.array(z.string().trim().toLowerCase().min(1).max(40)).max(20).optional(),
  inStockOnly: z.boolean().optional(),
  sort: z.enum(['newest', 'price_asc', 'price_desc', 'name']).default('newest'),
  limit: z.number().int().min(1).max(48).default(12),
});
export const CollectionInput = z
  .object({
    id: SlugId.optional(),
    name: z.string().trim().min(2).max(120),
    description: z.string().trim().max(1000).default(''),
    kind: z.enum(['manual', 'smart']).default('manual'),
    productIds: z.array(SlugId).max(100).optional(),
    rule: CollectionRule.optional(),
    visible: z.boolean().default(true),
    seoTitle: z.string().trim().max(120).nullable().optional(),
    seoDescription: z.string().trim().max(320).nullable().optional(),
  })
  .refine((v) => (v.kind === 'smart' ? !!v.rule && !v.productIds : !v.rule), {
    message: 'smart collections need a rule; manual collections need productIds',
  });
export type CollectionInput = z.infer<typeof CollectionInput>;

async function collectionDto(c: PoolClient, row: Record<string, unknown>) {
  const items = await c.query(
    `SELECT product_id FROM collection_items WHERE collection_id = $1 ORDER BY position`,
    [row.id],
  );
  return {
    id: row.id as string,
    name: row.name as string,
    description: row.description as string,
    kind: row.kind as 'manual' | 'smart',
    productIds: items.rows.map((r) => r.product_id as string),
    rule: (row.rule as z.infer<typeof CollectionRule> | null) ?? null,
    visible: row.visible as boolean,
    seoTitle: (row.seo_title as string | null) ?? null,
    seoDescription: (row.seo_description as string | null) ?? null,
    rev: row.rev as number,
    updatedAt: new Date(row.updated_at as string).toISOString(),
  };
}

export async function listCollections(c: PoolClient) {
  const r = await c.query(`SELECT * FROM collections ORDER BY name`);
  return Promise.all(r.rows.map((x) => collectionDto(c, x)));
}
export async function getCollection(c: PoolClient, id: string) {
  const r = await c.query(`SELECT * FROM collections WHERE id = $1`, [id]);
  if (r.rowCount === 0) throw new AppError('NOT_FOUND', 'Collection not found');
  return collectionDto(c, r.rows[0]);
}

async function setItems(c: PoolClient, id: string, productIds: string[]) {
  if (new Set(productIds).size !== productIds.length) fail({ productIds: 'duplicates are not allowed' });
  if (productIds.length) {
    const ok = await c.query(`SELECT id FROM products WHERE id = ANY($1) AND archived_at IS NULL`, [
      productIds,
    ]);
    if (ok.rowCount !== productIds.length) fail({ productIds: 'unknown or archived product' });
  }
  await c.query(`DELETE FROM collection_items WHERE collection_id = $1`, [id]);
  for (const [n, pid] of productIds.entries())
    await c.query(`INSERT INTO collection_items (collection_id, product_id, position) VALUES ($1,$2,$3)`, [
      id,
      pid,
      n,
    ]);
}

export async function createCollection(c: PoolClient, x: Ctx, input: CollectionInput) {
  const id = input.id ?? slugify(input.name);
  try {
    await c.query(
      `INSERT INTO collections (id, name, description, kind, rule, visible, seo_title, seo_description)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        id,
        input.name,
        input.description,
        input.kind,
        input.kind === 'smart' ? JSON.stringify(input.rule) : null,
        input.visible,
        input.seoTitle ?? null,
        input.seoDescription ?? null,
      ],
    );
  } catch (e) {
    if ((e as { code?: string }).code === '23505') fail({ id: 'a collection with this id already exists' });
    throw e;
  }
  if (input.kind === 'manual') await setItems(c, id, input.productIds ?? []);
  await audit(c, {
    actorId: x.adminId,
    actorRole: x.role,
    action: 'collection.create',
    resourceType: 'collection',
    resourceId: id,
    after: { name: input.name, kind: input.kind },
    requestId: x.requestId,
  });
  return getCollection(c, id);
}

export async function updateCollection(
  c: PoolClient,
  x: Ctx,
  id: string,
  input: CollectionInput,
  expectedRev: number,
) {
  const cur = await c.query(`SELECT * FROM collections WHERE id = $1 FOR UPDATE`, [id]);
  if (cur.rowCount === 0) throw new AppError('NOT_FOUND', 'Collection not found');
  if (cur.rows[0].rev !== expectedRev)
    throw new AppError(
      'CART_VERSION_CONFLICT',
      'This collection changed since you opened it; reload and retry',
    );
  if (cur.rows[0].kind !== input.kind)
    fail({ kind: 'cannot change between manual and smart; create a new collection' });
  await c.query(
    `UPDATE collections SET name=$2, description=$3, rule=$4, visible=$5, seo_title=$6, seo_description=$7,
            rev = rev + 1, updated_at = now() WHERE id = $1`,
    [
      id,
      input.name,
      input.description,
      input.kind === 'smart' ? JSON.stringify(input.rule) : null,
      input.visible,
      input.seoTitle ?? null,
      input.seoDescription ?? null,
    ],
  );
  if (input.kind === 'manual') await setItems(c, id, input.productIds ?? []);
  await audit(c, {
    actorId: x.adminId,
    actorRole: x.role,
    action: 'collection.update',
    resourceType: 'collection',
    resourceId: id,
    before: { rev: expectedRev },
    after: { name: input.name },
    requestId: x.requestId,
  });
  return getCollection(c, id);
}

export const CollectionDeleteGuard = z.object({
  expectedRev: z.number().int().min(1),
  reason: z.string().trim().min(3).max(300),
});

/** Studio documents (draft or live) and campaigns that point at a collection by slug. */
export async function collectionStudioRefs(
  c: PoolClient,
  id: string,
): Promise<Array<{ type: string; id: string; label: string }>> {
  const like = `%"slug": "${id}"%`;
  const out: Array<{ type: string; id: string; label: string }> = [];
  (
    await c.query(
      `SELECT channel || '/' || kind || ':' || key AS doc FROM exp_documents WHERE body::text LIKE $1 ORDER BY 1`,
      [like],
    )
  ).rows.forEach((r) =>
    out.push({ type: 'studio_draft', id: String(r.doc), label: `Draft ${String(r.doc)}` }),
  );
  (
    await c.query(
      `SELECT channel, number FROM v_exp_effective WHERE snapshot::text LIKE $1 ORDER BY channel`,
      [like],
    )
  ).rows.forEach((r) =>
    out.push({
      type: 'studio_live',
      id: String(r.channel),
      label: `Live ${String(r.channel)} release #${String(r.number)}`,
    }),
  );
  (
    await c.query(
      `SELECT id, name FROM exp_campaigns WHERE status <> 'archived' AND (coalesce(app::text, '') || coalesce(web::text, '')) LIKE $1`,
      [like],
    )
  ).rows.forEach((r) => out.push({ type: 'campaign', id: String(r.id), label: String(r.name) }));
  return out;
}

export async function deleteCollection(
  c: PoolClient,
  x: Ctx,
  id: string,
  guard: z.infer<typeof CollectionDeleteGuard>,
) {
  const cur = await c.query(`SELECT rev FROM collections WHERE id = $1 FOR UPDATE`, [id]);
  if (cur.rowCount === 0) throw new AppError('NOT_FOUND', 'Collection not found');
  if (cur.rows[0].rev !== guard.expectedRev)
    throw new AppError(
      'CART_VERSION_CONFLICT',
      'This collection changed since you opened it; reload and retry',
    );
  const refs = await collectionStudioRefs(c, id);
  if (refs.length)
    throw new AppError(
      'ILLEGAL_STATE',
      `This collection is used by ${refs.length} Studio item(s); remove it there first`,
      { lines: refs.slice(0, 50) },
    );
  const r = await c.query(`DELETE FROM collections WHERE id = $1`, [id]);
  if (r.rowCount === 0) throw new AppError('NOT_FOUND', 'Collection not found');
  await audit(c, {
    actorId: x.adminId,
    actorRole: x.role,
    action: 'collection.delete',
    resourceType: 'collection',
    resourceId: id,
    reason: guard.reason,
    before: { rev: guard.expectedRev },
    requestId: x.requestId,
  });
}

/** Ordered product ids a collection currently resolves to (active, non-archived products only). */
export async function resolveCollectionProductIds(c: PoolClient, id: string): Promise<string[]> {
  const col = await c.query(`SELECT * FROM collections WHERE id = $1`, [id]);
  if (col.rowCount === 0) throw new AppError('NOT_FOUND', 'Collection not found');
  const k = col.rows[0];
  if (k.kind === 'manual') {
    const r = await c.query(
      `SELECT i.product_id FROM collection_items i JOIN products p ON p.id = i.product_id
        WHERE i.collection_id = $1 AND p.active AND p.archived_at IS NULL ORDER BY i.position`,
      [id],
    );
    return r.rows.map((x) => x.product_id as string);
  }
  const rule = CollectionRule.parse(k.rule);
  const args: unknown[] = [];
  const w = ['p.active', 'p.archived_at IS NULL'];
  if (rule.categoryIds?.length) (args.push(rule.categoryIds), w.push(`p.category_id = ANY($${args.length})`));
  if (rule.tags?.length) (args.push(rule.tags), w.push(`p.tags && $${args.length}`));
  if (rule.inStockOnly)
    w.push(
      `EXISTS (SELECT 1 FROM product_variants v JOIN inventory_positions i ON i.variant_id = v.id WHERE v.product_id = p.id AND v.active AND i.on_hand - i.reserved > 0)`,
    );
  const price = `(SELECT min(v.price_paise) FROM product_variants v WHERE v.product_id = p.id AND v.active)`;
  const order = {
    newest: 'p.created_at DESC, p.id',
    price_asc: `${price} ASC, p.id`,
    price_desc: `${price} DESC, p.id`,
    name: 'p.name, p.id',
  }[rule.sort];
  args.push(rule.limit);
  const r = await c.query(
    `SELECT p.id FROM products p WHERE ${w.join(' AND ')} ORDER BY ${order} LIMIT $${args.length}`,
    args,
  );
  return r.rows.map((x) => x.id as string);
}

// ------------------------------------------------------------------ CSV I/O
export const CSV_COLUMNS = [
  'product_id',
  'name',
  'subtitle',
  'description',
  'category_id',
  'key_benefits',
  'suitable_surfaces',
  'box_contents',
  'tags',
  'active',
  'sort_order',
  'variant_id',
  'sku',
  'variant_title',
  'price_paise',
  'compare_at_price_paise',
  'weight_grams',
  'length_mm',
  'width_mm',
  'height_mm',
  'hsn_code',
  'barcode',
] as const;

/** Spreadsheet formula injection guard for exported text cells. */
export const safeCell = (v: unknown): string => {
  const s = v == null ? '' : String(v);
  const guarded = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
};

export const CATALOG_EXPORT_MAX_ROWS = 20_000;
export async function exportCatalogCsv(c: PoolClient): Promise<string> {
  const r = await c.query(
    `SELECT p.*, v.id AS vid, v.sku, v.title AS vtitle, v.price_paise, v.compare_at_price_paise, v.weight_grams,
            v.length_mm, v.width_mm, v.height_mm, v.hsn_code, v.barcode
       FROM products p JOIN product_variants v ON v.product_id = p.id ORDER BY p.sort_order, p.id, v.id LIMIT ${CATALOG_EXPORT_MAX_ROWS + 1}`,
  );
  if (r.rows.length > CATALOG_EXPORT_MAX_ROWS)
    throw new AppError(
      'VALIDATION_FAILED',
      `The catalogue has more than ${CATALOG_EXPORT_MAX_ROWS} variants; export is limited to that size`,
    );
  const lines = [CSV_COLUMNS.join(',')];
  for (const x of r.rows) {
    lines.push(
      [
        x.id,
        x.name,
        x.subtitle,
        x.description,
        x.category_id,
        (x.key_benefits as string[]).join(';'),
        x.suitable_surfaces,
        x.box_contents,
        (x.tags as string[]).join(';'),
        x.active ? 'true' : 'false',
        x.sort_order,
        x.vid,
        x.sku,
        x.vtitle,
        x.price_paise,
        x.compare_at_price_paise,
        x.weight_grams,
        x.length_mm,
        x.width_mm,
        x.height_mm,
        x.hsn_code,
        x.barcode,
      ]
        .map(safeCell)
        .join(','),
    );
  }
  return lines.join('\r\n') + '\r\n';
}

/** Minimal RFC-4180 parser (quotes, doubled quotes, CRLF/LF). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (q) {
      if (ch === '"' && text[i + 1] === '"') ((cell += '"'), i++);
      else if (ch === '"') q = false;
      else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') (row.push(cell), (cell = ''));
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      cell = '';
      if (row.some((v) => v !== '')) rows.push(row);
      row = [];
    } else cell += ch;
  }
  if (cell !== '' || row.length) (row.push(cell), row.some((v) => v !== '') && rows.push(row));
  return rows;
}

export interface ImportChange {
  kind: 'product' | 'variant';
  id: string;
  action: 'create' | 'update' | 'unchanged';
  /** Names of the fields whose stored value differs from the CSV (updates only). */
  fields: string[];
  priceChange?: { fromPaise: number | null; toPaise: number | null };
}

export interface ImportReport {
  dryRun: boolean;
  rows: number;
  products: { create: number; update: number };
  variants: { create: number; update: number };
  errors: Array<{ row: number; field?: string; message: string }>;
  applied: boolean;
  /** Exact per-record preview; capped at 500 entries (counts above stay exact). */
  changes: ImportChange[];
  /**
   * Fingerprint of THIS csv against the CURRENT product versions / variant timestamps. A commit must echo it back, so only the
   * exact preview an operator reviewed can be applied, and any edit in between (or a replay) invalidates it.
   */
  previewHash: string | null;
}

export interface ImportCommitGuard {
  previewHash?: string | undefined;
  reason?: string | undefined;
}

const num = (s: string | undefined) => (s === undefined || s.trim() === '' ? null : Number(s));

/** All-or-nothing: any row error means nothing is written. */
export async function importCatalogCsv(
  c: PoolClient,
  x: Ctx,
  text: string,
  dryRun: boolean,
  guard: ImportCommitGuard = {},
): Promise<ImportReport> {
  const errors: ImportReport['errors'] = [];
  const rep: ImportReport = {
    dryRun,
    rows: 0,
    products: { create: 0, update: 0 },
    variants: { create: 0, update: 0 },
    errors,
    applied: false,
    changes: [],
    previewHash: null,
  };
  if (!dryRun) {
    const reason = guard.reason?.trim() ?? '';
    if (reason.length < 3 || reason.length > 300)
      throw new AppError('VALIDATION_FAILED', 'A reason (3-300 characters) is required to apply an import', {
        fields: { reason: 'required' },
      });
    if (!guard.previewHash || !/^[0-9a-f]{64}$/.test(guard.previewHash))
      throw new AppError(
        'VALIDATION_FAILED',
        'Preview this exact file first and send its previewHash to apply it',
        { fields: { previewHash: 'required' } },
      );
  }
  if (text.length > 2_000_000) {
    errors.push({ row: 0, message: 'File too large (2 MB max)' });
    return rep;
  }
  const rows = parseCsv(text.replace(/^﻿/, ''));
  const header = rows.shift() ?? [];
  const missing = CSV_COLUMNS.filter((h) => !header.includes(h));
  if (missing.length) {
    errors.push({ row: 1, message: `Missing columns: ${missing.join(', ')}` });
    return rep;
  }
  if (rows.length > 5000) {
    errors.push({ row: 0, message: 'Too many rows (5000 max)' });
    return rep;
  }
  rep.rows = rows.length;
  const idx = Object.fromEntries(header.map((h, i) => [h, i]));
  const get = (r: string[], k: (typeof CSV_COLUMNS)[number]) =>
    r[idx[k] as number]?.replace(/^'(?=[=+\-@\t\r])/, '');
  const products = new Map<string, ProductInput>();
  rows.forEach((r, n) => {
    const rowNo = n + 2;
    const pid = (get(r, 'product_id') ?? '').trim();
    if (!pid) return errors.push({ row: rowNo, field: 'product_id', message: 'required' });
    const variant = VariantInput.safeParse({
      id: (get(r, 'variant_id') ?? '').trim(),
      sku: (get(r, 'sku') ?? '').trim(),
      title: get(r, 'variant_title') || 'Default',
      pricePaise: num(get(r, 'price_paise')),
      compareAtPricePaise: num(get(r, 'compare_at_price_paise')),
      weightGrams: num(get(r, 'weight_grams')),
      lengthMm: num(get(r, 'length_mm')),
      widthMm: num(get(r, 'width_mm')),
      heightMm: num(get(r, 'height_mm')),
      hsnCode: get(r, 'hsn_code') || null,
      barcode: get(r, 'barcode') || null,
    });
    if (!variant.success) {
      for (const i of variant.error.issues)
        errors.push({ row: rowNo, field: i.path.join('.'), message: i.message });
      return;
    }
    let p = products.get(pid);
    if (!p) {
      const parsed = ProductInput.omit({ variants: true, media: true }).safeParse({
        id: pid,
        name: get(r, 'name'),
        subtitle: get(r, 'subtitle') ?? '',
        description: get(r, 'description') ?? '',
        categoryId: get(r, 'category_id'),
        keyBenefits: (get(r, 'key_benefits') ?? '')
          .split(';')
          .map((s) => s.trim())
          .filter(Boolean),
        suitableSurfaces: get(r, 'suitable_surfaces') || null,
        boxContents: get(r, 'box_contents') || null,
        tags: (get(r, 'tags') ?? '')
          .split(';')
          .map((s) => s.trim())
          .filter(Boolean),
        active: (get(r, 'active') ?? 'true').trim().toLowerCase() !== 'false',
        sortOrder: num(get(r, 'sort_order')) ?? 0,
      });
      if (!parsed.success) {
        for (const i of parsed.error.issues)
          errors.push({ row: rowNo, field: i.path.join('.'), message: i.message });
        return;
      }
      p = { ...parsed.data, variants: [], media: [] };
      products.set(pid, p);
    }
    p.variants.push(variant.data);
  });
  if (errors.length) return rep;

  const state: Array<[string, string | number]> = [];
  const unchangedProducts = new Set<string>();
  const unchangedVariants = new Set<string>();
  const differs = (a: unknown, b: unknown) => JSON.stringify(a ?? null) !== JSON.stringify(b ?? null);
  const note = (change: ImportChange) => {
    if (rep.changes.length < 500) rep.changes.push(change);
  };
  for (const p of products.values()) {
    const exists = await c.query(`SELECT * FROM products WHERE id = $1`, [p.id]);
    exists.rowCount ? rep.products.update++ : rep.products.create++;
    if (exists.rowCount) {
      const cur = exists.rows[0] as Record<string, unknown>;
      state.push([`p:${p.id}`, Number(cur.version)]);
      const fields = [
        ['name', cur.name, p.name],
        ['subtitle', cur.subtitle, p.subtitle],
        ['description', cur.description, p.description],
        ['categoryId', cur.category_id, p.categoryId],
        ['keyBenefits', cur.key_benefits, p.keyBenefits],
        ['suitableSurfaces', cur.suitable_surfaces, p.suitableSurfaces],
        ['boxContents', cur.box_contents, p.boxContents],
        ['tags', cur.tags, p.tags],
        ['active', cur.active, p.active],
        ['sortOrder', cur.sort_order, p.sortOrder],
      ]
        .filter(([, a, b]) => differs(a, b))
        .map(([name]) => String(name));
      note({ kind: 'product', id: p.id!, action: fields.length ? 'update' : 'unchanged', fields });
      if (!fields.length) unchangedProducts.add(p.id!);
      // an archived product cannot be edited (updateProduct refuses), so the preview says so instead of failing at commit time;
      // an unchanged archived product (the export lists archived rows too) is simply skipped
      if (fields.length && cur.archived_at)
        errors.push({
          row: 0,
          field: 'product_id',
          message: `product ${p.id} is archived; restore it before importing changes`,
        });
    } else {
      state.push([`p:${p.id}`, 0]);
      note({ kind: 'product', id: p.id!, action: 'create', fields: [] });
    }
    for (const v of p.variants) {
      const ve = await c.query(`SELECT * FROM product_variants WHERE id = $1`, [v.id]);
      if (ve.rowCount && ve.rows[0].product_id !== p.id)
        errors.push({ row: 0, field: 'variant_id', message: `variant ${v.id} belongs to another product` });
      ve.rowCount ? rep.variants.update++ : rep.variants.create++;
      if (ve.rowCount) {
        const cur = ve.rows[0] as Record<string, unknown>;
        state.push([`v:${v.id}`, new Date(cur.updated_at as string).toISOString()]);
        const fields = [
          ['sku', cur.sku, v.sku],
          ['title', cur.title, v.title],
          ['pricePaise', cur.price_paise, v.pricePaise],
          ['compareAtPricePaise', cur.compare_at_price_paise, v.compareAtPricePaise],
          ['weightGrams', cur.weight_grams, v.weightGrams],
          ['lengthMm', cur.length_mm, v.lengthMm],
          ['widthMm', cur.width_mm, v.widthMm],
          ['heightMm', cur.height_mm, v.heightMm],
          ['hsnCode', cur.hsn_code, v.hsnCode],
          ['barcode', cur.barcode, v.barcode],
        ]
          .filter(([, a, b]) => differs(a, b))
          .map(([name]) => String(name));
        if (!fields.length) unchangedVariants.add(v.id);
        note({
          kind: 'variant',
          id: v.id,
          action: fields.length ? 'update' : 'unchanged',
          fields,
          ...(fields.includes('pricePaise')
            ? {
                priceChange: {
                  fromPaise: (cur.price_paise as number | null) ?? null,
                  toPaise: v.pricePaise ?? null,
                },
              }
            : {}),
        });
      } else {
        state.push([`v:${v.id}`, 0]);
        note({ kind: 'variant', id: v.id, action: 'create', fields: [] });
      }
    }
    const cat = await c.query(`SELECT 1 FROM categories WHERE id = $1`, [p.categoryId]);
    if (cat.rowCount === 0)
      errors.push({ row: 0, field: 'category_id', message: `unknown category ${p.categoryId}` });
  }
  if (errors.length) return rep;
  rep.previewHash = createHash('sha256')
    .update(
      JSON.stringify({
        csv: createHash('sha256').update(text).digest('hex'),
        state: state.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
      }),
    )
    .digest('hex');
  if (dryRun) return rep;
  if (rep.previewHash !== guard.previewHash)
    throw new AppError(
      'CART_VERSION_CONFLICT',
      'The catalogue changed since this preview, or the file is different. Preview again and review before applying.',
    );

  for (const p of products.values()) {
    const cur = await c.query(`SELECT version FROM products WHERE id = $1 FOR UPDATE`, [p.id]);
    if (cur.rowCount === 0) {
      await createProduct(c, x, p);
      continue;
    }
    if (!unchangedProducts.has(p.id!))
      await updateProduct(c, x, p.id!, {
        name: p.name,
        subtitle: p.subtitle,
        description: p.description,
        categoryId: p.categoryId,
        keyBenefits: p.keyBenefits,
        suitableSurfaces: p.suitableSurfaces,
        boxContents: p.boxContents,
        tags: p.tags,
        active: p.active,
        sortOrder: p.sortOrder,
        expectedVersion: cur.rows[0].version,
      });
    for (const v of p.variants) {
      if (unchangedVariants.has(v.id)) continue;
      const ve = await c.query(`SELECT 1 FROM product_variants WHERE id = $1`, [v.id]);
      if (ve.rowCount) {
        await c.query(
          `UPDATE product_variants SET sku=$2, title=$3, price_paise=$4, compare_at_price_paise=$5, weight_grams=$6,
                  length_mm=$7, width_mm=$8, height_mm=$9, hsn_code=$10, barcode=$11, updated_at=now() WHERE id=$1`,
          [
            v.id,
            v.sku,
            v.title,
            v.pricePaise,
            v.compareAtPricePaise ?? null,
            v.weightGrams ?? null,
            v.lengthMm ?? null,
            v.widthMm ?? null,
            v.heightMm ?? null,
            v.hsnCode ?? null,
            v.barcode ?? null,
          ],
        );
      } else await writeVariant(c, p.id!, v, x);
    }
  }
  rep.applied = true;
  await audit(c, {
    actorId: x.adminId,
    actorRole: x.role,
    action: 'catalog.import',
    resourceType: 'catalog',
    resourceId: 'csv',
    reason: guard.reason!.trim(),
    before: { previewHash: rep.previewHash },
    after: {
      products: rep.products,
      variants: rep.variants,
      changed: rep.changes
        .filter((ch) => ch.action !== 'unchanged')
        .slice(0, 200)
        .map((ch) => ({
          kind: ch.kind,
          id: ch.id,
          action: ch.action,
          fields: ch.fields,
          ...(ch.priceChange ? { priceChange: ch.priceChange } : {}),
        })),
    },
    requestId: x.requestId,
  });
  return rep;
}
