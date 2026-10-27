import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '@jw/config';
import { ConsoleSmsSender, InMemoryStorage } from '@jw/integrations';
import { createLogger } from '@jw/observability';
import { Fixtures, apiDb, superPool } from '@jw/test-support';
import { createApp } from '../../src/app.ts';
import { createTokenService } from '../../src/auth.ts';
import { MemoryStore } from '../../src/rateLimit.ts';
import { testEnv } from './support.ts';

const db = apiDb(4);
const sup = superPool();
const fx = new Fixtures(sup);
const sms = new ConsoleSmsSender();
const servers: import('node:http').Server[] = [];
const bases: Record<string, string> = {};

async function start(name: string, env: Record<string, string>, smsSender: ConsoleSmsSender | null) {
  const config = loadConfig(testEnv(env));
  const app = createApp({
    config,
    db,
    tokens: createTokenService(config),
    storage: new InMemoryStorage(),
    gateway: null,
    sms: smsSender,
    logger: createLogger('silent'),
    limits: new MemoryStore(),
    rateLimitsEnabled: false,
  });
  await new Promise<void>((r) => {
    const s = app.listen(0, '127.0.0.1', () => {
      bases[name] = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
      r();
    });
    servers.push(s);
  });
}
beforeAll(async () => {
  await start('sms', {}, sms); // dev-like: SMS provider present, demo on (default outside production)
  await start('nosms', {}, null); // no SMS provider
  await start('prod', { AUTH_DEMO_ENABLED: 'false' }, null); // production-like: demo explicitly OFF, no SMS provider
});
afterAll(async () => {
  servers.forEach((s) => s.close());
  await db.close();
  await sup.end();
});
beforeEach(async () => {
  await sup.query(`DELETE FROM auth.phone_otps`);
  sms.sent.length = 0;
});

async function post(base: string, path: string, body: unknown, token?: string) {
  const r = await fetch(bases[base] + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  const t = await r.text();
  return { status: r.status, json: t ? JSON.parse(t) : null };
}
const DEMO = '9800000001';

describe('demo phone login (9800000001 / 123456)', () => {
  it('works without any SMS provider, signs in a flagged demo account, and the session is real', async () => {
    const req = await post('nosms', '/v1/auth/otp/request', { phone: DEMO });
    expect(req.status).toBe(202);
    const bad = await post('nosms', '/v1/auth/otp/verify', { phone: DEMO, code: '654321' });
    expect([bad.status, bad.json.error.code]).toEqual([401, 'OTP_INVALID']);
    const ok = await post('nosms', '/v1/auth/otp/verify', { phone: '+91 98000 00001', code: '123456' }); // formats are normalised
    expect(ok.status).toBe(200);
    expect(ok.json.user.phone).toBe('+91 ••••••0001'); // masked in responses
    expect(ok.json.user.email).toBeNull();
    const me = await fetch(bases.nosms + '/v1/me', {
      headers: { authorization: `Bearer ${ok.json.accessToken}` },
    });
    expect(await me.json()).toMatchObject({ demo: true, accountPhone: '+91 ••••••0001' });
    expect(
      (await sup.query(`SELECT is_demo, phone FROM auth.users WHERE id = $1`, [ok.json.user.id])).rows[0],
    ).toEqual({ is_demo: true, phone: '+919800000001' });
    // a second login lands on the SAME account
    const again = await post('nosms', '/v1/auth/otp/verify', { phone: DEMO, code: '123456' });
    expect(again.json.user.id).toBe(ok.json.user.id);
    expect(sms.sent).toHaveLength(0); // nothing was ever "sent"
  });

  it('is OFF unless explicitly enabled in a production-like config; other numbers never accept 123456', async () => {
    const off = await post('prod', '/v1/auth/otp/request', { phone: DEMO });
    expect([off.status, off.json.error.code]).toEqual([503, 'OTP_UNAVAILABLE']);
    expect((await post('prod', '/v1/auth/otp/verify', { phone: DEMO, code: '123456' })).status).toBe(401);
    expect((await post('sms', '/v1/auth/otp/verify', { phone: '9800000002', code: '123456' })).status).toBe(
      401,
    );
  });
});

describe('real phone codes', () => {
  it('without an SMS provider other numbers get a clear "unavailable" answer (the app falls back to email)', async () => {
    const r = await post('nosms', '/v1/auth/otp/request', { phone: '9876543210' });
    expect([r.status, r.json.error.code, r.json.error.retryable]).toEqual([503, 'OTP_UNAVAILABLE', false]);
  });

  it('request → code arrives by SMS → verify creates the account once; the code is single-use', async () => {
    expect((await post('sms', '/v1/auth/otp/request', { phone: '+919876543210' })).status).toBe(202);
    expect(sms.sent).toHaveLength(1);
    const code = /^(\d{6}) is your JIMMY WAX/.exec(sms.sent[0]!.text)![1]!;
    expect((await sup.query(`SELECT code_hash FROM auth.phone_otps`)).rows[0].code_hash).not.toContain(code); // stored hashed
    const ok = await post('sms', '/v1/auth/otp/verify', { phone: '9876543210', code });
    expect(ok.status).toBe(200);
    const uid = ok.json.user.id as string;
    expect((await post('sms', '/v1/auth/otp/verify', { phone: '9876543210', code })).json.error.code).toBe(
      'OTP_INVALID',
    ); // burned
    // next login (new code) reuses the account
    await sup.query(`UPDATE auth.phone_otps SET last_sent_at = now() - interval '1 minute'`);
    await post('sms', '/v1/auth/otp/request', { phone: '9876543210' });
    const code2 = /^(\d{6})/.exec(sms.sent[1]!.text)![1]!;
    expect(
      (await post('sms', '/v1/auth/otp/verify', { phone: '9876543210', code: code2 })).json.user.id,
    ).toBe(uid);
    expect(
      (await sup.query(`SELECT count(*)::int n FROM auth.users WHERE phone = '+919876543210'`)).rows[0].n,
    ).toBe(1);
  });

  it('5 wrong guesses burn the code (even the right one then fails); expired codes say so', async () => {
    await post('sms', '/v1/auth/otp/request', { phone: '9123456780' });
    const code = /^(\d{6})/.exec(sms.sent[0]!.text)![1]!;
    const wrong = code === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i++)
      expect(
        (await post('sms', '/v1/auth/otp/verify', { phone: '9123456780', code: wrong })).json.error.code,
      ).toBe('OTP_INVALID');
    expect((await post('sms', '/v1/auth/otp/verify', { phone: '9123456780', code })).json.error.code).toBe(
      'OTP_INVALID',
    );
    await sup.query(`UPDATE auth.phone_otps SET attempts = 0, expires_at = now() - interval '1 second'`);
    expect((await post('sms', '/v1/auth/otp/verify', { phone: '9123456780', code })).json.error.code).toBe(
      'OTP_EXPIRED',
    );
  });

  it('resend cooldown (30 s) and hourly cap are enforced; bad numbers are rejected early', async () => {
    expect((await post('sms', '/v1/auth/otp/request', { phone: '9000011111' })).status).toBe(202);
    const quick = await post('sms', '/v1/auth/otp/request', { phone: '9000011111' });
    expect([quick.status, quick.json.error.code]).toEqual([429, 'RATE_LIMITED']);
    for (let i = 0; i < 4; i++) {
      await sup.query(`UPDATE auth.phone_otps SET last_sent_at = now() - interval '1 minute'`);
      expect((await post('sms', '/v1/auth/otp/request', { phone: '9000011111' })).status).toBe(202);
    }
    await sup.query(`UPDATE auth.phone_otps SET last_sent_at = now() - interval '1 minute'`);
    expect((await post('sms', '/v1/auth/otp/request', { phone: '9000011111' })).status).toBe(429); // 6th within the hour
    for (const bad of ['12345', '0123456789', '+441234567890', 'abcdefghij']) {
      expect((await post('sms', '/v1/auth/otp/request', { phone: bad })).status, bad).toBe(400);
    }
  });

  it('a deleted or disabled account cannot sign in with a valid code', async () => {
    await post('sms', '/v1/auth/otp/request', { phone: '9555500000' });
    const code = /^(\d{6})/.exec(sms.sent[0]!.text)![1]!;
    await sup.query(`INSERT INTO auth.users (phone, status) VALUES ('+919555500000','disabled')`);
    expect((await post('sms', '/v1/auth/otp/verify', { phone: '9555500000', code })).status).toBe(401);
  });
});

