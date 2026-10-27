import { Pool, type PoolClient, type PoolConfig } from 'pg';

export type Actor =
  | { kind: 'customer'; userId: string }
  | {
      kind: 'admin';
      userId: string;
      role: 'support' | 'catalog' | 'fulfillment' | 'finance' | 'designer' | 'admin';
    }
  | { kind: 'system'; reason: string }
  | { kind: 'anonymous' };

export interface Db {
  pool: Pool;
  /**
   * Runs `fn` in ONE transaction with the verified actor bound via transaction-local
   * settings (set_config(..., is_local => true)). They are discarded at COMMIT/ROLLBACK, so a
   * pooled connection can never leak one request's identity into the next.
   */
  tx<T>(
    actor: Actor,
    fn: (c: PoolClient) => Promise<T>,
    opts?: { isolation?: 'read committed' | 'repeatable read' },
  ): Promise<T>;
  close(): Promise<void>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createDb(
  cfg: { url: string; poolMax: number; statementTimeoutMs: number; lockTimeoutMs: number; appName?: string },
  poolOverrides: Partial<PoolConfig> = {},
): Db {
  const pool = new Pool({
    connectionString: cfg.url,
    max: cfg.poolMax,
    application_name: cfg.appName ?? 'jw',
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 3_000,
    ...poolOverrides,
  });
  pool.on('error', () => {
    /* idle client errors surface on next checkout; avoid crashing the process */
  });

  return {
    pool,
    async tx(actor, fn, opts) {
      // Deadlock / serialization failures roll the whole transaction back, so re-running the closure
      // is safe. Bounded: 3 attempts with jitter. Closures must keep provider/network calls OUTSIDE tx.
      for (let attempt = 1; ; attempt++) {
        try {
          return await runOnce(actor, fn, opts);
        } catch (err) {
          const code = pgCode(err);
          if ((code === PG.deadlock || code === PG.serialization) && attempt < 3) {
            await new Promise((r) => setTimeout(r, 10 + Math.random() * 40 * attempt));
            continue;
          }
          throw err;
        }
      }
    },
    close: () => pool.end(),
  };

  async function runOnce<T>(
    actor: Actor,
    fn: (c: PoolClient) => Promise<T>,
    opts?: { isolation?: 'read committed' | 'repeatable read' },
  ): Promise<T> {
    {
      const client = await pool.connect();
      let broken = false;
      try {
        await client.query(`BEGIN ISOLATION LEVEL ${(opts?.isolation ?? 'read committed').toUpperCase()}`);
        // Bounded waits so a stuck lock/query cannot pile up connections.
        await client.query(
          `SELECT set_config('statement_timeout', $1, true), set_config('lock_timeout', $2, true),
                  set_config('idle_in_transaction_session_timeout', '15000', true)`,
          [String(cfg.statementTimeoutMs), String(cfg.lockTimeoutMs)],
        );
        if (actor.kind === 'customer') {
          if (!UUID.test(actor.userId)) throw new Error('Invalid actor id');
          await client.query(
            `SELECT set_config('app.actor_id', $1, true), set_config('app.system', '', true), set_config('app.admin_role', '', true)`,
            [actor.userId],
          );
        } else if (actor.kind === 'admin') {
          if (!UUID.test(actor.userId)) throw new Error('Invalid actor id');
          await client.query(
            `SELECT set_config('app.actor_id', $1, true), set_config('app.system', '', true), set_config('app.admin_role', $2, true)`,
            [actor.userId, actor.role],
          );
        } else if (actor.kind === 'system') {
          await client.query(
            `SELECT set_config('app.actor_id', '', true), set_config('app.system', '1', true), set_config('app.admin_role', '', true)`,
          );
        } else {
          await client.query(
            `SELECT set_config('app.actor_id', '', true), set_config('app.system', '', true), set_config('app.admin_role', '', true)`,
          );
        }
        const out = await fn(client);
        await client.query('COMMIT');
        return out;
      } catch (err) {
        try {
          await client.query('ROLLBACK');
        } catch {
          broken = true; // connection unusable: destroy rather than return it to the pool
        }
        throw err;
      } finally {
        client.release(broken ? true : undefined);
      }
    }
  }
}

export type { PoolClient };

export function pgCode(err: unknown): string | undefined {
  return typeof err === 'object' && err !== null && 'code' in err
    ? String((err as { code: unknown }).code)
    : undefined;
}
export const PG = {
  uniqueViolation: '23505',
  checkViolation: '23514',
  lockNotAvailable: '55P03',
  serialization: '40001',
  deadlock: '40P01',
} as const;
