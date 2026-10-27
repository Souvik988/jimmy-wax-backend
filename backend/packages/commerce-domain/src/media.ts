import { z } from 'zod';
import type { PoolClient } from '@jw/database';
import { AppError, decodeCursor, encodeCursor } from '@jw/contracts';
import type { Processed } from '@jw/integrations';
import { audit, type AdminRole } from './admin.ts';

interface Ctx {
  adminId: string;
  role: AdminRole;
  requestId?: string;
}

export const PROVENANCE = ['original_photo', 'edited_photo', 'generated', 'illustration'] as const;
export const MEDIA_ROLES = [
  'product_packshot',
  'campaign',
  'brand',
  'mascot',
  'state_art',
  'avatar',
  'poster',
  'font',
] as const;

export const MediaPatch = z.object({
  alt: z.string().trim().max(200).optional(),
  decorative: z.boolean().optional(),
  focalX: z.number().min(0).max(1).nullable().optional(),
  focalY: z.number().min(0).max(1).nullable().optional(),
  tags: z.array(z.string().trim().toLowerCase().min(1).max(40)).max(20).optional(),
  folder: z.string().trim().max(80).optional(),
  role: z.enum(MEDIA_ROLES).nullable().optional(),
  provenance: z.enum(PROVENANCE).optional(),
  license: z.string().trim().max(300).nullable().optional(),
  posterMediaId: z.string().uuid().nullable().optional(),
  /** Who owns the rights to the picture (person or company), kept apart from the licence text. */
  rightsHolder: z.string().trim().min(2).max(200).nullable().optional(),
  /** Where the file came from and how it was made (shoot date, photographer, tool); no personal contact details. */
  provenanceNote: z.string().trim().min(3).max(500).nullable().optional(),
  /** Reference to a recorded consent (release form id), when people appear in the picture. */
  consentReference: z.string().trim().min(2).max(200).nullable().optional(),
  /** Path of the same picture shipped inside the mobile app binary (e.g. assets/runtime/banners/x.jpg); the app then shows its bundled copy. */
  bundledKey: z
    .string()
    .regex(/^assets\/[A-Za-z0-9_./-]{3,280}$/, 'a path under assets/')
    .nullable()
    .optional(),
});

export interface MediaRow {
  id: string;
  kind: 'image' | 'video' | 'font';
  sha256: string;
  mime: string;
  bytes: number;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  filename: string;
  status: string;
  provenance: string;
  approval: 'draft' | 'approved' | 'rejected';
  approvalNote: string | null;
  packagingAttested: boolean;
  alt: string;
  decorative: boolean;
  focal: { x: number; y: number } | null;
  tags: string[];
  folder: string;
  role: string | null;
  license: string | null;
  rightsHolder: string | null;
  provenanceNote: string | null;
  consentReference: string | null;
  posterMediaId: string | null;
  /** Shipped inside the mobile app binary; admin-managed. */
  bundledKey: string | null;
  archived: boolean;
  /** Version stamp for guarded writes (archive/restore). */
  updatedAt: string;
  urls: { original: string; variants: Array<{ url: string; width: number | null }> };
  createdAt: string;
}

const rowDto = (r: Record<string, unknown>): MediaRow => {
  const sha = r.sha256 as string;
  const variants = (r.variants as Array<{ file: string; width: number | null }>) ?? [];
  const url = (f: string) => `/v1/media/${sha}/${f}`;
  const orig = variants.find(
    (v) => v.file.startsWith('orig') || v.file.startsWith('video') || v.file.startsWith('font'),
  );
  return {
    id: r.id as string,
    kind: r.kind as MediaRow['kind'],
    sha256: sha,
    mime: r.mime as string,
    bytes: Number(r.bytes),
    width: (r.width as number | null) ?? null,
    height: (r.height as number | null) ?? null,
    durationMs: (r.duration_ms as number | null) ?? null,
    filename: r.filename as string,
    status: r.status as string,
    provenance: r.provenance as string,
    approval: r.approval as MediaRow['approval'],
    approvalNote: (r.approval_note as string | null) ?? null,
    packagingAttested: r.packaging_attested as boolean,
    alt: r.alt as string,
    decorative: r.decorative as boolean,
    focal: r.focal_x != null && r.focal_y != null ? { x: r.focal_x as number, y: r.focal_y as number } : null,
    tags: r.tags as string[],
    folder: r.folder as string,
    role: (r.role as string | null) ?? null,
    license: (r.license as string | null) ?? null,
    rightsHolder: (r.rights_holder as string | null) ?? null,
    provenanceNote: (r.provenance_note as string | null) ?? null,
    consentReference: (r.consent_reference as string | null) ?? null,
    bundledKey: (r.bundled_key as string | null) ?? null,
    updatedAt: new Date(r.updated_at as string).toISOString(),
    posterMediaId: (r.poster_media_id as string | null) ?? null,
    archived: r.archived_at != null,
    urls: {
      original: url(orig?.file ?? 'orig.webp'),
      variants: variants
        .filter((v) => /^w\d+\.webp$/.test(v.file))
        .map((v) => ({ url: url(v.file), width: v.width })),
    },
    createdAt: new Date(r.created_at as string).toISOString(),
  };
};

