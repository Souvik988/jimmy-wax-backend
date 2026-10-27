/**
 * Forward-only migration runner with a ledger. This is the ONLY way schema changes reach a database that holds real data;
 * `db-reset.ts` (drop + recreate) is for local/CI databases and refuses anything that is not localhost.
 *
 *   MIGRATE_DATABASE_URL=<owner connection> pnpm exec tsx scripts/migrate.ts [--status | --dry-run] [--baseline <version>] [--yes]
 *
 *   --status           show applied / pending / drifted migrations and exit
 *   --dry-run          list what would run and exit
 *   --baseline <v>     FIRST-TIME adoption of a database created before the ledger existed: record every migration whose
 *                      version is <= v as already applied (without running it). Refused when the ledger already has rows.
 *   --yes              required when the database is not on localhost (production safety catch)
 *
 * Each pending migration runs in its own transaction together with its ledger row, so a failure leaves nothing half-applied.
 * An applied migration whose file changed is DRIFT: the runner stops - never edit a migration that has shipped, add a new one.
 * Take a backup first (scripts/backup-postgres.ps1) - see docs/build/PRODUCTION_RUNBOOK.md.
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import pg from 'pg';

const root = resolve(import.meta.dirname, '..', '..');
const dir = join(root, 'db/migrations');
const args = process.argv.slice(2);
const flag = (n: string) => args.includes(n);
const baselineAt = args.includes('--baseline') ? args[args.indexOf('--baseline') + 1] : undefined;

export const LEDGER_DDL = `
CREATE TABLE IF NOT EXISTS public.schema_migrations (
  version text PRIMARY KEY,
  filename text NOT NULL,
  checksum text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now(),
  baselined boolean NOT NULL DEFAULT false
);
REVOKE ALL ON public.schema_migrations FROM PUBLIC;`;

export const checksum = (sql: string) =>
  createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex');
export const listMigrations = () =>
  readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((filename) => {
      const sql = readFileSync(join(dir, filename), 'utf8');
      return { version: filename.replace(/\.sql$/, ''), filename, sql, checksum: checksum(sql) };
    });

async function main() {
  const url = process.env.MIGRATE_DATABASE_URL;
  if (!url)
    throw new Error(
      'Set MIGRATE_DATABASE_URL to a connection that owns the schema (never the application login role).',
    );
  const local = /@(127\.0\.0\.1|localhost|\[::1\])[:/]/.test(url);
  if (!local && !flag('--yes') && !flag('--status') && !flag('--dry-run'))
    throw new Error('Refusing to change a non-local database without --yes (take a backup first).');

  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    await c.query('SELECT pg_advisory_lock(727001)'); // one runner at a time
    await c.query(LEDGER_DDL);
    const applied = new Map<string, { checksum: string; baselined: boolean }>(
      (await c.query('SELECT version, checksum, baselined FROM public.schema_migrations')).rows.map((r) => [
        r.version as string,
        { checksum: r.checksum as string, baselined: r.baselined as boolean },
      ]),
    );
    const all = listMigrations();

    if (baselineAt) {
      if (applied.size) throw new Error('--baseline is only for a database whose ledger is empty');
      const upto = all.filter((m) => m.version <= baselineAt);
      if (!upto.length) throw new Error(`No migration has a version <= ${baselineAt}`);
      for (const m of upto)
        await c.query(
          'INSERT INTO public.schema_migrations (version, filename, checksum, baselined) VALUES ($1,$2,$3,true)',
          [m.version, m.filename, m.checksum],
        );
      console.log(`baselined ${upto.length} migration(s) up to ${upto[upto.length - 1]!.version}`);
      upto.forEach((m) => applied.set(m.version, { checksum: m.checksum, baselined: true }));
    }

    const drift = all.filter(
      (m) =>
        applied.has(m.version) &&
        !applied.get(m.version)!.baselined &&
        applied.get(m.version)!.checksum !== m.checksum,
    );
    const missing = [...applied.keys()].filter((v) => !all.some((m) => m.version === v));
    const pending = all.filter((m) => !applied.has(m.version));
    if (flag('--status') || flag('--dry-run')) {
      for (const m of all)
        console.log(
          `${applied.has(m.version) ? (applied.get(m.version)!.baselined ? 'baselined' : 'applied  ') : 'PENDING  '} ${m.version}`,
        );
      if (drift.length)
        console.log(`DRIFT: ${drift.map((m) => m.version).join(', ')} changed after being applied`);
      if (missing.length) console.log(`UNKNOWN: ${missing.join(', ')} are in the ledger but have no file`);
      process.exitCode = drift.length || missing.length ? 1 : 0;
      return;
    }
    if (drift.length)
      throw new Error(
        `Migration drift: ${drift.map((m) => m.version).join(', ')} changed after being applied. Revert the edit and add a new migration.`,
      );
    if (missing.length) throw new Error(`The ledger lists migrations with no file: ${missing.join(', ')}`);

    for (const m of pending) {
      const started = Date.now();
      try {
        await c.query('BEGIN');
        await c.query(m.sql);
        await c.query(
          'INSERT INTO public.schema_migrations (version, filename, checksum) VALUES ($1,$2,$3)',
          [m.version, m.filename, m.checksum],
        );
        await c.query('COMMIT');
      } catch (e) {
        await c.query('ROLLBACK').catch(() => undefined);
        throw new Error(`Migration ${m.version} failed and was rolled back: ${(e as Error).message}`);
      }
      console.log(`applied ${m.version} (${Date.now() - started} ms)`);
    }
    console.log(pending.length ? `done: ${pending.length} migration(s) applied` : 'database is up to date');
  } finally {
    await c.query('SELECT pg_advisory_unlock(727001)').catch(() => undefined);
    await c.end();
  }
}

if (
  import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, '/')}` ||
  process.argv[1]?.endsWith('migrate.ts')
) {
  main().catch((e) => {
    console.error(String(e instanceof Error ? e.message : e));
    process.exit(1);
  });
}
