/**
 * Generates field-level JSON Schemas straight from the backend validators:
 *  - doc-schemas.json: design system, token overrides, navigation and chrome per channel (DASH-BR-046)
 *  - entity-schemas.json (written next to it): the six content-library entities - care guides, stories, journal,
 *    testimonials, FAQ groups, announcements (the request body of POST/PATCH /v1/admin/content/{type}).
 *   pnpm exec tsx packages/commerce-domain/scripts/gen-doc-schemas.ts [outFile]
 * The output is the source for the dashboard's schema-driven forms.
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { exp } from '../src/index.ts';

const out = process.argv[2] ?? 'doc-schemas.json';
const entityOut = join(dirname(out), 'entity-schemas.json');
const pick = (schema: z.ZodType, io: 'input' | 'output' = 'input'): unknown => {
  try {
    return z.toJSONSchema(schema, { unrepresentable: 'any', io, target: 'draft-2020-12' });
  } catch (error) {
    return { note: `not representable: ${(error as Error).message}` };
  }
};

const result = {
  schemaVersion: 1,
  docs: {
    'shared/tokens/base': pick(exp.DOC_SCHEMAS.tokens('shared')),
    'app/tokens/override': pick(exp.DOC_SCHEMAS.tokens('app')),
    'web/tokens/override': pick(exp.DOC_SCHEMAS.tokens('web')),
    'app/navigation/main': pick(exp.DOC_SCHEMAS.navigation('app')),
    'web/navigation/main': pick(exp.DOC_SCHEMAS.navigation('web')),
    'app/chrome/main': pick(exp.DOC_SCHEMAS.chrome('app')),
    'web/chrome/main': pick(exp.DOC_SCHEMAS.chrome('web')),
  },
};
writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);

/** Business rules the JSON Schema cannot express; the dashboard shows them next to the form. */
const ENTITY_RULES: Record<string, string[]> = {
  'care-guides': ['`id` (slug) is required on create; it cannot change afterwards.'],
  'faq-groups': ['`id` (slug) is required on create; it cannot change afterwards.'],
  journal: ['`id` (slug) is required on create; it cannot change afterwards.'],
  testimonials: [
    '`source: owner_supplied` requires `consent` ({recordedAt, note}).',
    'A `videoMediaId` requires a `posterMediaId`.',
    '`source: placeholder` testimonials cannot be published in a release.',
  ],
  announcements: ['`endsAt` must be after `startsAt`.'],
  stories: ['Ids are server-generated uuids.'],
};
const entities = {
  schemaVersion: 1,
  note: 'Request bodies for create; PATCH accepts any subset. Responses add id, rev (use as If-Match / expectedRev) and updatedAt.',
  entities: Object.fromEntries(
    exp.ENTITY_NAMES.map((name) => [
      name,
      {
        schema: pick(exp.ENTITY_SCHEMAS[name]),
        rules: ENTITY_RULES[name] ?? [],
        slugId: exp.entityUsesSlug(name),
      },
    ]),
  ),
};
writeFileSync(entityOut, `${JSON.stringify(entities, null, 2)}\n`);

const failed = Object.entries(result.docs).filter(([, value]) => (value as { note?: string }).note);
console.log(
  `wrote ${out}: ${Object.keys(result.docs).length - failed.length} schemas, ${failed.length} not representable`,
);
for (const [name, value] of failed) console.log(`  ${name}: ${(value as { note: string }).note}`);
console.log(`wrote ${entityOut}: ${exp.ENTITY_NAMES.length} entities`);
