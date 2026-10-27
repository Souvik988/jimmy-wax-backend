import type { ZodError } from 'zod';
import type { PoolClient } from '@jw/database';
import { AppError } from '@jw/contracts';
import { audit, type AdminRole } from '../admin.ts';
import {
  BLOCKS,
  BlockEnvelope,
  DOC_SCHEMAS,
  DesignSystem,
  MAX_BLOCKS,
  PageDoc,
  TokensOverrideDoc,
  blockAllowedOnPage,
  deepMerge,
  isPageKeyValid,
  isSubset,
  type Block,
  type Channel,
} from './schemas.ts';

interface Ctx {
  adminId: string;
  role: AdminRole;
  requestId?: string;
}

export type DocChannel = Channel | 'shared';
export type DocKind = 'tokens' | 'navigation' | 'chrome' | 'page';

export interface DocRow {
  channel: DocChannel;
  kind: DocKind;
  key: string;
  rev: number;
  etag: string;
  updatedAt: string;
  updatedBy: string | null;
  body: unknown;
}

const etag = (rev: number) => `"${rev}"`;
const toRow = (r: Record<string, unknown>): DocRow => ({
  channel: r.channel as DocChannel,
  kind: r.kind as DocKind,
  key: r.key as string,
  rev: r.rev as number,
  etag: etag(r.rev as number),
  updatedAt: new Date(r.updated_at as string).toISOString(),
  updatedBy: (r.updated_by as string | null) ?? null,
  body: r.body,
});

export function zodFields(err: ZodError, prefix = ''): Record<string, string> {
  const out: Record<string, string> = {};
  for (const i of err.issues) out[`${prefix}${i.path.join('.')}` || '_'] = i.message;
  return out;
}

const bad = (fields: Record<string, string>): never => {
  throw new AppError('VALIDATION_FAILED', 'This document is not valid', { fields });
};

export function expectedKey(channel: DocChannel, kind: DocKind): string | null {
  if (kind === 'tokens') return channel === 'shared' ? 'base' : 'override';
  if (kind === 'navigation' || kind === 'chrome') return 'main';
  return null;
}

/** Parses a page body: envelope, every block's props against its type schema, limits, uniqueness. Returns the normalised doc. */
export function parsePage(channel: Channel, key: string, body: unknown): PageDoc {
  const page = PageDoc.safeParse(body);
  if (!page.success) return bad(zodFields(page.error));
  const fields: Record<string, string> = {};
  const blocks: Block[] = [];
  const ids = new Set<string>();
  const counts = new Map<string, number>();
  if (page.data.blocks.length > MAX_BLOCKS[channel])
    fields.blocks = `at most ${MAX_BLOCKS[channel]} blocks per page`;
  page.data.blocks.forEach((b, i) => {
    const env = BlockEnvelope.safeParse(b);
    if (!env.success) return void Object.assign(fields, zodFields(env.error, `blocks.${i}.`));
    const def = BLOCKS[b.type];
    if (!def || def.channel !== channel)
      return void (fields[`blocks.${i}.type`] = `unknown ${channel} block type "${b.type}"`);
    if (!blockAllowedOnPage(channel, key, b.type))
      return void (fields[`blocks.${i}.type`] = `"${b.type}" is not allowed on page "${key}"`);
    if (ids.has(b.id)) fields[`blocks.${i}.id`] = 'duplicate block id';
    ids.add(b.id);
    const n = (counts.get(b.type) ?? 0) + 1;
    counts.set(b.type, n);
    if (n > def.max) fields[`blocks.${i}.type`] = `at most ${def.max} "${b.type}" per page`;
    const props = def.schema.safeParse(b.props);
    if (!props.success) return void Object.assign(fields, zodFields(props.error, `blocks.${i}.props.`));
    blocks.push({ ...env.data, props: props.data as Record<string, unknown> });
  });
  if (channel === 'web' && key !== 'product' && page.data.nativeSections)
    fields.nativeSections = 'only the product template has native sections';
  if (Object.keys(fields).length) return bad(fields);
  return { ...page.data, blocks } as PageDoc;
}

async function sharedBase(c: PoolClient): Promise<unknown | null> {
  const r = await c.query(
    `SELECT body FROM exp_documents WHERE channel='shared' AND kind='tokens' AND key='base'`,
  );
  return r.rows[0]?.body ?? null;
}

