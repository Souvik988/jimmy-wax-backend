/**
 * Generates blocks.schema.json from the Studio validators: every block's prop schema, the shared pieces
 * (Action, MediaRef, VisibilityRules, BlockStyle, Seo), the colour roles and brand slots, and - new - an
 * `x-slot: { minWidth, minHeight?, aspect?, kind? }` annotation on every media prop (see experience/slots.ts).
 *   pnpm exec tsx packages/commerce-domain/scripts/gen-blocks-schema.ts [outFile]
 */
import { writeFileSync } from 'node:fs';
import { z } from 'zod';
import { exp } from '../src/index.ts';

const out = process.argv[2] ?? 'blocks.schema.json';
type J = Record<string, unknown>;
/** zod 4 writes literals as `const`; the published file has always used the equivalent single-value `enum`, which consumers key on. */
const constToEnum = (n: unknown): unknown => {
  if (Array.isArray(n)) return n.map(constToEnum);
  if (n && typeof n === 'object') {
    const o: J = {};
    for (const [k, v] of Object.entries(n)) {
      if (k === 'const') o.enum = [v];
      else o[k] = constToEnum(v);
    }
    return o;
  }
  return n;
};
const js = (s: z.ZodType): J =>
  constToEnum(z.toJSONSchema(s, { unrepresentable: 'any', io: 'input', target: 'draft-7' })) as J;
const strip = (j: J): J => {
  const { $schema: _s, ...rest } = j;
  return rest;
};

const isMedia = (n: J): boolean => {
  const p = n.properties as J | undefined;
  return !!p && 'mediaId' in p && 'fit' in p;
};

/** Walks a JSON Schema, attaching `x-slot` to MediaRef objects whose path has a declared slot. */
function annotate(node: unknown, blockType: string, path: string, found: Set<string>): void {
  if (!node || typeof node !== 'object') return;
  const n = node as J;
  if (isMedia(n)) {
    const slot = exp.slotFor(blockType, path);
    if (slot) {
      n['x-slot'] = slot;
      found.add(`${blockType}:${path}`);
    }
    return;
  }
  const props = n.properties as Record<string, unknown> | undefined;
  if (props)
    for (const [k, v] of Object.entries(props)) annotate(v, blockType, path ? `${path}.${k}` : k, found);
  if (n.items) annotate(n.items, blockType, `${path}[]`, found);
  for (const key of ['oneOf', 'anyOf', 'allOf'] as const)
    if (Array.isArray(n[key])) for (const v of n[key] as unknown[]) annotate(v, blockType, path, found);
}

const found = new Set<string>();
const blocks: Record<string, unknown> = {};
for (const [type, def] of Object.entries(exp.BLOCKS)) {
  const props = strip(js(def.schema));
  annotate(props, type, '', found);
  blocks[type] = { channel: def.channel, maxPerPage: def.max, props };
}
const missing = Object.keys(exp.BLOCK_SLOTS).filter((k) => !found.has(k));
if (missing.length) {
  console.error(`slot table entries that match no media prop: ${missing.join(', ')}`);
  process.exit(1);
}

// Brand slots in the chrome document carry their own size table.
const seo = strip(js(exp.Seo));
const ogImage = (seo.properties as J | undefined)?.ogImage as J | undefined;
if (ogImage) ogImage['x-slot'] = exp.SEO_OG_SLOT;

const result = {
  schemaVersion: 1,
  limits: { maxBlocks: exp.MAX_BLOCKS },
  appPages: exp.APP_PAGES,
  webFixedPages: exp.WEB_FIXED_PAGES,
  appScreens: exp.APP_SCREENS,
  webRoutes: exp.WEB_ROUTES,
  pdpSections: exp.PDP_SECTIONS,
  colorRoles: exp.COLOR_ROLES,
  brandSlots: exp.BRAND_SLOTS,
  brandSlotSpecs: exp.BRAND_SLOT_SPECS,
  docKeys: exp.DOC_KEYS,
  slotsNote:
    'x-slot gives the minimum SOURCE pixels and the crop shape for a media prop. Smaller or differently shaped files still publish; the release validator raises media.slot_too_small / media.slot_shape warnings. Values are proposed defaults owned by the owner/designer.',
  blockEnvelope: strip(js(exp.BlockEnvelope)),
  pageDoc: strip(js(exp.PageDoc)),
  mediaRef: strip(js(exp.MediaRef)),
  action: strip(js(exp.Action)),
  visibilityRules: strip(js(exp.VisibilityRules)),
  blockStyle: strip(js(exp.BlockStyle)),
  seo,
  blocks,
};
writeFileSync(out, `${JSON.stringify(result, null, 1)}\n`);
console.log(`wrote ${out}: ${Object.keys(blocks).length} blocks, ${found.size} slot annotations`);
