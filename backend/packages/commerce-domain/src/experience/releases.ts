import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { PoolClient } from '@jw/database';
import { AppError } from '@jw/contracts';
import { audit, type AdminRole } from '../admin.ts';
import { listEntities } from './entities.ts';
import { parseDoc, type DocChannel, type DocKind } from './docs.ts';
import { collectFrom, emptyCollected } from './refs.ts';
import { DesignSystem, deepMerge, isSubset, type Channel } from './schemas.ts';
import { validateChannel } from './validate.ts';

interface Ctx {
  adminId: string;
  role: AdminRole;
  requestId?: string;
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

// ------------------------------------------------------------------- snapshot
export interface ResolvedMedia {
  id: string;
  kind: 'image' | 'video' | 'font';
  url: string;
  width: number | null;
  height: number | null;
  alt: string;
  decorative: boolean;
  variants: Array<{ url: string; width: number | null }>;
  poster?: { url: string; width: number | null; height: number | null } | null;
  bundledKey: string | null;
}

export interface Snapshot {
  schemaVersion: 1;
  channel: Channel;
  builtAt: string;
  docs: Record<string, unknown>;
  entities: {
    careGuides: Record<string, unknown>;
    faqGroups: Record<string, unknown>;
    stories: Record<string, unknown>;
    journal: Record<string, unknown>;
    testimonials: Record<string, unknown>;
    announcements: unknown[];
  };
  media: Record<string, ResolvedMedia>;
  collections: Record<string, { kind: 'manual' | 'smart'; rule: unknown; productIds: string[] }>;
  campaigns: Array<{ id: string; name: string; startsAt: string; endsAt: string; overlay: unknown }>;
}

const mediaUrl = (sha256: string, file: string) => `/v1/media/${sha256}/${file}`;

async function resolveMedia(c: PoolClient, ids: string[]): Promise<Record<string, ResolvedMedia>> {
  if (!ids.length) return {};
  const r = await c.query(`SELECT * FROM media_assets WHERE id = ANY($1)`, [ids]);
  const posterIds = r.rows.map((m) => m.poster_media_id as string | null).filter(Boolean) as string[];
  const posters = posterIds.length
    ? new Map(
        (await c.query(`SELECT * FROM media_assets WHERE id = ANY($1)`, [posterIds])).rows.map((p) => [
          p.id as string,
          p,
        ]),
      )
    : new Map();
  const out: Record<string, ResolvedMedia> = {};
  for (const m of r.rows) {
    const variants = (m.variants as Array<{ file: string; width: number | null }>) ?? [];
    const main = variants.find((v) => /^(orig|video|font)\./.test(v.file));
    const poster = m.poster_media_id ? posters.get(m.poster_media_id) : null;
    out[m.id] = {
      id: m.id,
      kind: m.kind,
      url: mediaUrl(m.sha256, main?.file ?? 'orig.webp'),
      width: m.width,
      height: m.height,
      alt: m.alt,
      decorative: m.decorative,
      variants: variants
        .filter((v) => /^w\d+\.webp$/.test(v.file))
        .map((v) => ({ url: mediaUrl(m.sha256, v.file), width: v.width })),
      poster: poster
        ? { url: mediaUrl(poster.sha256, 'orig.webp'), width: poster.width, height: poster.height }
        : null,
      bundledKey: m.bundled_key ?? null,
    };
  }
  return out;
}

/** Freezes the channel's current DRAFT (documents + the content they reference) into an immutable snapshot. */
export async function buildSnapshot(c: PoolClient, channel: Channel): Promise<Snapshot> {
  const rows = (
    await c.query(`SELECT channel, kind, key, body FROM exp_documents WHERE channel IN ('shared', $1)`, [
      channel,
    ])
  ).rows as Array<{ channel: DocChannel; kind: DocKind; key: string; body: unknown }>;
  const docs: Record<string, unknown> = {};
  const col = emptyCollected();
  for (const r of rows) {
    const body = await parseDoc(c, r.channel, r.kind, r.key, r.body);
    docs[`${r.kind}:${r.key}`] = body;
    if (r.kind === 'page')
      for (const b of (body as { blocks: Array<{ id: string; type: string; props: unknown }> }).blocks)
        collectFrom(col, `page:${r.key}`, b.props, { id: b.id, type: b.type }, 'props');
    else collectFrom(col, `${r.kind}:${r.key}`, body);
  }
  const shared = docs['tokens:base'] as
    | {
        surfaces?: { backdrop?: { image?: string } };
        type?: { families?: Record<string, { mediaId?: string }> };
      }
    | undefined;
  const mediaIds = new Set(col.media.map((m) => m.mediaId));
  if (shared?.surfaces?.backdrop?.image) mediaIds.add(shared.surfaces.backdrop.image);
  for (const f of Object.values(shared?.type?.families ?? {})) if (f?.mediaId) mediaIds.add(f.mediaId);

  const pick = async (name: string, ids: string[]) => {
    const all = (await listEntities(c, name, 'active')) as Array<{ id: string } & Record<string, unknown>>;
    const out: Record<string, unknown> = {};
    for (const e of all) if (ids.includes(e.id)) out[e.id] = e;
    return out;
  };
  const entities = {
    careGuides: await pick('care-guides', [...col.careGuides.keys()]),
    faqGroups: await pick('faq-groups', [...col.faqGroups.keys()]),
    stories: await pick('stories', [...col.stories.keys()]),
    journal: await pick('journal', [...col.journal.keys()]),
    testimonials: await pick('testimonials', [...col.testimonials.keys()]),
    announcements: (
      (await listEntities(c, 'announcements', 'active')) as Array<{ channels: string[] }>
    ).filter((a) => a.channels.includes(channel)),
  };
  // media referenced from entities
  for (const g of Object.values(entities.careGuides) as Array<{
    steps: Array<{ image: { mediaId: string } }>;
  }>)
    g.steps.forEach((s) => mediaIds.add(s.image.mediaId));
  for (const s of Object.values(entities.stories) as Array<{ videoMediaId: string; posterMediaId: string }>)
    (mediaIds.add(s.videoMediaId), mediaIds.add(s.posterMediaId));
  for (const n of Object.values(entities.journal) as Array<{ imageMediaId: string | null }>)
    if (n.imageMediaId) mediaIds.add(n.imageMediaId);
  for (const t of Object.values(entities.testimonials) as Array<{
    avatarMediaId: string | null;
    videoMediaId: string | null;
    posterMediaId: string | null;
  }>)
    for (const m of [t.avatarMediaId, t.videoMediaId, t.posterMediaId]) if (m) mediaIds.add(m);

  const collections: Snapshot['collections'] = {};
  for (const slug of col.collections.keys()) {
    const k = (await c.query(`SELECT kind, rule FROM collections WHERE id = $1`, [slug])).rows[0];
    if (!k) continue;
    const items =
      k.kind === 'manual'
        ? (
            await c.query(
              `SELECT product_id FROM collection_items WHERE collection_id = $1 ORDER BY position`,
              [slug],
            )
          ).rows.map((r) => r.product_id as string)
        : [];
    collections[slug] = { kind: k.kind, rule: k.rule, productIds: items };
  }

  const camps = (
    await c.query(
      `SELECT id, name, starts_at, ends_at, ${channel} AS overlay FROM exp_campaigns WHERE status = 'active' AND ${channel} IS NOT NULL ORDER BY starts_at`,
    )
  ).rows;
  for (const k of camps) {
    const ov = k.overlay as { announcement?: unknown; extraHeroSlide?: { image?: { mediaId: string } } };
    collectFrom(col, `campaign:${k.id}`, ov);
    for (const m of col.media.filter((x) => x.doc === `campaign:${k.id}`)) mediaIds.add(m.mediaId);
  }

  return {
    schemaVersion: 1,
    channel,
    builtAt: new Date().toISOString(),
    docs,
    entities,
    media: await resolveMedia(c, [...mediaIds]),
    collections,
    campaigns: camps.map((k) => ({
      id: k.id,
      name: k.name,
      startsAt: new Date(k.starts_at).toISOString(),
      endsAt: new Date(k.ends_at).toISOString(),
      overlay: k.overlay,
    })),
  };
}

// ------------------------------------------------------------------- releases
export interface ReleaseRow {
  id: string;
  channel: Channel;
  number: number;
  status: string;
  label: string;
  note: string | null;
  scheduledAt: string | null;
  activatedAt: string | null;
  rollbackOf: string | null;
  bundleId: string | null;
  createdBy: string | null;
  createdAt: string;
  checksum: string;
}
const rel = (r: Record<string, unknown>): ReleaseRow => ({
  id: r.id as string,
  channel: r.channel as Channel,
  number: r.number as number,
  status: r.status as string,
  label: r.label as string,
  note: (r.note as string | null) ?? null,
  scheduledAt: r.scheduled_at ? new Date(r.scheduled_at as string).toISOString() : null,
  activatedAt: r.activated_at ? new Date(r.activated_at as string).toISOString() : null,
  rollbackOf: (r.rollback_of as string | null) ?? null,
  bundleId: (r.bundle_id as string | null) ?? null,
  createdBy: (r.created_by as string | null) ?? null,
  createdAt: new Date(r.created_at as string).toISOString(),
  checksum: r.checksum as string,
});

export interface CreateReleaseInput {
  channels: Channel[];
  label: string;
  note?: string;
  scheduledAt?: string;
  idempotencyKey?: string;
  confirmReplaceScheduled?: boolean;
}

async function insertRelease(
  c: PoolClient,
  x: Ctx,
  ch: Channel,
  input: {
    label: string;
    note?: string;
    scheduledAt?: string;
    idempotencyKey?: string;
    confirmReplaceScheduled?: boolean;
    snapshot: Snapshot;
    rollbackOf?: string;
    bundleId: string;
    now: Date;
  },
): Promise<ReleaseRow> {
  await c.query(`SELECT 1 FROM exp_channel_state WHERE channel = $1 FOR UPDATE`, [ch]); // serialises publishes per channel
  const payloadHash = sha(
    JSON.stringify([input.label, input.note ?? '', input.scheduledAt ?? '', input.rollbackOf ?? '']),
  );
  if (input.idempotencyKey) {
    const ex = await c.query(`SELECT * FROM exp_releases WHERE channel = $1 AND idempotency_key = $2`, [
      ch,
      input.idempotencyKey,
    ]);
    if (ex.rowCount) {
      if (ex.rows[0].payload_hash !== payloadHash)
        throw new AppError(
          'DUPLICATE_REQUEST_MISMATCH',
          'This idempotency key was used with a different request',
        );
      return rel(ex.rows[0]);
    }
  }
  const pending = await c.query(`SELECT id FROM exp_releases WHERE channel = $1 AND status = 'scheduled'`, [
    ch,
  ]);
  if (pending.rowCount) {
    if (!input.confirmReplaceScheduled)
      throw new AppError(
        'ILLEGAL_STATE',
        `A scheduled release already exists for ${ch}; cancel it or confirm that this release replaces it`,
        { lines: pending.rows.map((p) => p.id) },
      );
    await c.query(
      `UPDATE exp_releases SET status = 'cancelled' WHERE channel = $1 AND status = 'scheduled'`,
      [ch],
    );
  }
  const scheduled = input.scheduledAt ? new Date(input.scheduledAt) : null;
  if (scheduled && scheduled <= input.now)
    throw new AppError('VALIDATION_FAILED', 'The scheduled time must be in the future', {
      fields: { scheduledAt: 'must be in the future' },
    });
  const num = (
    await c.query(`SELECT coalesce(max(number), 0) + 1 AS n FROM exp_releases WHERE channel = $1`, [ch])
  ).rows[0].n as number;
  const json = JSON.stringify(input.snapshot);
  const ins = await c.query(
    `INSERT INTO exp_releases (channel, number, status, label, note, snapshot, checksum, scheduled_at, activated_at, rollback_of, bundle_id, idempotency_key, payload_hash, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,${scheduled ? 'NULL' : 'now()'},$9,$10,$11,$12,$13) RETURNING *`,
    [
      ch,
      num,
      scheduled ? 'scheduled' : 'live',
      input.label,
      input.note ?? null,
      json,
      sha(json),
      scheduled,
      input.rollbackOf ?? null,
      input.bundleId,
      input.idempotencyKey ?? null,
      payloadHash,
      x.adminId,
    ],
  );
  if (!scheduled)
    await c.query(
      `UPDATE exp_releases SET status = 'superseded' WHERE channel = $1 AND status = 'live' AND id <> $2`,
      [ch, ins.rows[0].id],
    );
  await audit(c, {
    actorId: x.adminId,
    actorRole: x.role,
    action: scheduled
      ? 'experience.release.schedule'
      : input.rollbackOf
        ? 'experience.release.rollback'
        : 'experience.release.create',
    resourceType: 'exp_release',
    resourceId: ins.rows[0].id,
    after: { channel: ch, number: num, label: input.label, scheduledAt: scheduled?.toISOString() },
    requestId: x.requestId,
  });
  return rel(ins.rows[0]);
}

export async function createRelease(c: PoolClient, x: Ctx, input: CreateReleaseInput, now = new Date()) {
  if (!input.label.trim())
    throw new AppError('VALIDATION_FAILED', 'A release label is required', { fields: { label: 'required' } });
  const channels = [...new Set(input.channels)].sort();
  const bundleId = randomUUID();
  // validate everything first so a bundle is all-or-nothing
  const reports = [];
  for (const ch of channels) {
    const report = await validateChannel(c, ch, now);
    if (!report.canPublish)
      throw new AppError(
        'VALIDATION_FAILED',
        `Fix ${report.errors.length} issue(s) before publishing ${ch}`,
        { lines: report.errors },
      );
    reports.push({ ch, report });
  }
  const releases: ReleaseRow[] = [];
  for (const ch of channels)
    releases.push(
      await insertRelease(c, x, ch, { ...input, snapshot: await buildSnapshot(c, ch), bundleId, now }),
    );
  return {
    releases,
    warnings: reports.flatMap((r) => r.report.warnings.map((w) => ({ ...w, channel: r.ch }))),
  };
}

export async function listReleases(c: PoolClient, f: { channel?: Channel; status?: string; limit: number }) {
  const args: unknown[] = [];
  const w: string[] = [];
  if (f.channel) w.push(`channel = $${args.push(f.channel)}`);
  if (f.status) w.push(`status = $${args.push(f.status)}`);
  args.push(f.limit);
  const r = await c.query(
    `SELECT id, channel, number, status, label, note, scheduled_at, activated_at, rollback_of, bundle_id, created_by, created_at, checksum FROM exp_releases ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY created_at DESC LIMIT $${args.length}`,
    args,
  );
  return r.rows.map(rel);
}

export async function getRelease(c: PoolClient, id: string) {
  const r = await c.query(`SELECT * FROM exp_releases WHERE id = $1`, [id]);
  if (r.rowCount === 0) throw new AppError('NOT_FOUND', 'Release not found');
  const x = r.rows[0];
  const prev = (
    await c.query(
      `SELECT snapshot FROM exp_releases WHERE channel = $1 AND number < $2 AND status <> 'cancelled' ORDER BY number DESC LIMIT 1`,
      [x.channel, x.number],
    )
  ).rows[0];
  return { ...rel(x), changes: diffSnapshots(prev?.snapshot ?? null, x.snapshot) };
}

/** Rollback = publish an older snapshot as a NEW release (history stays linear; numbers stay monotonic). */
export async function rollbackRelease(
  c: PoolClient,
  x: Ctx,
  releaseId: string,
  reason: string,
  confirmReplaceScheduled = false,
  now = new Date(),
) {
  const t = await c.query(`SELECT * FROM exp_releases WHERE id = $1`, [releaseId]);
  if (t.rowCount === 0) throw new AppError('NOT_FOUND', 'Release not found');
  const target = t.rows[0];
  if (!['live', 'superseded'].includes(target.status))
    throw new AppError('ILLEGAL_STATE', 'Only a release that has been live can be rolled back to');
  const cur = (await c.query(`SELECT release_id FROM v_exp_effective WHERE channel = $1`, [target.channel]))
    .rows[0];
  if (cur?.release_id === releaseId) throw new AppError('ILLEGAL_STATE', 'This release is already live');
  const out = await insertRelease(c, x, target.channel, {
    label: `Rollback to #${target.number}`,
    note: reason,
    snapshot: target.snapshot,
    rollbackOf: releaseId,
    bundleId: randomUUID(),
    confirmReplaceScheduled,
    now,
  });
  return out;
}

export async function cancelScheduled(c: PoolClient, x: Ctx, releaseId: string) {
  const r = await c.query(
    `UPDATE exp_releases SET status = 'cancelled' WHERE id = $1 AND status = 'scheduled' RETURNING *`,
    [releaseId],
  );
  if (r.rowCount === 0) throw new AppError('ILLEGAL_STATE', 'Only a scheduled release can be cancelled');
  await audit(c, {
    actorId: x.adminId,
    actorRole: x.role,
    action: 'experience.release.cancel',
    resourceType: 'exp_release',
    resourceId: releaseId,
    requestId: x.requestId,
  });
  return rel(r.rows[0]);
}

/** Bookkeeping for due scheduled releases (the public view already serves them at their time; this keeps statuses honest). */
export async function activateDueReleases(c: PoolClient): Promise<number> {
  const due = await c.query(
    `SELECT id, channel, number FROM exp_releases WHERE status = 'scheduled' AND scheduled_at <= now() ORDER BY channel, number FOR UPDATE`,
  );
  for (const d of due.rows) {
    await c.query(
      `UPDATE exp_releases SET status = 'superseded' WHERE channel = $1 AND status = 'live' AND number < $2`,
      [d.channel, d.number],
    );
    await c.query(`UPDATE exp_releases SET status = 'live', activated_at = now() WHERE id = $1`, [d.id]);
    await c.query(
      `INSERT INTO audit_log (actor_id, actor_role, action, resource_type, resource_id, after) VALUES (NULL, 'system', 'experience.release.activate', 'exp_release', $1, $2)`,
      [d.id, JSON.stringify({ channel: d.channel, number: d.number })],
    );
  }
  return due.rowCount ?? 0;
}

export async function setChannelEnabled(
  c: PoolClient,
  x: Ctx,
  channel: Channel,
  enabled: boolean,
  reason: string,
) {
  await c.query(
    `UPDATE exp_channel_state SET enabled = $2, kill_reason = $3, kill_by = $4, kill_at = now(), updated_at = now() WHERE channel = $1`,
    [channel, enabled, enabled ? null : reason, enabled ? null : x.adminId],
  );
  await audit(c, {
    actorId: x.adminId,
    actorRole: x.role,
    action: enabled ? 'experience.kill.off' : 'experience.kill.on',
    resourceType: 'exp_channel',
    resourceId: channel,
    reason,
    requestId: x.requestId,
  });
  return channelState(c, channel);
}

export async function channelState(c: PoolClient, channel: Channel) {
  const s = (await c.query(`SELECT * FROM exp_channel_state WHERE channel = $1`, [channel])).rows[0];
  const e = (
    await c.query(`SELECT release_id, number, label, published_at FROM v_exp_effective WHERE channel = $1`, [
      channel,
    ])
  ).rows[0];
  return {
    channel,
    enabled: s.enabled as boolean,
    killReason: (s.kill_reason as string | null) ?? null,
    killedAt: s.kill_at ? new Date(s.kill_at).toISOString() : null,
    live: e?.release_id
      ? {
          id: e.release_id as string,
          number: e.number as number,
          label: e.label as string,
          publishedAt: new Date(e.published_at).toISOString(),
        }
      : null,
  };
}

// -------------------------------------------------------------- preview tokens
export async function createPreviewToken(
  c: PoolClient,
  x: Ctx,
  channel: Channel,
  input: { ttlMinutes: number; releaseId?: string },
) {
  if (input.releaseId) {
    const r = await c.query(`SELECT 1 FROM exp_releases WHERE id = $1 AND channel = $2`, [
      input.releaseId,
      channel,
    ]);
    if (r.rowCount === 0) throw new AppError('NOT_FOUND', 'Release not found for this channel');
  }
  const raw = randomBytes(24).toString('base64url');
  const r = await c.query(
    `INSERT INTO exp_preview_tokens (channel, token_hash, release_id, expires_at, created_by) VALUES ($1,$2,$3, now() + make_interval(mins => $4), $5) RETURNING id, expires_at`,
    [channel, sha(raw), input.releaseId ?? null, input.ttlMinutes, x.adminId],
  );
  await audit(c, {
    actorId: x.adminId,
    actorRole: x.role,
    action: 'experience.preview.create',
    resourceType: 'exp_preview',
    resourceId: r.rows[0].id,
    after: { channel, ttlMinutes: input.ttlMinutes },
    requestId: x.requestId,
  });
  return { id: r.rows[0].id as string, token: raw, expiresAt: new Date(r.rows[0].expires_at).toISOString() };
}

export async function revokePreviewToken(c: PoolClient, id: string) {
  const r = await c.query(
    `UPDATE exp_preview_tokens SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL`,
    [id],
  );
  if (r.rowCount === 0) throw new AppError('NOT_FOUND', 'Preview link not found');
}

export async function resolvePreviewToken(
  c: PoolClient,
  channel: Channel,
  raw: string,
): Promise<{ releaseId: string | null } | null> {
  const r = await c.query(
    `SELECT release_id FROM exp_preview_tokens WHERE token_hash = $1 AND channel = $2 AND revoked_at IS NULL AND expires_at > now()`,
    [sha(raw), channel],
  );
  return r.rows[0] ? { releaseId: (r.rows[0].release_id as string | null) ?? null } : null;
}

export async function releaseSnapshot(
  c: PoolClient,
  id: string,
): Promise<{ snapshot: Snapshot; row: ReleaseRow } | null> {
  const r = await c.query(`SELECT * FROM exp_releases WHERE id = $1`, [id]);
  return r.rows[0] ? { snapshot: r.rows[0].snapshot as Snapshot, row: rel(r.rows[0]) } : null;
}

// ------------------------------------------------------------------------ diff
export interface Change {
  path: string;
  from?: unknown;
  to?: unknown;
}
export interface DocDiff {
  doc: string;
  status: 'added' | 'removed' | 'changed';
  summary: string[];
  changes: Change[];
}

function leafDiff(a: unknown, b: unknown, path: string, out: Change[]) {
  if (JSON.stringify(a) === JSON.stringify(b)) return;
  const isO = (v: unknown): v is Record<string, unknown> =>
    v !== null && typeof v === 'object' && !Array.isArray(v);
  if (isO(a) && isO(b)) {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)]))
      leafDiff(a[k], b[k], path ? `${path}.${k}` : k, out);
    return;
  }
  out.push({ path, from: a, to: b });
}

