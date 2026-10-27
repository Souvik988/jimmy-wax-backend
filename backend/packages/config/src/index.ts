import { z } from 'zod';

const bool = z.enum(['true', 'false']).transform((v) => v === 'true');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  SERVICE_ROLE: z.enum(['commerce', 'experience', 'worker']).default('commerce'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  // Application login role (jw_commerce_api member); NOT a superuser, NOT bypassrls.
  DATABASE_URL: z.string().url(),
  // Per-process pool ceiling; see docs/build/CAPACITY_REPORT.md for the global budget.
  DB_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  DB_STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(100).default(5000),
  DB_LOCK_TIMEOUT_MS: z.coerce.number().int().min(50).default(2000),
  REDIS_CACHE_URL: z.string().url().optional(),
  // Own identity service. Access tokens are Ed25519 (EdDSA) JWTs signed by this API.
  AUTH_SIGNING_PRIVATE_KEY: z.string().optional(), // PKCS#8 PEM (escaped newlines allowed)
  AUTH_SIGNING_KID: z.string().default('k1'),
  AUTH_VERIFY_PUBLIC_KEYS: z.string().optional(), // JSON {"kid":"SPKI PEM"} — add the previous key here during rotation
  AUTH_ISSUER: z.string().min(1).default('jimmywax'),
  AUTH_AUDIENCE: z.string().min(1).default('jimmywax-api'),
  AUTH_ACCESS_TTL_S: z.coerce.number().int().min(60).max(3600).default(900),
  AUTH_ADMIN_ACCESS_TTL_S: z.coerce.number().int().min(60).max(3600).default(1800),
  AUTH_TOTP_ENC_KEY: z.string().optional(), // base64, 32 bytes: encrypts TOTP secrets at rest
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().default(587),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  EMAIL_FROM: z.string().default('JIMMY WAX <no-reply@localhost>'),
  // Media / label storage. 'disk' = local directory (development, or one host with a persistent volume); 's3' = any S3-compatible
  // object store (AWS S3, Cloudflare R2, MinIO, Spaces). Production should use s3 (see docs/build/PRODUCTION_RUNBOOK.md).
  STORAGE_DRIVER: z.enum(['disk', 's3']).default('disk'),
  STORAGE_DIR: z.string().default('./.data/storage'),
  STORAGE_ALLOW_LOCAL_DISK: bool.default(false), // production opt-in for single-host deployments with a backed-up volume
  S3_BUCKET: z.string().min(3).max(63).optional(),
  S3_REGION: z.string().optional(),
  S3_ENDPOINT: z.string().url().optional(), // R2 / MinIO / Spaces; leave unset for AWS S3
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_FORCE_PATH_STYLE: bool.default(false),
  S3_PREFIX: z.string().max(60).optional(),
  // Protects GET /metrics (Prometheus scrape). Unset: the endpoint answers 404 in production and is open only in development/test.
  METRICS_TOKEN: z.string().min(16).optional(),
  // Shared secret the email provider sends (Authorization: Bearer) to POST /v1/webhooks/email when it reports bounces/complaints.
  EMAIL_WEBHOOK_TOKEN: z.string().min(16).optional(),
  // Phone sign-in. SMS delivery needs a DLT-registered provider (not configured): with SMS_PROVIDER=none only the
  // demo number below can sign in by phone. 'console' logs OTPs (development only).
  SMS_PROVIDER: z.enum(['none', 'console', 'twilio']).default('none'),
  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  TWILIO_MESSAGING_SERVICE_SID: z.string().optional(),
  TWILIO_FROM: z.string().optional(),
  SMS_OTP_TEMPLATE: z
    .string()
    .max(1000)
    .default('{{code}} is your JIMMY WAX verification code. It is valid for 5 minutes. Do not share it.'),
  // Fixed-code demo login for ONE phone (store review / demos). On by default outside production; production needs
  // AUTH_DEMO_ENABLED=true on purpose. The demo account is flagged in the console.
  AUTH_DEMO_ENABLED: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === 'true')),
  AUTH_DEMO_PHONE: z
    .string()
    .regex(/^\+91[6-9][0-9]{9}$/)
    .default('+919800000001'),
  AUTH_DEMO_OTP: z
    .string()
    .regex(/^[0-9]{6}$/)
    .default('123456'),
  CORS_ORIGINS: z.string().default(''),
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),
  PAYMENT_PROVIDER: z.enum(['none', 'test', 'razorpay']).default('none'),
  RAZORPAY_KEY_ID: z.string().optional(),
  RAZORPAY_KEY_SECRET: z.string().optional(),
  RAZORPAY_WEBHOOK_SECRET: z.string().optional(),
  // Where hosted checkout sends the customer back to (the website origin, no path). Never taken from a request.
  STOREFRONT_ORIGIN: z.string().url().optional(),
  // Public https origin of THIS API (used in provider callback URLs). Falls back to the request host when unset.
  PUBLIC_API_ORIGIN: z.string().url().optional(),
  // Deep link the mobile app listens on after hosted checkout, e.g. jimmywax://payment. Without it the browser shows a close-this-tab page.
  APP_RETURN_URL: z
    .string()
    .regex(/^[a-z][a-z0-9+.-]*:\/\/[^\s?#]*$/i)
    .optional(),
  // Shipping provider. 'none' = manual shipments only (courier + tracking number typed in). 'fake' is for local
  // development/tests and is refused in production. Shiprocket needs an API user (NOT the panel login).
  SHIPPING_PROVIDER: z.enum(['none', 'fake', 'shiprocket']).default('none'),
  SHIPROCKET_EMAIL: z.string().optional(),
  SHIPROCKET_PASSWORD: z.string().optional(),
  SHIPROCKET_API_TOKEN: z.string().min(16).optional(),
  SHIPROCKET_WEBHOOK_TOKEN: z.string().optional(),
  SHIPROCKET_BASE_URL: z.string().url().optional(),
  // Kill switches (defence in depth on top of store_settings gates).
  // Sensitive admin actions need an AAL2 (MFA) session. Only disable for local development.
  ADMIN_REQUIRE_MFA: bool.default(true),
  // Per-operator request ceilings for /v1/admin (one minute window). Reads and writes are counted separately so a
  // Studio session that saves many blocks cannot starve browsing (DASH-BR-049). 429 carries Retry-After.
  ADMIN_RATE_READ_PER_MIN: z.coerce.number().int().min(30).max(6000).default(600),
  ADMIN_RATE_WRITE_PER_MIN: z.coerce.number().int().min(30).max(3000).default(360),
  // Development bridge: lets the public media URL serve media that is not approved yet, so an older dashboard can still preview
  // drafts. Refused in production (DASH-BR-042).
  MEDIA_PUBLIC_ALLOW_UNAPPROVED: bool.default(false),
  FEATURE_CHECKOUT: bool.default(false),
  FEATURE_COD: bool.default(false),
  FEATURE_ONLINE_PAYMENTS: bool.default(false),
});

