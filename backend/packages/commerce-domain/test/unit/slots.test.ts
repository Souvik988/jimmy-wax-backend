import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  BLOCKS,
  BLOCK_SLOTS,
  BRAND_SLOTS,
  BRAND_SLOT_SPECS,
  checkAgainstSlot,
  slotFor,
  type Slot,
} from '../../src/experience/index.ts';

type J = Record<string, unknown>;
/** Finds every MediaRef object in a block's JSON Schema, with the `a.b[].c` path the slot table uses. */
function mediaPaths(node: unknown, path = '', out: string[] = []): string[] {
  if (!node || typeof node !== 'object') return out;
  const n = node as J;
  const props = n.properties as Record<string, unknown> | undefined;
  if (props && 'mediaId' in props && 'fit' in props) return (out.push(path), out);
  if (props) for (const [k, v] of Object.entries(props)) mediaPaths(v, path ? `${path}.${k}` : k, out);
  if (n.items) mediaPaths(n.items, `${path}[]`, out);
  for (const key of ['oneOf', 'anyOf', 'allOf'] as const)
    if (Array.isArray(n[key])) for (const v of n[key] as unknown[]) mediaPaths(v, path, out);
  return out;
}

describe('image slots', () => {
  it('every media prop of every block has a declared slot, and every declared slot matches a media prop', () => {
    const seen = new Set<string>();
    for (const [type, def] of Object.entries(BLOCKS)) {
      const schema = z.toJSONSchema(def.schema, { unrepresentable: 'any', io: 'input', target: 'draft-7' });
      for (const p of mediaPaths(schema)) {
        seen.add(`${type}:${p}`);
        expect(slotFor(type, p), `${type}:${p} has no x-slot`).toBeDefined();
      }
    }
    expect([...seen].sort()).toEqual(Object.keys(BLOCK_SLOTS).sort());
  });

  it('declares a size for every chrome brand slot', () => {
    expect(Object.keys(BRAND_SLOT_SPECS).sort()).toEqual([...BRAND_SLOTS].sort());
  });

  it('website heroes are at least 1920 px wide; sizes are sane', () => {
    expect(slotFor('web.hero_film', 'film.desktop')?.minWidth).toBeGreaterThanOrEqual(1920);
    for (const s of [...Object.values(BLOCK_SLOTS), ...Object.values(BRAND_SLOT_SPECS)]) {
      expect(s.minWidth).toBeGreaterThanOrEqual(240);
      expect(s.minHeight === undefined || s.minHeight >= 240).toBe(true);
    }
  });

  it('flags files that are too small or the wrong shape, and stays quiet otherwise', () => {
    const slot: Slot = { minWidth: 1170, minHeight: 780, aspect: '3:2' };
    expect(checkAgainstSlot(slot, 1170, 780)).toBeNull();
    expect(checkAgainstSlot(slot, 2340, 1560)).toBeNull();
    expect(checkAgainstSlot(slot, 2000, 1380)).toBeNull(); // within the 12 % crop tolerance
    expect(checkAgainstSlot(slot, 640, 480)).toMatchObject({
      problem: 'too_small',
      detail: expect.stringContaining('640x480'),
    });
    expect(checkAgainstSlot(slot, 3000, 1000)).toMatchObject({ problem: 'wrong_shape' });
    expect(checkAgainstSlot(slot, null, null)).toBeNull(); // unknown size (fonts, processing) is never a warning
    expect(checkAgainstSlot({ minWidth: 600, aspect: 'free' }, 600, 90)).toBeNull();
  });
});
