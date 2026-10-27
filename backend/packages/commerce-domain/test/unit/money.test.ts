import { describe, expect, it } from 'vitest';
import {
  allocateProportional,
  canonicalHash,
  computeTax,
  gstExclusive,
  gstIncluded,
  shippingFor,
  totals,
} from '../../src/money.ts';

describe('allocateProportional', () => {
  it('always sums exactly to the total (randomised)', () => {
    for (let n = 0; n < 500; n++) {
      const k = 1 + Math.floor(Math.random() * 8);
      const weights = Array.from({ length: k }, () => 1 + Math.floor(Math.random() * 100000));
      const total = Math.floor(Math.random() * 10_000_000);
      const parts = allocateProportional(total, weights);
      expect(parts.reduce((a, b) => a + b, 0)).toBe(total);
      parts.forEach((p) => expect(Number.isInteger(p) && p >= 0).toBe(true));
    }
  });
  it('is deterministic with ties broken by index', () => {
    expect(allocateProportional(100, [1, 1, 1])).toEqual([34, 33, 33]);
  });
  it('rejects non-integer or zero-weight input', () => {
    expect(() => allocateProportional(1.5, [1])).toThrow();
    expect(() => allocateProportional(10, [0, 0])).toThrow();
  });
});

describe('pricing', () => {
  const policy = { shippingFeePaise: 4000, freeShippingThresholdPaise: 200000, codMaxOrderPaise: null };
  it('charges shipping below the threshold and waives it at/above', () => {
    expect(shippingFor(199999, policy)).toBe(4000);
    expect(shippingFor(200000, policy)).toBe(0);
  });
  it('never has a free-shipping threshold unless configured', () => {
    expect(shippingFor(10_000_000, { ...policy, freeShippingThresholdPaise: null })).toBe(4000);
  });
  it('reconciles subtotal, discount, shipping, tax', () => {
    expect(totals(29900, 900, 4000, 0, 0, true).total).toBe(33000);
    expect(() => totals(100, 200, 0, 0, 0, true)).toThrow();
  });
});

describe('canonicalHash', () => {
  it('ignores key order but not values', () => {
    expect(canonicalHash({ a: 1, b: { c: 2, d: 3 } })).toBe(canonicalHash({ b: { d: 3, c: 2 }, a: 1 }));
    expect(canonicalHash({ a: 1 })).not.toBe(canonicalHash({ a: 2 }));
  });
});

describe('GST 18% (inclusive prices) and COD fee', () => {
  it('extracts GST from a tax-inclusive amount (round half up)', () => {
    expect(gstIncluded(29900, 1800)).toBe(4561); // 29900 * 18 / 118 = 4561.02
    expect(gstIncluded(11800, 1800)).toBe(1800);
    expect(gstIncluded(2500, 1800)).toBe(381); // COD fee: 2500 * 18/118 = 381.36
    expect(gstIncluded(0, 1800)).toBe(0);
  });
  it('adds GST on a tax-exclusive amount', () => {
    expect(gstExclusive(10000, 1800)).toBe(1800);
  });
  it('breakdown reconciles: taxable + tax == displayed amount for every component', () => {
    const b = computeTax({
      lines: [
        { key: 'a', amountPaise: 29900 },
        { key: 'b', amountPaise: 49900 },
      ],
      shippingPaise: 4000,
      codFeePaise: 2500,
      rateBps: 1800,
      inclusive: true,
    });
    for (const l of b.lines) expect(l.taxablePaise + l.taxPaise).toBe(l.key === 'a' ? 29900 : 49900);
    expect(b.shipping.taxablePaise + b.shipping.taxPaise).toBe(4000);
    expect(b.codFee.taxablePaise + b.codFee.taxPaise).toBe(2500);
    expect(b.totalTaxPaise).toBe(
      b.lines.reduce((n, l) => n + l.taxPaise, 0) + b.shipping.taxPaise + b.codFee.taxPaise,
    );
  });
  it('COD adds exactly ₹25 to the payable total; inclusive tax never changes it', () => {
    const tax = computeTax({
      lines: [{ key: 'a', amountPaise: 29900 }],
      shippingPaise: 4000,
      codFeePaise: 2500,
      rateBps: 1800,
      inclusive: true,
    });
    expect(totals(29900, 0, 4000, 2500, tax.totalTaxPaise, true).total).toBe(36400);
    expect(totals(29900, 0, 4000, 0, 0, true).total).toBe(33900);
  });
  it('exclusive pricing adds tax to the total', () => {
    expect(totals(10000, 0, 0, 0, 1800, false).total).toBe(11800);
  });
});