export interface InsertResult {
  asset: MediaRow;
  duplicate: boolean;
}

/** Content-addressed: uploading identical bytes returns the existing asset. */
export async function insertMedia(
  c: PoolClient,
  x: Ctx,
  p: Processed,
  meta: {
    filename: string;
    alt?: string;
    provenance?: string;
    folder?: string;
    license?: string;
    rightsHolder?: string;
    provenanceNote?: string;
    consentReference?: string;
  },
): Promise<InsertResult> {
  const filename = meta.filename.replace(/[^\w.\- ]+/g, '_').slice(0, 200) || 'upload';
  const ins = await c.query(
    `INSERT INTO media_assets (kind, sha256, mime, bytes, width, height, filename, alt, provenance, folder, license, variants, created_by, rights_holder, provenance_note, consent_reference)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
     ON CONFLICT (sha256) DO NOTHING RETURNING *`,
    [
      p.kind,
      p.sha256,
      p.mime,
      p.bytes,
      p.width,
      p.height,
      filename,
      meta.alt ?? '',
      meta.provenance ?? 'original_photo',
      meta.folder ?? '',
      meta.license ?? null,
      JSON.stringify(p.variants),
      x.adminId,
      meta.rightsHolder ?? null,
      meta.provenanceNote ?? null,
      meta.consentReference ?? null,
    ],
  );
  if (ins.rowCount) {
    await audit(c, {
      actorId: x.adminId,
      actorRole: x.role,
      action: 'media.upload',
      resourceType: 'media',
      resourceId: ins.rows[0].id,
      after: { kind: p.kind, sha256: p.sha256, bytes: p.bytes },
      requestId: x.requestId,
    });
    return { asset: rowDto(ins.rows[0]), duplicate: false };
  }
  const ex = await c.query(`SELECT * FROM media_assets WHERE sha256 = $1`, [p.sha256]);
  return { asset: rowDto(ex.rows[0]), duplicate: true };
}

const Cur = z.object({ t: z.string(), id: z.string() });
export async function listMedia(
  c: PoolClient,
  f: {
    q?: string;
    kind?: string;
    tag?: string;
    folder?: string;
    approval?: string;
    provenance?: string;
    archived?: boolean;
    inUse?: boolean;
    limit: number;
    cursor?: string;
  },
) {
  const cur = decodeCursor(f.cursor, Cur);
  const args: unknown[] = [];
  const w: string[] = [];
  const add = (v: unknown) => (args.push(v), `$${args.length}`);
  if (f.q) {
    const p = add(`%${f.q.replace(/[%_\\]/g, (m) => '\\' + m)}%`);
    w.push(`(filename ILIKE ${p} OR alt ILIKE ${p})`);
  }
  if (f.kind) w.push(`kind = ${add(f.kind)}`);
  if (f.tag) w.push(`${add(f.tag)} = ANY(tags)`);
  if (f.folder !== undefined) w.push(`folder = ${add(f.folder)}`);
  if (f.approval) w.push(`approval = ${add(f.approval)}`);
  if (f.provenance) w.push(`provenance = ${add(f.provenance)}`);
  w.push(f.archived ? 'm.archived_at IS NOT NULL' : 'm.archived_at IS NULL');
  if (f.inUse !== undefined) w.push(f.inUse ? IN_USE_SQL : `NOT ${IN_USE_SQL}`);
  if (cur) w.push(`(created_at, id) < (${add(cur.t)}::timestamptz, ${add(cur.id)}::uuid)`);
  const r = await c.query(
    `SELECT m.* FROM media_assets m WHERE ${w.join(' AND ')} ORDER BY m.created_at DESC, m.id DESC LIMIT ${add(f.limit + 1)}`,
    args,
  );
  const rows = r.rows.slice(0, f.limit);
  const last = rows[rows.length - 1];
  return {
    items: rows.map(rowDto),
    nextCursor:
      r.rows.length > f.limit && last
        ? encodeCursor({ t: new Date(last.created_at as string).toISOString(), id: last.id })
        : null,
  };
}

