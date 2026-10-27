import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '@jw/config';
import { InMemoryStorage, TestPaymentGateway } from '@jw/integrations';
import { createLogger } from '@jw/observability';
import { Fixtures, apiDb, superPool } from '@jw/test-support';
import { base32Decode, hotp, issuePhoneOtp } from '@jw/commerce-domain';
import { createApp } from '../../src/app.ts';
import { createTokenService } from '../../src/auth.ts';
import { MemoryStore } from '../../src/rateLimit.ts';
import { testEnv } from './support.ts';

const config = loadConfig(testEnv());
const tokens = createTokenService(config);
const db = apiDb(4);
const sup = superPool();
const fx = new Fixtures(sup);
let base = '';
let server: import('node:http').Server;

async function call(method: string, path: string, body?: unknown, token?: string) {
  const res = await fetch(base + path, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const t = await res.text();
  return { status: res.status, json: t ? JSON.parse(t) : null };
}
const PW = 'Correct-Horse-9!';
it('phone-only account deletion needs a fresh account-bound OTP and commits failed attempts', async () => {
  const phone = '+919876543219';
  const first = await db.tx({ kind: 'anonymous' }, (c) => issuePhoneOtp(c, phone));
  if (!first.ok) throw first.error;
  const login = await call('POST', '/v1/auth/otp/verify', { phone, code: first.code });
  expect(login.status).toBe(200);
  // Skip only the cooldown in this disposable test database, not verification.
  await sup.query(`DELETE FROM auth.phone_otps WHERE phone=$1`, [phone]);
  const next = await db.tx({ kind: 'anonymous' }, (c) => issuePhoneOtp(c, phone));
  if (!next.ok) throw next.error;
  const wrong = next.code === '000000' ? '999999' : '000000';
  expect(
    (await call('POST', '/v1/auth/account/delete', { code: wrong }, login.json.accessToken)).status,
  ).toBe(401);
  expect(
    (await sup.query(`SELECT attempts FROM auth.phone_otps WHERE phone=$1`, [phone])).rows[0].attempts,
  ).toBe(1);
  expect(
    (await call('POST', '/v1/auth/account/delete', { code: next.code }, login.json.accessToken)).status,
  ).toBe(204);
  expect(
    (await sup.query(`SELECT status FROM auth.users WHERE id=$1`, [login.json.user.id])).rows[0].status,
  ).toBe('deleted');
});
let n = 0;
const email = () => `user${++n}-${Date.now()}@example.test`;
const emailToken = async (to: string, template: string) =>
  (
    await sup.query(
      `SELECT payload FROM email_outbox WHERE to_email = $1 AND template = $2 ORDER BY id DESC LIMIT 1`,
      [to, template],
    )
  ).rows[0]?.payload.token as string;

beforeAll(async () => {
  const app = createApp({
    config,
    db,
    tokens,
    storage: new InMemoryStorage(),
    gateway: new TestPaymentGateway(),
    logger: createLogger(process.env.TEST_LOG ?? 'silent'),
    limits: new MemoryStore(),
    rateLimitsEnabled: false,
  });
  await new Promise<void>((r) => {
    server = app.listen(0, '127.0.0.1', () => r());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.close();
  await db.close();
  await sup.end();
});
beforeEach(async () => {
  await fx.resetCommerceData();
  await sup.query(`DELETE FROM admin_users`);
});

describe('registration and login (own identity, no external provider)', () => {
  it('registers, stores only a scrypt hash, creates profile + preferences, returns a working session', async () => {
    const e = email();
    const r = await call('POST', '/v1/auth/register', {
      email: e.toUpperCase(),
      password: PW,
      fullName: 'Asha K',
    });
    expect(r.status).toBe(201);
    expect(r.json.user.email).toBe(e); // normalised
    const row = (await sup.query(`SELECT password_hash FROM auth.users WHERE email = $1`, [e])).rows[0];
    expect(row.password_hash).toMatch(/^scrypt\$/);
    expect(row.password_hash).not.toContain(PW);
    expect(
      (await sup.query(`SELECT full_name FROM profiles WHERE id = $1`, [r.json.user.id])).rows[0].full_name,
    ).toBe('Asha K');
    const me = await call('GET', '/v1/me', undefined, r.json.accessToken);
    expect(me.status).toBe(200);
    expect(me.json.fullName).toBe('Asha K');
    expect(await emailToken(e, 'verify_email')).toBeTruthy();
  });

  it('rejects weak/duplicate credentials with field errors and never reveals the hash', async () => {
    const e = email();
    expect(
      (await call('POST', '/v1/auth/register', { email: e, password: 'short', fullName: 'A' })).json.error
        .fields.password,
    ).toBeTruthy();
    expect(
      (await call('POST', '/v1/auth/register', { email: e, password: 'password1234', fullName: 'A' })).status,
    ).toBe(400);
    expect((await call('POST', '/v1/auth/register', { email: e, password: PW, fullName: 'A' })).status).toBe(
      201,
    );
    const dup = await call('POST', '/v1/auth/register', { email: e, password: PW, fullName: 'B' });
    expect(dup.status).toBe(400);
    expect(JSON.stringify(dup.json)).not.toMatch(/scrypt/);
  });

  it('login: same generic error for unknown email and wrong password; lockout after 5 failures survives rollback', async () => {
    const e = email();
    await call('POST', '/v1/auth/register', { email: e, password: PW, fullName: 'A' });
    const unknown = await call('POST', '/v1/auth/login', { email: 'nobody@example.test', password: PW });
    const wrong = await call('POST', '/v1/auth/login', { email: e, password: 'Wrong-Password-1' });
    expect(unknown.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(unknown.json.error.message).toBe(wrong.json.error.message);
    for (let i = 0; i < 4; i++)
      await call('POST', '/v1/auth/login', { email: e, password: 'Wrong-Password-1' });
    const locked = await call('POST', '/v1/auth/login', { email: e, password: PW }); // right password, but locked
    expect(locked.status).toBe(429);
    expect(
      (await sup.query(`SELECT locked_until FROM auth.users WHERE email = $1`, [e])).rows[0].locked_until,
    ).not.toBeNull();
    await sup.query(`UPDATE auth.users SET locked_until = NULL, failed_logins = 0 WHERE email = $1`, [e]);
    expect((await call('POST', '/v1/auth/login', { email: e, password: PW })).status).toBe(200);
  });

  it('refresh rotates tokens; replaying an old refresh token revokes the whole session family', async () => {
    const e = email();
    const reg = await call('POST', '/v1/auth/register', { email: e, password: PW, fullName: 'A' });
    const r1 = reg.json.refreshToken as string;
    const second = await call('POST', '/v1/auth/refresh', { refreshToken: r1 });
    expect(second.status).toBe(200);
    expect(second.json.refreshToken).not.toBe(r1);
    const replay = await call('POST', '/v1/auth/refresh', { refreshToken: r1 }); // stolen/replayed token
    expect(replay.status).toBe(401);
    // the legitimate descendant is dead too (family revoked)
    expect((await call('POST', '/v1/auth/refresh', { refreshToken: second.json.refreshToken })).status).toBe(
      401,
    );
  });

  it('logout revokes the session (idempotent)', async () => {
    const reg = await call('POST', '/v1/auth/register', { email: email(), password: PW, fullName: 'A' });
    expect((await call('POST', '/v1/auth/logout', { refreshToken: reg.json.refreshToken })).status).toBe(204);
    expect((await call('POST', '/v1/auth/logout', { refreshToken: reg.json.refreshToken })).status).toBe(204);
    expect((await call('POST', '/v1/auth/refresh', { refreshToken: reg.json.refreshToken })).status).toBe(
      401,
    );
  });
});

describe('password reset, change and email verification', () => {
  it('forgot is indistinguishable for unknown accounts; reset signs out every device and the token is single-use', async () => {
    const e = email();
    const reg = await call('POST', '/v1/auth/register', { email: e, password: PW, fullName: 'A' });
    const a = await call('POST', '/v1/auth/password/forgot', { email: e });
    const b = await call('POST', '/v1/auth/password/forgot', { email: 'ghost@example.test' });
    expect([a.status, a.json]).toEqual([b.status, b.json]);
    const t = await emailToken(e, 'password_reset');
    expect(t).toBeTruthy();
    expect(
      (await call('POST', '/v1/auth/password/reset', { token: t, password: 'Brand-New-Pass-77' })).status,
    ).toBe(204);
    expect(
      (await call('POST', '/v1/auth/password/reset', { token: t, password: 'Another-Pass-88!' })).status,
    ).toBe(400);
    expect((await call('POST', '/v1/auth/refresh', { refreshToken: reg.json.refreshToken })).status).toBe(
      401,
    );
    expect((await call('POST', '/v1/auth/login', { email: e, password: PW })).status).toBe(401);
    expect((await call('POST', '/v1/auth/login', { email: e, password: 'Brand-New-Pass-77' })).status).toBe(
      200,
    );
  });

  it('change password needs the current one and keeps only the current session', async () => {
    const e = email();
    const reg = await call('POST', '/v1/auth/register', { email: e, password: PW, fullName: 'A' });
    const other = await call('POST', '/v1/auth/login', { email: e, password: PW });
    expect(
      (
        await call(
          'POST',
          '/v1/auth/password/change',
          { currentPassword: 'nope-nope-nope', newPassword: 'Newer-Pass-123' },
          reg.json.accessToken,
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await call(
          'POST',
          '/v1/auth/password/change',
          { currentPassword: PW, newPassword: 'Newer-Pass-123' },
          reg.json.accessToken,
        )
      ).status,
    ).toBe(204);
    expect((await call('POST', '/v1/auth/refresh', { refreshToken: other.json.refreshToken })).status).toBe(
      401,
    );
    expect((await call('POST', '/v1/auth/refresh', { refreshToken: reg.json.refreshToken })).status).toBe(
      200,
    );
  });

  it('email verification token marks the account verified once', async () => {
    const e = email();
    const reg = await call('POST', '/v1/auth/register', { email: e, password: PW, fullName: 'A' });
    const t = await emailToken(e, 'verify_email');
    expect((await call('POST', '/v1/auth/email/verify', { token: t })).status).toBe(204);
    expect((await call('POST', '/v1/auth/email/verify', { token: t })).status).toBe(400);
    expect(
      (await sup.query(`SELECT email_verified_at FROM auth.users WHERE id = $1`, [reg.json.user.id])).rows[0]
        .email_verified_at,
    ).not.toBeNull();
  });
});

describe('operator login and TOTP MFA', () => {
  const code = (secret: string, stepOffset = 0) =>
    hotp(base32Decode(secret), Math.floor(Date.now() / 30000) + stepOffset);

  it('customers cannot sign in to the console; staff can; MFA enrolment → aal2 enables sensitive actions; codes are single-use', async () => {
    const e = email();
    const reg = await call('POST', '/v1/auth/register', { email: e, password: PW, fullName: 'Owner' });
    const uid = reg.json.user.id as string;
    expect((await call('POST', '/v1/auth/login', { email: e, password: PW, client: 'admin' })).status).toBe(
      403,
    );
    await sup.query(`INSERT INTO admin_users (user_id, role) VALUES ($1,'admin')`, [uid]);

    const login = await call('POST', '/v1/auth/login', { email: e, password: PW, client: 'admin' });
    expect(login.status).toBe(200);
    expect(login.json.mfa).toEqual({ required: false, enrolled: false });
    const aal1 = login.json.accessToken as string;
    // sensitive action refused without MFA
    expect(
      (
        await call(
          'POST',
          '/v1/admin/checkout/activate',
          { confirm: true, reason: 'abc', expectedVersion: 1 },
          aal1,
        )
      ).status,
    ).toBe(403);

    const enroll = await call('POST', '/v1/auth/mfa/enroll', undefined, aal1);
    expect(enroll.status).toBe(201);
    expect(enroll.json.otpauthUri).toMatch(/^otpauth:\/\/totp\//);
    // secret is encrypted at rest
    const stored = (await sup.query(`SELECT secret_enc FROM auth.admin_totp WHERE user_id = $1`, [uid]))
      .rows[0].secret_enc as string;
    expect(stored).not.toContain(enroll.json.secret);

    expect((await call('POST', '/v1/auth/mfa/verify', { code: '000000' }, aal1)).status).toBe(401);
    const good = code(enroll.json.secret);
    const up = await call('POST', '/v1/auth/mfa/verify', { code: good }, aal1);
    expect(up.status).toBe(200);
    expect(up.json.aal).toBe('aal2');
    expect((await call('GET', '/v1/admin/me', undefined, up.json.accessToken)).json.mfa).toBe(true);
    // replay of the same code is rejected
    expect((await call('POST', '/v1/auth/mfa/verify', { code: good }, aal1)).status).toBe(401);

    // next login now REQUIRES MFA, and a refresh keeps aal2 for that session
    const again = await call('POST', '/v1/auth/login', { email: e, password: PW, client: 'admin' });
    expect(again.json.mfa).toEqual({ required: true, enrolled: true });
    const rotated = await call('POST', '/v1/auth/refresh', { refreshToken: login.json.refreshToken });
    expect(rotated.json.aal).toBe('aal2');
  });

  it('a revoked session stops working on admin routes immediately', async () => {
    const e = email();
    const reg = await call('POST', '/v1/auth/register', { email: e, password: PW, fullName: 'Owner' });
    await sup.query(`INSERT INTO admin_users (user_id, role) VALUES ($1,'admin')`, [reg.json.user.id]);
    const login = await call('POST', '/v1/auth/login', { email: e, password: PW, client: 'admin' });
    expect((await call('GET', '/v1/admin/me', undefined, login.json.accessToken)).status).toBe(200);
    await call('POST', '/v1/auth/logout', { refreshToken: login.json.refreshToken });
    expect((await call('GET', '/v1/admin/me', undefined, login.json.accessToken)).status).toBe(401);
  });
});

describe('account export and deletion', () => {
  it('export contains the customer’s own data only; deletion erases personal data but keeps the financial record', async () => {
    const e = email();
    const reg = await call('POST', '/v1/auth/register', { email: e, password: PW, fullName: 'Delete Me' });
    const t = reg.json.accessToken as string;
    await call(
      'POST',
      '/v1/addresses',
      {
        recipientName: 'Delete Me',
        phone: '9999999999',
        line1: '9 Lane',
        city: 'Pune',
        state: 'Maharashtra',
        postalCode: '411001',
        isDefault: true,
      },
      t,
    );
    await fx.setStock('twinkle-shine-leather-polish', 5);
    await fx.openStore();
    await call('PUT', '/v1/cart/lines/twinkle-shine-leather-polish', { quantity: 1 }, t);
    const ex = await call('GET', '/v1/auth/account/export', undefined, t);
    expect(ex.status).toBe(200);
    expect(ex.json.account.email).toBe(e);
    expect(ex.json.addresses).toHaveLength(1);
    expect(JSON.stringify(ex.json)).not.toMatch(/password_hash|scrypt/);

    // place and deliver an order so there is a financial record to retain
    const a = (await call('GET', '/v1/addresses', undefined, t)).json.items[0];
    const q = await call('POST', '/v1/checkout/quotes', { addressId: a.id, paymentMethod: 'cod' }, t);
    const o = await fetch(`${base}/v1/orders`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${t}`,
        'content-type': 'application/json',
        'idempotency-key': 'idem-delete-test-1',
      },
      body: JSON.stringify({ quoteId: q.json.id }),
    });
    const order = await o.json();
    expect((await call('POST', '/v1/auth/account/delete', { password: PW }, t)).status).toBe(409); // order still in progress
    await sup.query(`UPDATE orders SET status = 'confirmed' WHERE id = $1`, [order.id]);
    await sup.query(`UPDATE orders SET status = 'processing' WHERE id = $1`, [order.id]);
    await sup.query(`UPDATE orders SET status = 'shipped' WHERE id = $1`, [order.id]);
    await sup.query(`UPDATE orders SET status = 'delivered' WHERE id = $1`, [order.id]);

    expect((await call('POST', '/v1/auth/account/delete', { password: 'wrong-password-1' }, t)).status).toBe(
      401,
    );
    expect((await call('POST', '/v1/auth/account/delete', { password: PW }, t)).status).toBe(204);
    const u = (
      await sup.query(`SELECT email, status, password_hash FROM auth.users WHERE id = $1`, [reg.json.user.id])
    ).rows[0];
    expect(u.status).toBe('deleted');
    expect(u.email).toMatch(/^deleted\+/);
    expect(u.password_hash).toBeNull();
    expect(
      (await sup.query(`SELECT count(*)::int n FROM addresses WHERE user_id = $1`, [reg.json.user.id]))
        .rows[0].n,
    ).toBe(0);
    // financial record intact, with its immutable address snapshot
    const kept = (
      await sup.query(`SELECT total_paise, address_snapshot FROM orders WHERE id = $1`, [order.id])
    ).rows[0];
    expect(kept.total_paise).toBeGreaterThan(0);
    expect(kept.address_snapshot.pin).toBe('411001');
    expect((await call('POST', '/v1/auth/login', { email: e, password: PW })).status).toBe(401);
  });
});
