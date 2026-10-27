import 'server-only';

/** Sign-in against OUR OWN identity API (POST /v1/auth/*). No third-party identity provider is involved. */
export interface Tokens {
  accessToken: string;
  refreshToken: string;
  /** access-token expiry, epoch seconds */
  exp: number;
}
export interface LoginResult extends Tokens {
  email: string;
  mfa: { required: boolean; enrolled: boolean };
}

const BASE = () => process.env.COMMERCE_API_URL ?? 'http://127.0.0.1:4000';

async function post(path: string, body: unknown, token?: string) {
  const res = await fetch(`${BASE()}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
    cache: 'no-store',
    signal: AbortSignal.timeout(10_000),
  });
  const text = await res.text();
  return { status: res.status, ok: res.ok, json: text ? JSON.parse(text) : null };
}

const toTokens = (
  j: { accessToken: string; refreshToken?: string; expiresIn: number },
  fallbackRefresh = '',
): Tokens => ({
  accessToken: j.accessToken,
  refreshToken: j.refreshToken ?? fallbackRefresh,
  exp: Math.floor(Date.now() / 1000) + j.expiresIn,
});

export async function apiLogin(email: string, password: string): Promise<LoginResult> {
  const r = await post('/v1/auth/login', { email, password, client: 'admin' });
  if (!r.ok)
    throw new Error(
      r.status === 429
        ? 'Too many attempts. Try again in a few minutes.'
        : r.status === 403
          ? 'This account has no operator role.'
          : 'Email or password is incorrect.',
    );
  return { ...toTokens(r.json), email: r.json.user.email, mfa: r.json.mfa };
}

export async function apiVerifyMfa(accessToken: string, refreshToken: string, code: string): Promise<Tokens> {
  const r = await post('/v1/auth/mfa/verify', { code }, accessToken);
  if (!r.ok) throw new Error('That authentication code is not valid.');
  return toTokens(r.json, refreshToken);
}

export async function apiEnrollMfa(accessToken: string): Promise<{ secret: string; otpauthUri: string }> {
  const r = await post('/v1/auth/mfa/enroll', {}, accessToken);
  if (!r.ok) throw new Error(r.json?.error?.message ?? 'Could not start MFA enrolment.');
  return r.json;
}

export async function apiRefresh(refreshToken: string): Promise<Tokens | null> {
  const r = await post('/v1/auth/refresh', { refreshToken });
  return r.ok ? toTokens(r.json) : null;
}

export async function apiLogout(refreshToken: string): Promise<void> {
  await post('/v1/auth/logout', { refreshToken }).catch(() => undefined);
}
