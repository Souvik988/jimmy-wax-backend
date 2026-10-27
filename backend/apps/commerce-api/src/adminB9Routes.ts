import type { Request } from 'express';
import { z } from 'zod';
import { AppError } from '@jw/contracts';
import { exp } from '@jw/commerce-domain';
import type { AdminKit } from './adminKit.ts';

const channel2 = z.enum(['app', 'web']);
const docChannel = z.enum(['app', 'web', 'shared']);
const kind = z.enum(['tokens', 'navigation', 'chrome', 'page']);
const key = z.string().regex(/^[a-z0-9:_-]{1,80}$/);

/** `If-Match: "3"` (or `3`) → 3. Creating a document uses `If-Match: "0"`. */
function ifMatch(req: Request): number {
  const raw = req.header('if-match');
  const m = raw ? /^"?(\d+)"?$/.exec(raw.trim()) : null;
  if (!m)
    throw new AppError(
      'VALIDATION_FAILED',
      'Send the revision you are editing in the If-Match header (use "0" to create)',
      { fields: { 'If-Match': 'required' } },
    );
  return Number(m[1]);
}

/** Experience Studio admin API (phase B9). */
export function registerB9(k: AdminKit) {
  const { r, db, need, actor, ctx, parse, uuid } = k;
  const tx = <T>(req: Request, fn: Parameters<typeof db.tx<T>>[1]) => db.tx(actor(req), fn);

  const adminMfa = (req: Request) => {
    if (req.admin!.role !== 'admin') throw new AppError('FORBIDDEN', 'Only administrators can do this');
  };

  r.get('/experience/state', need('experience:read'), async (req, res) => {
    res.json({
      channels: await tx(req, async (c) => [
        await exp.channelState(c, 'app'),
        await exp.channelState(c, 'web'),
      ]),
    });
  });

  r.get('/experience/variables', need('experience:read'), async (req, res) => {
    const facts = await tx(req, (c) => exp.loadStoreFacts(c));
    const v = exp.resolveVariables(facts);
    res.json({ items: exp.VARIABLE_NAMES.map((n) => ({ name: n, token: `{{${n}}}`, value: v[n] })) });
  });

  // --------------------------------------------------------- releases (before /:channel routes)
  r.post('/experience/releases', need('experience:publish'), async (req, res) => {
    const b = parse(
      z.object({
        channels: z.array(channel2).min(1).max(2),
        label: z.string().trim().min(2).max(120),
        note: z.string().trim().max(500).optional(),
        scheduledAt: z.string().datetime().optional(),
        confirmReplaceScheduled: z.boolean().optional(),
      }),
      req.body,
    );
    const idem = req.header('idempotency-key') ?? undefined;
    res
      .status(201)
      .json(await tx(req, (c) => exp.createRelease(c, ctx(req), { ...b, idempotencyKey: idem })));
  });
  r.get('/experience/releases', need('experience:read'), async (req, res) => {
    const q = parse(
      z.object({
        channel: channel2.optional(),
        status: z.string().max(20).optional(),
        limit: z.coerce.number().int().min(1).max(100).default(30),
      }),
      req.query,
    );
    res.json({ items: await tx(req, (c) => exp.listReleases(c, q)) });
  });
  r.get('/experience/releases/:id', need('experience:read'), async (req, res) => {
    res.json(await tx(req, (c) => exp.getRelease(c, uuid(req.params.id))));
  });
  r.post('/experience/releases/:id/rollback', need('experience:publish'), async (req, res) => {
    const b = parse(
      z.object({
        reason: z.string().trim().min(3).max(300),
        confirmReplaceScheduled: z.boolean().optional(),
      }),
      req.body,
    );
    res
      .status(201)
      .json(
        await tx(req, (c) =>
          exp.rollbackRelease(c, ctx(req), uuid(req.params.id), b.reason, b.confirmReplaceScheduled),
        ),
      );
  });
  r.post('/experience/releases/:id/cancel', need('experience:publish'), async (req, res) => {
    res.json(await tx(req, (c) => exp.cancelScheduled(c, ctx(req), uuid(req.params.id))));
  });
  r.delete('/experience/preview-tokens/:id', need('experience:write'), async (req, res) => {
    await tx(req, (c) => exp.revokePreviewToken(c, uuid(req.params.id)));
    res.status(204).end();
  });

  // ---------------------------------------------------------------- campaigns
  const Campaign = z.object({
    name: z.string().trim().min(2).max(120),
    startsAt: z.string().datetime(),
    endsAt: z.string().datetime(),
    app: z.record(z.string(), z.unknown()).nullable().optional(),
    web: z.record(z.string(), z.unknown()).nullable().optional(),
    status: z.enum(['draft', 'active', 'archived']).optional(),
  });
  r.get('/experience/campaigns', need('experience:read'), async (req, res) => {
    res.json({ items: await tx(req, (c) => exp.listCampaigns(c)) });
  });
  r.post('/experience/campaigns', need('experience:write'), async (req, res) => {
    res
      .status(201)
      .json(await tx(req, (c) => exp.saveCampaign(c, ctx(req), null, parse(Campaign, req.body))));
  });
  r.put('/experience/campaigns/:id', need('experience:write'), async (req, res) => {
    res.json(
      await tx(req, (c) =>
        exp.saveCampaign(c, ctx(req), uuid(req.params.id), parse(Campaign, req.body), ifMatch(req)),
      ),
    );
  });

  // ------------------------------------------------------- per-channel documents
  r.get('/experience/:channel/docs', need('experience:read'), async (req, res) => {
    const ch = parse(docChannel, req.params.channel);
    res.json({ items: await tx(req, (c) => exp.listDocs(c, ch)) });
  });
  r.get('/experience/:channel/docs/:kind/:key', need('experience:read'), async (req, res) => {
    const d = await tx(req, (c) =>
      exp.getDoc(
        c,
        parse(docChannel, req.params.channel),
        parse(kind, req.params.kind),
        parse(key, req.params.key),
      ),
    );
    res.setHeader('ETag', d.etag);
    res.json(d);
  });
  r.put('/experience/:channel/docs/:kind/:key', need('experience:write'), async (req, res) => {
    const ch = parse(docChannel, req.params.channel);
    const d = await tx(req, (c) =>
      exp.putDoc(
        c,
        ctx(req),
        ch,
        parse(kind, req.params.kind),
        parse(key, req.params.key),
        req.body,
        ifMatch(req),
      ),
    );
    res.setHeader('ETag', d.etag);
    res.json(d);
  });
  r.delete('/experience/:channel/docs/:kind/:key', need('experience:write'), async (req, res) => {
    await tx(req, (c) =>
      exp.deleteDoc(
        c,
        ctx(req),
        parse(docChannel, req.params.channel),
        parse(kind, req.params.kind),
        parse(key, req.params.key),
      ),
    );
    res.status(204).end();
  });
  r.post('/experience/:channel/docs/:kind/:key/discard-draft', need('experience:write'), async (req, res) => {
    const b = parse(z.object({ reason: z.string().trim().min(3).max(300) }), req.body);
    const d = await tx(req, (c) =>
      exp.discardDraft(
        c,
        ctx(req),
        parse(docChannel, req.params.channel),
        parse(kind, req.params.kind),
        parse(key, req.params.key),
        ifMatch(req),
        b.reason,
      ),
    );
    res.setHeader('ETag', d.etag);
    res.json(d);
  });
  r.get('/experience/:channel/docs/:kind/:key/revisions', need('experience:read'), async (req, res) => {
    res.json({
      items: await tx(req, (c) =>
        exp.listRevisions(
          c,
          parse(docChannel, req.params.channel),
          parse(kind, req.params.kind),
          parse(key, req.params.key),
        ),
      ),
    });
  });
  r.post('/experience/:channel/validate', need('experience:read'), async (req, res) => {
    res.json(await tx(req, (c) => exp.validateChannel(c, parse(channel2, req.params.channel))));
  });
  r.get('/experience/:channel/diff', need('experience:read'), async (req, res) => {
    const q = parse(z.object({ against: z.string().default('live') }), req.query);
    const against = q.against === 'live' ? 'live' : q.against.replace(/^release:/, '');
    if (against !== 'live') uuid(against);
    res.json(await tx(req, (c) => exp.diffDraft(c, parse(channel2, req.params.channel), against)));
  });
  r.post('/experience/:channel/preview-tokens', need('experience:write'), async (req, res) => {
    const b = parse(
      z.object({
        ttlMinutes: z.number().int().min(5).max(1440).default(240),
        releaseId: z.string().uuid().optional(),
      }),
      req.body ?? {},
    );
    const out = await tx(req, (c) =>
      exp.createPreviewToken(c, ctx(req), parse(channel2, req.params.channel), b),
    );
    res.status(201).json({ ...out, path: `/v1/experience/${req.params.channel}/preview?token=${out.token}` });
  });
  r.post('/experience/:channel/kill', need('experience:publish'), async (req, res) => {
    adminMfa(req);
    const b = parse(z.object({ enabled: z.boolean(), reason: z.string().trim().min(3).max(300) }), req.body);
    res.json(
      await tx(req, (c) =>
        exp.setChannelEnabled(c, ctx(req), parse(channel2, req.params.channel), b.enabled, b.reason),
      ),
    );
  });

  // --------------------------------------------------------------------- presence
  r.put('/experience/:channel/presence', need('experience:write'), async (req, res) => {
    const ch = parse(channel2, req.params.channel);
    const b = parse(z.object({ pageKey: key }), req.body);
    await tx(req, async (c) => {
      const u = await c.query(`SELECT email FROM auth.users WHERE id = $1`, [req.admin!.userId]);
      await c.query(
        `INSERT INTO exp_presence (channel, page_key, user_id, label, seen_at) VALUES ($1,$2,$3,$4, now())
         ON CONFLICT (channel, page_key, user_id) DO UPDATE SET seen_at = now(), label = EXCLUDED.label`,
        [ch, b.pageKey, req.admin!.userId, String(u.rows[0]?.email ?? 'someone').split('@')[0]],
      );
      await c.query(`DELETE FROM exp_presence WHERE seen_at < now() - interval '10 minutes'`);
    });
    res.status(204).end();
  });
  r.get('/experience/:channel/presence', need('experience:read'), async (req, res) => {
    const ch = parse(channel2, req.params.channel);
    const rows = await tx(req, (c) =>
      c.query(
        `SELECT page_key, user_id, label, seen_at FROM exp_presence WHERE channel = $1 AND seen_at > now() - interval '60 seconds' AND user_id <> $2`,
        [ch, req.admin!.userId],
      ),
    );
    res.json({
      items: rows.rows.map((x) => ({
        pageKey: x.page_key,
        userId: x.user_id,
        label: x.label,
        seenAt: new Date(x.seen_at).toISOString(),
      })),
    });
  });

  // ------------------------------------------------------------- content library
  const entity = z.enum(exp.ENTITY_NAMES as [string, ...string[]]);
  const entityId = (name: string, v: unknown) => (exp.entityUsesSlug(name) ? k.slug(v) : uuid(v));
  r.get('/content-library/:entity', need('experience:read'), async (req, res) => {
    const q = parse(z.object({ status: z.enum(['draft', 'active', 'archived']).optional() }), req.query);
    res.json({
      items: await tx(req, (c) => exp.listEntities(c, parse(entity, req.params.entity), q.status)),
    });
  });
  r.post('/content-library/:entity', need('experience:write'), async (req, res) => {
    res
      .status(201)
      .json(await tx(req, (c) => exp.createEntity(c, ctx(req), parse(entity, req.params.entity), req.body)));
  });
  r.get('/content-library/:entity/:id', need('experience:read'), async (req, res) => {
    const name = parse(entity, req.params.entity);
    res.json(await tx(req, (c) => exp.getEntity(c, name, entityId(name, req.params.id))));
  });
  r.patch('/content-library/:entity/:id', need('experience:write'), async (req, res) => {
    const name = parse(entity, req.params.entity);
    res.json(
      await tx(req, (c) =>
        exp.updateEntity(c, ctx(req), name, entityId(name, req.params.id), req.body, ifMatch(req)),
      ),
    );
  });
  r.delete('/content-library/:entity/:id', need('experience:write'), async (req, res) => {
    const name = parse(entity, req.params.entity);
    await tx(req, (c) => exp.deleteEntity(c, ctx(req), name, entityId(name, req.params.id)));
    res.status(204).end();
  });
}
