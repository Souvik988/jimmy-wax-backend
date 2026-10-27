import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  randomInt,
  randomUUID,
  scrypt as scryptCb,
  timingSafeEqual,
} from 'node:crypto';
import { promisify } from 'node:util';
import type { PoolClient } from '@jw/database';
import { AppError } from '@jw/contracts';

const scrypt = promisify(scryptCb) as (
  pw: string,
  salt: Buffer,
  len: number,
  opts: object,
) => Promise<Buffer>;

// ----------------------------------------------------------------- passwords
const N = 16384;
const R = 8;
const P = 1;
const COMMON = new Set([
  'password123',
  'password1234',
  '1234567890',
  'qwertyuiop',
  'iloveyou123',
  'welcome1234',
  'letmein1234',
  'admin12345',
  'changeme123',
]);

export function validatePassword(pw: string, email?: string): void {
  const fields: Record<string, string> = {};
  if (pw.length < 10) fields.password = 'Use at least 10 characters';
  else if (pw.length > 128) fields.password = 'Use at most 128 characters';
  else if (COMMON.has(pw.toLowerCase())) fields.password = 'This password is too common';
  else if (
    email &&
    pw.toLowerCase().includes(email.split('@')[0]!.toLowerCase()) &&
    email.split('@')[0]!.length >= 4
  ) {
    fields.password = 'Password must not contain your email name';
  }
  if (Object.keys(fields).length)
    throw new AppError('VALIDATION_FAILED', 'Choose a stronger password', { fields });
}

export async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(pw, salt, 32, { N, r: R, p: P, maxmem: 64 * 1024 * 1024 });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(pw: string, stored: string | null): Promise<boolean> {
  // Always burn the same work, even for unknown users, so response time does not reveal account existence.
  const parts = (stored ?? DUMMY).split('$');
  const [, n, r, p, salt, hash] = parts;
  const key = await scrypt(pw, Buffer.from(salt!, 'base64'), 32, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    maxmem: 64 * 1024 * 1024,
  });
  const ok = timingSafeEqual(key, Buffer.from(hash!, 'base64'));
  return stored !== null && ok;
}
const DUMMY = `scrypt$${N}$${R}$${P}$${Buffer.alloc(16).toString('base64')}$${Buffer.alloc(32).toString('base64')}`;

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
export const normaliseEmail = (e: string) => e.trim().toLowerCase();

// -------------------------------------------------------------------- users
export interface UserRow {
  id: string;
  email: string;
  phone: string | null;
  password_hash: string | null;
  status: string;
  email_verified_at: Date | null;
  locked_until: Date | null;
  failed_logins: number;
}

export async function registerUser(
  c: PoolClient,
  input: { email: string; password: string; fullName: string },
): Promise<{ id: string; verifyToken: string }> {
  const email = normaliseEmail(input.email);
  validatePassword(input.password, email);
  const exists = await c.query(`SELECT 1 FROM auth.users WHERE lower(email) = $1`, [email]);
  if (exists.rowCount) {
    throw new AppError('VALIDATION_FAILED', 'An account with this email already exists', {
      fields: { email: 'already registered' },
    });
  }
  const hash = await hashPassword(input.password);
  // The profile + notification-preference rows are created by the on_auth_user_created trigger.
  const u = await c.query(
    `INSERT INTO auth.users (email, password_hash, raw_user_meta_data) VALUES ($1,$2,$3) RETURNING id`,
    [email, hash, JSON.stringify({ full_name: input.fullName.trim() })],
  );
  const id = u.rows[0].id as string;
  const verifyToken = await createOneTimeToken(c, id, 'email_verify', 48 * 3600);
  return { id, verifyToken };
}

const MAX_FAILS = 5;
const LOCK_MINUTES = 15;

/**
 * Returns a result instead of throwing on bad credentials: the failed-attempt counter / lockout must be COMMITTED,
 * and a thrown error would roll the transaction back. The route throws `error` after the commit.
 */
