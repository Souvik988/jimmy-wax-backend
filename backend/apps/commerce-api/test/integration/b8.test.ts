import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness } from './harness.ts';
import { makePng } from './png.ts';

const U = randomUUID().slice(0, 6);
let h: Awaited<ReturnType<typeof startHarness>>;
let admin: { id: string; token: string };

beforeAll(async () => {
  h = await startHarness();
  admin = await h.staff('admin');
});
afterAll(async () => {
  await h.close();
});

const variant = (n: string, over: Record<string, unknown> = {}) => ({
  id: `tp-${U}-${n}`,
  sku: `SKU-${U}-${n}`.toUpperCase(),
  title: 'Standard',
  pricePaise: 10000,
  compareAtPricePaise: 12000,
  weightGrams: 250,
  lengthMm: 120,
  widthMm: 60,
  heightMm: 40,
  hsnCode: '3405',
  ...over,
});
const productBody = (n: string, over: Record<string, unknown> = {}) => ({
  id: `tp-${U}-${n}`,
  name: `Test Product ${n} ${U}`,
  categoryId: 'polish',
  keyBenefits: ['Shine'],
  tags: ['test', `tag-${U}`],
  variants: [variant(n)],
  ...over,
});

describe('team, invitations, sessions', () => {
  it('invites by email (token only in the email), accepts once, role applies, MFA required to invite', async () => {
    const email = `designer-${U}@example.test`;
    expect(
      (await h.call('POST', '/v1/admin/team/invite', admin.token, { email, role: 'designer' })).status,
    ).toBe(201);
    const q = await h.sup.query(
      `SELECT payload FROM email_outbox WHERE to_email = $1 AND template = 'admin.invite'`,
      [email],
    );
    const token = q.rows[0].payload.token as string;
    expect(token.length).toBeGreaterThan(30);

    const bad = await h.call('POST', '/v1/auth/invite/accept', undefined, {
      token: 'x'.repeat(40),
      password: 'Str0ng-Pass-Phrase!',
      fullName: 'Dee Signer',
    });
    expect(bad.status).toBe(400);
    const weak = await h.call('POST', '/v1/auth/invite/accept', undefined, {
      token,
      password: 'short',
      fullName: 'Dee Signer',
    });
    expect(weak.status).toBe(400);
    const ok = await h.call('POST', '/v1/auth/invite/accept', undefined, {
      token,
      password: 'Str0ng-Pass-Phrase!',
      fullName: 'Dee Signer',
    });
    expect([ok.status, ok.json.role]).toEqual([201, 'designer']);
    expect(
      (
        await h.call('POST', '/v1/auth/invite/accept', undefined, {
          token,
          password: 'Str0ng-Pass-Phrase!',
          fullName: 'Dee Signer',
        })
      ).status,
    ).toBe(400);

    const login = await h.call('POST', '/v1/auth/login', undefined, {
      email,
      password: 'Str0ng-Pass-Phrase!',
      client: 'admin',
    });
    expect(login.status).toBe(200);
    const me = await h.call('GET', '/v1/admin/me', login.json.accessToken);
    expect(me.json.role).toBe('designer');
    expect(me.json.permissions).toContain('experience:write');
    expect(me.json.permissions).not.toContain('experience:publish');

    // changing the role revokes the member's sessions immediately
    const list = await h.call('GET', '/v1/admin/team', admin.token);
    const member = list.json.members.find((m: { email: string }) => m.email === email);
    expect(
      (await h.call('PATCH', `/v1/admin/team/${member.userId}`, admin.token, { role: 'catalog' })).status,
    ).toBe(200);
    expect((await h.call('GET', '/v1/admin/me', login.json.accessToken)).status).toBe(401);

    const aal1 = await h.staff('admin', 'aal1');
    const noMfa = await h.call('POST', '/v1/admin/team/invite', aal1.token, {
      email: `x-${U}@example.test`,
      role: 'support',
    });
    expect([noMfa.status, noMfa.json.error.code]).toEqual([403, 'MFA_REQUIRED']);
    const sup = await h.staff('support');
    expect((await h.call('GET', '/v1/admin/team', sup.token)).status).toBe(403);
  });

  it('cannot invite an existing operator, cannot self-demote, reset-mfa and disable revoke sessions', async () => {
    const other = await h.staff('support');
    const dupe = await h.sup.query(`SELECT email FROM auth.users WHERE id = $1`, [other.id]);
    const r = await h.call('POST', '/v1/admin/team/invite', admin.token, {
      email: dupe.rows[0].email,
      role: 'support',
    });
    expect(r.status).toBe(400);
    const self = await h.call('PATCH', `/v1/admin/team/${admin.id}`, admin.token, { disabled: true });
    expect([self.status, self.json.error.code]).toEqual([409, 'ILLEGAL_STATE']);
    expect((await h.call('POST', `/v1/admin/team/${other.id}/reset-mfa`, admin.token)).status).toBe(204);
    expect((await h.call('GET', '/v1/admin/me', other.token)).status).toBe(401);
    const third = await h.staff('support');
    expect(
      (await h.call('PATCH', `/v1/admin/team/${third.id}`, admin.token, { disabled: true })).status,
    ).toBe(200);
    expect((await h.call('GET', '/v1/admin/me', third.token)).status).toBe(401);
  });

  it('recovery codes: operators with MFA only, single-use, upgrade a session', async () => {
    const s = await h.staff('admin');
    const aal1 = await h.mint(s.id, 'aal1');
    const denied = await h.call('POST', '/v1/auth/mfa/recovery-codes', aal1);
    expect([denied.status, denied.json.error.code]).toEqual([403, 'MFA_REQUIRED']);
    const gen = await h.call('POST', '/v1/auth/mfa/recovery-codes', s.token);
    expect(gen.status).toBe(201);
    expect(gen.json.codes).toHaveLength(8);
    const code = gen.json.codes[0] as string;
    const up = await h.call('POST', '/v1/auth/mfa/verify', aal1, { recoveryCode: code });
    expect([up.status, up.json.aal]).toEqual([200, 'aal2']);
    expect((await h.call('POST', '/v1/auth/mfa/verify', aal1, { recoveryCode: code })).status).toBe(401);
    const stored = await h.sup.query(`SELECT code_hash FROM auth.mfa_recovery_codes WHERE user_id = $1`, [
      s.id,
    ]);
    expect(stored.rows.every((x) => x.code_hash !== code)).toBe(true); // only hashes are stored
  });

  it('lists and revokes own sessions', async () => {
    const s = await h.staff('support');
    const other = await h.mint(s.id, 'aal2');
    const l = await h.call('GET', '/v1/admin/sessions', s.token);
    expect(l.json.items.length).toBeGreaterThanOrEqual(2);
    expect(l.json.items.filter((x: { current: boolean }) => x.current)).toHaveLength(1);
    const target = l.json.items.find((x: { current: boolean }) => !x.current);
    expect((await h.call('DELETE', `/v1/admin/sessions/${target.id}`, s.token)).status).toBe(204);
    expect((await h.call('GET', '/v1/admin/me', other)).status).toBe(401);
    expect((await h.call('GET', '/v1/admin/me', s.token)).status).toBe(200);
  });
});

