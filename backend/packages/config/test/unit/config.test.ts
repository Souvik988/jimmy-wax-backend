import { describe, expect, it } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { loadConfig, productionProblems } from '../../src/index.ts';

const pem = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
/** A configuration that is valid for production; each test breaks exactly one thing. */
const good = (over: Record<string, string> = {}) =>
  ({
    NODE_ENV: 'production',
    DATABASE_URL: 'postgres://jw_api_login:Zx9q-long-random-secret@db.internal:5432/jimmywax',
    AUTH_SIGNING_PRIVATE_KEY: pem,
    AUTH_TOTP_ENC_KEY: Buffer.alloc(32, 9).toString('base64'),
    CORS_ORIGINS: 'https://www.jimmyandwax.example,https://jimmyandwax.example',
    TRUST_PROXY_HOPS: '1',
    SMTP_HOST: 'smtp.mail.example',
    SMTP_USER: 'apikey',
    SMTP_PASS: 'long-random-smtp-secret',
    EMAIL_FROM: 'JIMMY WAX <care@jimmyandwax.example>',
    STORAGE_DRIVER: 's3',
    S3_BUCKET: 'jimmywax-media',
    S3_REGION: 'ap-south-1',
    S3_ACCESS_KEY_ID: 'AKIAEXAMPLE',
    S3_SECRET_ACCESS_KEY: 'long-random-s3-secret',
    ...over,
  }) as NodeJS.ProcessEnv;

const reasons = (over: Record<string, string>) => {
  try {
    loadConfig(good(over));
    return [];
  } catch (e) {
    return [(e as Error).message];
  }
};

describe('production configuration fails fast on unsafe values', () => {
  it('read-only experience service needs no commerce identity or provider credentials', () => {
    expect(() =>
      loadConfig(
        good({
          SERVICE_ROLE: 'experience',
          AUTH_SIGNING_PRIVATE_KEY: '',
          AUTH_TOTP_ENC_KEY: '',
          SMTP_HOST: '',
          EMAIL_FROM: '',
          FEATURE_ONLINE_PAYMENTS: 'true',
          STOREFRONT_ORIGIN: 'https://shop.store.com',
        }),
      ),
    ).not.toThrow();
  });
  it('accepts a complete, safe configuration', () => {
    expect(() => loadConfig(good())).not.toThrow();
    expect(productionProblems(loadConfig(good()))).toEqual([]);
  });

  it.each([
    ['plain-http CORS origin', { CORS_ORIGINS: 'http://www.jimmyandwax.example' }, /https origin/],
    ['wildcard CORS', { CORS_ORIGINS: '*' }, /exact origins/],
    ['localhost CORS', { CORS_ORIGINS: 'https://localhost:5174' }, /local machine/],
    ['CORS origin with a path', { CORS_ORIGINS: 'https://shop.example/app' }, /https origin without a path/],
    [
      'development database password',
      { DATABASE_URL: 'postgres://jw_api_login:jw_api_dev@127.0.0.1:5432/x' },
      /development password/,
    ],
    ['postgres:postgres', { DATABASE_URL: 'postgres://postgres:postgres@db:5432/x' }, /development password/],
    ['MFA off', { ADMIN_REQUIRE_MFA: 'false' }, /ADMIN_REQUIRE_MFA/],
    ['no trusted proxy hop', { TRUST_PROXY_HOPS: '0' }, /TRUST_PROXY_HOPS/],
    ['no SMTP', { SMTP_HOST: '' }, /SMTP_HOST/],
    ['localhost sender', { EMAIL_FROM: 'JIMMY WAX <no-reply@localhost>' }, /EMAIL_FROM/],
    ['demo login with the default OTP', { AUTH_DEMO_ENABLED: 'true' }, /demo OTP/],
    ['local disk storage without opt-in', { STORAGE_DRIVER: 'disk' }, /STORAGE_DRIVER=s3/],
    ['http S3 endpoint', { S3_ENDPOINT: 'http://minio:9000' }, /S3_ENDPOINT must be https/],
    [
      'the bridge flag for unapproved media',
      { MEDIA_PUBLIC_ALLOW_UNAPPROVED: 'true' },
      /MEDIA_PUBLIC_ALLOW_UNAPPROVED/,
    ],
    ['the fake shipping provider', { SHIPPING_PROVIDER: 'fake' }, /fake/],
    ['the test payment provider', { PAYMENT_PROVIDER: 'test' }, /test/],
    ['online payments without a provider', { FEATURE_ONLINE_PAYMENTS: 'true' }, /PAYMENT_PROVIDER/],
    ['a long-lived admin token', { AUTH_ADMIN_ACCESS_TTL_S: '3600' }, /AUTH_ADMIN_ACCESS_TTL_S/],
  ])('refuses %s', (_name, over, message) => {
    const [r] = reasons(over as Record<string, string>);
    expect(r).toMatch(message);
  });

  it('allows single-host local disk storage only as an explicit opt-in, and reports every problem at once', () => {
    expect(() =>
      loadConfig(good({ STORAGE_DRIVER: 'disk', STORAGE_ALLOW_LOCAL_DISK: 'true' })),
    ).not.toThrow();
    const [many] = reasons({ CORS_ORIGINS: '*', ADMIN_REQUIRE_MFA: 'false', SMTP_HOST: '' });
    expect(many).toContain('CORS_ORIGINS');
    expect(many).toContain('ADMIN_REQUIRE_MFA');
    expect(many).toContain('SMTP_HOST');
  });

  it('S3 storage needs its credentials; development is not restricted', () => {
    expect(reasons({ S3_BUCKET: '' })[0]).toMatch(/S3/);
    expect(() =>
      loadConfig({
        NODE_ENV: 'development',
        DATABASE_URL: 'postgres://jw_api_login:jw_api_dev@127.0.0.1:55432/jimmywax_dev',
      } as NodeJS.ProcessEnv),
    ).not.toThrow();
  });

  it('requires the secrets production cannot run without', () => {
    expect(reasons({ AUTH_SIGNING_PRIVATE_KEY: '' })[0]).toMatch(/AUTH_SIGNING_PRIVATE_KEY/);
    expect(reasons({ AUTH_TOTP_ENC_KEY: '' })[0]).toMatch(/AUTH_TOTP_ENC_KEY/);
  });
});