export type AuthResult = { ok: true; user: UserRow } | { ok: false; error: AppError };
export async function authenticate(c: PoolClient, emailRaw: string, password: string): Promise<AuthResult> {
  const email = normaliseEmail(emailRaw);
  const r = await c.query<UserRow>(`SELECT * FROM auth.users WHERE lower(email) = $1 FOR UPDATE`, [email]);
  const u = r.rows[0] ?? null;
  const locked = u?.locked_until && u.locked_until.getTime() > Date.now();
  const ok = await verifyPassword(password, locked ? null : (u?.password_hash ?? null));
  const generic = new AppError('UNAUTHENTICATED', 'Email or password is incorrect');
  if (!u) return { ok: false, error: generic };
  if (locked)
    return {
      ok: false,
      error: new AppError('RATE_LIMITED', 'Too many attempts. Try again in a few minutes.'),
    };
  if (u.status !== 'active') return { ok: false, error: generic };
  if (!ok) {
    const fails = u.failed_logins + 1;
    const lock = fails >= MAX_FAILS;
    await c.query(
      `UPDATE auth.users SET failed_logins = $2::int,
              locked_until = CASE WHEN $3::boolean THEN now() + make_interval(mins => $4::int) ELSE locked_until END,
              updated_at = now() WHERE id = $1`,
      [u.id, lock ? 0 : fails, lock, LOCK_MINUTES],
    );
    return { ok: false, error: generic };
  }
  await c.query(
    `UPDATE auth.users SET failed_logins = 0, locked_until = NULL, last_login_at = now(), updated_at = now() WHERE id = $1`,
    [u.id],
  );
  return { ok: true, user: u };
}

// ---------------------------------------------------------------- sessions
const SESSION_TTL_S = { app: 30 * 24 * 3600, admin: 8 * 3600 } as const;

export async function issueSession(
  c: PoolClient,
  userId: string,
  client: 'app' | 'admin',
  aal: 'aal1' | 'aal2' = 'aal1',
  familyId: string = randomUUID(),
) {
  const raw = randomBytes(32).toString('base64url');
  await c.query(
    `INSERT INTO auth.refresh_tokens (user_id, family_id, token_hash, client, aal, expires_at)
     VALUES ($1,$2,$3,$4,$5, now() + make_interval(secs => $6))`,
    [userId, familyId, sha(raw), client, aal, SESSION_TTL_S[client]],
  );
  return { refreshToken: raw, familyId, aal };
}

export interface RotatedSession {
  userId: string;
  familyId: string;
  client: 'app' | 'admin';
  aal: 'aal1' | 'aal2';
  refreshToken: string;
}

/** Rotating refresh tokens with reuse detection: replaying a rotated token revokes the whole family. */
export type RotateResult = { ok: true; session: RotatedSession } | { ok: false; error: AppError };
export async function rotateRefresh(c: PoolClient, rawToken: string): Promise<RotateResult> {
  const r = await c.query(`SELECT * FROM auth.refresh_tokens WHERE token_hash = $1 FOR UPDATE`, [
    sha(rawToken),
  ]);
  const t = r.rows[0];
  const bad = new AppError('UNAUTHENTICATED', 'Sign in again to continue');
  if (!t) return { ok: false, error: bad };
  if (t.revoked_at) {
    await c.query(
      `UPDATE auth.refresh_tokens SET revoked_at = coalesce(revoked_at, now()) WHERE family_id = $1`,
      [t.family_id],
    );
    return { ok: false, error: bad }; // family revoked; committed by the caller
  }
  if (new Date(t.expires_at).getTime() <= Date.now()) return { ok: false, error: bad };
  const u = await c.query(`SELECT status FROM auth.users WHERE id = $1`, [t.user_id]);
  if (u.rows[0]?.status !== 'active') return { ok: false, error: bad };
  const next = await issueSession(c, t.user_id, t.client, t.aal, t.family_id);
  // Keep the ORIGINAL absolute expiry so rotation cannot extend a session forever.
  await c.query(`UPDATE auth.refresh_tokens SET expires_at = $2 WHERE token_hash = $1`, [
    sha(next.refreshToken),
    t.expires_at,
  ]);
  await c.query(
    `UPDATE auth.refresh_tokens SET revoked_at = now(), replaced_by = (SELECT id FROM auth.refresh_tokens WHERE token_hash = $2) WHERE id = $1`,
    [t.id, sha(next.refreshToken)],
  );
  return {
    ok: true,
    session: {
      userId: t.user_id,
      familyId: t.family_id,
      client: t.client,
      aal: t.aal,
      refreshToken: next.refreshToken,
    },
  };
}