function pageDiff(
  a: { blocks: Array<{ id: string; type: string; visible: boolean }> } | undefined,
  b: typeof a,
): { summary: string[]; changes: Change[] } {
  const summary: string[] = [];
  const changes: Change[] = [];
  const am = new Map((a?.blocks ?? []).map((x) => [x.id, x]));
  const bm = new Map((b?.blocks ?? []).map((x) => [x.id, x]));
  for (const [id, blk] of bm) {
    const old = am.get(id);
    if (!old) summary.push(`Added ${blk.type}`);
    else {
      const ch: Change[] = [];
      leafDiff(old, blk, `blocks.${id}`, ch);
      if (ch.length) {
        changes.push(...ch);
        if (old.visible !== blk.visible) summary.push(`${blk.type}: ${blk.visible ? 'shown' : 'hidden'}`);
        const props = [...new Set(ch.map((c0) => c0.path.split('.')[2]).filter((p) => p && p !== 'visible'))];
        if (props.length) summary.push(`${blk.type}: ${props.join(', ')} changed`);
      }
    }
  }
  for (const [id, blk] of am) if (!bm.has(id)) summary.push(`Removed ${blk.type}`);
  const orderA = (a?.blocks ?? [])
    .filter((x) => bm.has(x.id))
    .map((x) => x.id)
    .join();
  const orderB = (b?.blocks ?? [])
    .filter((x) => am.has(x.id))
    .map((x) => x.id)
    .join();
  if (orderA !== orderB) summary.push('Blocks reordered');
  return { summary, changes };
}