describe('catalogue', () => {
  it('creates products with shipping attributes; validates; optimistic versioning; role limits', async () => {
    const catalog = await h.staff('catalog');
    const support = await h.staff('support');
    expect((await h.call('POST', '/v1/admin/products', support.token, productBody('a'))).status).toBe(403);

    const bad = await h.call(
      'POST',
      '/v1/admin/products',
      catalog.token,
      productBody('a', { variants: [variant('a', { compareAtPricePaise: 5000 })] }),
    );
    expect(bad.status).toBe(400);
    expect(Object.keys(bad.json.error.fields).join()).toContain('compareAtPricePaise');

    const productKey = { 'idempotency-key': `product-${U}-a-0001` };
    const created = await h.call('POST', '/v1/admin/products', catalog.token, productBody('a'), productKey);
    const createdAgain = await h.call(
      'POST',
      '/v1/admin/products',
      catalog.token,
      productBody('a'),
      productKey,
    );
    expect([createdAgain.status, createdAgain.headers.get('idempotent-replay')]).toEqual([201, 'true']);
    expect(createdAgain.json.id).toBe(created.json.id);
    expect(created.status).toBe(201);
    expect(created.json.version).toBe(1);
    expect(created.json.variants[0]).toMatchObject({ weightGrams: 250, hsnCode: '3405', onHand: 0 });
    expect((await h.call('POST', '/v1/admin/products', catalog.token, productBody('a'))).status).toBe(400); // duplicate id

    const stale = await h.call('PATCH', `/v1/admin/products/tp-${U}-a`, catalog.token, {
      name: 'Renamed',
      expectedVersion: 7,
    });
    expect(stale.status).toBe(409);
    const ok = await h.call('PATCH', `/v1/admin/products/tp-${U}-a`, catalog.token, {
      name: 'Renamed',
      expectedVersion: 1,
    });
    expect([ok.status, ok.json.version, ok.json.name]).toEqual([200, 2, 'Renamed']);

    // cost price: admin only, never shown to others
    const guardAdd = { expectedVersion: 2, reason: 'Add a 2nd size' };
    const cost = await h.call('POST', `/v1/admin/products/tp-${U}-a/variants`, catalog.token, {
      ...variant('a2', { costPricePaise: 4000 }),
      ...guardAdd,
    });
    expect(cost.status).toBe(403);
    // add-variant needs the product version and a reason; stale versions are refused
    expect(
      (
        await h.call(
          'POST',
          `/v1/admin/products/tp-${U}-a/variants`,
          admin.token,
          variant('a2', { costPricePaise: 4000 }),
        )
      ).status,
    ).toBe(400);
    const staleAdd = await h.call('POST', `/v1/admin/products/tp-${U}-a/variants`, admin.token, {
      ...variant('a2', { costPricePaise: 4000 }),
      expectedVersion: 1,
      reason: 'stale',
    });
    expect([staleAdd.status, staleAdd.json.error.code]).toEqual([409, 'CART_VERSION_CONFLICT']);
    // Idempotency-Key: the same key + body replays the stored response and creates nothing twice; a different body is refused
    const idemKey = `variant-${U}-0001`;
    const adminAdd = await h.call(
      'POST',
      `/v1/admin/products/tp-${U}-a/variants`,
      admin.token,
      { ...variant('a2', { costPricePaise: 4000 }), ...guardAdd },
      { 'idempotency-key': idemKey },
    );
    expect(adminAdd.status).toBe(201);
    const replayAdd = await h.call(
      'POST',
      `/v1/admin/products/tp-${U}-a/variants`,
      admin.token,
      { ...variant('a2', { costPricePaise: 4000 }), ...guardAdd },
      { 'idempotency-key': idemKey },
    );
    expect([replayAdd.status, replayAdd.headers.get('idempotent-replay')]).toEqual([201, 'true']);
    expect(replayAdd.json.version).toBe(adminAdd.json.version);
    const mismatchAdd = await h.call(
      'POST',
      `/v1/admin/products/tp-${U}-a/variants`,
      admin.token,
      { ...variant('a3'), ...guardAdd },
      { 'idempotency-key': idemKey },
    );
    expect([mismatchAdd.status, mismatchAdd.json.error.code]).toEqual([422, 'DUPLICATE_REQUEST_MISMATCH']);
    const variantAudit = await h.sup.query(
      `SELECT reason, before, after FROM audit_log WHERE action = 'variant.create' AND resource_id = $1`,
      [`tp-${U}-a2`],
    );
    expect(variantAudit.rows).toHaveLength(1);
    expect(variantAudit.rows[0]).toMatchObject({
      reason: 'Add a 2nd size',
      before: { productVersion: 2 },
      after: { productVersion: 3 },
    });
    expect(adminAdd.json.variants.find((v: { id: string }) => v.id === `tp-${U}-a2`).costPricePaise).toBe(
      4000,
    );
    const seen = await h.call('GET', `/v1/admin/products/tp-${U}-a`, catalog.token);
    expect(JSON.stringify(seen.json)).not.toContain('costPricePaise');

    // new variants get an inventory position automatically (stock is entered through the audited inventory flow)
    const inv = await h.sup.query(`SELECT on_hand FROM inventory_positions WHERE variant_id = $1`, [
      `tp-${U}-a2`,
    ]);
    expect(inv.rows[0].on_hand).toBe(0);
  });

  it('lists with filters and keyset paging; archive hides, restore returns; copies are inactive', async () => {
    const catalog = await h.staff('catalog');
    for (const n of ['p1', 'p2', 'p3'])
      expect(
        (await h.call('POST', '/v1/admin/products', catalog.token, productBody(n, { sortOrder: 500 })))
          .status,
      ).toBe(201);
    const page1 = await h.call('GET', `/v1/admin/products?q=${U}&limit=2`, catalog.token);
    expect(page1.json.items.length).toBe(2);
    expect(page1.json.nextCursor).toBeTruthy();
    const page2 = await h.call(
      'GET',
      `/v1/admin/products?q=${U}&limit=2&cursor=${page1.json.nextCursor}`,
      catalog.token,
    );
    const ids = [...page1.json.items, ...page2.json.items].map((x: { id: string }) => x.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect((await h.call('GET', `/v1/admin/products?q=SKU-${U}-P1`, catalog.token)).json.items).toHaveLength(
      1,
    ); // SKU search

    const before = (await h.call('GET', `/v1/admin/products/tp-${U}-p1`, catalog.token)).json;
    // archive/restore are guarded: expected version + reason, conflicts and repeats are refused, audit carries before/after
    expect((await h.call('POST', `/v1/admin/products/tp-${U}-p1/archive`, catalog.token)).status).toBe(400);
    expect(
      (
        await h.call('POST', `/v1/admin/products/tp-${U}-p1/archive`, catalog.token, {
          expectedVersion: before.version,
          reason: 'x',
        })
      ).status,
    ).toBe(400);
    const stale = await h.call('POST', `/v1/admin/products/tp-${U}-p1/archive`, catalog.token, {
      expectedVersion: before.version + 5,
      reason: 'stale attempt',
    });
    expect([stale.status, stale.json.error.code]).toEqual([409, 'CART_VERSION_CONFLICT']);
    const archivedRes = await h.call('POST', `/v1/admin/products/tp-${U}-p1/archive`, catalog.token, {
      expectedVersion: before.version,
      reason: 'Discontinued line',
    });
    expect(archivedRes.json.archived).toBe(true);
    expect(archivedRes.json.version).toBe(before.version + 1);
    const again = await h.call('POST', `/v1/admin/products/tp-${U}-p1/archive`, catalog.token, {
      expectedVersion: before.version + 1,
      reason: 'twice',
    });
    expect([again.status, again.json.error.code]).toEqual([409, 'ILLEGAL_STATE']);
    const auditRows = (
      await h.call('GET', `/v1/admin/audit?resourceType=product`, admin.token)
    ).json.items.filter(
      (a: { resourceId: string; action: string }) =>
        a.resourceId === `tp-${U}-p1` && a.action === 'product.archive',
    );
    expect(auditRows[0]).toMatchObject({
      reason: 'Discontinued line',
      before: { archived: false, version: before.version },
      after: { archived: true, version: before.version + 1 },
    });
    const active = await h.call('GET', `/v1/admin/products?q=${U}-p1`, catalog.token);
    expect(active.json.items).toHaveLength(0);
    const arch = await h.call('GET', `/v1/admin/products?status=archived&q=${U}-p1`, catalog.token);
    expect(arch.json.items).toHaveLength(1);
    const edit = await h.call('PATCH', `/v1/admin/products/tp-${U}-p1`, catalog.token, {
      name: 'Nope',
      expectedVersion: arch.json.items[0].version,
    });
    expect([edit.status, edit.json.error.code]).toEqual([409, 'ILLEGAL_STATE']);
    expect(
      (
        await h.call('POST', `/v1/admin/products/tp-${U}-p1/restore`, catalog.token, {
          expectedVersion: arch.json.items[0].version,
          reason: 'Back in range',
        })
      ).json.archived,
    ).toBe(false);

    const dup = await h.call('POST', `/v1/admin/products/tp-${U}-p2/duplicate`, catalog.token, {});
    expect(dup.status).toBe(201);
    expect(dup.json.active).toBe(false);
    expect(dup.json.variants[0].active).toBe(false);
    expect(dup.json.variants[0].sku).not.toBe(`SKU-${U}-P2`);
    // copying again must work (it used to collide on the copy SKU) and each copy gets its own id and SKU
    const dup2 = await h.call('POST', `/v1/admin/products/tp-${U}-p2/duplicate`, catalog.token, {});
    expect(dup2.status).toBe(201);
    expect(dup2.json.id).not.toBe(dup.json.id);
    expect(dup2.json.variants[0].sku).not.toBe(dup.json.variants[0].sku);
    const named = await h.call('POST', `/v1/admin/products/tp-${U}-p2/duplicate`, catalog.token, {
      newId: `tp-${U}-named-copy`,
    });
    expect([named.status, named.json.id]).toEqual([201, `tp-${U}-named-copy`]);
    expect(named.json.variants[0].sku).not.toBe(dup.json.variants[0].sku);
  });

  it('categories: create, reorder (must list all), delete only when empty', async () => {
    const catalog = await h.staff('catalog');
    const c = await h.call('POST', '/v1/admin/categories', catalog.token, {
      name: `Cat ${U}`,
      description: 'x',
    });
    expect(c.status).toBe(201);
    expect((await h.call('POST', '/v1/admin/categories', catalog.token, { name: `Cat ${U}` })).status).toBe(
      400,
    );
    const list = (await h.call('GET', '/v1/admin/categories', catalog.token)).json.items as Array<{
      id: string;
      rev: number;
    }>;
    const all = list.map((x) => x.id);
    const expectedRevs = Object.fromEntries(list.map((x) => [x.id, x.rev]));
    expect(
      (await h.call('PUT', '/v1/admin/categories/order', catalog.token, { ids: all.slice(1), expectedRevs }))
        .status,
    ).toBe(400);
    const rev = [...all].reverse();
    const re = await h.call('PUT', '/v1/admin/categories/order', catalog.token, { ids: rev, expectedRevs });
    expect(re.json.items.map((x: { id: string }) => x.id)).toEqual(rev);
    expect((await h.call('DELETE', '/v1/admin/categories/polish', catalog.token)).status).toBe(409);
    expect((await h.call('DELETE', `/v1/admin/categories/${c.json.id}`, catalog.token)).status).toBe(204);
  });

  it('collections: manual order, smart rules, stale revision conflict', async () => {
    const catalog = await h.staff('catalog');
    const manual = await h.call('POST', '/v1/admin/collections', catalog.token, {
      id: `col-${U}`,
      name: `Picks ${U}`,
      kind: 'manual',
      productIds: [`tp-${U}-p3`, `tp-${U}-a`],
    });
    expect(manual.status).toBe(201);
    const res = await h.call('GET', `/v1/admin/collections/col-${U}?resolve=true`, catalog.token);
    expect(res.json.resolvedProductIds).toEqual([`tp-${U}-p3`, `tp-${U}-a`]);
    const smart = await h.call('POST', '/v1/admin/collections', catalog.token, {
      id: `smart-${U}`,
      name: `Smart ${U}`,
      kind: 'smart',
      rule: { tags: [`tag-${U}`], sort: 'name', limit: 3 },
    });
    expect(smart.status).toBe(201);
    const sres = await h.call('GET', `/v1/admin/collections/smart-${U}?resolve=true`, catalog.token);
    expect(sres.json.resolvedProductIds).toHaveLength(3);
    const bad = await h.call('POST', '/v1/admin/collections', catalog.token, {
      id: `x-${U}`,
      name: 'Bad',
      kind: 'smart',
    });
    expect(bad.status).toBe(400);
    const stale = await h.call('PUT', `/v1/admin/collections/col-${U}`, catalog.token, {
      name: 'New',
      kind: 'manual',
      productIds: [],
      expectedRev: 9,
    });
    expect(stale.status).toBe(409);
    const upd = await h.call('PUT', `/v1/admin/collections/col-${U}`, catalog.token, {
      name: 'New',
      kind: 'manual',
      productIds: [`tp-${U}-a`],
      expectedRev: 1,
    });
    expect([upd.status, upd.json.rev]).toEqual([200, 2]);
    expect((await h.call('DELETE', `/v1/admin/collections/smart-${U}`, catalog.token)).status).toBe(400); // guard body required
    expect(
      (
        await h.call('DELETE', `/v1/admin/collections/smart-${U}`, catalog.token, {
          expectedRev: 1,
          reason: 'tidy up',
        })
      ).status,
    ).toBe(204);
  });

  it('CSV: export guards formulas; import is dry-run by default and all-or-nothing', async () => {
    const catalog = await h.staff('catalog');
    await h.call('POST', '/v1/admin/products', catalog.token, productBody('csv', { name: `=SUM(1+1) ${U}` }));
    const exp = await h.call('GET', '/v1/admin/catalog/export', catalog.token);
    expect(exp.headers.get('content-type')).toContain('text/csv');
    expect(exp.text).toContain(`'=SUM(1+1) ${U}`); // neutralised for spreadsheets
    const lines = exp.text.trim().split('\r\n');
    const header = lines[0]!;
    const row = lines.find((l) => l.startsWith(`tp-${U}-csv,`))!;
    const modified = row.replace(',10000,12000,', ',11000,13000,');
    const body = `${header}\r\n${modified}\r\n`;
    const dry = await h.call('POST', '/v1/admin/catalog/import', catalog.token, body, {
      'content-type': 'text/csv',
    });
    expect([dry.status, dry.json.dryRun, dry.json.applied, dry.json.products.update]).toEqual([
      200,
      true,
      false,
      1,
    ]);
    const still = await h.call('GET', `/v1/admin/products/tp-${U}-csv`, catalog.token);
    expect(still.json.variants[0].pricePaise).toBe(10000);
    // the preview names exactly what will change and carries a fingerprint that a commit must echo back
    expect(dry.json.previewHash).toMatch(/^[0-9a-f]{64}$/);
    expect(dry.json.changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'variant',
          id: expect.stringContaining(U),
          action: 'update',
          priceChange: { fromPaise: 10000, toPaise: 11000 },
        }),
      ]),
    );
    const hash = dry.json.previewHash as string;
    const csv = { 'content-type': 'text/csv' };
    // commit without a preview fingerprint or without a reason is refused and changes nothing
    expect(
      (await h.call('POST', '/v1/admin/catalog/import?dryRun=false', catalog.token, body, csv)).status,
    ).toBe(400);
    expect(
      (
        await h.call(
          'POST',
          `/v1/admin/catalog/import?dryRun=false&previewHash=${hash}`,
          catalog.token,
          body,
          csv,
        )
      ).status,
    ).toBe(400);
    // a different file than the one previewed is refused
    const other = `${header}\r\n${row.replace(',10000,12000,', ',10500,13000,')}\r\n`;
    const mismatch = await h.call(
      'POST',
      `/v1/admin/catalog/import?dryRun=false&previewHash=${hash}&reason=${encodeURIComponent('wrong file')}`,
      catalog.token,
      other,
      csv,
    );
    expect([mismatch.status, mismatch.json.error.code]).toEqual([409, 'CART_VERSION_CONFLICT']);
    const bad = await h.call(
      'POST',
      '/v1/admin/catalog/import?dryRun=false&previewHash=' + hash + '&reason=bad+row',
      catalog.token,
      `${header}\r\n${row.replace(',10000,', ',-5,')}\r\n`,
      csv,
    );
    expect(bad.status).toBe(422);
    expect(bad.json.errors.length).toBeGreaterThan(0);
    expect(
      (await h.call('GET', `/v1/admin/products/tp-${U}-csv`, catalog.token)).json.variants[0].pricePaise,
    ).toBe(10000);
    const applied = await h.call(
      'POST',
      `/v1/admin/catalog/import?dryRun=false&previewHash=${hash}&reason=${encodeURIComponent('Quarterly price review')}`,
      catalog.token,
      body,
      csv,
    );
    expect([applied.status, applied.json.applied]).toEqual([200, true]);
    expect(
      (await h.call('GET', `/v1/admin/products/tp-${U}-csv`, catalog.token)).json.variants[0].pricePaise,
    ).toBe(11000);
    // replaying the same commit is refused: the data moved on, so the fingerprint no longer matches
    const replay = await h.call(
      'POST',
      `/v1/admin/catalog/import?dryRun=false&previewHash=${hash}&reason=${encodeURIComponent('replay')}`,
      catalog.token,
      body,
      csv,
    );
    expect([replay.status, replay.json.error.code]).toEqual([409, 'CART_VERSION_CONFLICT']);
    const importAudit = await h.sup.query(
      `SELECT reason, before, after FROM audit_log WHERE action = 'catalog.import' ORDER BY id DESC LIMIT 1`,
    );
    expect(importAudit.rows[0]).toMatchObject({
      reason: 'Quarterly price review',
      before: { previewHash: hash },
    });
    expect(JSON.stringify(importAudit.rows[0].after)).toContain('priceChange');
    // an archived product is reported by the preview itself (not discovered at commit time)
    const arch = await h.call('GET', `/v1/admin/products/tp-${U}-csv`, catalog.token);
    await h.call('POST', `/v1/admin/products/tp-${U}-csv/archive`, catalog.token, {
      expectedVersion: arch.json.version,
      reason: 'archive before import',
    });
    const archivedDry = await h.call(
      'POST',
      '/v1/admin/catalog/import',
      catalog.token,
      `${header}\r\n${row.replace(',10000,12000,', ',10100,12000,')}\r\n`,
      csv,
    );
    expect(archivedDry.status).toBe(422);
    expect(JSON.stringify(archivedDry.json.errors)).toContain('is archived');
    // ...but an UNCHANGED archived row (a full export lists archived products too) is skipped, not an error
    const exportAgain = (await h.call('GET', '/v1/admin/catalog/export', catalog.token)).text;
    const noChange = await h.call('POST', '/v1/admin/catalog/import', catalog.token, exportAgain, csv);
    expect([noChange.status, noChange.json.errors.length]).toEqual([200, 0]);
    const audit = await h.sup.query(`SELECT 1 FROM audit_log WHERE action = 'catalog.import'`);
    expect(audit.rowCount).toBeGreaterThan(0);
  });
});

