import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { queueEmail, sendDueEmails } from '@jw/commerce-domain';
import type { EmailSender } from '@jw/integrations';
import { workerDb } from '@jw/test-support';
import { startHarness } from './harness.ts';

/** Production-readiness behaviours: email bounce handling, metrics exposure, refund capability, authorisation of every admin route. */
const U = randomUUID().slice(0, 6);
let h: Awaited<ReturnType<typeof startHarness>>;
const wdb = workerDb(2);
let admin: { id: string; token: string };
let admin1: { id: string; token: string };
let support: { id: string; token: string };

beforeAll(async () => {
  h = await startHarness({
    env: { EMAIL_WEBHOOK_TOKEN: 'email-webhook-token-0123456789', METRICS_TOKEN: 'metrics-token-0123456789' },
  });
  await h.fx.resetCommerceData();
  await h.fx.openStore();
  admin = await h.staff('admin');
  admin1 = await h.staff('admin', 'aal1');
  support = await h.staff('support');
});
afterAll(async () => {
  await wdb.close();
  await h.close();
});

const sender = (impl: (to: string) => void): EmailSender & { sent: string[] } => {
  const sent: string[] = [];
  return {
    name: 'test',
    sent,
    async send(m) {
      impl(m.to);
      sent.push(m.to);
    },
  };
};
const queue = (to: string, template = 'order.placed') =>
  h.db.tx({ kind: 'system', reason: 'test' }, (c) =>
    queueEmail(c, {
      to,
      template,
      payload: { orderNumber: 'JW-1', totalPaise: 100, paymentMethod: 'cod' },
      dedupeKey: `t:${randomUUID()}`,
    }),
  );
const statusOf = async (to: string) =>
  (
    await h.sup.query(
      `SELECT status, last_error, payload FROM email_outbox WHERE to_email = $1 ORDER BY id DESC LIMIT 1`,
      [to],
    )
  ).rows[0];

