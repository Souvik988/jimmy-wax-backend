import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  type KeyObject,
} from 'node:crypto';
import { SignJWT, jwtVerify, type JWTPayload } from 'jose';
import type { AppConfig } from '@jw/config';
import { AppError } from '@jw/contracts';

export interface Principal {
  userId: string;
  /** session (refresh-token family) id */
  sid: string;
  aal: 'aal1' | 'aal2';
  claims: JWTPayload;
}

export interface TokenService {
  sign(p: {
    userId: string;
    sid: string;
    aal: 'aal1' | 'aal2';
    client: 'app' | 'admin';
  }): Promise<{ accessToken: string; expiresIn: number }>;
  verify(token: string): Promise<Principal>;
  /** Public keys as JWKS-like PEM map (for external verifiers / rotation). */
  publicKeys(): Record<string, string>;
  /** AES key for TOTP secrets at rest (base64). */
  totpKey: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Identity uses Ed25519-signed JWTs. Verification pins the algorithm, issuer and audience, checks expiry,
 * and requires a UUID subject and session id. Nothing in a token (or any client-supplied claim) grants admin rights:
 * those come from the `admin_users` table. Key rotation: sign with the new key, keep the old public key listed in
 * AUTH_VERIFY_PUBLIC_KEYS until the longest access token (≤ 1 h) has expired.
 */
export function createTokenService(
  cfg: AppConfig,
  log?: { warn: (o: object, m: string) => void },
): TokenService {
  let privatePem = cfg.AUTH_SIGNING_PRIVATE_KEY?.replace(/\\n/g, '\n');
  if (!privatePem) {
    // Development only (production config validation requires a real key): ephemeral key, sessions die on restart.
    privatePem = generateKeyPairSync('ed25519')
      .privateKey.export({ type: 'pkcs8', format: 'pem' })
      .toString();
    log?.warn({}, 'AUTH_SIGNING_PRIVATE_KEY not set: using an EPHEMERAL dev signing key');
  }
  const priv: KeyObject = createPrivateKey(privatePem);
  const kid = cfg.AUTH_SIGNING_KID;
  const pubs: Record<string, KeyObject> = { [kid]: createPublicKey(priv) };
  const extra = cfg.AUTH_VERIFY_PUBLIC_KEYS
    ? (JSON.parse(cfg.AUTH_VERIFY_PUBLIC_KEYS) as Record<string, string>)
    : {};
  for (const [k, pem] of Object.entries(extra)) pubs[k] = createPublicKey(pem.replace(/\\n/g, '\n'));
  const totpKey = cfg.AUTH_TOTP_ENC_KEY ?? randomBytes(32).toString('base64');

  return {
    totpKey,
    publicKeys: () =>
      Object.fromEntries(
        Object.entries(pubs).map(([k, v]) => [k, v.export({ type: 'spki', format: 'pem' }).toString()]),
      ),
    async sign({ userId, sid, aal, client }) {
      const ttl = client === 'admin' ? cfg.AUTH_ADMIN_ACCESS_TTL_S : cfg.AUTH_ACCESS_TTL_S;
      const accessToken = await new SignJWT({ role: 'authenticated', aal, sid, client })
        .setProtectedHeader({ alg: 'EdDSA', kid })
        .setSubject(userId)
        .setIssuer(cfg.AUTH_ISSUER)
        .setAudience(cfg.AUTH_AUDIENCE)
        .setIssuedAt()
        .setExpirationTime(`${ttl}s`)
        .sign(priv);
      return { accessToken, expiresIn: ttl };
    },
    async verify(token) {
      try {
        const { payload } = await jwtVerify(
          token,
          async (header) => {
            const k = header.kid ? pubs[header.kid] : undefined;
            if (!k) throw new Error('unknown key id');
            return k;
          },
          { issuer: cfg.AUTH_ISSUER, audience: cfg.AUTH_AUDIENCE, algorithms: ['EdDSA'], clockTolerance: 5 },
        );
        const sid = payload.sid;
        if (
          typeof payload.sub !== 'string' ||
          !UUID.test(payload.sub) ||
          typeof sid !== 'string' ||
          !UUID.test(sid)
        ) {
          throw new Error('bad claims');
        }
        return { userId: payload.sub, sid, aal: payload.aal === 'aal2' ? 'aal2' : 'aal1', claims: payload };
      } catch {
        throw new AppError('UNAUTHENTICATED', 'Sign in again to continue');
      }
    },
  };
}
