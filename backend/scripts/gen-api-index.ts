/**
 * Generates api-index.md (every operation with auth, permission and MFA) from contracts/api/openapi.yaml.
 *   pnpm exec tsx scripts/gen-api-index.ts [outFile]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { parse } from 'yaml';
import { SPEC_PATH } from '@jw/test-support';

const out = process.argv[2] ?? 'api-index.md';
const spec = parse(readFileSync(SPEC_PATH, 'utf8')) as {
  info: { version: string };
  paths: Record<string, Record<string, Record<string, unknown>>>;
};
const METHODS = ['get', 'post', 'put', 'patch', 'delete'];

const groupOf = (path: string): string => {
  const m = /^\/v1\/admin\/([a-z-]+)/u.exec(path);
  if (m) return `admin/${m[1]}`;
  if (path.startsWith('/v1/auth')) return 'auth';
  return 'public+customer';
};
const oneLine = (s: unknown): string =>
  String(s ?? '')
    .replace(/\s+/gu, ' ')
    .trim()
    .replace(/\|/gu, '\\|');

const groups = new Map<string, string[]>();
let ops = 0;
for (const [path, item] of Object.entries(spec.paths)) {
  for (const method of Object.keys(item).filter((k) => METHODS.includes(k))) {
    const op = item[method];
    if (!op) continue;
    ops += 1;
    const desc = oneLine(op.description);
    const perm = /permission `([a-z_]+:[a-z_]+)`/iu.exec(desc)?.[1] ?? '';
    const mfa = /\bnot (?:MFA|step-up)/iu.test(desc)
      ? ''
      : /\bMFA\b|\baal2\b|step-up/iu.test(desc)
        ? 'MFA'
        : '';
    const secured =
      Array.isArray(op.security) &&
      (op.security as unknown[]).length > 0 &&
      JSON.stringify(op.security) !== '[{}]';
    const row = `| ${method.toUpperCase()} | \`${path}\` | ${secured ? 'bearer' : 'public'} | ${[perm, mfa].filter(Boolean).join(' · ')} | ${String(op.operationId ?? '')} | ${desc} |`;
    const g = groupOf(path);
    groups.set(g, [...(groups.get(g) ?? []), row]);
  }
}

const order = [...groups.keys()].sort((a, b) =>
  a === 'public+customer' ? 1 : b === 'public+customer' ? -1 : a.localeCompare(b),
);
let md = `# API index (generated from contracts/api/openapi.yaml)\n\nSpec version ${spec.info.version}, ${ops} operations. Permission/MFA are taken from the operation description. Bodies not typed here are described in 03_BACKEND_CONTRACT.md and blocks.schema.json.\n\n`;
for (const g of order) {
  md += `\n## ${g}\n\n| Method | Path | Auth | Permission | operationId | Notes |\n|---|---|---|---|---|---|\n${groups.get(g)!.join('\n')}\n`;
}
writeFileSync(out, md);
console.log(`wrote ${out}: ${ops} operations in ${order.length} groups`);
