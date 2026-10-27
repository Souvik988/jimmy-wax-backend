import type { PoolClient } from '@jw/database';
import { AppError } from '@jw/contracts';
import { audit, type AdminRole } from './admin.ts';

interface Ctx {
  adminId: string;
  role: AdminRole;
  requestId?: string;
}

/** Policy/care-guide pages are versioned: every save is an immutable version; publishing exposes the current one. */
export async function saveContentDraft(
  c: PoolClient,
  x: Ctx,
  slug: string,
  input: { kind: 'policy' | 'care_guide' | 'page'; title: string; bodyMd: string; expectedVersion?: number },
) {
  const cur = (await c.query(`SELECT * FROM content_pages WHERE slug = $1 FOR UPDATE`, [slug])).rows[0];
  if (cur && input.expectedVersion !== undefined && cur.version !== input.expectedVersion) {
    throw new AppError('CART_VERSION_CONFLICT', 'This page was edited by someone else; reload and retry');
  }
  const version = cur ? cur.version + 1 : 1;
  await c.query(
    `INSERT INTO content_pages (slug, kind, title, body_md, version, status, updated_by, updated_at)
     VALUES ($1,$2,$3,$4,1,'draft',$5,now())
     ON CONFLICT (slug) DO UPDATE SET kind = $2, title = $3, body_md = $4, version = content_pages.version + 1, updated_by = $5, updated_at = now()`,
    [slug, input.kind, input.title, input.bodyMd, x.adminId],
  );
  await c.query(
    `INSERT INTO content_versions (slug, version, title, body_md, created_by) VALUES ($1,$2,$3,$4,$5)`,
    [slug, version, input.title, input.bodyMd, x.adminId],
  );
  await audit(c, {
    actorId: x.adminId,
    actorRole: x.role,
    action: 'content.save',
    resourceType: 'content',
    resourceId: slug,
    after: { version },
    requestId: x.requestId,
  });
  return { slug, version };
}

export async function publishContent(c: PoolClient, x: Ctx, slug: string) {
  const r = await c.query(
    `UPDATE content_pages SET status = 'published', published_at = now() WHERE slug = $1 RETURNING version`,
    [slug],
  );
  if (r.rowCount === 0) throw new AppError('NOT_FOUND', 'Page not found');
  await audit(c, {
    actorId: x.adminId,
    actorRole: x.role,
    action: 'content.publish',
    resourceType: 'content',
    resourceId: slug,
    after: { version: r.rows[0].version },
    requestId: x.requestId,
  });
}