describe('media library', () => {
  it('uploads, sanitises to content-addressed WebP variants, dedupes, rejects non-media', async () => {
    const designer = await h.staff('designer');
    const png = makePng(800, 600, 1);
    const up = await h.call(
      'POST',
      `/v1/admin/media?filename=hero.png&alt=${encodeURIComponent('A shoe')}`,
      designer.token,
      png,
      { 'content-type': 'image/png' },
    );
    expect(up.status).toBe(201);
    expect(up.json).toMatchObject({
      kind: 'image',
      width: 800,
      height: 600,
      approval: 'draft',
      alt: 'A shoe',
    });
    const sha = up.json.sha256 as string;
    expect(h.storage.objects.has(`media/${sha}/orig.webp`)).toBe(true);
    expect(h.storage.objects.has(`media/${sha}/w640.webp`)).toBe(true);
    expect(h.storage.objects.has(`media/${sha}/w1080.webp`)).toBe(false); // never upscale
    expect(up.json.urls.original).toBe(`/v1/media/${sha}/orig.webp`);

    const again = await h.call('POST', '/v1/admin/media?filename=copy.png', designer.token, png, {
      'content-type': 'image/png',
    });
    expect([again.status, again.json.duplicate, again.json.id]).toEqual([200, true, up.json.id]);

    const txt = await h.call(
      'POST',
      '/v1/admin/media?filename=evil.png',
      designer.token,
      Buffer.from('<?php echo 1; ?>'.repeat(5)),
      { 'content-type': 'image/png' },
    );
    expect(txt.status).toBe(400);
    const sup = await h.staff('support');
    expect(
      (
        await h.call('POST', '/v1/admin/media?filename=a.png', sup.token, makePng(10, 10, 2), {
          'content-type': 'image/png',
        })
      ).status,
    ).toBe(403);
    expect((await h.call('GET', '/v1/admin/media', sup.token)).status).toBe(200); // support may read
  });

  it('approval gate: admin only; alt required; generated needs the packaging attestation; pack-shots need real photography', async () => {
    const designer = await h.staff('designer');
    const up = await h.call('POST', `/v1/admin/media?filename=a.png`, designer.token, makePng(640, 480, 3), {
      'content-type': 'image/png',
    });
    const id = up.json.id as string;
    const byDesigner = await h.call('POST', `/v1/admin/media/${id}/approve`, designer.token, {});
    expect(byDesigner.status).toBe(403);
    const noAlt = await h.call('POST', `/v1/admin/media/${id}/approve`, admin.token, {});
    expect(noAlt.status).toBe(400);
    expect(noAlt.json.error.fields.alt).toBeTruthy();
    await h.call('PATCH', `/v1/admin/media/${id}`, designer.token, {
      alt: 'Brown shoe',
      provenance: 'generated',
    });
    const noAttest = await h.call('POST', `/v1/admin/media/${id}/approve`, admin.token, {});
    expect(noAttest.json.error.fields.packagingAttested).toBeTruthy();
    const ok = await h.call('POST', `/v1/admin/media/${id}/approve`, admin.token, {
      packagingAttested: true,
      note: 'checked',
    });
    expect([ok.status, ok.json.approval]).toEqual([200, 'approved']);

    // changing provenance after approval requires a new review
    const re = await h.call('PATCH', `/v1/admin/media/${id}`, designer.token, { provenance: 'illustration' });
    expect(re.json.approval).toBe('draft');

    await h.call('PATCH', `/v1/admin/media/${id}`, designer.token, {
      role: 'product_packshot',
      provenance: 'generated',
    });
    const packshot = await h.call('POST', `/v1/admin/media/${id}/approve`, admin.token, {
      packagingAttested: true,
    });
    expect(packshot.json.error.fields.provenance).toBeTruthy();
    const rej = await h.call('POST', `/v1/admin/media/${id}/reject`, admin.token, {
      note: 'Not product truth',
    });
    expect(rej.json.approval).toBe('rejected');

    // the database refuses an approved generated asset without the attestation even if the API were bypassed
    await expect(
      h.sup.query(
        `UPDATE media_assets SET approval='approved', approval_by=$2, approval_at=now(), provenance='generated', packaging_attested=false WHERE id=$1`,
        [id, admin.id],
      ),
    ).rejects.toThrow();
  });

  it('attaches to products as catalogue images; in-use media cannot be archived', async () => {
    const catalog = await h.staff('catalog');
    const up = await h.call(
      'POST',
      `/v1/admin/media?filename=p.png&alt=Pack`,
      catalog.token,
      makePng(500, 500, 4),
      { 'content-type': 'image/png' },
    );
    await h.call('POST', '/v1/admin/products', catalog.token, productBody('img'));
    const set = await h.call('PUT', `/v1/admin/products/tp-${U}-img/media`, catalog.token, {
      items: [{ mediaId: up.json.id, alt: 'Pack shot' }],
    });
    expect(set.status).toBe(200);
    expect(set.json.media[0].assetPath).toBe(`/v1/media/${up.json.sha256}/orig.webp`);
    const usage = await h.call('GET', `/v1/admin/media/${up.json.id}/usage`, catalog.token);
    expect(usage.json.items).toEqual([{ type: 'product', id: `tp-${U}-img`, label: expect.any(String) }]);
    const stamp = () =>
      h.call('GET', `/v1/admin/media/${up.json.id}`, catalog.token).then((r) => r.json.updatedAt as string);
    expect((await h.call('POST', `/v1/admin/media/${up.json.id}/archive`, catalog.token)).status).toBe(400); // reason + stamp required
    const blocked = await h.call('POST', `/v1/admin/media/${up.json.id}/archive`, catalog.token, {
      expectedUpdatedAt: await stamp(),
      reason: 'cleanup',
    });
    expect([blocked.status, blocked.json.error.code]).toEqual([409, 'ILLEGAL_STATE']);
    await h.call('PUT', `/v1/admin/products/tp-${U}-img/media`, catalog.token, { items: [] });
    expect(
      (
        await h.call('POST', `/v1/admin/media/${up.json.id}/archive`, catalog.token, {
          expectedUpdatedAt: await stamp(),
          reason: 'cleanup',
        })
      ).json.archived,
    ).toBe(true);
    const listed = await h.call('GET', '/v1/admin/media?archived=true', catalog.token);
    expect(listed.json.items.some((m: { id: string }) => m.id === up.json.id)).toBe(true);
    // archived media can no longer be attached
    const reuse = await h.call('PUT', `/v1/admin/products/tp-${U}-img/media`, catalog.token, {
      items: [{ mediaId: up.json.id, alt: 'x' }],
    });
    expect(reuse.status).toBe(400);
  });
});