export async function getMedia(c: PoolClient, id: string): Promise<MediaRow> {
  const r = await c.query(`SELECT * FROM media_assets WHERE id = $1`, [id]);
  if (r.rowCount === 0) throw new AppError('NOT_FOUND', 'Media not found');
  return rowDto(r.rows[0]);
}

export async function updateMedia(c: PoolClient, x: Ctx, id: string, patch: z.infer<typeof MediaPatch>) {
  const cur = await c.query(`SELECT * FROM media_assets WHERE id = $1 FOR UPDATE`, [id]);
  if (cur.rowCount === 0) throw new AppError('NOT_FOUND', 'Media not found');
  const before = cur.rows[0];
  if (patch.bundledKey !== undefined && x.role !== 'admin')
    throw new AppError('FORBIDDEN', 'Only administrators map media to app-bundled files');
  const map: Record<string, string> = {
    alt: 'alt',
    decorative: 'decorative',
    focalX: 'focal_x',
    focalY: 'focal_y',
    tags: 'tags',
    folder: 'folder',
    role: 'role',
    provenance: 'provenance',
    license: 'license',
    rightsHolder: 'rights_holder',
    provenanceNote: 'provenance_note',
    consentReference: 'consent_reference',
    posterMediaId: 'poster_media_id',
    bundledKey: 'bundled_key',
  };
  if (patch.posterMediaId) {
    const p = await c.query(`SELECT kind FROM media_assets WHERE id = $1`, [patch.posterMediaId]);
    if (p.rowCount === 0 || p.rows[0].kind !== 'image')
      throw new AppError('VALIDATION_FAILED', 'Poster must be an image in the library', {
        fields: { posterMediaId: 'not an image asset' },
      });
  }
  const sets: string[] = [];
  const args: unknown[] = [id];
  for (const [k, col] of Object.entries(map)) {
    const v = (patch as Record<string, unknown>)[k];
    if (v === undefined) continue;
    args.push(v);
    sets.push(`${col} = $${args.length}`);
  }
  // A changed provenance invalidates a previous approval: it must be reviewed again.
  const reset =
    (patch.provenance && patch.provenance !== before.provenance && before.approval === 'approved') ||
    (patch.role && patch.role !== before.role && before.approval === 'approved');
  if (reset)
    sets.push(
      `approval = 'draft', approval_by = NULL, approval_at = NULL, approval_note = 'Re-review required after metadata change', packaging_attested = false`,
    );
  if (sets.length) {
    await c.query(`UPDATE media_assets SET ${sets.join(', ')}, updated_at = now() WHERE id = $1`, args);
    await audit(c, {
      actorId: x.adminId,
      actorRole: x.role,
      action: 'media.update',
      resourceType: 'media',
      resourceId: id,
      before: Object.fromEntries(Object.keys(patch).map((k) => [k, before[map[k] ?? k]])),
      after: patch,
      requestId: x.requestId,
    });
  }
  return getMedia(c, id);
}

