/**
 * Contract gate: (1) the OpenAPI document is valid; (2) every route the Express apps serve under /v1 is
 * documented and every documented path is served (parity). Response conformance is asserted by the
 * integration tests via @jw/test-support `conforms()`.
 */
import { readFileSync } from 'node:fs';
import SwaggerParser from '@apidevtools/swagger-parser';
import { loadConfig } from '@jw/config';
import { createDb } from '@jw/database';
import { createLogger } from '@jw/observability';
import { SPEC_PATH, specSha256 } from '@jw/test-support';
import { InMemoryStorage } from '@jw/integrations';
import { createApp } from '../apps/commerce-api/src/app.ts';
import { createTokenService } from '../apps/commerce-api/src/auth.ts';
import { createExperienceApp } from '../apps/experience-api/src/app.ts';
import { parse } from 'yaml';

const spec = parse(readFileSync(SPEC_PATH, 'utf8')) as { paths: Record<string, Record<string, unknown>> };
await SwaggerParser.validate(SPEC_PATH);

const db = createDb({
  url: 'postgres://x:y@127.0.0.1:1/z',
  poolMax: 1,
  statementTimeoutMs: 1000,
  lockTimeoutMs: 1000,
});
const config = loadConfig({
  NODE_ENV: 'test',
  DATABASE_URL: 'postgres://x:y@127.0.0.1:1/z',
  AUTH_DEV_HS256_SECRET: 'x'.repeat(32),
  PAYMENT_PROVIDER: 'test',
} as NodeJS.ProcessEnv);
const log = createLogger('silent');
const served = new Set<string>();
const add = (app: { locals: Record<string, unknown> }) => {
  for (const r of app.locals.routeTable as string[]) served.add(r);
};
add(
  createApp({
    config,
    db,
    tokens: createTokenService(config),
    storage: new InMemoryStorage(),
    gateway: null,
    logger: log,
  }),
);
add(createExperienceApp({ db, logger: log }));

const documented = new Set<string>();
for (const [p, ops] of Object.entries(spec.paths))
  for (const m of Object.keys(ops)) documented.add(`${m.toUpperCase()} ${p}`);

// Path-parameter NAMES may differ between router and spec; compare on shape.
const shape = (s: string) => s.replace(/\{[^}]+\}/g, '{}');
const servedShapes = new Set([...served].map(shape));
const docShapes = new Set([...documented].map(shape));
const undocumented = [...served].filter((s) => !docShapes.has(shape(s)));
const unserved = [...documented].filter((s) => !servedShapes.has(shape(s)));

console.log(`spec sha256: ${specSha256()}`);
console.log(`documented operations: ${documented.size}, served operations: ${served.size}`);
if (undocumented.length) console.error('SERVED BUT UNDOCUMENTED:\n  ' + undocumented.join('\n  '));
if (unserved.length) console.error('DOCUMENTED BUT NOT SERVED:\n  ' + unserved.join('\n  '));
await db.close();
process.exit(undocumented.length || unserved.length ? 1 : 0);
