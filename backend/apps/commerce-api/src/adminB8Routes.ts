import express from 'express';
import { z } from 'zod';
import { AppError, PageQuery } from '@jw/contracts';
import {
  ADMIN_ROLES,
  CategoryInput,
  CollectionDeleteGuard,
  CollectionInput,
  MediaPatch,
  ProductInput,
  ProductPatch,
  VariantInput,
  addVariant,
  archiveMedia,
  archiveProduct,
  ArchiveGuard,
  MediaGuard,
  adminIdempotent,
  createCategory,
  createCollection,
  createProduct,
  deleteCategory,
  deleteCollection,
  duplicateProduct,
  exportCatalogCsv,
  getCollection,
  getMedia,
  getProduct,
  importCatalogCsv,
  insertMedia,
  inviteMember,
  listCategoriesAdmin,
  listCollections,
  listMedia,
  listProducts,
  listSessions,
  listTeam,
  mediaUsage,
  resolveCollectionProductIds,
  reorderCategories,
  resetMfa,
  reviewMedia,
  revokeInvite,
  revokeOwnSession,
  setProductMedia,
  updateCategory,
  updateCollection,
  updateMedia,
  updateMember,
  updateProduct,
} from '@jw/commerce-domain';
import { MEDIA_FILE, MIME_BY_EXT, MediaRejected, mediaKey, processLibraryMedia } from '@jw/integrations';
import type { AdminKit } from './adminKit.ts';

const bool = z.enum(['true', 'false']).transform((v) => v === 'true');
const role = z.enum(ADMIN_ROLES);