export async function reviewMedia(
  c: PoolClient,
  x: Ctx,
  id: string,
  decision: { approve: boolean; note?: string; packagingAttested?: boolean },
) {
  const cur = await c.query(`SELECT * FROM media_assets WHERE id = $1 FOR UPDATE`, [id]);
  if (cur.rowCount === 0) throw new AppError('NOT_FOUND', 'Media not found');
  const m = cur.rows[0];
  if (decision.approve) {
    const fields: Record<string, string> = {};
    if (m.status !== 'ready') fields.status = 'the file is not ready';
    if (m.archived_at) fields.archived = 'restore the asset first';
    if (m.kind === 'image' && !m.decorative && m.alt.trim().length < 3)
      fields.alt = 'alt text is required (or mark as decorative)';
    if (m.role === 'product_packshot' && !['original_photo', 'edited_photo'].includes(m.provenance))
      fields.provenance = 'product pack-shots must come from original photography';
    if (m.provenance === 'generated' && !decision.packagingAttested)
      fields.packagingAttested = 'confirm that the image does not alter product packaging or labels';
    if (m.kind === 'video' && !m.poster_media_id)
      fields.posterMediaId = 'a poster image is required for video';
    if (m.kind === 'font' && !m.license) fields.license = 'a licence record is required for fonts';
    if (Object.keys(fields).length)
      throw new AppError('VALIDATION_FAILED', 'This asset cannot be approved yet', { fields });
  }
  await c.query(
    decision.approve
      ? `UPDATE media_assets SET approval='approved', approval_by=$2, approval_at=now(), approval_note=$3,
            packaging_attested = $4, updated_at = now() WHERE id=$1`
      : `UPDATE media_assets SET approval='rejected', approval_by=$2, approval_at=now(), approval_note=$3,
            packaging_attested = false, updated_at = now() WHERE id=$1`,
    decision.approve
      ? [id, x.adminId, decision.note ?? null, decision.packagingAttested ?? false]
      : [id, x.adminId, decision.note ?? null],
  );
  await audit(c, {
    actorId: x.adminId,
    actorRole: x.role,
    action: decision.approve ? 'media.approve' : 'media.reject',
    resourceType: 'media',
    resourceId: id,
    before: { approval: m.approval },
    after: { approval: decision.approve ? 'approved' : 'rejected', note: decision.note },
    requestId: x.requestId,
  });
  return getMedia(c, id);
}

/**
 * SQL that is true when the media asset `m` is referenced anywhere durable: catalogue, library entities, draft Studio
 * documents, the LIVE release of either channel, or a campaign. Kept in one place so the list filter and the archive
 * guard can never disagree (DASH-BR-040/041).
 */
const IN_USE_SQL = `(
  EXISTS (SELECT 1 FROM product_media x WHERE x.media_id = m.id)
  OR EXISTS (SELECT 1 FROM categories x WHERE x.image_media_id = m.id)
  OR EXISTS (SELECT 1 FROM media_assets x WHERE x.poster_media_id = m.id)
  OR EXISTS (SELECT 1 FROM exp_documents x WHERE x.body::text LIKE '%' || m.id::text || '%')
  OR EXISTS (SELECT 1 FROM v_exp_effective x WHERE x.snapshot::text LIKE '%' || m.id::text || '%')
  OR EXISTS (SELECT 1 FROM exp_campaigns x WHERE x.status <> 'archived' AND (coalesce(x.app::text, '') || coalesce(x.web::text, '')) LIKE '%' || m.id::text || '%')
  OR EXISTS (SELECT 1 FROM care_guides x WHERE x.steps::text LIKE '%' || m.id::text || '%')
  OR EXISTS (SELECT 1 FROM stories x WHERE x.video_media_id = m.id OR x.poster_media_id = m.id)
  OR EXISTS (SELECT 1 FROM journal_notes x WHERE x.image_media_id = m.id)
  OR EXISTS (SELECT 1 FROM testimonials x WHERE x.avatar_media_id = m.id OR x.video_media_id = m.id OR x.poster_media_id = m.id)
)`;

export interface MediaUsageRow {
  type:
    | 'product'
    | 'category'
    | 'media_poster'
    | 'studio_draft'
    | 'studio_live'
    | 'campaign'
    | 'care_guide'
    | 'story'
    | 'journal'
    | 'testimonial';
  id: string;
  label: string;
}