describe('email bounce handling', () => {
  it('a permanent SMTP failure suppresses the address, fails the message once (no retry storm) and later mail is not attempted', async () => {
    const bad = `gone-${U}@example.test`;
    await queue(bad);
    const s = sender(() => {
      throw Object.assign(new Error('550 5.1.1 mailbox unavailable'), { responseCode: 550 });
    });
    await sendDueEmails(wdb, s, 50);
    const first = await statusOf(bad);
    expect(first.status).toBe('failed');
    expect(first.payload).toEqual({});
    expect(
      (await h.sup.query(`SELECT reason FROM email_suppressions WHERE email = $1`, [bad])).rows[0],
    ).toEqual({ reason: 'hard_bounce' });
    await queue(bad); // a later notification to the same address
    const s2 = sender(() => undefined);
    await sendDueEmails(wdb, s2, 50);
    expect(s2.sent).not.toContain(bad);
    expect((await statusOf(bad)).status).toBe('suppressed');
  });

  it('a temporary failure (4xx / network) is retried, not suppressed', async () => {
    const flaky = `flaky-${U}@example.test`;
    await queue(flaky);
    await sendDueEmails(
      wdb,
      sender(() => {
        throw Object.assign(new Error('451 try later'), { responseCode: 451 });
      }),
      50,
    );
    expect((await statusOf(flaky)).status).toBe('pending');
    expect((await h.sup.query(`SELECT 1 FROM email_suppressions WHERE email = $1`, [flaky])).rowCount).toBe(
      0,
    );
  });

  it('provider callbacks suppress on hard bounce / complaint only, need the shared token, and operators can lift an entry with a reason', async () => {
    const hook = (body: unknown, token?: string) =>
      h.call('POST', '/v1/webhooks/email', undefined, JSON.stringify(body), {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      });
    const a = `bounce-${U}@example.test`;
    const b = `spam-${U}@example.test`;
    const c = `soft-${U}@example.test`;
    const ev = {
      events: [
        { type: 'bounce', email: a.toUpperCase() },
        { type: 'complaint', email: b, detail: 'marked as spam' },
        { type: 'delivered', email: c },
        { type: 'bounce', email: 'not-an-email' },
      ],
    };
    expect((await hook(ev)).status).toBe(401);
    expect((await hook(ev, 'wrong-token-0123456789abcdef')).status).toBe(401);
    const ok = await hook(ev, 'email-webhook-token-0123456789');
    expect([ok.status, ok.json]).toEqual([200, { received: true, suppressed: 2 }]);
    expect((await hook(ev, 'email-webhook-token-0123456789')).json.suppressed).toBe(0); // idempotent
    const rows = (
      await h.sup.query(`SELECT email, reason FROM email_suppressions WHERE email = ANY($1) ORDER BY email`, [
        [a, b, c],
      ])
    ).rows;
    expect(rows).toEqual([
      { email: a, reason: 'hard_bounce' },
      { email: b, reason: 'complaint' },
    ]);

    // operators: ops:read to see, settings:write (+MFA) and a reason to lift
    const list = await h.call('GET', '/v1/admin/outbox/suppressions', admin.token);
    expect(list.json.items.map((x: { email: string }) => x.email)).toEqual(expect.arrayContaining([a, b]));
    expect((await h.call('GET', '/v1/admin/outbox/suppressions', support.token)).status).toBe(403);
    expect(
      (
        await h.call('POST', '/v1/admin/outbox/suppressions/lift', admin1.token, {
          email: a,
          reason: 'customer fixed the mailbox',
        })
      ).json.error.code,
    ).toBe('MFA_REQUIRED');
    expect(
      (await h.call('POST', '/v1/admin/outbox/suppressions/lift', admin.token, { email: a })).status,
    ).toBe(400);
    expect(
      (
        await h.call('POST', '/v1/admin/outbox/suppressions/lift', admin.token, {
          email: a,
          reason: 'customer fixed the mailbox',
        })
      ).status,
    ).toBe(204);
    expect(
      (
        await h.call('POST', '/v1/admin/outbox/suppressions/lift', admin.token, {
          email: a,
          reason: 'again please',
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await h.sup.query(
          `SELECT reason FROM audit_log WHERE action = 'email.suppression.lift' AND resource_id = $1`,
          [a],
        )
      ).rows[0].reason,
    ).toBe('customer fixed the mailbox');
  });

  it('the email webhook does not exist without a configured token', async () => {
    const noHook = await startHarness({ pool: 2 });
    try {
      const r = await noHook.call('POST', '/v1/webhooks/email', undefined, '{"events":[]}', {
        'content-type': 'application/json',
      });
      expect(r.status).toBe(404);
    } finally {
      await noHook.close();
    }
  });
});

describe('metrics and refund capability', () => {
  it('/metrics needs the bearer token when one is configured', async () => {
    const base = h.base();
    expect((await fetch(`${base}/metrics`)).status).toBe(401);
    expect((await fetch(`${base}/metrics`, { headers: { authorization: 'Bearer nope' } })).status).toBe(401);
    const ok = await fetch(`${base}/metrics`, {
      headers: { authorization: 'Bearer metrics-token-0123456789' },
    });
    expect([ok.status, ok.headers.get('cache-control')]).toEqual([200, 'no-store']);
  });

  it('each refund says whether it can be processed now and why not', async () => {
    const finance = await h.staff('finance');
    const { order } = await h.placeOrder('cod', 'twinkle-shine-leather-polish', 1);
    await h.sup.query(
      `INSERT INTO refunds (order_id, amount_paise, status, reason, idempotency_key) VALUES ($1, 100, 'requested', 'cod refund', $2)`,
      [order.id, `cap-${U}`],
    );
    const items = (await h.call('GET', '/v1/admin/refunds', finance.token)).json.items as Array<{
      orderId: string;
      processable: boolean;
      blockedReason: string | null;
    }>;
    expect(items.find((r) => r.orderId === order.id)).toMatchObject({
      processable: false,
      blockedReason: 'no_online_payment',
    });
  });
});

/** Operations whose OpenAPI text does not name the permission; the handler guard is asserted here instead. */
const CODE_GUARDS: Record<string, string> = {
  'GET /v1/admin/content': 'catalog:read',
  'GET /v1/admin/content/{slug}': 'catalog:read',
  'PUT /v1/admin/content/{slug}': 'catalog:write',
  'POST /v1/admin/content/{slug}/publish': 'catalog:write',
  'GET /v1/admin/inventory': 'inventory:read',
  'GET /v1/admin/inventory/{variantId}/movements': 'inventory:read',
  'POST /v1/admin/inventory/{variantId}/adjust': 'inventory:write',
  'PATCH /v1/admin/catalog/variants/{id}': 'catalog:write',
  'GET /v1/admin/settings': 'settings:read',
  'PATCH /v1/admin/settings': 'settings:write',
  'GET /v1/admin/ops/outbox': 'ops:read',
  'POST /v1/admin/ops/outbox/{id}/replay': 'ops:replay',
  'GET /v1/admin/shipping/pins': 'orders:read',
  'PUT /v1/admin/shipping/pins': 'settings:write',
  'GET /v1/admin/reviews': 'reviews:moderate',
  'POST /v1/admin/reviews/{id}/moderate': 'reviews:moderate',
  'POST /v1/admin/review-media/{id}/moderate': 'reviews:moderate',
  'GET /v1/admin/review-media/{id}/image': 'reviews:moderate',
  'POST /v1/admin/orders/{id}/status': 'orders:fulfil',
  'POST /v1/admin/orders/{id}/cancel': 'orders:cancel',
  'POST /v1/admin/orders/{id}/cod-collected': 'orders:fulfil',
};

describe('authorisation of every admin operation (generated from the contract)', () => {
  it('rejects anonymous callers on all admin routes and callers without the documented permission', async () => {
    const { readFileSync } = await import('node:fs');
    const { parse } = await import('yaml');
    const { SPEC_PATH } = await import('@jw/test-support');
    const spec = parse(readFileSync(SPEC_PATH, 'utf8')) as {
      paths: Record<
        string,
        Record<string, { operationId?: string; description?: string; security?: unknown[] }>
      >;
    };
    const { permissionsFor } = await import('@jw/commerce-domain');
    const roles = ['support', 'catalog', 'fulfillment', 'finance', 'designer'] as const;
    const staff = Object.fromEntries(
      await Promise.all(roles.map(async (r) => [r, await h.staff(r)] as const)),
    );
    const fill = (p: string) =>
      p.replace(/\{[^}]+\}/g, (m) =>
        m === '{sha}'
          ? 'a'.repeat(64)
          : m === '{platform}'
            ? 'android'
            : m === '{channel}'
              ? 'web'
              : m === '{kind}'
                ? 'page'
                : m === '{key}'
                  ? 'home'
                  : m === '{variantId}'
                    ? 'v-x'
                    : m === '{provider}'
                      ? 'x'
                      : m === '{file}'
                        ? 'orig.webp'
                        : m === '{name}'
                          ? 'smtp'
                          : randomUUID(),
      );
    const unguarded: string[] = [];
    const wrong: string[] = [];
    let checked = 0;
    for (const [path, item] of Object.entries(spec.paths)) {
      if (!path.startsWith('/v1/admin/')) continue;
      for (const [method, op] of Object.entries(item)) {
        if (!['get', 'post', 'put', 'patch', 'delete'].includes(method)) continue;
        const url = fill(path);
        const anon = await h.call(method.toUpperCase(), url, undefined, method === 'get' ? undefined : {});
        if (anon.status !== 401) wrong.push(`${method.toUpperCase()} ${path} anonymous -> ${anon.status}`);
        const need =
          /permission `([a-z_]+:[a-z_]+)`/i.exec(op.description ?? '')?.[1] ??
          CODE_GUARDS[`${method.toUpperCase()} ${path}`];
        if (!need) {
          unguarded.push(`${method.toUpperCase()} ${path}`);
          continue;
        }
        // a role that lacks the permission must be refused before anything else is evaluated
        const lacking = roles.find((r) => !(permissionsFor(r) as readonly string[]).includes(need));
        if (!lacking) continue; // every non-admin role has it
        const res = await h.call(
          method.toUpperCase(),
          url,
          staff[lacking]!.token,
          method === 'get' ? undefined : {},
        );
        checked += 1;
        if (res.status !== 403)
          wrong.push(`${method.toUpperCase()} ${path} as ${lacking} (needs ${need}) -> ${res.status}`);
      }
    }
    expect(wrong).toEqual([]);
    expect(checked).toBeGreaterThan(120);
    // self-service routes (an operator acting on their own account) are guarded by authentication only
    expect(unguarded.sort()).toEqual([
      'DELETE /v1/admin/sessions/{id}',
      'GET /v1/admin/me',
      'GET /v1/admin/sessions',
    ]);
  });
});
