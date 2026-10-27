/**
 * Recreates a local/CI database from the tracked migration ledger.
 *   tsx scripts/db-reset.ts [dbName] [--cutover] [--seed]
 * Order: db/migrations/*.sql (lexical) → optional seed → optional cutover →
 * login-role provisioning. Refuses to run against anything but localhost.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import pg from 'pg';
import { LEDGER_DDL, checksum } from './migrate.ts';

const root = resolve(import.meta.dirname, '..', '..');
const args = process.argv.slice(2);
const dbName = args.find((a) => !a.startsWith('--')) ?? 'jimmywax_dev';
const withSeed = args.includes('--seed');
const admin =
  process.env.PG_ADMIN_URL ??
  `postgres://postgres:postgres@127.0.0.1:${process.env.PG_HOST_PORT ?? '54422'}/postgres`;

if (!/(127\.0\.0\.1|localhost)/.test(admin)) throw new Error('db-reset only runs against localhost');
if (!/^[a-z0-9_]+$/.test(dbName)) throw new Error('invalid database name');

async function run() {
  const a = new pg.Client({ connectionString: admin });
  await a.connect();
  await a.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await a.query(`CREATE DATABASE ${dbName}`);
  await a.end();

  const c = new pg.Client({ connectionString: admin.replace(/\/[^/]*$/, `/${dbName}`) });
  await c.connect();
  const exec = async (file: string) => c.query(readFileSync(file, 'utf8'));
  await c.query(LEDGER_DDL); // databases made here are tracked by the same ledger the production migrator uses
  for (const f of readdirSync(join(root, 'db/migrations'))
    .filter((x) => x.endsWith('.sql'))
    .sort()) {
    await exec(join(root, 'db/migrations', f));
    await c.query('INSERT INTO public.schema_migrations (version, filename, checksum) VALUES ($1,$2,$3)', [
      f.replace(/\.sql$/, ''),
      f,
      checksum(readFileSync(join(root, 'db/migrations', f), 'utf8')),
    ]);
  }
  if (withSeed) await exec(join(root, 'db/seed.sql'));
  // Login roles for the app. Dev-only passwords; production roles come from the secret manager.
  await c.query(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'jw_api_login') THEN
        CREATE ROLE jw_api_login LOGIN PASSWORD 'jw_api_dev' NOBYPASSRLS IN ROLE jw_commerce_api;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'jw_experience_login') THEN
        CREATE ROLE jw_experience_login LOGIN PASSWORD 'jw_experience_dev' NOBYPASSRLS IN ROLE jw_experience;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'jw_worker_login') THEN
        CREATE ROLE jw_worker_login LOGIN PASSWORD 'jw_worker_dev' NOBYPASSRLS IN ROLE jw_worker;
      END IF;
    END $$;`);
  await c.end();
  console.log(`database ${dbName} ready (seed=${withSeed})`);
}
run().catch((e) => {
  console.error(e);
  process.exit(1);
});