/** Every durable place an asset is referenced. Complete: archive is refused while any row exists. */
export async function mediaUsage(c: PoolClient, id: string): Promise<MediaUsageRow[]> {
  const out: MediaUsageRow[] = [];
  const like = `%${id}%`;
  const add = (
    type: MediaUsageRow['type'],
    rows: Array<Record<string, unknown>>,
    idKey: string,
    label: (r: Record<string, unknown>) => string,
  ) => rows.forEach((r) => out.push({ type, id: String(r[idKey]), label: label(r) }));
  add(
    'product',
    (
      await c.query(
        `SELECT p.id, p.name FROM product_media m JOIN products p ON p.id = m.product_id WHERE m.media_id = $1`,
        [id],
      )
    ).rows,
    'id',
    (r) => String(r.name),
  );
  add(
    'category',
    (await c.query(`SELECT id, name FROM categories WHERE image_media_id = $1`, [id])).rows,
    'id',
    (r) => String(r.name),
  );
  add(
    'media_poster',
    (await c.query(`SELECT id, filename FROM media_assets WHERE poster_media_id = $1`, [id])).rows,
    'id',
    (r) => String(r.filename),
  );
  add(
    'studio_draft',
    (
      await c.query(
        `SELECT channel || '/' || kind || ':' || key AS doc FROM exp_documents WHERE body::text LIKE $1 ORDER BY 1`,
        [like],
      )
    ).rows,
    'doc',
    (r) => `Draft ${String(r.doc)}`,
  );
  add(
    'studio_live',
    (
      await c.query(
        `SELECT channel, number FROM v_exp_effective WHERE snapshot::text LIKE $1 ORDER BY channel`,
        [like],
      )
    ).rows,
    'channel',
    (r) => `Live ${String(r.channel)} release #${String(r.number)}`,
  );
  add(
    'campaign',
    (
      await c.query(
        `SELECT id, name FROM exp_campaigns WHERE status <> 'archived' AND (coalesce(app::text, '') || coalesce(web::text, '')) LIKE $1`,
        [like],
      )
    ).rows,
    'id',
    (r) => String(r.name),
  );
  add(
    'care_guide',
    (await c.query(`SELECT id, title FROM care_guides WHERE steps::text LIKE $1`, [like])).rows,
    'id',
    (r) => String(r.title),
  );
  add(
    'story',
    (await c.query(`SELECT id, title FROM stories WHERE video_media_id = $1 OR poster_media_id = $1`, [id]))
      .rows,
    'id',
    (r) => String(r.title),
  );
  add(
    'journal',
    (await c.query(`SELECT id, title FROM journal_notes WHERE image_media_id = $1`, [id])).rows,
    'id',
    (r) => String(r.title),
  );
  add(
    'testimonial',
    (
      await c.query(
        `SELECT id, name FROM testimonials WHERE avatar_media_id = $1 OR video_media_id = $1 OR poster_media_id = $1`,
        [id],
      )
    ).rows,
    'id',
    (r) => String(r.name),
  );
  return out;
}

export const MediaGuard = z.object({
  expectedUpdatedAt: z.string().datetime(),
  reason: z.string().trim().min(3).max(300),
});

export async function archiveMedia(
  c: PoolClient,
  x: Ctx,
  id: string,
  archive: boolean,
  guard: z.infer<typeof MediaGuard>,
) {
  const cur = await c.query(`SELECT updated_at, archived_at FROM media_assets WHERE id = $1 FOR UPDATE`, [
    id,
  ]);
  if (cur.rowCount === 0) throw new AppError('NOT_FOUND', 'Media not found');
  if (new Date(cur.rows[0].updated_at as string).getTime() !== new Date(guard.expectedUpdatedAt).getTime())
    throw new AppError(
      'CART_VERSION_CONFLICT',
      'This asset changed since you loaded it; reload and try again',
    );
  if ((cur.rows[0].archived_at != null) === archive)
    throw new AppError(
      'ILLEGAL_STATE',
      archive ? 'This asset is already archived' : 'This asset is not archived',
    );
  if (archive) {
    const used = await mediaUsage(c, id);
    if (used.length)
      throw new AppError(
        'ILLEGAL_STATE',
        `This asset is in use by ${used.length} item(s); remove it from them first`,
        {
          lines: used.slice(0, 50),
        },
      );
  }
  await c.query(
    `UPDATE media_assets SET archived_at = ${archive ? 'now()' : 'NULL'}, updated_at = now() WHERE id = $1`,
    [id],
  );
  await audit(c, {
    actorId: x.adminId,
    actorRole: x.role,
    action: archive ? 'media.archive' : 'media.restore',
    resourceType: 'media',
    resourceId: id,
    reason: guard.reason,
    before: { archived: !archive },
    after: { archived: archive },
    requestId: x.requestId,
  });
  return getMedia(c, id);
}