/** Team, catalogue, categories, collections, CSV, media library (phase B8). */
export function registerB8(k: AdminKit) {
  const { r, db, need, actor, ctx, parse, uuid, slug, storage } = k;
  const tx = <T>(req: Parameters<typeof actor>[0], fn: Parameters<typeof db.tx<T>>[1]) =>
    db.tx(actor(req), fn);
  const withCost = (req: Parameters<typeof actor>[0]) => req.admin!.role === 'admin';

  // ------------------------------------------------------------------- team
  r.get('/team', need('team:manage'), async (req, res) => {
    res.json(await tx(req, (c) => listTeam(c)));
  });
  r.post('/team/invite', need('team:manage'), async (req, res) => {
    const b = parse(z.object({ email: z.string().trim().max(254), role }), req.body);
    res.status(201).json(await tx(req, (c) => inviteMember(c, ctx(req), b)));
  });
  r.delete('/team/invites/:id', need('team:manage'), async (req, res) => {
    await tx(req, (c) => revokeInvite(c, ctx(req), uuid(req.params.id)));
    res.status(204).end();
  });
  r.patch('/team/:id', need('team:manage'), async (req, res) => {
    const b = parse(z.object({ role: role.optional(), disabled: z.boolean().optional() }), req.body);
    res.json(await tx(req, (c) => updateMember(c, ctx(req), uuid(req.params.id), b)));
  });
  r.post('/team/:id/reset-mfa', need('team:manage'), async (req, res) => {
    await tx(req, (c) => resetMfa(c, ctx(req), uuid(req.params.id)));
    res.status(204).end();
  });
  r.get('/sessions', async (req, res) => {
    res.json({
      items: await tx(req, (c) => listSessions(c, req.admin!.userId, req.principal!.sid)),
    });
  });
  r.delete('/sessions/:id', async (req, res) => {
    await tx(req, (c) => revokeOwnSession(c, req.admin!.userId, uuid(req.params.id)));
    res.status(204).end();
  });

  // --------------------------------------------------------------- products
  r.get('/products', need('catalog:read'), async (req, res) => {
    const q = parse(
      PageQuery.extend({
        q: z.string().trim().max(100).optional(),
        categoryId: z.string().max(100).optional(),
        status: z.enum(['active', 'inactive', 'archived']).optional(),
        stock: z.enum(['low', 'out']).optional(),
      }),
      req.query,
    );
    res.json(await tx(req, (c) => listProducts(c, q, withCost(req))));
  });
  r.post('/products', need('catalog:write'), async (req, res) => {
    const b = parse(ProductInput, req.body);
    const out = await tx(req, (c) =>
      adminIdempotent(
        c,
        ctx(req),
        'product.create',
        req.header('idempotency-key') ?? undefined,
        req.body,
        () => createProduct(c, ctx(req), b),
      ),
    );
    if (out.replayed) res.setHeader('Idempotent-Replay', 'true');
    res.status(201).json(out.body);
  });
  r.get('/products/:id', need('catalog:read'), async (req, res) => {
    res.json(await tx(req, (c) => getProduct(c, slug(req.params.id), withCost(req))));
  });
  r.patch('/products/:id', need('catalog:write'), async (req, res) => {
    const b = parse(ProductPatch, req.body);
    res.json(await tx(req, (c) => updateProduct(c, ctx(req), slug(req.params.id), b)));
  });
  r.put('/products/:id/media', need('catalog:write'), async (req, res) => {
    const b = parse(
      z.object({
        items: z
          .array(z.object({ mediaId: z.string().uuid(), alt: z.string().trim().min(1).max(200) }))
          .max(12),
      }),
      req.body,
    );
    res.json(await tx(req, (c) => setProductMedia(c, ctx(req), slug(req.params.id), b.items)));
  });
  r.post('/products/:id/variants', need('catalog:write'), async (req, res) => {
    const { expectedVersion, reason, ...rest } = parse(
      z
        .object({ expectedVersion: z.number().int().min(0), reason: z.string().trim().min(3).max(300) })
        .passthrough(),
      req.body,
    );
    const b = parse(VariantInput, rest);
    const key = req.header('idempotency-key') ?? undefined;
    const out = await tx(req, (c) =>
      adminIdempotent(c, ctx(req), `variant.add:${slug(req.params.id)}`, key, req.body, () =>
        addVariant(c, ctx(req), slug(req.params.id), b, { expectedVersion, reason }),
      ),
    );
    if (out.replayed) res.setHeader('Idempotent-Replay', 'true');
    res.status(201).json(out.body);
  });
  r.post('/products/:id/archive', need('catalog:write'), async (req, res) => {
    res.json(
      await tx(req, (c) =>
        archiveProduct(c, ctx(req), slug(req.params.id), true, parse(ArchiveGuard, req.body)),
      ),
    );
  });
  r.post('/products/:id/restore', need('catalog:write'), async (req, res) => {
    res.json(
      await tx(req, (c) =>
        archiveProduct(c, ctx(req), slug(req.params.id), false, parse(ArchiveGuard, req.body)),
      ),
    );
  });
  r.post('/products/:id/duplicate', need('catalog:write'), async (req, res) => {
    const b = parse(z.object({ newId: z.string().max(100).optional() }), req.body ?? {});
    res.status(201).json(await tx(req, (c) => duplicateProduct(c, ctx(req), slug(req.params.id), b.newId)));
  });

  // ------------------------------------------------------------- categories
  r.get('/categories', need('catalog:read'), async (req, res) => {
    res.json({ items: await tx(req, (c) => listCategoriesAdmin(c)) });
  });
  r.post('/categories', need('catalog:write'), async (req, res) => {
    res.status(201).json(await tx(req, (c) => createCategory(c, ctx(req), parse(CategoryInput, req.body))));
  });
  // Registered before '/:id' so "order" is not captured as an id.
  r.put('/categories/order', need('catalog:write'), async (req, res) => {
    const b = parse(
      z.object({
        ids: z.array(z.string().max(100)).min(1).max(200),
        expectedRevs: z.record(z.string(), z.number().int().min(1)),
      }),
      req.body,
    );
    res.json({ items: await tx(req, (c) => reorderCategories(c, ctx(req), b.ids, b.expectedRevs)) });
  });
  r.patch('/categories/:id', need('catalog:write'), async (req, res) => {
    const { expectedRev, ...b } = parse(
      CategoryInput.partial()
        .omit({ id: true })
        .extend({ expectedRev: z.number().int().min(1) }),
      req.body,
    );
    res.json(await tx(req, (c) => updateCategory(c, ctx(req), slug(req.params.id), b, expectedRev)));
  });
  r.delete('/categories/:id', need('catalog:write'), async (req, res) => {
    await tx(req, (c) => deleteCategory(c, ctx(req), slug(req.params.id)));
    res.status(204).end();
  });

  // ------------------------------------------------------------ collections
  r.get('/collections', need('catalog:read'), async (req, res) => {
    res.json({ items: await tx(req, (c) => listCollections(c)) });
  });
  r.post('/collections', need('catalog:write'), async (req, res) => {
    res
      .status(201)
      .json(await tx(req, (c) => createCollection(c, ctx(req), parse(CollectionInput, req.body))));
  });
  r.get('/collections/:id', need('catalog:read'), async (req, res) => {
    const q = parse(z.object({ resolve: bool.optional() }), req.query);
    res.json(
      await tx(req, async (c) => {
        const col = await getCollection(c, slug(req.params.id));
        return q.resolve ? { ...col, resolvedProductIds: await resolveCollectionProductIds(c, col.id) } : col;
      }),
    );
  });
  r.put('/collections/:id', need('catalog:write'), async (req, res) => {
    const b = parse(CollectionInput.and(z.object({ expectedRev: z.number().int().min(1) })), req.body);
    res.json(await tx(req, (c) => updateCollection(c, ctx(req), slug(req.params.id), b, b.expectedRev)));
  });
  r.delete('/collections/:id', need('catalog:write'), async (req, res) => {
    const g = parse(CollectionDeleteGuard, req.body);
    await tx(req, (c) => deleteCollection(c, ctx(req), slug(req.params.id), g));
    res.status(204).end();
  });

  // ------------------------------------------------------------------- CSV
  r.get('/catalog/export', need('catalog:read'), async (req, res) => {
    const csv = await tx(req, (c) => exportCatalogCsv(c));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="jimmywax-catalogue.csv"');
    res.send(csv);
  });
  r.post(
    '/catalog/import',
    need('catalog:write'),
    express.text({ type: () => true, limit: '2mb' }),
    async (req, res) => {
      const q = parse(
        z.object({
          dryRun: bool.default(true),
          previewHash: z.string().length(64).optional(),
          reason: z.string().trim().min(3).max(300).optional(),
        }),
        req.query,
      );
      if (typeof req.body !== 'string' || !req.body.trim())
        throw new AppError('VALIDATION_FAILED', 'Send the CSV as the request body', {
          fields: { body: 'empty' },
        });
      const rep = await tx(req, (c) =>
        importCatalogCsv(c, ctx(req), req.body as string, q.dryRun, {
          previewHash: q.previewHash,
          reason: q.reason,
        }),
      );
      res.status(rep.errors.length ? 422 : 200).json(rep);
    },
  );

  // ------------------------------------------------------------ media library
  r.post(
    '/media',
    need('media:write'),
    k.lim('media-upload', 60_000, 30, true),
    express.raw({ type: () => true, limit: '100mb' }),
    async (req, res) => {
      let headerMeta: Record<string, unknown> = {};
      const rawMeta = req.header('x-jw-upload-meta');
      if (rawMeta) {
        try {
          headerMeta = JSON.parse(Buffer.from(rawMeta, 'base64url').toString('utf8')) as Record<
            string,
            unknown
          >;
        } catch {
          throw new AppError('VALIDATION_FAILED', 'X-JW-Upload-Meta must be base64url-encoded JSON', {
            fields: { 'X-JW-Upload-Meta': 'invalid' },
          });
        }
      }
      const q = parse(
        z.object({
          filename: z.string().trim().min(1).max(200),
          alt: z.string().trim().max(200).optional(),
          provenance: z.enum(['original_photo', 'edited_photo', 'generated', 'illustration']).optional(),
          folder: z.string().trim().max(80).optional(),
          license: z.string().trim().max(300).optional(),
          rightsHolder: z.string().trim().min(2).max(200).optional(),
          provenanceNote: z.string().trim().min(3).max(500).optional(),
          consentReference: z.string().trim().min(2).max(200).optional(),
        }),
        { ...req.query, ...headerMeta },
      );
      const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      let processed;
      try {
        processed = await processLibraryMedia(buf);
      } catch (e) {
        if (e instanceof MediaRejected)
          throw new AppError('VALIDATION_FAILED', e.message, { fields: { file: e.message } });
        throw e;
      }
      // Files are content-addressed, so re-writing identical bytes is harmless and orphans are never reachable.
      for (const f of processed.files) await storage.put(mediaKey(processed.sha256, f.file), f.data);
      const out = await tx(req, (c) => insertMedia(c, ctx(req), processed, q));
      res.status(out.duplicate ? 200 : 201).json({ ...out.asset, duplicate: out.duplicate });
    },
  );
  r.get('/media', need('media:read'), async (req, res) => {
    const q = parse(
      PageQuery.extend({
        q: z.string().trim().max(100).optional(),
        kind: z.enum(['image', 'video', 'font']).optional(),
        tag: z.string().max(40).optional(),
        folder: z.string().max(80).optional(),
        approval: z.enum(['draft', 'approved', 'rejected']).optional(),
        provenance: z.enum(['original_photo', 'edited_photo', 'generated', 'illustration']).optional(),
        archived: bool.optional(),
        inUse: bool.optional(),
      }),
      req.query,
    );
    res.json(await tx(req, (c) => listMedia(c, q)));
  });
  r.get('/media/:id', need('media:read'), async (req, res) => {
    res.json(await tx(req, (c) => getMedia(c, uuid(req.params.id))));
  });
  r.patch('/media/:id', need('media:write'), async (req, res) => {
    const patch = parse(MediaPatch, req.body);
    // Mapping a library picture to a file shipped inside the app changes what customers see: administrators, with step-up.
    if (patch.bundledKey !== undefined) {
      if (req.admin!.role !== 'admin')
        throw new AppError('FORBIDDEN', 'Only administrators map media to app-bundled files');
      if (k.config.ADMIN_REQUIRE_MFA && !req.admin!.mfa)
        throw new AppError('MFA_REQUIRED', 'Re-authenticate with MFA to perform this action');
    }
    res.json(await tx(req, (c) => updateMedia(c, ctx(req), uuid(req.params.id), patch)));
  });
  // Approval is a brand decision: administrators only.
  const adminOnly = (req: Parameters<typeof actor>[0]) => {
    if (req.admin!.role !== 'admin')
      throw new AppError('FORBIDDEN', 'Only administrators approve or reject media');
  };
  r.post('/media/:id/approve', need('media:write'), async (req, res) => {
    adminOnly(req);
    const b = parse(
      z.object({ note: z.string().trim().max(300).optional(), packagingAttested: z.boolean().optional() }),
      req.body ?? {},
    );
    res.json(await tx(req, (c) => reviewMedia(c, ctx(req), uuid(req.params.id), { approve: true, ...b })));
  });
  r.post('/media/:id/reject', need('media:write'), async (req, res) => {
    adminOnly(req);
    const b = parse(z.object({ note: z.string().trim().min(3).max(300) }), req.body);
    res.json(
      await tx(req, (c) => reviewMedia(c, ctx(req), uuid(req.params.id), { approve: false, note: b.note })),
    );
  });
  r.post('/media/:id/archive', need('media:write'), async (req, res) => {
    const g = parse(MediaGuard, req.body);
    res.json(await tx(req, (c) => archiveMedia(c, ctx(req), uuid(req.params.id), true, g)));
  });
  r.post('/media/:id/restore', need('media:write'), async (req, res) => {
    const g = parse(MediaGuard, req.body);
    res.json(await tx(req, (c) => archiveMedia(c, ctx(req), uuid(req.params.id), false, g)));
  });
  r.get('/media/:id/usage', need('media:read'), async (req, res) => {
    res.json({ items: await tx(req, (c) => mediaUsage(c, uuid(req.params.id))) });
  });
  // Authenticated bytes of ANY library asset, approved or not: the way an operator previews a draft now that the public
  // content-addressed URL serves approved media only (DASH-BR-042). Never cached by shared caches.
  r.get('/media-files/:sha/:file', need('media:read'), async (req, res) => {
    const sha = /^[0-9a-f]{64}$/.exec(String(req.params.sha));
    const file = String(req.params.file);
    if (!sha || !MEDIA_FILE.test(file)) throw new AppError('NOT_FOUND', 'Media not found');
    const known = await tx(req, (c) => c.query('SELECT 1 FROM media_assets WHERE sha256 = $1', [sha[0]]));
    if (known.rowCount === 0) throw new AppError('NOT_FOUND', 'Media not found');
    const data = await storage.get(mediaKey(sha[0], file));
    if (!data) throw new AppError('NOT_FOUND', 'Media not found');
    res.setHeader('Content-Type', MIME_BY_EXT[file.split('.').pop() ?? ''] ?? 'application/octet-stream');
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(data);
  });
}
