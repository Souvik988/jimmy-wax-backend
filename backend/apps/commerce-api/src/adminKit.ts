import type { Request, RequestHandler, Router } from 'express';
import type { z } from 'zod';
import type { Actor, Db } from '@jw/database';
import type { AdminRole, Permission } from '@jw/commerce-domain';
import type { AppConfig } from '@jw/config';
import type { ObjectStorage } from '@jw/integrations';
import type { Deps } from './app.ts';

/** Helpers every admin route group receives from `adminRouter` (auth gate, permission guard, parsing, audit ctx). */
export interface AdminKit {
  r: Router;
  deps: Deps;
  db: Db;
  config: AppConfig;
  storage: ObjectStorage;
  lim: (name: string, windowMs: number, max: number, byUser?: boolean) => RequestHandler;
  need: (p: Permission) => RequestHandler;
  actor: (req: Request) => Actor;
  ctx: (req: Request) => { adminId: string; role: AdminRole; requestId: string };
  parse: <T>(s: z.ZodType<T>, v: unknown) => T;
  uuid: (v: unknown) => string;
  slug: (v: unknown) => string;
  iso: (d: unknown) => string;
}
