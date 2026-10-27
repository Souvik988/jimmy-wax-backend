/**
 * Production preflight: run it against the real environment BEFORE (re)starting the services.
 *   <load the production environment>  pnpm exec tsx scripts/preflight.ts [--probe]
 * Without --probe it only validates configuration (no network). With --probe it also checks, read-only:
 *   - the database answers and no migration is pending (set MIGRATE_DATABASE_URL to a schema-owner connection for this check)
 *   - object storage accepts a write, read and delete of a probe object
 *   - SMTP accepts a connection (no message is sent)
 * Exit code 0 = ready. Secrets are never printed.
 */
import { loadConfig, productionProblems } from '@jw/config';
import { SmtpEmailSender, createObjectStorage } from '@jw/integrations';
import pg from 'pg';
import { listMigrations } from './migrate.ts';

const probe = process.argv.includes('--probe');
let failed = 0;
const line = (ok: boolean, name: string, detail = '') => {
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` - ${detail}` : ''}`);
};

let config;
try {
  config = loadConfig({ ...process.env, NODE_ENV: 'production' });
  line(true, 'configuration is valid for production');
} catch (e) {
  line(false, 'configuration is valid for production', (e as Error).message);
  process.exit(1);
}
const extra = productionProblems(config);
line(extra.length === 0, 'no unsafe production values', extra.join('; '));
line(
  config.FEATURE_CHECKOUT || true,
  `checkout feature flag is ${config.FEATURE_CHECKOUT ? 'ON' : 'off'} (store_settings still gates real sales)`,
);
line(
  config.SHIPPING_PROVIDER === 'none' || config.SHIPPING_PROVIDER === 'shiprocket',
  `shipping provider: ${config.SHIPPING_PROVIDER}`,
);
line(
  true,
  `payments: provider=${config.PAYMENT_PROVIDER}, online payments ${config.FEATURE_ONLINE_PAYMENTS ? 'enabled' : 'disabled'}`,
);
line(!!config.METRICS_TOKEN, 'METRICS_TOKEN set (otherwise /metrics is disabled in production)');
line(
  !!config.EMAIL_WEBHOOK_TOKEN,
  'EMAIL_WEBHOOK_TOKEN set (otherwise provider bounce callbacks are disabled)',
);

if (probe) {
  try {
    const url = process.env.MIGRATE_DATABASE_URL ?? config.DATABASE_URL;
    const c = new pg.Client({ connectionString: url, connectionTimeoutMillis: 5000 });
    await c.connect();
    await c.query('SELECT 1');
    const ledger = await c.query(`SELECT to_regclass('public.schema_migrations') AS t`);
    if (!ledger.rows[0].t)
      line(
        false,
        'migration ledger',
        'public.schema_migrations is missing; run scripts/migrate.ts (use --baseline for a database created before the ledger)',
      );
    else {
      const applied = new Set(
        (await c.query('SELECT version FROM public.schema_migrations')).rows.map((r) => r.version as string),
      );
      const pending = listMigrations().filter((m) => !applied.has(m.version));
      line(pending.length === 0, 'database is up to date', pending.map((m) => m.version).join(', '));
    }
    await c.end();
  } catch (e) {
    line(false, 'database reachable', (e as Error).message.slice(0, 160));
  }
  try {
    const storage = createObjectStorage(config);
    const key = `probe/preflight-${Date.now()}.txt`;
    await storage.put(key, Buffer.from('ok'));
    const back = await storage.get(key);
    await storage.delete(key);
    line(back?.toString() === 'ok', `object storage (${config.STORAGE_DRIVER}) write/read/delete`);
  } catch (e) {
    line(false, 'object storage write/read/delete', (e as Error).message.slice(0, 160));
  }
  if (config.SMTP_HOST) {
    try {
      await new SmtpEmailSender({
        host: config.SMTP_HOST,
        port: config.SMTP_PORT,
        user: config.SMTP_USER,
        pass: config.SMTP_PASS,
        from: config.EMAIL_FROM,
      }).verify();
      line(true, 'SMTP accepts a connection and credentials');
    } catch (e) {
      line(false, 'SMTP accepts a connection and credentials', (e as Error).message.slice(0, 160));
    }
  }
}
console.log(failed ? `\n${failed} check(s) failed` : '\nready');
process.exit(failed ? 1 : 0);
