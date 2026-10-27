import type { Db } from '@jw/database';
import { issueSession } from '@jw/commerce-domain';
import type { TokenService } from '../../src/auth.ts';

/** Creates a REAL session row (as /auth/login would) and returns a signed access token for it. */
export async function mintFor(
  db: Db,
  tokens: TokenService,
  userId: string,
  opts: { aal?: 'aal1' | 'aal2'; client?: 'app' | 'admin' } = {},
): Promise<string> {
  const client = opts.client ?? 'app';
  const aal = opts.aal ?? 'aal1';
  const s = await db.tx({ kind: 'anonymous' }, (c) => issueSession(c, userId, client, aal));
  return (await tokens.sign({ userId, sid: s.familyId, aal, client })).accessToken;
}

import { generateKeyPairSync, randomUUID, type KeyObject } from 'node:crypto';
import { SignJWT } from 'jose';

const pair = generateKeyPairSync('ed25519');
export const TEST_PRIVATE_PEM = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
export const TEST_TOTP_KEY = Buffer.alloc(32, 7).toString('base64');

export const testEnv = (over: Record<string, string> = {}) =>
  ({
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://x:y@127.0.0.1:1/z',
    AUTH_SIGNING_PRIVATE_KEY: TEST_PRIVATE_PEM,
    AUTH_TOTP_ENC_KEY: TEST_TOTP_KEY,
    FEATURE_CHECKOUT: 'true',
    FEATURE_COD: 'true',
    FEATURE_ONLINE_PAYMENTS: 'true',
    PAYMENT_PROVIDER: 'test',
    ...over,
  }) as NodeJS.ProcessEnv;

/** Hand-crafts a token so tests can prove bad ones are rejected (wrong key/audience/issuer/expiry). */
export async function forge(o: {
  sub: string;
  sid?: string;
  aud?: string;
  iss?: string;
  exp?: string;
  otherKey?: boolean;
  aal?: string;
}): Promise<string> {
  const key: KeyObject = o.otherKey ? generateKeyPairSync('ed25519').privateKey : pair.privateKey;
  return new SignJWT({ role: 'authenticated', aal: o.aal ?? 'aal1', sid: o.sid ?? randomUUID() })
    .setProtectedHeader({ alg: 'EdDSA', kid: 'k1' })
    .setSubject(o.sub)
    .setIssuer(o.iss ?? 'jimmywax')
    .setAudience(o.aud ?? 'jimmywax-api')
    .setIssuedAt()
    .setExpirationTime(o.exp ?? '10m')
    .sign(key);
}
