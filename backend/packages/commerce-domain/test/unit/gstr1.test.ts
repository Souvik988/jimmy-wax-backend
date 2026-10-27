import { describe, expect, it } from 'vitest';
import {
  allocateByWeight,
  gstr1Csv,
  merchantStateCode,
  splitTax,
  stateCodeFor,
  stateLabel,
  type Gstr1Report,
} from '../../src/gstr1.ts';

describe('GSTR-1 helpers', () => {
  it('maps the state names customers type to GST state codes', () => {
    expect(stateCodeFor('Maharashtra')).toBe('27');
    expect(stateCodeFor('  tamil   nadu ')).toBe('33');
    expect(stateCodeFor('Jammu & Kashmir')).toBe('01');
    expect(stateCodeFor('Andaman and Nicobar Islands')).toBe('35');
    expect(stateCodeFor('Atlantis')).toBeNull();
    expect(stateCodeFor(undefined)).toBeNull();
    expect(stateLabel('27')).toBe('27-Maharashtra');
  });

  it('takes the home state from a valid GSTIN only', () => {
    expect(merchantStateCode('27AAPFU0939F1ZV')).toBe('27');
    expect(merchantStateCode('27aapfu0939f1zv')).toBe('27');
    expect(merchantStateCode('not-a-gstin')).toBeNull();
    expect(merchantStateCode(null)).toBeNull();
  });

  it('splits tax so the parts always add back to the exact total', () => {
    expect(splitTax(10113, true)).toEqual({ igst: 10113, cgst: 0, sgst: 0 });
    const s = splitTax(10113, false);
    expect(s.cgst + s.sgst).toBe(10113);
    expect(s.igst).toBe(0);
    expect(s.sgst - s.cgst).toBe(1); // the odd paisa goes to state tax
    expect(splitTax(0, false)).toEqual({ igst: 0, cgst: 0, sgst: 0 });
  });

  it('allocates an amount across weights without losing a paisa', () => {
    for (const [total, weights] of [
      [10000, [1, 1, 1]],
      [999, [3, 5, 7]],
      [1, [1, 1, 1]],
      [0, [4, 4]],
      [500, [0, 0]],
    ] as const) {
      const parts = allocateByWeight(total, [...weights]);
      expect(parts.reduce((a, b) => a + b, 0)).toBe(total);
      expect(parts.every((p) => p >= 0)).toBe(true);
    }
    expect(allocateByWeight(100, [1, 3])).toEqual([25, 75]);
    expect(allocateByWeight(5, [])).toEqual([]);
  });

  it('writes offline-tool style CSV with rupees, rates and formula-guarded text', () => {
    const report: Gstr1Report = {
      month: '2026-10',
      merchantStateCode: '27',
      orders: 2,
      warnings: [],
      totals: { taxablePaise: 0, igstPaise: 0, cgstPaise: 0, sgstPaise: 0 },
      b2cs: [
        {
          placeOfSupply: '27-Maharashtra',
          rateBps: 1800,
          taxablePaise: 100000,
          igstPaise: 0,
          cgstPaise: 9000,
          sgstPaise: 9000,
          orders: 2,
        },
      ],
      hsn: [
        {
          hsn: '3405',
          description: '=Leather, polish',
          uqc: 'PCS',
          quantity: 3,
          totalValuePaise: 118000,
          taxablePaise: 100000,
          igstPaise: 0,
          cgstPaise: 9000,
          sgstPaise: 9000,
          rateBps: 1800,
        },
      ],
    };
    const b2cs = gstr1Csv(report, 'b2cs').split('\r\n');
    expect(b2cs[0]).toContain('Place Of Supply');
    expect(b2cs[1]).toBe('OE,27-Maharashtra,18.00,,1000.00,0.00,,0.00,90.00,90.00,2');
    const hsn = gstr1Csv(report, 'hsn').split('\r\n');
    expect(hsn[1]).toBe('3405,"\'=Leather, polish",PCS-PIECES,3,1180.00,1000.00,0.00,90.00,90.00,0.00,18.00');
  });
});