export async function revokeFamily(c: PoolClient, familyId: string) {
  await c.query(
    `UPDATE auth.refresh_tokens SET revoked_at = coalesce(revoked_at, now()) WHERE family_id = $1`,
    [familyId],
  );
}
export async function revokeAllSessions(c: PoolClient, userId: string, exceptFamily?: string) {
  await c.query(
    `UPDATE auth.refresh_tokens SET revoked_at = coalesce(revoked_at, now()) WHERE user_id = $1 AND ($2::uuid IS NULL OR family_id <> $2)`,
    [userId, exceptFamily ?? null],
  );
}
export async function upgradeFamilyToAal2(c: PoolClient, familyId: string) {
  await c.query(`UPDATE auth.refresh_tokens SET aal = 'aal2' WHERE family_id = $1 AND revoked_at IS NULL`, [
    familyId,
  ]);
}
export async function sessionIsLive(c: PoolClient, familyId: string): Promise<boolean> {
  const r = await c.query(
    `SELECT 1 FROM auth.refresh_tokens WHERE family_id = $1 AND revoked_at IS NULL AND expires_at > now() LIMIT 1`,
    [familyId],
  );
  return (r.rowCount ?? 0) > 0;
}

// -------------------------------------------------------- one-time tokens
export async function createOneTimeToken(
  c: PoolClient,
  userId: string,
  purpose: 'password_reset' | 'email_verify',
  ttlSeconds: number,
): Promise<string> {
  const raw = randomBytes(32).toString('base64url');
  await c.query(`DELETE FROM auth.one_time_tokens WHERE user_id = $1 AND purpose = $2`, [userId, purpose]);
  await c.query(
    `INSERT INTO auth.one_time_tokens (token_hash, user_id, purpose, expires_at) VALUES ($1,$2,$3, now() + make_interval(secs => $4))`,
    [sha(raw), userId, purpose, ttlSeconds],
  );
  return raw;
}
export async function consumeOneTimeToken(
  c: PoolClient,
  raw: string,
  purpose: 'password_reset' | 'email_verify',
): Promise<string> {
  const r = await c.query(
    `UPDATE auth.one_time_tokens SET used_at = now() WHERE token_hash = $1 AND purpose = $2 AND used_at IS NULL AND expires_at > now() RETURNING user_id`,
    [sha(raw), purpose],
  );
  if (r.rowCount === 0) throw new AppError('VALIDATION_FAILED', 'This link is invalid or has expired');
  return r.rows[0].user_id as string;
}

export async function setPassword(c: PoolClient, userId: string, password: string, email: string) {
  validatePassword(password, email);
  await c.query(
    `UPDATE auth.users SET password_hash = $2, failed_logins = 0, locked_until = NULL, updated_at = now() WHERE id = $1`,
    [userId, await hashPassword(password)],
  );
}

// --------------------------------------------------------------------- TOTP
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of buf) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
export function base32Decode(s: string): Buffer {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of s.replace(/=+$/, '').toUpperCase()) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new Error('bad base32');
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}
/** RFC 4226 HOTP / RFC 6238 TOTP (SHA-1, 6 digits, 30 s). */
export function hotp(secret: Buffer, counter: number): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = createHmac('sha1', secret).update(msg).digest();
  const o = h[h.length - 1]! & 15;
  const code = ((h[o]! & 0x7f) << 24) | (h[o + 1]! << 16) | (h[o + 2]! << 8) | h[o + 3]!;
  return String(code % 1_000_000).padStart(6, '0');
}
/** Returns the matching counter (±1 step) or null. */
export function matchTotp(secret: Buffer, code: string, nowMs = Date.now()): number | null {
  const step = Math.floor(nowMs / 30000);
  for (const d of [0, -1, 1]) {
    const expected = hotp(secret, step + d);
    if (expected.length === code.length && timingSafeEqual(Buffer.from(expected), Buffer.from(code)))
      return step + d;
  }
  return null;
}

