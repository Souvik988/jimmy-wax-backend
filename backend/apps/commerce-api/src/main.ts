import { loadConfig } from '@jw/config';
import { createDb } from '@jw/database';
import {
  ConsoleEmailSender,
  ConsoleSmsSender,
  TwilioSmsSender,
  SmtpEmailSender,
  createObjectStorage,
  RazorpayGateway,
  TestPaymentGateway,
  createShippingProvider,
} from '@jw/integrations';
import { createLogger, watchPool } from '@jw/observability';
import { Redis } from 'ioredis';
import { createApp } from './app.ts';
import { createTokenService } from './auth.ts';
import { RedisStore } from './rateLimit.ts';

const config = loadConfig();
const logger = createLogger(config.LOG_LEVEL, 'commerce-api');
const db = createDb({
  url: config.DATABASE_URL,
  poolMax: config.DB_POOL_MAX,
  statementTimeoutMs: config.DB_STATEMENT_TIMEOUT_MS,
  lockTimeoutMs: config.DB_LOCK_TIMEOUT_MS,
  appName: 'commerce-api',
});
watchPool(db.pool);
const gateway =
  config.PAYMENT_PROVIDER === 'razorpay'
    ? new RazorpayGateway({
        keyId: config.RAZORPAY_KEY_ID!,
        keySecret: config.RAZORPAY_KEY_SECRET!,
        webhookSecret: config.RAZORPAY_WEBHOOK_SECRET!,
      })
    : config.PAYMENT_PROVIDER === 'test'
      ? new TestPaymentGateway()
      : null;

const redis = config.REDIS_CACHE_URL
  ? new Redis(config.REDIS_CACHE_URL, { maxRetriesPerRequest: 1, enableOfflineQueue: false })
  : null;
redis?.on('error', () => undefined);

const app = createApp({
  config,
  db,
  tokens: createTokenService(config, logger),
  storage: createObjectStorage(config),
  sms:
    config.SMS_PROVIDER === 'twilio'
      ? new TwilioSmsSender({
          accountSid: config.TWILIO_ACCOUNT_SID!,
          authToken: config.TWILIO_AUTH_TOKEN!,
          messagingServiceSid: config.TWILIO_MESSAGING_SERVICE_SID,
          from: config.TWILIO_FROM,
        })
      : config.SMS_PROVIDER === 'console' && config.NODE_ENV !== 'production'
        ? new ConsoleSmsSender()
        : null,
  gateway,
  shipping: createShippingProvider(config),
  email: config.SMTP_HOST
    ? new SmtpEmailSender({
        host: config.SMTP_HOST,
        port: config.SMTP_PORT,
        user: config.SMTP_USER,
        pass: config.SMTP_PASS,
        from: config.EMAIL_FROM,
      })
    : new ConsoleEmailSender(),
  logger,
  limits: redis ? new RedisStore(redis) : undefined,
});

const server = app.listen(config.PORT, () => logger.info({ port: config.PORT }, 'commerce-api listening'));
server.keepAliveTimeout = 65_000; // longer than typical LB idle timeout
server.headersTimeout = 66_000;

let closing = false;
async function shutdown(sig: string) {
  if (closing) return;
  closing = true;
  logger.info({ sig }, 'draining');
  server.close(async () => {
    await db.close().catch(() => undefined);
    redis?.disconnect();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 25_000).unref(); // hard stop after drain budget
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
