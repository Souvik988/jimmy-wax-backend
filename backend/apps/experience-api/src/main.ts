import { loadConfig } from '@jw/config';
import { createDb } from '@jw/database';
import { createObjectStorage } from '@jw/integrations';
import { createLogger, watchPool } from '@jw/observability';
import { createExperienceApp } from './app.ts';

const config = loadConfig();
const logger = createLogger(config.LOG_LEVEL, 'experience-api');
const db = createDb({
  url: config.DATABASE_URL,
  poolMax: config.DB_POOL_MAX,
  statementTimeoutMs: 3000,
  lockTimeoutMs: 500,
  appName: 'experience-api',
});
watchPool(db.pool);
const server = createExperienceApp({
  db,
  logger,
  storage: createObjectStorage(config),
  allowUnapprovedMedia: config.MEDIA_PUBLIC_ALLOW_UNAPPROVED,
  onlinePaymentsEnabled: config.FEATURE_ONLINE_PAYMENTS,
  corsOrigins: config.CORS_ORIGINS.split(',')
    .map((s) => s.trim())
    .filter(Boolean),
}).listen(config.PORT, () => logger.info({ port: config.PORT }, 'experience-api listening'));
server.keepAliveTimeout = 65_000;
const stop = () => server.close(() => void db.close().then(() => process.exit(0)));
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
