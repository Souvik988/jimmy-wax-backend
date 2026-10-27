import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLogger } from '@jw/observability';
import { experienceDb } from '@jw/test-support';
import { createExperienceApp } from '../../../experience-api/src/app.ts';
import { startHarness } from './harness.ts';
import { makePng } from './png.ts';
import {
  announcementBlock,
  appChrome,
  appHome,
  appNav,
  designSystem,
  heroBlock,
  webChrome,
  webHome,
  webNav,
} from './experienceFixtures.ts';

const U = randomUUID().slice(0, 6);
let h: Awaited<ReturnType<typeof startHarness>>;
let pub = '';
let pubServer: import('node:http').Server;
const edb = experienceDb(3);
let admin: { id: string; token: string };
let designer: { id: string; token: string };
let seed = 100;

beforeAll(async () => {
  h = await startHarness();
  pubServer = await new Promise((resolve) => {
    const s = createExperienceApp({
      db: edb,
      logger: createLogger('silent'),
      ttlMs: 1,
      storage: h.storage,
    }).listen(0, '127.0.0.1', () => {
      pub = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
      resolve(s);
    });
  });
  admin = await h.staff('admin');
  designer = await h.staff('designer');
  await h.sup.query(
    `TRUNCATE exp_documents, exp_document_revisions, exp_campaigns, exp_preview_tokens CASCADE`,
  );
  await h.sup.query(`DELETE FROM exp_presence`);
});
afterAll(async () => {
  pubServer.close();
  await edb.close();
  await h.close();
});

const A = '/v1/admin/experience';
const put = (
  channel: string,
  kind: string,
  key: string,
  body: unknown,
  rev: number,
  token = designer.token,
) => h.call('PUT', `${A}/${channel}/docs/${kind}/${key}`, token, body, { 'if-match': `"${rev}"` });
const bundle = async (channel: 'app' | 'web', headers: Record<string, string> = {}) => {
  const r = await fetch(`${pub}/v1/experience/${channel}`, { headers });
  const t = await r.text();
  return { status: r.status, json: t ? JSON.parse(t) : null, headers: r.headers };
};

/** Uploads an image, gives it alt text and has an administrator approve it. */
async function approvedImage(alt = 'A leather shoe'): Promise<string> {
  const up = await h.call(
    'POST',
    `/v1/admin/media?filename=img-${seed}.png`,
    designer.token,
    makePng(640, 480, seed++),
    { 'content-type': 'image/png' },
  );
  expect(up.status).toBe(201);
  await h.call('PATCH', `/v1/admin/media/${up.json.id}`, designer.token, { alt });
  const ok = await h.call('POST', `/v1/admin/media/${up.json.id}/approve`, admin.token, { note: 'ok' });
  expect(ok.json.approval).toBe('approved');
  return up.json.id as string;
}

async function seedValidApp(mediaId: string) {
  let rev =
    (await h.sup.query(`SELECT rev FROM exp_documents WHERE channel='shared' AND key='base'`)).rows[0]?.rev ??
    0;
  expect((await put('shared', 'tokens', 'base', designSystem(), rev)).status).toBe(200);
  for (const [kind, key, body] of [
    ['navigation', 'main', appNav()],
    ['chrome', 'main', appChrome()],
    ['page', 'home', appHome([heroBlock(mediaId)])],
  ] as const) {
    const cur =
      (
        await h.sup.query(`SELECT rev FROM exp_documents WHERE channel='app' AND kind=$1 AND key=$2`, [
          kind,
          key,
        ])
      ).rows[0]?.rev ?? 0;
    const r = await put('app', kind, key, body, cur);
    expect([kind, r.status]).toEqual([kind, 200]);
  }
}
const publish = (
  channels: string[],
  label: string,
  token = admin.token,
  extra: Record<string, unknown> = {},
  headers: Record<string, string> = {},
) => h.call('POST', `${A}/releases`, token, { channels, label, ...extra }, headers);