export function diffDocs(from: Record<string, unknown> | null, to: Record<string, unknown>): DocDiff[] {
  const out: DocDiff[] = [];
  for (const key of new Set([...Object.keys(from ?? {}), ...Object.keys(to)])) {
    const a = from?.[key];
    const b = to[key];
    if (a !== undefined && b === undefined)
      out.push({ doc: key, status: 'removed', summary: ['Removed'], changes: [] });
    else if (a === undefined) out.push({ doc: key, status: 'added', summary: ['New'], changes: [] });
    else if (JSON.stringify(a) !== JSON.stringify(b)) {
      if (key.startsWith('page:')) {
        const d = pageDiff(a as never, b as never);
        const seoChanges: Change[] = [];
        leafDiff((a as { seo?: unknown }).seo, (b as { seo?: unknown }).seo, 'seo', seoChanges);
        out.push({
          doc: key,
          status: 'changed',
          summary: [...d.summary, ...(seoChanges.length ? ['SEO changed'] : [])],
          changes: [...d.changes, ...seoChanges],
        });
      } else {
        const changes: Change[] = [];
        leafDiff(a, b, '', changes);
        out.push({
          doc: key,
          status: 'changed',
          summary: changes
            .slice(0, 8)
            .map((c0) => `${c0.path}: ${JSON.stringify(c0.from)} → ${JSON.stringify(c0.to)}`),
          changes,
        });
      }
    }
  }
  return out.sort((x, y) => x.doc.localeCompare(y.doc));
}