export type AppConfig = z.infer<typeof schema>;

const DEV_PASSWORD = /(:|^)(postgres|jw_[a-z]+_dev|CHANGE_ME|changeme|password|secret)@/i;

/** Everything that must be true before the API may start with NODE_ENV=production. Exported so it can be tested and reused by preflight checks. */
export function productionProblems(c: AppConfig): string[] {
  const p: string[] = [];
  const origins = c.CORS_ORIGINS.split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  for (const o of origins) {
    if (o === '*') p.push('CORS_ORIGINS must list exact origins, not *');
    else if (!/^https:\/\/[a-z0-9.-]+(:[0-9]+)?$/i.test(o))
      p.push(`CORS origin ${o} must be an https origin without a path`);
    else if (/^https:\/\/(localhost|127\.|0\.0\.0\.0|\[::1\])/i.test(o))
      p.push(`CORS origin ${o} points at the local machine`);
  }
  if (DEV_PASSWORD.test(c.DATABASE_URL.replace(/^[a-z]+:\/\//i, '')))
    p.push('DATABASE_URL uses a development password');
  if (!c.ADMIN_REQUIRE_MFA) p.push('ADMIN_REQUIRE_MFA must be true');
  if (c.SERVICE_ROLE === 'commerce' && c.TRUST_PROXY_HOPS < 1)
    p.push(
      'TRUST_PROXY_HOPS must be at least 1 behind the TLS proxy (otherwise every client shares one rate-limit bucket)',
    );
  if (c.SERVICE_ROLE !== 'experience' && !c.SMTP_HOST)
    p.push('SMTP_HOST is required (operator invitations and password resets are delivered by email only)');
  if (c.SERVICE_ROLE !== 'experience' && /@localhost>?$/i.test(c.EMAIL_FROM))
    p.push('EMAIL_FROM must be a real sender address');
  if (c.AUTH_DEMO_ENABLED && c.AUTH_DEMO_OTP === '123456')
    p.push(
      'AUTH_DEMO_ENABLED=true with the default demo OTP; change AUTH_DEMO_OTP or switch the demo login off',
    );
  if (c.STORAGE_DRIVER === 'disk' && !c.STORAGE_ALLOW_LOCAL_DISK)
    p.push(
      'STORAGE_DRIVER=s3 is required (or STORAGE_ALLOW_LOCAL_DISK=true for a single host with a backed-up volume)',
    );
  if (c.SHIPROCKET_BASE_URL && !c.SHIPROCKET_BASE_URL.startsWith('https://'))
    p.push('SHIPROCKET_BASE_URL must be https');
  if (c.S3_ENDPOINT && !c.S3_ENDPOINT.startsWith('https://')) p.push('S3_ENDPOINT must be https');
  if (c.SERVICE_ROLE !== 'experience' && c.FEATURE_ONLINE_PAYMENTS && c.PAYMENT_PROVIDER === 'none')
    p.push('FEATURE_ONLINE_PAYMENTS=true needs PAYMENT_PROVIDER=razorpay');
  if (c.FEATURE_ONLINE_PAYMENTS && !/^https:\/\/[a-z0-9.-]+(:[0-9]+)?$/i.test(c.STOREFRONT_ORIGIN ?? ''))
    p.push('STOREFRONT_ORIGIN must be the https website origin (no path) when online payments are on');
  if (c.AUTH_ADMIN_ACCESS_TTL_S > 1800) p.push('AUTH_ADMIN_ACCESS_TTL_S must be at most 1800 (30 minutes)');
  if (c.PAYMENT_PROVIDER === 'razorpay' && c.RAZORPAY_KEY_ID && !/^rzp_(live|test)_/.test(c.RAZORPAY_KEY_ID))
    p.push('RAZORPAY_KEY_ID does not look like a Razorpay key id');
  return p;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid configuration: ${issues}`);
  }
  const c = parsed.data;
  if (
    c.STORAGE_DRIVER === 's3' &&
    (!c.S3_BUCKET || !c.S3_ACCESS_KEY_ID || !c.S3_SECRET_ACCESS_KEY || (!c.S3_REGION && !c.S3_ENDPOINT))
  ) {
    throw new Error(
      'S3 storage needs S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY and S3_REGION (or S3_ENDPOINT)',
    );
  }
  if (c.NODE_ENV === 'production') {
    const problems = productionProblems(c);
    if (problems.length) throw new Error(`Unsafe production configuration: ${problems.join('; ')}`);
    if (c.PAYMENT_PROVIDER === 'test') throw new Error('PAYMENT_PROVIDER=test is not allowed in production');
    if (c.MEDIA_PUBLIC_ALLOW_UNAPPROVED)
      throw new Error('MEDIA_PUBLIC_ALLOW_UNAPPROVED=true is not allowed in production');
    if (c.SHIPPING_PROVIDER === 'fake')
      throw new Error('SHIPPING_PROVIDER=fake is not allowed in production');
    if (c.SERVICE_ROLE === 'commerce' && !c.AUTH_SIGNING_PRIVATE_KEY)
      throw new Error('AUTH_SIGNING_PRIVATE_KEY is required in production');
    if (c.SERVICE_ROLE === 'commerce' && !c.AUTH_TOTP_ENC_KEY)
      throw new Error('AUTH_TOTP_ENC_KEY is required in production');
  }
  if (
    c.SERVICE_ROLE !== 'experience' &&
    c.PAYMENT_PROVIDER === 'razorpay' &&
    (!c.RAZORPAY_KEY_ID || !c.RAZORPAY_KEY_SECRET || !c.RAZORPAY_WEBHOOK_SECRET)
  ) {
    throw new Error('Razorpay credentials are incomplete');
  }
  if (
    c.SERVICE_ROLE !== 'experience' &&
    c.SHIPPING_PROVIDER === 'shiprocket' &&
    ((!c.SHIPROCKET_API_TOKEN && (!c.SHIPROCKET_EMAIL || !c.SHIPROCKET_PASSWORD)) ||
      !c.SHIPROCKET_WEBHOOK_TOKEN)
  ) {
    throw new Error(
      'Shiprocket needs SHIPROCKET_WEBHOOK_TOKEN and either SHIPROCKET_API_TOKEN or SHIPROCKET_EMAIL with SHIPROCKET_PASSWORD',
    );
  }
  if (!c.SMS_OTP_TEMPLATE.includes('{{code}}')) throw new Error('SMS_OTP_TEMPLATE must include {{code}}');
  if (
    c.SERVICE_ROLE === 'commerce' &&
    c.SMS_PROVIDER === 'twilio' &&
    (!/^AC[0-9a-f]{32}$/i.test(c.TWILIO_ACCOUNT_SID ?? '') ||
      !c.TWILIO_AUTH_TOKEN ||
      (!c.TWILIO_MESSAGING_SERVICE_SID && !c.TWILIO_FROM))
  )
    throw new Error('Twilio SMS needs account SID, auth token and a messaging service SID or sender');
  if (c.NODE_ENV === 'production' && c.SMS_PROVIDER === 'console')
    throw new Error('Console SMS is development-only');
  return c;
}
