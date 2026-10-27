import 'server-only';
import { EncryptJWT, jwtDecrypt, decodeJwt } from 'jose';
import { cookies } from 'next/headers';

/**
 * Browser session = ONE encrypted, HTTP-only, SameSite=Strict cookie holding the provider access token.
 * Privileged tokens never reach client JavaScript or browser storage. The cookie is only a courier:
 * the Express API re-verifies the token and re-checks permissions on every call.
 */
const COOKIE = 'jw_admin_session';
const MAX_AGE_S = 8 * 60 * 60;

export interface Session {
  accessToken: string;
  refreshToken: string;
  email: string;
  /** access-token expiry, epoch seconds (informational; the API is authoritative) */
  exp: number;
}

function key(): Uint8Array {
  const raw = process.env.ADMIN_SESSION_SECRET;
  if (!raw || raw.length < 32) throw new Error('ADMIN_SESSION_SECRET must be set (>= 32 chars)');
  return new TextEncoder().encode(raw.slice(0, 32).padEnd(32, '0'));
}

export async function writeSession(s: Session): Promise<void> {
  const jwe = await new EncryptJWT({ ...s })
    .setProtectedHeader({ alg: 'dir', enc: 'A256GCM' })
    .setIssuedAt()
    .setExpirationTime(`${MAX_AGE_S}s`)
    .encrypt(key());
  (await cookies()).set(COOKIE, jwe, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: '/',
    maxAge: MAX_AGE_S,
  });
}

export async function readSession(opts: { allowExpired?: boolean } = {}): Promise<Session | null> {
  const raw = (await cookies()).get(COOKIE)?.value;
  if (!raw) return null;
  try {
    const { payload } = await jwtDecrypt(raw, key());
    const s = payload as unknown as Session;
    if (!s.accessToken) return null;
    // Provider tokens are short-lived; an expired one means "sign in again".
    const exp = s.exp ?? decodeJwt(s.accessToken).exp ?? 0;
    if (exp * 1000 < Date.now() && !opts.allowExpired) return null;
    return { ...s, exp };
  } catch {
    return null;
  }
}

export async function clearSession(): Promise<void> {
  (await cookies()).delete(COOKIE);
}