/** Validates + normalises any document body. */
export async function parseDoc(
  c: PoolClient,
  channel: DocChannel,
  kind: DocKind,
  key: string,
  body: unknown,
): Promise<unknown> {
  if (kind === 'page') {
    if (channel === 'shared') return bad({ channel: 'pages belong to app or web' });
    if (!isPageKeyValid(channel, key)) return bad({ key: `"${key}" is not a valid ${channel} page` });
    return parsePage(channel, key, body);
  }
  const want = expectedKey(channel, kind);
  if (key !== want) return bad({ key: `must be "${want}"` });
  if (channel === 'shared' && kind !== 'tokens') return bad({ channel: 'only tokens are shared' });
  if (kind === 'tokens') {
    if (channel === 'shared') {
      const p = DesignSystem.safeParse(body);
      return p.success ? p.data : bad(zodFields(p.error));
    }
    const o = TokensOverrideDoc.safeParse(body);
    if (!o.success) return bad(zodFields(o.error));
    const base = await sharedBase(c);
    if (base) {
      if (!isSubset(o.data.overrides, base))
        return bad({ overrides: 'contains keys that do not exist in the shared design system' });
      const merged = DesignSystem.safeParse(deepMerge(base, o.data.overrides));
      if (!merged.success) return bad(zodFields(merged.error, 'overrides.'));
    }
    return o.data;
  }
  const schema = DOC_SCHEMAS[kind](channel);
  const p = schema.safeParse(body);
  return p.success ? p.data : bad(zodFields(p.error));
}

export async function getDoc(
  c: PoolClient,
  channel: DocChannel,
  kind: DocKind,
  key: string,
): Promise<DocRow> {
  const r = await c.query(`SELECT * FROM exp_documents WHERE channel=$1 AND kind=$2 AND key=$3`, [
    channel,
    kind,
    key,
  ]);
  if (r.rowCount === 0) throw new AppError('NOT_FOUND', 'Document not found');
  return toRow(r.rows[0]);
}

export async function listDocs(c: PoolClient, channel: DocChannel) {
  const r = await c.query(`SELECT * FROM exp_documents WHERE channel = $1 ORDER BY kind, key`, [channel]);
  let live: Record<string, unknown> | null = null;
  if (channel !== 'shared') {
    const e = await c.query(`SELECT snapshot FROM v_exp_effective WHERE channel = $1`, [channel]);
    live = (e.rows[0]?.snapshot as { docs?: Record<string, unknown> } | undefined)?.docs ?? null;
  }
  return r.rows.map((x) => {
    const row = toRow(x);
    const liveBody = live?.[`${row.kind}:${row.key}`];
    return {
      channel: row.channel,
      kind: row.kind,
      key: row.key,
      rev: row.rev,
      etag: row.etag,
      updatedAt: row.updatedAt,
      updatedBy: row.updatedBy,
      dirtyVsLive:
        channel === 'shared'
          ? null
          : liveBody === undefined
            ? true
            : JSON.stringify(liveBody) !== JSON.stringify(row.body),
    };
  });
}

/** `expectedRev` 0 = create. A stale write returns ETAG_MISMATCH carrying the server copy for the client's 3-way merge. */
export async function putDoc(
  c: PoolClient,
  x: Ctx,
  channel: DocChannel,
  kind: DocKind,
  key: string,
  body: unknown,
  expectedRev: number,
): Promise<DocRow> {
  const parsed = await parseDoc(c, channel, kind, key, body);
  const cur = await c.query(
    `SELECT * FROM exp_documents WHERE channel=$1 AND kind=$2 AND key=$3 FOR UPDATE`,
    [channel, kind, key],
  );
  if (cur.rowCount === 0) {
    if (expectedRev !== 0) throw new AppError('NOT_FOUND', 'Document not found');
    try {
      const ins = await c.query(
        `INSERT INTO exp_documents (channel, kind, key, rev, body, updated_by) VALUES ($1,$2,$3,1,$4,$5) RETURNING *`,
        [channel, kind, key, JSON.stringify(parsed), x.adminId],
      );
      await c.query(
        `INSERT INTO exp_document_revisions (channel, kind, key, rev, body, updated_by) VALUES ($1,$2,$3,1,$4,$5)`,
        [channel, kind, key, JSON.stringify(parsed), x.adminId],
      );
      await audit(c, {
        actorId: x.adminId,
        actorRole: x.role,
        action: 'experience.draft.save',
        resourceType: 'exp_document',
        resourceId: `${channel}/${kind}/${key}`,
        after: { rev: 1 },
        requestId: x.requestId,
      });
      return toRow(ins.rows[0]);
    } catch (e) {
      if ((e as { code?: string }).code === '23505')
        throw new AppError('ETAG_MISMATCH', 'This document was created by someone else');
      throw e;
    }
  }
  if (cur.rows[0].rev !== expectedRev) {
    throw new AppError('ETAG_MISMATCH', 'This document changed since you loaded it', {
      lines: [toRow(cur.rows[0])],
    });
  }
  const rev = expectedRev + 1;
  const upd = await c.query(
    `UPDATE exp_documents SET body = $4, rev = $5, updated_by = $6, updated_at = now() WHERE channel=$1 AND kind=$2 AND key=$3 RETURNING *`,
    [channel, kind, key, JSON.stringify(parsed), rev, x.adminId],
  );
  await c.query(
    `INSERT INTO exp_document_revisions (channel, kind, key, rev, body, updated_by) VALUES ($1,$2,$3,$4,$5,$6)`,
    [channel, kind, key, rev, JSON.stringify(parsed), x.adminId],
  );
  await audit(c, {
    actorId: x.adminId,
    actorRole: x.role,
    action: 'experience.draft.save',
    resourceType: 'exp_document',
    resourceId: `${channel}/${kind}/${key}`,
    before: { rev: expectedRev },
    after: { rev },
    requestId: x.requestId,
  });
  return toRow(upd.rows[0]);
}