describe('documents', () => {
  it('requires If-Match, versions every write, returns the server copy on conflict, enforces roles', async () => {
    const noHeader = await h.call('PUT', `${A}/shared/docs/tokens/base`, designer.token, designSystem());
    expect(noHeader.status).toBe(400);
    const created = await put('shared', 'tokens', 'base', designSystem(), 0);
    expect([created.status, created.headers.get('etag')]).toEqual([200, '"1"']);
    const dup = await put('shared', 'tokens', 'base', designSystem(), 0);
    expect([dup.status, dup.json.error.code]).toEqual([409, 'ETAG_MISMATCH']);
    const ds2 = designSystem();
    ds2.color.roles['accent.primary'] = '#E0AD54';
    expect((await put('shared', 'tokens', 'base', ds2, 1)).json.rev).toBe(2);
    const stale = await put('shared', 'tokens', 'base', designSystem(), 1);
    expect(stale.status).toBe(409);
    expect(stale.json.error.lines[0].rev).toBe(2); // the server copy, for the client's 3-way merge
    const revs = await h.call('GET', `${A}/shared/docs/tokens/base/revisions`, designer.token);
    expect(revs.json.items.map((x: { rev: number }) => x.rev)).toEqual([2, 1]);
    const support = await h.staff('support');
    expect((await h.call('GET', `${A}/shared/docs`, support.token)).status).toBe(403);
    expect(
      (await put('shared', 'tokens', 'base', designSystem(), 2, (await h.staff('catalog')).token)).status,
    ).toBe(403);
    await put('shared', 'tokens', 'base', designSystem(), 2); // restore palette for later tests
  });

  it('rejects malformed content: unknown/foreign block types, extra props, over-limit, bad keys, bad tokens', async () => {
    const m = await approvedImage();
    const bad = async (blocks: unknown[], key = 'home', channel = 'app') =>
      put(channel, 'page', key, channel === 'app' ? appHome(blocks) : webHome(blocks), 0);
    const unknown = await bad([{ id: 'blk-x-0001', type: 'app.nope', visible: true, props: {} }]);
    expect(unknown.status).toBe(400);
    expect(Object.values(unknown.json.error.fields).join()).toContain('unknown app block type');
    const foreign = await bad([
      { id: 'blk-x-0002', type: 'web.marquee', visible: true, props: { items: ['a', 'b', 'c', 'd'] } },
    ]);
    expect(foreign.status).toBe(400);
    const extra = await bad([
      { ...heroBlock(m), props: { ...heroBlock(m).props, html: '<script>alert(1)</script>' } },
    ]);
    expect(extra.status).toBe(400);
    const nineSlides = await bad([
      heroBlock(m, {
        slides: Array.from({ length: 9 }, (_, i) => ({
          id: `slide-${i}000`,
          image: { mediaId: m, alt: 'x' },
          action: { type: 'none' },
          a11yLabel: 'slide label',
        })),
      }),
    ]);
    expect(nineSlides.status).toBe(400);
    expect(
      (
        await bad([
          heroBlock(m),
          { ...heroBlock(m), id: 'blk-hero-0002' },
          { ...heroBlock(m), id: 'blk-hero-0003' },
        ])
      ).status,
    ).toBe(400); // max 2 hero blocks
    expect((await bad([], 'checkout')).status).toBe(400); // not an app page
    const dsBad = designSystem();
    (dsBad.color.roles as Record<string, string>)['accent.primary'] = 'gold';
    expect((await put('shared', 'tokens', 'base', dsBad, 2)).status).toBe(400);
    const ov = await put(
      'app',
      'tokens',
      'override',
      { overrides: { color: { roles: { 'accent.primary': '#C99534' }, nope: 1 } } },
      0,
    );
    expect(ov.status).toBe(400); // override keys must exist in the shared system
    const okOv = await put(
      'app',
      'tokens',
      'override',
      { overrides: { color: { roles: { 'accent.primary': '#C99534' } } } },
      0,
    );
    expect(okOv.status).toBe(200);
  });
});

describe('validation report (the publish gate)', () => {
  it('reports missing docs, unapproved media, missing alt, bad links, variables, copy lint, contrast, placeholders', async () => {
    await h.sup.query(`DELETE FROM exp_documents WHERE channel = 'app'`);
    let rep = await h.call('POST', `${A}/app/validate`, designer.token);
    expect(rep.json.canPublish).toBe(false);
    expect(rep.json.errors.map((e: { code: string }) => e.code)).toEqual(
      expect.arrayContaining(['doc.missing']),
    );

    const up = await h.call(
      'POST',
      '/v1/admin/media?filename=raw.png',
      designer.token,
      makePng(300, 300, seed++),
      { 'content-type': 'image/png' },
    );
    const raw = up.json.id as string; // draft, no alt
    const ann = announcementBlock(
      'Free shipping above {{store.nope}} — {{store.freeShippingThreshold}} and only ₹99! Certified best polish',
      'blk-ann-0009',
    );
    const page = appHome([
      heroBlock(raw, {
        slides: [
          {
            id: 'slide-0001',
            image: { mediaId: raw },
            textInImage: true,
            action: { type: 'url', url: 'http://evil.example/x' },
            a11yLabel: 'hero slide',
          },
        ],
      }),
      ann,
      {
        id: 'blk-rail-0001',
        type: 'app.product_rail',
        visible: true,
        props: {
          title: 'Picks',
          source: { kind: 'manual', productIds: ['does-not-exist'] },
          limit: 5,
          card: 'standard',
        },
      },
    ]);
    for (const [kind, key, body] of [
      ['navigation', 'main', appNav()],
      ['chrome', 'main', appChrome()],
      ['page', 'home', page],
    ] as const)
      expect((await put('app', kind, key, body, 0)).status).toBe(200);
    const ds = designSystem();
    ds.color.roles['text.primary'] = '#2A1E15'; // unreadable on the dark backgrounds
    const cur = (await h.sup.query(`SELECT rev FROM exp_documents WHERE channel='shared' AND key='base'`))
      .rows[0].rev;
    await put('shared', 'tokens', 'base', ds, cur);

    rep = await h.call('POST', `${A}/app/validate`, designer.token);
    const codes = (l: Array<{ code: string }>) => l.map((x) => x.code);
    expect(codes(rep.json.errors)).toEqual(
      expect.arrayContaining([
        'ref.media_unapproved',
        'a11y.alt_missing',
        'ref.link_scheme_blocked',
        'var.unknown',
        'ref.product_missing',
        'a11y.contrast_fail',
      ]),
    );
    expect(codes(rep.json.warnings)).toEqual(
      expect.arrayContaining(['copy.price_literal', 'copy.claim_unsubstantiated']),
    );
    expect(rep.json.errors.find((e: { code: string }) => e.code === 'ref.media_unapproved').blockId).toBe(
      'blk-hero-0001',
    ); // deep-linkable

    // publishing is refused with the same report
    const refused = await publish(['app'], 'Should fail');
    expect([refused.status, refused.json.error.code]).toEqual([400, 'VALIDATION_FAILED']);
    expect(refused.json.error.lines.length).toBeGreaterThan(3);
    await put('shared', 'tokens', 'base', designSystem(), cur + 1); // restore
  });

  it('blocks placeholder testimonials; owner-supplied ones need consent; text-only in the app', async () => {
    const mid = await approvedImage();
    await seedValidApp(mid);
    const t = await h.call('POST', '/v1/admin/content-library/testimonials', designer.token, {
      name: 'Rohan',
      city: 'Pune',
      quote: 'My shoes look new again after two minutes.',
      rating: 5,
      source: 'placeholder',
      status: 'active',
    });
    expect(t.status).toBe(201);
    const noConsent = await h.call('POST', '/v1/admin/content-library/testimonials', designer.token, {
      name: 'Sneha',
      quote: 'The kit is lovely and easy to use.',
      source: 'owner_supplied',
    });
    expect(noConsent.status).toBe(400);
    const page = appHome([
      heroBlock(mid),
      {
        id: 'blk-testi-001',
        type: 'app.testimonials',
        visible: true,
        props: { mode: 'curated', testimonialIds: [t.json.id], limit: 4 },
      },
    ]);
    const cur = (await h.sup.query(`SELECT rev FROM exp_documents WHERE channel='app' AND key='home'`))
      .rows[0].rev;
    await put('app', 'page', 'home', page, cur);
    let rep = await h.call('POST', `${A}/app/validate`, designer.token);
    expect(rep.json.errors.map((e: { code: string }) => e.code)).toContain('testimonial.placeholder');

    const owner = await h.call(
      'PATCH',
      `/v1/admin/content-library/testimonials/${t.json.id}`,
      designer.token,
      {
        source: 'owner_supplied',
        consent: { recordedAt: new Date().toISOString(), note: 'Customer agreed in writing, kept on file' },
      },
      { 'if-match': '"1"' },
    );
    expect([owner.status, owner.json.source]).toEqual([200, 'owner_supplied']);
    rep = await h.call('POST', `${A}/app/validate`, designer.token);
    expect(rep.json.errors).toEqual([]);
    const stale = await h.call(
      'PATCH',
      `/v1/admin/content-library/testimonials/${t.json.id}`,
      designer.token,
      { rating: 4 },
      { 'if-match': '"1"' },
    );
    expect([stale.status, stale.json.error.code]).toEqual([409, 'ETAG_MISMATCH']);
  });
});

