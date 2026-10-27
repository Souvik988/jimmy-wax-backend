import type { Request, RequestHandler } from 'express';
import type { Redis } from 'ioredis';
import { AppError } from '@jw/contracts';

export interface LimitStore {
  hit(key: string, windowMs: number): Promise<number>;
}

export class MemoryStore implements LimitStore {
  private m = new Map<string, { n: number; reset: number }>();
  async hit(key: string, windowMs: number) {
    const now = Date.now();
    const cur = this.m.get(key);
    if (!cur || cur.reset <= now) {
      this.m.set(key, { n: 1, reset: now + windowMs });
      if (this.m.size > 50_000) for (const [k, v] of this.m) if (v.reset <= now) this.m.delete(k);
      return 1;
    }
    return ++cur.n;
  }
}

/** Shared across replicas. Fails OPEN on Redis errors (availability over strictness) — logged by caller. */
export class RedisStore implements LimitStore {
  constructor(private r: Redis) {}
  async hit(key: string, windowMs: number) {
    const k = `rl:${key}`;
    const n = await this.r.incr(k);
    if (n === 1) await this.r.pexpire(k, windowMs);
    return n;
  }
}

export interface Bucket {
  name: string;
  windowMs: number;
  max: number;
  key?: (req: Request) => string;
}

/** Separate buckets: public browsing must never share a tiny checkout quota. */
export function limiter(store: LimitStore, b: Bucket): RequestHandler {
  return async (req, res, next) => {
    const id = b.key ? b.key(req) : (req.ip ?? 'unknown');
    try {
      const n = await store.hit(`${b.name}:${id}`, b.windowMs);
      res.setHeader('RateLimit-Limit', String(b.max));
      res.setHeader('RateLimit-Remaining', String(Math.max(0, b.max - n)));
      if (n > b.max) {
        res.setHeader('Retry-After', String(Math.ceil(b.windowMs / 1000)));
        return next(new AppError('RATE_LIMITED', 'Too many requests; slow down and retry'));
      }
    } catch {
      /* fail open */
    }
    next();
  };
}