export function diffSnapshots(prev: Snapshot | null, next: Snapshot): DocDiff[] {
  return diffDocs(prev?.docs ?? null, next.docs);
}

/** Draft vs live (or vs a given release). */
export async function diffDraft(c: PoolClient, channel: Channel, against: 'live' | string) {
  let base: Snapshot | null = null;
  if (against === 'live')
    base =
      ((await c.query(`SELECT snapshot FROM v_exp_effective WHERE channel = $1`, [channel])).rows[0]
        ?.snapshot as Snapshot | undefined) ?? null;
  else {
    const r = await releaseSnapshot(c, against);
    if (!r || r.row.channel !== channel)
      throw new AppError('NOT_FOUND', 'Release not found for this channel');
    base = r.snapshot;
  }
  const draft = await buildSnapshot(c, channel);
  return { against, docs: diffSnapshots(base, draft) };
}

// ------------------------------------------------------------------ campaigns
export async function saveCampaign(
  c: PoolClient,
  x: Ctx,
  id: string | null,
  body: {
    name: string;
    startsAt: string;
    endsAt: string;
    app?: Record<string, unknown> | null;
    web?: Record<string, unknown> | null;
    status?: 'draft' | 'active' | 'archived';
  },
  expectedRev?: number,
) {
  if (new Date(body.endsAt) <= new Date(body.startsAt))
    throw new AppError('VALIDATION_FAILED', 'End must be after start', {
      fields: { endsAt: 'must be after startsAt' },
    });
  // token overlays must be a structural subset of the shared design system and still be a valid design system when merged
  const base = (
    await c.query(`SELECT body FROM exp_documents WHERE channel='shared' AND kind='tokens' AND key='base'`)
  ).rows[0]?.body;
  for (const ch of ['app', 'web'] as const) {
    const o = body[ch] as { tokens?: unknown } | null | undefined;
    if (o?.tokens && base) {
      if (!isSubset(o.tokens, base))
        throw new AppError('VALIDATION_FAILED', 'Overlay contains unknown design-system keys', {
          fields: { [`${ch}.tokens`]: 'unknown keys' },
        });
      const merged = DesignSystem.safeParse(deepMerge(base, o.tokens));
      if (!merged.success)
        throw new AppError('VALIDATION_FAILED', 'Overlay makes the design system invalid', {
          fields: { [`${ch}.tokens`]: merged.error.issues[0]?.message ?? 'invalid' },
        });
    }
  }
  if (!id) {
    const r = await c.query(
      `INSERT INTO exp_campaigns (name, starts_at, ends_at, app, web, status) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [
        body.name,
        body.startsAt,
        body.endsAt,
        body.app ? JSON.stringify(body.app) : null,
        body.web ? JSON.stringify(body.web) : null,
        body.status ?? 'draft',
      ],
    );
    await audit(c, {
      actorId: x.adminId,
      actorRole: x.role,
      action: 'campaign.create',
      resourceType: 'exp_campaign',
      resourceId: r.rows[0].id,
      requestId: x.requestId,
    });
    return campaignDto(r.rows[0]);
  }
  const cur = await c.query(`SELECT rev FROM exp_campaigns WHERE id = $1 FOR UPDATE`, [id]);
  if (cur.rowCount === 0) throw new AppError('NOT_FOUND', 'Campaign not found');
  if (cur.rows[0].rev !== expectedRev)
    throw new AppError('ETAG_MISMATCH', 'This campaign changed since you loaded it');
  const r = await c.query(
    `UPDATE exp_campaigns SET name=$2, starts_at=$3, ends_at=$4, app=$5, web=$6, status=$7, rev = rev + 1, updated_at = now() WHERE id=$1 RETURNING *`,
    [
      id,
      body.name,
      body.startsAt,
      body.endsAt,
      body.app ? JSON.stringify(body.app) : null,
      body.web ? JSON.stringify(body.web) : null,
      body.status ?? 'draft',
    ],
  );
  await audit(c, {
    actorId: x.adminId,
    actorRole: x.role,
    action: 'campaign.update',
    resourceType: 'exp_campaign',
    resourceId: id,
    requestId: x.requestId,
  });
  return campaignDto(r.rows[0]);
}
const campaignDto = (r: Record<string, unknown>) => ({
  id: r.id as string,
  name: r.name as string,
  startsAt: new Date(r.starts_at as string).toISOString(),
  endsAt: new Date(r.ends_at as string).toISOString(),
  app: r.app ?? null,
  web: r.web ?? null,
  status: r.status as string,
  rev: r.rev as number,
});
export async function listCampaigns(c: PoolClient) {
  return (await c.query(`SELECT * FROM exp_campaigns ORDER BY starts_at DESC`)).rows.map(campaignDto);
}
