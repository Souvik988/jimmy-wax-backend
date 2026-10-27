/**
 * Builds the contract pack the other projects consume, from the single source of truth in this repo.
 *   pnpm contract:pack [outDir]            default outDir: contracts/pack
 *   pnpm contract:pack "<dashboard>/docs/backend-contract"
 *
 * Writes: openapi.yaml, CHANGELOG.md, api-index.md (generated), blocks.schema.json (generated, with x-slot image requirements),
 * doc-schemas.json + entity-schemas.json (generated from the validators), the Studio/integration specs, and a README.
 * After copying into the dashboard run `pnpm contract:generate` there and update contract.lock.json with its tool.
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';

const repo = resolve(import.meta.dirname, '..', '..');
const backend = resolve(import.meta.dirname, '..');
const out = resolve(process.argv[2] ?? join(repo, 'contracts/pack'));
mkdirSync(out, { recursive: true });

const tsx = createRequire(import.meta.url).resolve('tsx/cli');
const run = (script: string, ...args: string[]) =>
  execFileSync(process.execPath, [tsx, script, ...args], {
    cwd: backend,
    stdio: ['ignore', 'inherit', 'inherit'],
  });

run('packages/commerce-domain/scripts/gen-doc-schemas.ts', join(out, 'doc-schemas.json')); // also writes entity-schemas.json next to it
run('packages/commerce-domain/scripts/gen-blocks-schema.ts', join(out, 'blocks.schema.json'));
run('scripts/gen-api-index.ts', join(out, 'api-index.md'));

const copies: Array<[string, string]> = [
  ['contracts/api/openapi.yaml', 'openapi.yaml'],
  ['contracts/api/CHANGELOG.md', 'CHANGELOG.md'],
  ['docs/dashboard-prompt/01_REFERENCE_ANALYSIS_BAKALOO.md', '01_REFERENCE_ANALYSIS_BAKALOO.md'],
  ['docs/dashboard-prompt/02_EXPERIENCE_STUDIO_SPEC.md', '02_EXPERIENCE_STUDIO_SPEC.md'],
  ['docs/dashboard-prompt/03_BACKEND_CONTRACT.md', '03_BACKEND_CONTRACT.md'],
  ['docs/dashboard-prompt/05_CLIENT_INTEGRATION_SPEC.md', '05_CLIENT_INTEGRATION_SPEC.md'],
  ['docs/build/INTEGRATION_GUIDE.md', 'INTEGRATION_GUIDE.md'],
];
for (const [from, to] of copies) copyFileSync(join(repo, from), join(out, to));

const spec = parse(readFileSync(join(repo, 'contracts/api/openapi.yaml'), 'utf8')) as {
  info: { version: string };
  paths: Record<string, Record<string, unknown>>;
};
const ops = Object.values(spec.paths).reduce(
  (n, item) => n + ['get', 'post', 'put', 'patch', 'delete'].filter((m) => m in item).length,
  0,
);
writeFileSync(
  join(out, 'README.md'),
  `# Backend contract pack (generated from the backend repo; deterministic - re-running with no source change produces no diff)

- openapi.yaml: source of truth (v${spec.info.version}, ${ops} operations)
- api-index.md: every operation with auth, permission and MFA (generated)
- blocks.schema.json: field-level JSON Schemas for all Studio blocks, the page/tokens/navigation/chrome documents and per-slot image requirements \`x-slot\` (generated)
- doc-schemas.json: design system / token overrides / navigation / chrome JSON Schemas (generated from the backend validators)
- entity-schemas.json: content-library entities - care guides, stories, journal, testimonials, FAQ groups, announcements (generated)
- 03_BACKEND_CONTRACT.md, 02_EXPERIENCE_STUDIO_SPEC.md, 01_REFERENCE_ANALYSIS_BAKALOO.md, 05_CLIENT_INTEGRATION_SPEC.md, INTEGRATION_GUIDE.md, CHANGELOG.md

Regenerate with \`pnpm contract:pack "<destination>"\` in the backend (never edit these files by hand in a consuming project).
`,
);
console.log(`contract pack v${spec.info.version} (${ops} operations) written to ${out}`);