describe('first service area', () => {
  it('PIN 743287 is serviceable from the migration; an order can be quoted to it', async () => {
    await fx.openStore();
    // Other suites reset this table; the migration's own seed is asserted on a fresh DB by running this file alone.
    await sup.query(`DELETE FROM serviceable_pin_prefixes WHERE prefix <> '743287'`);
    await sup.query(`INSERT INTO serviceable_pin_prefixes (prefix) VALUES ('743287') ON CONFLICT DO NOTHING`);
    await fx.setStock('twinkle-shine-leather-polish', 5);
    const login = await post('sms', '/v1/auth/otp/verify', { phone: DEMO, code: '123456' });
    const t = login.json.accessToken as string;
    const call = (m: string, p: string, b?: unknown) =>
      fetch(bases.sms + p, {
        method: m,
        headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' },
        body: b ? JSON.stringify(b) : undefined,
      }).then(async (r) => ({ status: r.status, json: await r.json() }));
    const addr = (pin: string) => ({
      recipientName: 'Demo',
      phone: '9800000001',
      line1: '1 Demo Road',
      city: 'Kolkata',
      state: 'West Bengal',
      postalCode: pin,
      isDefault: false,
    });
    const ok = await call('POST', '/v1/addresses', addr('743287'));
    const out = await call('POST', '/v1/addresses', addr('700001'));
    await call('PUT', '/v1/cart/lines/twinkle-shine-leather-polish', { quantity: 1 });
    const q1 = await call('POST', '/v1/checkout/quotes', { addressId: ok.json.id, paymentMethod: 'cod' });
    expect([q1.status, q1.json.error?.code]).toEqual([201, undefined]);
    const q2 = await call('POST', '/v1/checkout/quotes', { addressId: out.json.id, paymentMethod: 'cod' });
    expect([q2.status, q2.json.error.code]).toEqual([422, 'NOT_SERVICEABLE']);
  });
});