export async function deleteDoc(c: PoolClient, x: Ctx, channel: DocChannel, kind: DocKind, key: string) {
  if (kind !== 'page' || !(/^custom:/.test(key) || /^product:/.test(key)))
    throw new AppError('ILLEGAL_STATE', 'Only custom and product pages can be deleted');
  const r = await c.query(`DELETE FROM exp_documents WHERE channel=$1 AND kind=$2 AND key=$3`, [
    channel,
    kind,
    key,
  ]);
  if (r.rowCount === 0) throw new AppError('NOT_FOUND', 'Document not found');
  await audit(c, {
    actorId: x.adminId,
    actorRole: x.role,
    action: 'experience.draft.delete',
    resourceType: 'exp_document',
    resourceId: `${channel}/${kind}/${key}`,
    requestId: x.requestId,
  });
}

/**
 * Standard pages cannot be deleted, so this is how an operator abandons a draft: it copies the LIVE (last published) version
 * back over the draft as a new revision (history is kept). `expectedRev` guards against discarding someone else's newer edit.
 */
export async function discardDraft(
  c: PoolClient,
  x: Ctx,
  channel: DocChannel,
  kind: DocKind,
  key: string,
  expectedRev: number,
  reason: string,
): Promise<DocRow> {
  if (channel === 'shared')
    throw new AppError('ILLEGAL_STATE', 'The shared design system has no published copy to return to');
  const live = await c.query(`SELECT snapshot FROM v_exp_effective WHERE channel = $1`, [channel]);
  const docs = (live.rows[0]?.snapshot as { docs?: Record<string, unknown> } | undefined)?.docs;
  const liveBody = docs?.[`${kind}:${key}`];
  if (liveBody === undefined)
    throw new AppError(
      'ILLEGAL_STATE',
      'This document has not been published yet, so there is no live version to return to',
    );
  const cur = await getDoc(c, channel, kind, key);
  if (cur.rev !== expectedRev)
    throw new AppError('ETAG_MISMATCH', 'This document changed since you loaded it', { lines: [cur] });
  if (JSON.stringify(cur.body) === JSON.stringify(liveBody)) return cur;
  const row = await putDoc(c, x, channel, kind, key, liveBody, expectedRev);
  await audit(c, {
    actorId: x.adminId,
    actorRole: x.role,
    action: 'experience.draft.discard',
    resourceType: 'exp_document',
    resourceId: `${channel}/${kind}/${key}`,
    reason,
    before: { rev: expectedRev },
    after: { rev: row.rev },
    requestId: x.requestId,
  });
  return row;
}

export async function listRevisions(
  c: PoolClient,
  channel: DocChannel,
  kind: DocKind,
  key: string,
  limit = 50,
) {
  const r = await c.query(
    `SELECT rev, updated_by, created_at, body FROM exp_document_revisions WHERE channel=$1 AND kind=$2 AND key=$3 ORDER BY rev DESC LIMIT $4`,
    [channel, kind, key, limit],
  );
  return r.rows.map((x) => ({
    rev: x.rev as number,
    updatedBy: x.updated_by as string | null,
    createdAt: new Date(x.created_at).toISOString(),
    body: x.body as unknown,
  }));
}
