/**
 * Creates (or resets) an operator account. Run on a trusted machine with database-owner access:
 *   PG_ADMIN_URL=postgres://postgres:***@host:5432/jimmywax tsx scripts/create-admin.ts --email you@example.com --role admin
 * A strong random password is generated and printed ONCE (override with ADMIN_PASSWORD). Sign in at the console,
 * change nothing else, then set up two-step verification under "My security".
 */
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { hashPassword, normaliseEmail, validatePassword } from '../packages/commerce-domain/src/identity.ts';

const arg = (k: string) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > -1 ? process.argv[i + 1] : undefined;
};
const email = normaliseEmail(arg('email') ?? '');
const role = arg('role') ?? 'admin';
const url = process.env.PG_ADMIN_URL;
if (!email || !email.includes('@')) throw new Error('--email is required');
if (!['support', 'catalog', 'fulfillment', 'finance', 'designer', 'admin'].includes(role))
  throw new Error('invalid --role');
if (!url) throw new Error('PG_ADMIN_URL is required');

const generated = !process.env.ADMIN_PASSWORD;
const password = process.env.ADMIN_PASSWORD ?? randomBytes(15).toString('base64url');
validatePassword(password, email);

const c = new pg.Client({ connectionString: url });
await c.connect();
try {
  await c.query('BEGIN');
  const hash = await hashPassword(password);
  const u = await c.query(
    `INSERT INTO auth.users (email, password_hash, email_verified_at) VALUES ($1,$2, now())
     ON CONFLICT ((lower(email))) WHERE email IS NOT NULL
     DO UPDATE SET password_hash = excluded.password_hash, failed_logins = 0, locked_until = NULL, status = 'active', updated_at = now()
     RETURNING id`,
    [email, hash],
  );
  await c.query(
    `INSERT INTO admin_users (user_id, role, disabled) VALUES ($1,$2,false)
     ON CONFLICT (user_id) DO UPDATE SET role = excluded.role, disabled = false, updated_at = now()`,
    [u.rows[0].id, role],
  );
  await c.query('COMMIT');
  console.log(`Operator ready: ${email} (${role})`);
  if (generated) console.log(`One-time password (shown once, store it safely): ${password}`);
} catch (e) {
  await c.query('ROLLBACK');
  throw e;
} finally {
  await c.end();
}