const encKey = (k: string) => {
  const b = Buffer.from(k, 'base64');
  if (b.length !== 32) throw new Error('AUTH_TOTP_ENC_KEY must be 32 bytes, base64');
  return b;
};
export function encryptSecret(secret: Buffer, key: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', encKey(key), iv);
  const enc = Buffer.concat([c.update(secret), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64');
}
export function decryptSecret(blob: string, key: string): Buffer {
  const b = Buffer.from(blob, 'base64');
  const d = createDecipheriv('aes-256-gcm', encKey(key), b.subarray(0, 12));
  d.setAuthTag(b.subarray(12, 28));
  return Buffer.concat([d.update(b.subarray(28)), d.final()]);
}

export async function beginTotpEnrollment(
  c: PoolClient,
  userId: string,
  email: string,
  key: string,
  issuer = 'JIMMY WAX Admin',
) {
  const secret = randomBytes(20);
  await c.query(
    `INSERT INTO auth.admin_totp (user_id, secret_enc) VALUES ($1,$2)
     ON CONFLICT (user_id) DO UPDATE SET secret_enc = excluded.secret_enc, verified_at = NULL, last_counter = 0
     WHERE auth.admin_totp.verified_at IS NULL`,
    [userId, encryptSecret(secret, key)],
  );
  const stored = await c.query(`SELECT verified_at FROM auth.admin_totp WHERE user_id = $1`, [userId]);
  if (stored.rows[0]?.verified_at)
    throw new AppError('ILLEGAL_STATE', 'MFA is already enabled for this account');
  const b32 = base32Encode(secret);
  return {
    secret: b32,
    otpauthUri: `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(email)}?secret=${b32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`,
  };
}

/** Verifies a code, rejecting replays of an already-used time step. Activates the factor on first success. */
export async function checkTotp(c: PoolClient, userId: string, code: string, key: string): Promise<boolean> {
  const r = await c.query(`SELECT * FROM auth.admin_totp WHERE user_id = $1 FOR UPDATE`, [userId]);
  const t = r.rows[0];
  if (!t || !/^\d{6}$/.test(code)) return false;
  const counter = matchTotp(decryptSecret(t.secret_enc, key), code);
  if (counter === null || counter <= Number(t.last_counter)) return false;
  await c.query(
    `UPDATE auth.admin_totp SET last_counter = $2, verified_at = coalesce(verified_at, now()) WHERE user_id = $1`,
    [userId, counter],
  );
  return true;
}
export async function hasVerifiedTotp(c: PoolClient, userId: string): Promise<boolean> {
  const r = await c.query(`SELECT 1 FROM auth.admin_totp WHERE user_id = $1 AND verified_at IS NOT NULL`, [
    userId,
  ]);
  return (r.rowCount ?? 0) > 0;
}

// --------------------------------------------------------- account lifecycle
export async function exportAccount(c: PoolClient, userId: string) {
  const q = async (sql: string) => (await c.query(sql, [userId])).rows;
  return {
    exportedAt: new Date().toISOString(),
    account: (await q(`SELECT id, email, email_verified_at, created_at FROM auth.users WHERE id = $1`))[0],
    profile: (await q(`SELECT full_name, phone, created_at FROM profiles WHERE id = $1`))[0] ?? null,
    addresses: await q(
      `SELECT recipient_name, phone, line1, landmark, city, state, postal_code, is_default, created_at FROM addresses WHERE user_id = $1`,
    ),
    orders: await q(
      `SELECT order_number, status, payment_status, payment_method, subtotal_paise, shipping_paise, cod_fee_paise, tax_paise, total_paise, address_snapshot, created_at FROM orders WHERE user_id = $1 ORDER BY created_at`,
    ),
    orderItems: await q(
      `SELECT o.order_number, i.sku, i.product_name, i.variant_title, i.unit_price_paise, i.quantity, i.line_total_paise FROM order_items i JOIN orders o ON o.id = i.order_id WHERE o.user_id = $1 ORDER BY o.created_at, i.id`,
    ),
    wishlist: await q(`SELECT product_id, created_at FROM wishlist_items WHERE user_id = $1`),
    reviews: await q(
      `SELECT product_id, rating, title, body, status, created_at FROM reviews WHERE user_id = $1`,
    ),
    notificationPreferences:
      (
        await q(`SELECT order_updates, offers_and_care_tips FROM notification_preferences WHERE user_id = $1`)
      )[0] ?? null,
    devices: await q(`SELECT platform, created_at FROM device_tokens WHERE user_id = $1`),
  };
}

/**
 * Deletion = erase personal data, KEEP the financial record. Orders (and their immutable address snapshot) are
 * retained because Indian tax/accounting law requires it; the login, profile, saved addresses, wishlist, devices,
 * reviews and sessions are removed. Retention period is a merchant/CA decision (OWNER_INPUTS #12).
 */
export async function deleteAccount(c: PoolClient, userId: string, password: string) {
  const r = await c.query<UserRow>(`SELECT * FROM auth.users WHERE id = $1 FOR UPDATE`, [userId]);
  const u = r.rows[0];
  if (!u || !(await verifyPassword(password, u.password_hash)))
    throw new AppError('UNAUTHENTICATED', 'Password is incorrect');
  await eraseAccount(c, userId);
}

/** The OTP is bound to the authenticated account's phone, never a body-supplied phone. Failed attempts must commit. */
export async function deleteAccountWithOtp(c: PoolClient, userId: string, code: string): Promise<OtpCheck> {
  const user = (await c.query(`SELECT phone, status FROM auth.users WHERE id=$1 FOR UPDATE`, [userId]))
    .rows[0];
  if (!user?.phone || user.status !== 'active')
    return {
      ok: false,
      error: new AppError('UNAUTHENTICATED', 'Use your account password to confirm deletion'),
    };
  const check = await checkPhoneOtp(c, user.phone, code);
  if (!check.ok) return check;
  await eraseAccount(c, userId);
  return { ok: true };
}

async function eraseAccount(c: PoolClient, userId: string) {
  const open = await c.query(
    `SELECT 1 FROM orders WHERE user_id = $1 AND status IN ('pending_payment','placed','confirmed','processing','shipped','out_for_delivery') LIMIT 1`,
    [userId],
  );
  if (open.rowCount)
    throw new AppError(
      'ILLEGAL_STATE',
      'You have orders in progress. Deletion is possible after they are delivered or cancelled.',
    );
  await c.query(`DELETE FROM addresses WHERE user_id = $1`, [userId]);
  await c.query(`DELETE FROM wishlist_items WHERE user_id = $1`, [userId]);
  await c.query(`DELETE FROM device_tokens WHERE user_id = $1`, [userId]);
  await c.query(`DELETE FROM cart_lines WHERE cart_id IN (SELECT id FROM carts WHERE user_id = $1)`, [
    userId,
  ]);
  await c.query(`DELETE FROM checkout_quotes WHERE user_id = $1 AND consumed_order_id IS NULL`, [userId]);
  await c.query(`DELETE FROM notifications WHERE user_id = $1`, [userId]);
  await c.query(`DELETE FROM reviews WHERE user_id = $1`, [userId]);
  await c.query(`UPDATE profiles SET full_name = '', phone = NULL WHERE id = $1`, [userId]);
  await c.query(`DELETE FROM auth.refresh_tokens WHERE user_id = $1`, [userId]);
  await c.query(`DELETE FROM auth.one_time_tokens WHERE user_id = $1`, [userId]);
  await c.query(`DELETE FROM auth.admin_totp WHERE user_id = $1`, [userId]);
  await c.query(
    `UPDATE auth.users SET email = 'deleted+' || id::text || '@invalid.local', password_hash = NULL, phone = NULL, status = 'deleted',
            raw_user_meta_data = '{}', updated_at = now() WHERE id = $1`,
    [userId],
  );
}

// ---------------------------------------------------------- phone OTP sign-in
const OTP_TTL_S = 300;
const OTP_MAX_ATTEMPTS = 5;
const OTP_COOLDOWN_S = 30;
const OTP_HOURLY_MAX = 5;

/** Indian mobile numbers only: accepts "9800000001", "+919800000001", "91 98000 00001"; returns E.164. */
export function normalisePhone(raw: string): string {
  const digits = raw.replace(/[^\d]/g, '');
  const ten =
    digits.length === 12 && digits.startsWith('91') ? digits.slice(2) : digits.length === 10 ? digits : '';
  if (!/^[6-9]\d{9}$/.test(ten)) {
    throw new AppError('VALIDATION_FAILED', 'Enter a valid 10-digit Indian mobile number', {
      fields: { phone: 'invalid' },
    });
  }
  return `+91${ten}`;
}

const otpHash = (phone: string, code: string) =>
  createHash('sha256').update(`${phone}:${code}`).digest('hex');
export const maskPhoneE164 = (p: string) => `+91 ••••••${p.slice(-4)}`;

export type OtpIssue = { ok: true; code: string } | { ok: false; error: AppError };

/** Creates/refreshes the single live code for a phone with a 30 s resend cooldown and 5 sends/hour cap. */
export async function issuePhoneOtp(c: PoolClient, phone: string): Promise<OtpIssue> {
  const cur = (await c.query(`SELECT * FROM auth.phone_otps WHERE phone = $1 FOR UPDATE`, [phone])).rows[0];
  const now = Date.now();
  if (cur) {
    if (now - new Date(cur.last_sent_at).getTime() < OTP_COOLDOWN_S * 1000) {
      return {
        ok: false,
        error: new AppError('RATE_LIMITED', 'Please wait 30 seconds before requesting another code'),
      };
    }
    const inWindow = now - new Date(cur.window_started_at).getTime() < 3600_000;
    if (inWindow && cur.sent_in_window >= OTP_HOURLY_MAX) {
      return {
        ok: false,
        error: new AppError('RATE_LIMITED', 'Too many codes requested. Try again in an hour.'),
      };
    }
  }
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  const fresh = !cur || now - new Date(cur.window_started_at).getTime() >= 3600_000;
  await c.query(
    `INSERT INTO auth.phone_otps (phone, code_hash, expires_at) VALUES ($1,$2, now() + make_interval(secs => $3))
     ON CONFLICT (phone) DO UPDATE SET code_hash = $2, expires_at = now() + make_interval(secs => $3), attempts = 0,
       last_sent_at = now(),
       window_started_at = CASE WHEN $4::boolean THEN now() ELSE auth.phone_otps.window_started_at END,
       sent_in_window = CASE WHEN $4::boolean THEN 1 ELSE auth.phone_otps.sent_in_window + 1 END`,
    [phone, otpHash(phone, code), OTP_TTL_S, fresh],
  );
  return { ok: true, code };
}

export type OtpCheck = { ok: true } | { ok: false; error: AppError };

/** Bad guesses are COUNTED and committed (result, not throw): after 5 the code is burned. */
export async function checkPhoneOtp(c: PoolClient, phone: string, code: string): Promise<OtpCheck> {
  const row = (await c.query(`SELECT * FROM auth.phone_otps WHERE phone = $1 FOR UPDATE`, [phone])).rows[0];
  const invalid = { ok: false, error: new AppError('OTP_INVALID', 'That code is not correct') } as const;
  if (!row) return invalid;
  if (new Date(row.expires_at).getTime() <= Date.now()) {
    await c.query(`DELETE FROM auth.phone_otps WHERE phone = $1`, [phone]);
    return { ok: false, error: new AppError('OTP_EXPIRED', 'That code has expired. Request a new one.') };
  }
  if (row.attempts >= OTP_MAX_ATTEMPTS) return invalid;
  const good =
    /^\d{6}$/.test(code) && timingSafeEqual(Buffer.from(otpHash(phone, code)), Buffer.from(row.code_hash));
  if (!good) {
    await c.query(`UPDATE auth.phone_otps SET attempts = attempts + 1 WHERE phone = $1`, [phone]);
    return invalid;
  }
  await c.query(`DELETE FROM auth.phone_otps WHERE phone = $1`, [phone]); // single use
  return { ok: true };
}

/** Finds or creates the account for a verified phone. Disabled/deleted accounts cannot sign in. */
export async function userForPhone(c: PoolClient, phone: string, demo = false) {
  const existing = (
    await c.query(`SELECT id, email, status FROM auth.users WHERE phone = $1 FOR UPDATE`, [phone])
  ).rows[0];
  if (existing) {
    if (existing.status !== 'active') return null;
    await c.query(
      `UPDATE auth.users SET last_login_at = now(), email_verified_at = email_verified_at, updated_at = now() WHERE id = $1`,
      [existing.id],
    );
    return { id: existing.id as string, email: (existing.email as string | null) ?? null, phone };
  }
  const u = await c.query(
    `INSERT INTO auth.users (phone, is_demo, last_login_at) VALUES ($1,$2, now()) RETURNING id`,
    [phone, demo],
  );
  return { id: u.rows[0].id as string, email: null, phone };
}

export { timingSafeEqual as constantTimeEqual };