describe('releases', () => {
  it('publish needs MFA + permission; atomic, immutable, served with ETag; edits stay draft until published', async () => {
    const mid = await approvedImage();
    await seedValidApp(mid);
    const aal1 = await h.staff('admin', 'aal1');
    const noMfa = await publish(['app'], 'First', aal1.token);
    expect([noMfa.status, noMfa.json.error.code]).toEqual([403, 'MFA_REQUIRED']);
    expect((await publish(['app'], 'First', designer.token)).status).toBe(403); // designers cannot publish
    expect((await bundle('app')).json.enabled).toBe(false); // nothing published yet

    const r1 = await publish(['app'], 'First light');
    expect(r1.status).toBe(201);
    expect(r1.json.releases[0]).toMatchObject({ number: 1, status: 'live', channel: 'app' });
    const b1 = await bundle('app');
    expect(b1.json).toMatchObject({ enabled: true, channel: 'app', release: { number: 1 } });
    expect(b1.json.pages.home.blocks[0].type).toBe('app.hero_carousel');
    expect(b1.json.tokens.color.roles['accent.primary']).toBe('#E7B54A');
    const mediaIdKey = Object.keys(b1.json.media)[0]!;
    expect(b1.json.media[mediaIdKey].url).toMatch(/^\/v1\/media\/[0-9a-f]{64}\/orig\.webp$/);
    const etag = b1.headers.get('etag')!;
    expect(b1.headers.get('cache-control')).toContain('max-age=60');
    const nm = await fetch(`${pub}/v1/experience/app`, { headers: { 'if-none-match': etag } });
    expect(nm.status).toBe(304);

    // draft edits are invisible to customers until published
    const cur = (await h.sup.query(`SELECT rev FROM exp_documents WHERE channel='app' AND key='home'`))
      .rows[0].rev;
    await put('app', 'page', 'home', appHome([heroBlock(mid), announcementBlock('Hello draft')]), cur);
    expect((await bundle('app')).json.pages.home.blocks).toHaveLength(1);
    const diff = await h.call('GET', `${A}/app/diff?against=live`, designer.token);
    expect(JSON.stringify(diff.json.docs)).toContain('Added app.announcement_bar');

    // releases are immutable at the database level
    await expect(
      h.sup.query(`UPDATE exp_releases SET snapshot = '{}'::jsonb WHERE number = 1 AND channel = 'app'`),
    ).rejects.toThrow(/immutable/);
    await expect(
      h.sup.query(`DELETE FROM exp_releases WHERE number = 1 AND channel = 'app'`),
    ).rejects.toThrow(/cannot be deleted/);

    // release 2 → rollback to 1 creates release 3 with release 1's content
    expect((await publish(['app'], 'Second')).json.releases[0].number).toBe(2);
    expect((await bundle('app')).json.pages.home.blocks).toHaveLength(2);
    const target = r1.json.releases[0].id;
    const rb = await h.call('POST', `${A}/releases/${target}/rollback`, admin.token, {
      reason: 'Announcement was wrong',
    });
    expect([rb.status, rb.json.number, rb.json.rollbackOf]).toEqual([201, 3, target]);
    expect((await bundle('app')).json.release.number).toBe(3);
    expect((await bundle('app')).json.pages.home.blocks).toHaveLength(1);
    const already = await h.call('POST', `${A}/releases/${rb.json.id}/rollback`, admin.token, {
      reason: 'again please',
    });
    expect(already.status).toBe(409);
    const list = await h.call('GET', `${A}/releases?channel=app`, designer.token);
    expect(list.json.items.map((x: { status: string }) => x.status)).toEqual([
      'live',
      'superseded',
      'superseded',
    ]);

    // discard-draft: standard pages cannot be deleted, so an abandoned draft is returned to the live version (as a new revision)
    const discard = (rev: number, reason = 'Start over from live') =>
      h.call(
        'POST',
        `${A}/app/docs/page/home/discard-draft`,
        designer.token,
        { reason },
        { 'if-match': String(rev) },
      );
    const draftNow = (await h.call('GET', `${A}/app/docs/page/home`, designer.token)).json;
    expect(draftNow.body.blocks).toHaveLength(2);
    expect((await discard(draftNow.rev - 1)).status).toBe(409); // never discard someone else's newer edit
    expect((await discard(draftNow.rev, 'x')).status).toBe(400); // a reason is required
    const reset = await discard(draftNow.rev);
    expect([reset.status, reset.json.rev, reset.json.body.blocks.length]).toEqual([200, draftNow.rev + 1, 1]);
    expect((await h.call('GET', `${A}/app/docs/page/home/revisions`, designer.token)).json.items[0].rev).toBe(
      draftNow.rev + 1,
    ); // history kept
    expect((await discard(reset.json.rev)).json.rev).toBe(reset.json.rev); // already equal to live: no-op, no new revision
    expect(
      (
        await h.call(
          'POST',
          `${A}/app/docs/page/home/discard-draft`,
          (await h.staff('catalog')).token,
          { reason: 'not mine to do' },
          { 'if-match': String(reset.json.rev) },
        )
      ).status,
    ).toBe(403);
    await put(
      'app',
      'page',
      'home',
      appHome([heroBlock(mid), announcementBlock('Hello draft')]),
      reset.json.rev,
    ); // restore the draft later tests expect
  });

  it('idempotency keys, scheduling (replace confirmation, cancel, activation by time), kill switch', async () => {
    const key = randomUUID();
    const a = await publish(['app'], 'Idem', admin.token, {}, { 'idempotency-key': key });
    const b = await publish(['app'], 'Idem', admin.token, {}, { 'idempotency-key': key });
    expect(b.json.releases[0].id).toBe(a.json.releases[0].id);
    const mismatch = await publish(['app'], 'Different', admin.token, {}, { 'idempotency-key': key });
    expect([mismatch.status, mismatch.json.error.code]).toEqual([422, 'DUPLICATE_REQUEST_MISMATCH']);

    const live = (await bundle('app')).json.release.number;
    const mid = (await h.sup.query(`SELECT id FROM media_assets WHERE approval='approved' LIMIT 1`)).rows[0]
      .id as string;
    const cur = (await h.sup.query(`SELECT rev FROM exp_documents WHERE channel='app' AND key='home'`))
      .rows[0].rev;
    await put('app', 'page', 'home', appHome([heroBlock(mid), announcementBlock('Scheduled sale')]), cur);
    const past = await publish(['app'], 'Past', admin.token, {
      scheduledAt: new Date(Date.now() - 1000).toISOString(),
    });
    expect(past.status).toBe(400);
    const soon = new Date(Date.now() + 2500).toISOString();
    const sched = await publish(['app'], 'Scheduled', admin.token, { scheduledAt: soon });
    expect([sched.status, sched.json.releases[0].status]).toEqual([201, 'scheduled']);
    expect((await bundle('app')).json.release.number).toBe(live); // not yet
    const clash = await publish(['app'], 'Another', admin.token);
    expect([clash.status, clash.json.error.code]).toEqual([409, 'ILLEGAL_STATE']);
    await new Promise((r) => setTimeout(r, 3000));
    const after = await bundle('app');
    expect(after.json.release.number).toBe(live + 1);
    expect(after.json.pages.home.blocks).toHaveLength(2);
    // bookkeeping job marks it live and supersedes the previous one
    const n = await h.db.tx({ kind: 'system', reason: 'test' }, async (c) =>
      (await import('@jw/commerce-domain')).exp.activateDueReleases(c),
    );
    expect(n).toBe(1);
    const row = await h.sup.query(`SELECT status FROM exp_releases WHERE channel='app' AND number = $1`, [
      live + 1,
    ]);
    expect(row.rows[0].status).toBe('live');

    const cancelMe = await publish(['app'], 'To cancel', admin.token, {
      scheduledAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    expect(cancelMe.status).toBe(201);
    const c1 = await h.call('POST', `${A}/releases/${cancelMe.json.releases[0].id}/cancel`, admin.token);
    expect(c1.json.status).toBe('cancelled');
    await expect(
      h.sup.query(`UPDATE exp_releases SET status='scheduled' WHERE id = $1`, [cancelMe.json.releases[0].id]),
    ).rejects.toThrow();

    // kill switch: admin only, reason required, clients are told to use bundled defaults
    expect(
      (
        await h.call('POST', `${A}/app/kill`, designer.token, {
          enabled: false,
          reason: 'testing the switch',
        })
      ).status,
    ).toBe(403);
    const killed = await h.call('POST', `${A}/app/kill`, admin.token, {
      enabled: false,
      reason: 'Bad hero image shipped',
    });
    expect(killed.json).toMatchObject({ enabled: false, killReason: 'Bad hero image shipped' });
    expect((await bundle('app')).json).toMatchObject({ enabled: false });
    await h.call('POST', `${A}/app/kill`, admin.token, { enabled: true, reason: 'resolved' });
    expect((await bundle('app')).json.enabled).toBe(true);
    const audit = await h.sup.query(
      `SELECT action FROM audit_log WHERE action LIKE 'experience.%' ORDER BY id`,
    );
    expect(audit.rows.map((x) => x.action)).toEqual(
      expect.arrayContaining([
        'experience.release.create',
        'experience.release.rollback',
        'experience.release.schedule',
        'experience.kill.on',
        'experience.kill.off',
        'experience.draft.save',
      ]),
    );
  });
});

describe('bundle assembly', () => {
  it('substitutes facts live (no release needed), holds back unsupported blocks, applies campaigns by time', async () => {
    const mid = (await h.sup.query(`SELECT id FROM media_assets WHERE approval='approved' LIMIT 1`)).rows[0]
      .id as string;
    await h.sup.query(
      `UPDATE store_settings SET support_email = 'care@example.test', cod_fee_paise = 2500, shipping_fee_paise = 4000`,
    );
    const cur = (await h.sup.query(`SELECT rev FROM exp_documents WHERE channel='app' AND key='home'`))
      .rows[0].rev;
    await put(
      'app',
      'page',
      'home',
      appHome([
        heroBlock(mid),
        announcementBlock(
          'Shipping is {{store.shippingFee}}, COD fee {{store.codFee}}, GST {{store.gstRate}} included',
        ),
      ]),
      cur,
    );
    await h.sup.query(`DELETE FROM exp_campaigns`);
    const rel = await publish(['app'], 'Facts');
    expect(rel.status).toBe(201);
    let b = await bundle('app');
    expect(JSON.stringify(b.json.pages.home.blocks[1].props.text)).toContain(
      'Shipping is ₹40, COD fee ₹25, GST 18% included',
    );
    await h.sup.query(`UPDATE store_settings SET shipping_fee_paise = 5500`);
    b = await bundle('app');
    expect(b.json.pages.home.blocks[1].props.text).toContain('Shipping is ₹55');
    await h.sup.query(`UPDATE store_settings SET shipping_fee_paise = 4000`);

    const caps = await bundle('app', {
      'x-jw-client': 'app/1.0.0+7; platform=android; caps=app.hero_carousel',
    });
    expect(caps.json.pages.home.blocks.map((x: { type: string }) => x.type)).toEqual(['app.hero_carousel']);
    expect(caps.json.diagnostics.heldBack).toEqual({ 'app.announcement_bar': 1 });

    // campaign overlay: active window changes tokens and adds an announcement; outside the window nothing changes
    const camp = await h.call('POST', `${A}/campaigns`, designer.token, {
      name: 'Diwali glow',
      startsAt: new Date(Date.now() - 60_000).toISOString(),
      endsAt: new Date(Date.now() + 3_600_000).toISOString(),
      status: 'active',
      app: {
        tokens: { color: { roles: { 'accent.primary': '#F5C968' } } },
        announcement: { text: 'Festival offers are live', tone: 'promo' },
      },
    });
    expect(camp.status).toBe(201);
    await publish(['app'], 'With campaign');
    b = await bundle('app');
    expect(b.json.tokens.color.roles['accent.primary']).toBe('#F5C968');
    expect(
      b.json.content.announcements.some((a: { text: string }) => a.text === 'Festival offers are live'),
    ).toBe(true);
    expect(b.json.diagnostics.activeCampaigns).toEqual([camp.json.id]);
    await h.sup.query(
      `UPDATE exp_campaigns SET starts_at = now() + interval '1 day', ends_at = now() + interval '2 days'`,
    ); // window moves; snapshot keeps the definition
    // (the snapshot stores the old window, so the bundle still shows it; a new release would capture the new window)
    const bad = await h.call('POST', `${A}/campaigns`, designer.token, {
      name: 'Bad',
      startsAt: '2030-01-02T00:00:00Z',
      endsAt: '2030-01-01T00:00:00Z',
    });
    expect(bad.status).toBe(400);
    await h.sup.query(`DELETE FROM exp_campaigns`);
  });

  it('sources resolve against live catalogue data (manual, collection, newest, bestsellers) and drop inactive products', async () => {
    const mid = (await h.sup.query(`SELECT id FROM media_assets WHERE approval='approved' LIMIT 1`)).rows[0]
      .id as string;
    const cat = await h.staff('catalog');
    for (const n of ['x1', 'x2', 'x3'])
      await h.call('POST', '/v1/admin/products', cat.token, {
        id: `sx-${U}-${n}`,
        name: `Source ${n} ${U}`,
        categoryId: 'polish',
        tags: [`src-${U}`],
        variants: [{ id: `sx-${U}-${n}`, sku: `SX-${U}-${n}`.toUpperCase(), pricePaise: 10000 }],
      });
    await h.call('POST', '/v1/admin/collections', cat.token, {
      id: `col-${U}`,
      name: `Col ${U}`,
      kind: 'manual',
      productIds: [`sx-${U}-x2`, `sx-${U}-x1`, `sx-${U}-x3`],
    });
    const rail = (id: string, source: unknown) => ({
      id,
      type: 'app.product_rail',
      visible: true,
      props: { title: 'Rail', source, limit: 5, card: 'standard' },
    });
    const cur = (await h.sup.query(`SELECT rev FROM exp_documents WHERE channel='app' AND key='home'`))
      .rows[0].rev;
    const page = appHome([
      heroBlock(mid),
      rail('blk-rail-0001', { kind: 'collection', slug: `col-${U}` }),
      rail('blk-rail-0002', { kind: 'newest' }),
      rail('blk-rail-0003', { kind: 'bestsellers' }),
      rail('blk-rail-0004', { kind: 'manual', productIds: [`sx-${U}-x1`] }),
    ]);
    expect((await put('app', 'page', 'home', page, cur)).status).toBe(200);
    for (const n of ['x1', 'x2', 'x3']) await h.fx.setStock(`sx-${U}-${n}`, 5);
    expect((await publish(['app'], 'Rails')).status).toBe(201);
    let b = await bundle('app');
    const ids = (i: number) => b.json.pages.home.blocks[i].resolved.productIds as string[];
    expect(ids(1)).toEqual([`sx-${U}-x2`, `sx-${U}-x1`, `sx-${U}-x3`]);
    expect(ids(2).length).toBe(5);
    expect(ids(3).length).toBe(5);
    expect(ids(4)).toEqual([`sx-${U}-x1`]);
    const x2 = (await h.call('GET', `/v1/admin/products/sx-${U}-x2`, cat.token)).json;
    await h.call('POST', `/v1/admin/products/sx-${U}-x2/archive`, cat.token, {
      expectedVersion: x2.version,
      reason: 'test archive',
    });
    b = await bundle('app');
    expect(ids(1)).toEqual([`sx-${U}-x1`, `sx-${U}-x3`]); // live data, no re-release needed
    expect(
      (await fetch(`${pub}/v1/collections/col-${U}/products`).then((r) => r.json())).items.map(
        (x: { id: string }) => x.id,
      ),
    ).toEqual([`sx-${U}-x1`, `sx-${U}-x3`]);
    const byIds = await fetch(`${pub}/v1/products?ids=sx-${U}-x3,sx-${U}-x1,nope-nope`).then((r) => r.json());
    expect(byIds.items.map((x: { id: string }) => x.id)).toEqual([`sx-${U}-x3`, `sx-${U}-x1`]);
    expect((await fetch(`${pub}/v1/products?ids=${'a-b,'.repeat(60)}`)).status).toBe(400);

    // out-of-stock contract: sold-out products stay in the rail but never lead it (rule-fed rails), manual order is kept, and they are named
    await h.fx.setStock(`sx-${U}-x1`, 0);
    b = await bundle('app');
    expect(ids(1)).toEqual([`sx-${U}-x3`, `sx-${U}-x1`]); // x1 sold out -> moved after x3
    expect(b.json.pages.home.blocks[1].resolved.outOfStockIds).toEqual([`sx-${U}-x1`]);
    expect(ids(4)).toEqual([`sx-${U}-x1`]); // hand-picked list keeps the editor's order and still names the sold-out id
    expect(b.json.pages.home.blocks[4].resolved.outOfStockIds).toEqual([`sx-${U}-x1`]);
    await h.fx.setStock(`sx-${U}-x1`, 5);
  });

  it('serves the bundle with ETag/304 (strong, weak and list validators), a 60 s cache and Vary on the client header', async () => {
    const first = await bundle('app');
    const etag = first.headers.get('etag') as string;
    expect(etag).toMatch(/^"[0-9a-f]{32}"$/);
    expect(first.headers.get('cache-control')).toContain('max-age=60');
    expect(first.headers.get('vary')).toContain('X-JW-Client');
    for (const inm of [etag, `W/${etag}`, `"nope", ${etag}`, '*']) {
      const r = await fetch(`${pub}/v1/experience/app`, { headers: { 'if-none-match': inm } });
      expect([inm, r.status, r.headers.get('etag')]).toEqual([inm, 304, etag]);
    }
    expect(
      (await fetch(`${pub}/v1/experience/app`, { headers: { 'if-none-match': '"stale"' } })).status,
    ).toBe(200);
    // a different capability set is a different representation
    const lean = await fetch(`${pub}/v1/experience/app`, {
      headers: { 'x-jw-client': 'app/1.0.0+7; platform=android; caps=app.hero_carousel' },
    });
    expect(lean.headers.get('etag')).not.toBe(etag);
  });

  it('warns when media is smaller or differently shaped than the block slot (x-slot) but still lets the page publish', async () => {
    const mid = await approvedImage('A tiny hero'); // 640x480 -> far below the 1170x780 app hero slot
    const cur = (await h.sup.query(`SELECT rev FROM exp_documents WHERE channel='app' AND key='home'`))
      .rows[0].rev;
    expect((await put('app', 'page', 'home', appHome([heroBlock(mid)]), cur)).status).toBe(200);
    const rep = (await h.call('POST', `${A}/app/validate`, designer.token)).json;
    const w = rep.warnings.filter((x: { code: string }) => x.code === 'media.slot_too_small');
    expect(w.length).toBeGreaterThan(0);
    expect(w[0]).toMatchObject({
      docKey: 'page:home',
      message: expect.stringContaining('640x480'),
      fixHint: expect.stringContaining('1170x780'),
    });
    expect(rep.errors.some((e: { code: string }) => e.code.startsWith('media.slot'))).toBe(false);
  });
});

describe('web channel, preview, media delivery', () => {
  it('web documents validate (SEO titles unique), publish both channels as a bundle, text-only testimonials in the app', async () => {
    const mid = await approvedImage('Collection still');
    await seedValidApp(mid);
    await put('web', 'navigation', 'main', webNav(), 0);
    await put('web', 'chrome', 'main', webChrome(), 0);
    await put(
      'web',
      'page',
      'home',
      webHome([
        {
          id: 'blk-mar-0001',
          type: 'web.marquee',
          visible: true,
          props: { items: ['The finishing touch', 'Leather', 'Ritual', 'Light'] },
        },
      ]),
      0,
    );
    const miss = await h.call('POST', `${A}/web/validate`, designer.token);
    expect(miss.json.canPublish).toBe(true);
    await put(
      'web',
      'page',
      'shop',
      webHome([
        { id: 'blk-mar-0002', type: 'web.marquee', visible: true, props: { items: ['a', 'b', 'c', 'd'] } },
      ]),
      0,
    ); // same SEO title as home
    expect(
      (await h.call('POST', `${A}/web/validate`, designer.token)).json.errors.map(
        (e: { code: string }) => e.code,
      ),
    ).toContain('seo.title_duplicate');
    const shop = (await h.sup.query(`SELECT rev FROM exp_documents WHERE channel='web' AND key='shop'`))
      .rows[0].rev;
    await put(
      'web',
      'page',
      'shop',
      webHome(
        [{ id: 'blk-mar-0002', type: 'web.marquee', visible: true, props: { items: ['a', 'b', 'c', 'd'] } }],
        'Shop · Jimmy & Wax',
      ),
      shop,
    );

    // a video testimonial: kept for the website, removed from the app bundle
    const video = await h.call(
      'POST',
      '/v1/admin/media?filename=t.mp4',
      designer.token,
      Buffer.concat([Buffer.alloc(4), Buffer.from('ftypisom'), Buffer.alloc(64, 7)]),
      { 'content-type': 'video/mp4' },
    );
    expect(video.status).toBe(201);
    expect(video.json.kind).toBe('video');
    const t = await h.call('POST', '/v1/admin/content-library/testimonials', designer.token, {
      name: 'Aman',
      quote: 'Genuinely the easiest way to look after leather.',
      source: 'owner_supplied',
      consent: { recordedAt: new Date().toISOString(), note: 'Written consent on file' },
      videoMediaId: video.json.id,
      posterMediaId: mid,
      status: 'active',
      channels: ['web', 'app'],
    });
    expect(t.status).toBe(201);
    const noPoster = await h.call('POST', '/v1/admin/content-library/testimonials', designer.token, {
      name: 'Bad',
      quote: 'A video without poster.',
      source: 'placeholder',
      videoMediaId: video.json.id,
    });
    expect(noPoster.status).toBe(400);
    // video needs a poster and approval before it can be approved
    const pa = await h.call('POST', `/v1/admin/media/${video.json.id}/approve`, admin.token, {});
    expect(pa.json.error.fields.posterMediaId).toBeTruthy();
    await h.call('PATCH', `/v1/admin/media/${video.json.id}`, designer.token, { posterMediaId: mid });
    expect(
      (await h.call('POST', `/v1/admin/media/${video.json.id}/approve`, admin.token, {})).json.approval,
    ).toBe('approved');

    const appHomeCur = (await h.sup.query(`SELECT rev FROM exp_documents WHERE channel='app' AND key='home'`))
      .rows[0].rev;
    await put(
      'app',
      'page',
      'home',
      appHome([
        heroBlock(mid),
        {
          id: 'blk-testi-001',
          type: 'app.testimonials',
          visible: true,
          props: { mode: 'curated', testimonialIds: [t.json.id], limit: 4 },
        },
      ]),
      appHomeCur,
    );
    const webHomeCur = (await h.sup.query(`SELECT rev FROM exp_documents WHERE channel='web' AND key='home'`))
      .rows[0].rev;
    await put(
      'web',
      'page',
      'home',
      webHome([
        {
          id: 'blk-tw-00001',
          type: 'web.testimonials',
          visible: true,
          props: { testimonialIds: [t.json.id], layout: 'grid' },
        },
      ]),
      webHomeCur,
    );

    const both = await publish(['app', 'web'], 'Launch bundle');
    expect(both.status).toBe(201);
    expect(both.json.releases).toHaveLength(2);
    expect(both.json.releases[0].bundleId).toBe(both.json.releases[1].bundleId);
    const a = await bundle('app');
    const w = await bundle('web');
    const [tid] = Object.keys(a.json.content.testimonials);
    expect(a.json.content.testimonials[tid!].videoMediaId).toBeUndefined(); // the app is text-only
    expect(w.json.content.testimonials[tid!].videoMediaId).toBe(video.json.id);
    expect(w.json.media[video.json.id].kind).toBe('video');
    expect(w.json.media[video.json.id].poster.url).toMatch(/orig\.webp$/);
  });

  it('preview tokens: draft visible only with a valid, channel-scoped, unexpired, unrevoked token; always no-store', async () => {
    const mid = (
      await h.sup.query(`SELECT id FROM media_assets WHERE approval='approved' AND kind='image' LIMIT 1`)
    ).rows[0].id as string;
    const cur = (await h.sup.query(`SELECT rev FROM exp_documents WHERE channel='app' AND key='home'`))
      .rows[0].rev;
    await put('app', 'page', 'home', appHome([heroBlock(mid), announcementBlock('Only in the draft')]), cur);
    const tok = await h.call('POST', `${A}/app/preview-tokens`, designer.token, { ttlMinutes: 30 });
    expect(tok.status).toBe(201);
    const url = (t: string, ch = 'app') => `/v1/experience/${ch}/preview?token=${t}`;
    const ok = await h.call('GET', url(tok.json.token));
    expect(ok.status).toBe(200);
    expect(ok.headers.get('cache-control')).toBe('no-store');
    expect(ok.headers.get('x-robots-tag')).toBe('noindex');
    expect(JSON.stringify(ok.json.pages.home.blocks)).toContain('Only in the draft');
    expect(ok.json).toMatchObject({ preview: true, release: { id: 'draft' } });
    expect(
      (await bundle('app')).json.pages.home.blocks.some((b: { id: string }) => b.id === 'blk-ann-0001'),
    ).toBe(false); // public stays published
    expect((await h.call('GET', url(tok.json.token, 'web'))).status).toBe(401); // scoped to its channel
    expect((await h.call('GET', url('x'.repeat(30)))).status).toBe(401);
    expect((await h.call('GET', '/v1/experience/app/preview')).status).toBe(401);
    await h.sup.query(
      `UPDATE exp_preview_tokens SET expires_at = now() - interval '1 minute' WHERE id = $1`,
      [tok.json.id],
    );
    expect((await h.call('GET', url(tok.json.token))).status).toBe(401);
    const t2 = await h.call('POST', `${A}/app/preview-tokens`, designer.token, {});
    expect((await h.call('DELETE', `${A}/preview-tokens/${t2.json.id}`, designer.token)).status).toBe(204);
    expect((await h.call('GET', url(t2.json.token))).status).toBe(401);
    const rel = (await h.call('GET', `${A}/releases?channel=app&limit=1`, designer.token)).json.items[0];
    const t3 = await h.call('POST', `${A}/app/preview-tokens`, designer.token, { releaseId: rel.id });
    expect((await h.call('GET', url(t3.json.token))).json.release.id).toBe(rel.id); // a token can pin an old release
  });

  it('serves content-addressed media with immutable caching, Range for video, and refuses unknown files', async () => {
    const up = await h.call(
      'POST',
      '/v1/admin/media?filename=m.png',
      designer.token,
      makePng(900, 700, seed++),
      { 'content-type': 'image/png' },
    );
    const sha = up.json.sha256 as string;
    // pending (draft) media is not public (DASH-BR-042); after approval it is
    expect((await fetch(`${pub}/v1/media/${sha}/orig.webp`)).status).toBe(404);
    await h.call('PATCH', `/v1/admin/media/${up.json.id}`, designer.token, { alt: 'A shoe' });
    expect(
      (await h.call('POST', `/v1/admin/media/${up.json.id}/approve`, admin.token, { note: 'ok' })).json
        .approval,
    ).toBe('approved');
    const img = await fetch(`${pub}/v1/media/${sha}/orig.webp`);
    expect([img.status, img.headers.get('content-type')]).toEqual([200, 'image/webp']);
    expect(img.headers.get('cache-control')).toContain('immutable');
    expect(img.headers.get('x-content-type-options')).toBe('nosniff');
    expect((await fetch(`${pub}/v1/media/${sha}/w1080.webp`)).status).toBe(404); // not generated (never upscaled)
    expect((await fetch(`${pub}/v1/media/${sha}/../../etc/passwd`)).status).toBe(404);
    expect((await fetch(`${pub}/v1/media/${'0'.repeat(64)}/orig.webp`)).status).toBe(404);
    const vid = await h.call(
      'POST',
      '/v1/admin/media?filename=r.mp4',
      designer.token,
      Buffer.concat([
        Buffer.alloc(4),
        Buffer.from('ftypisom'),
        Buffer.from(Array.from({ length: 200 }, (_, i) => i % 251)),
      ]),
      { 'content-type': 'video/mp4' },
    );
    await h.sup.query(
      `UPDATE media_assets SET approval='approved', approval_by=$2, approval_at=now() WHERE id=$1`,
      [vid.json.id, admin.id],
    );
    const part = await fetch(`${pub}/v1/media/${vid.json.sha256}/video.mp4`, {
      headers: { range: 'bytes=10-19' },
    });
    expect([part.status, part.headers.get('content-range')]).toEqual([206, `bytes 10-19/212`]);
    expect((await part.arrayBuffer()).byteLength).toBe(10);
    expect(
      (await fetch(`${pub}/v1/media/${vid.json.sha256}/video.mp4`, { headers: { range: 'bytes=999-1000' } }))
        .status,
    ).toBe(416);
  });

  it('presence is advisory and excludes yourself', async () => {
    await h.call('PUT', `${A}/app/presence`, designer.token, { pageKey: 'home' });
    const seen = await h.call('GET', `${A}/app/presence`, admin.token);
    expect(seen.json.items.map((x: { pageKey: string }) => x.pageKey)).toEqual(['home']);
    expect((await h.call('GET', `${A}/app/presence`, designer.token)).json.items).toEqual([]);
  });
});
