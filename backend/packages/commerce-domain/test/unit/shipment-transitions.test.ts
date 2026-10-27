import { describe, expect, it } from 'vitest';

import { SHIPMENT_STATUSES, SHIPMENT_TRANSITIONS } from '../../src/shipping.ts';

describe('manual shipment transitions', () => {
  it('covers every status and never allows leaving a terminal one', () => {
    for (const status of SHIPMENT_STATUSES) expect(SHIPMENT_TRANSITIONS[status]).toBeDefined();
    expect(SHIPMENT_TRANSITIONS.delivered).toEqual([]);
    expect(SHIPMENT_TRANSITIONS.returned_to_origin).toEqual([]);
  });
  it('only moves forward (a re-scan of the same status is fine, rewinding is not)', () => {
    expect(SHIPMENT_TRANSITIONS.in_transit).toContain('delivered');
    expect(SHIPMENT_TRANSITIONS.in_transit).not.toContain('label_created');
    expect(SHIPMENT_TRANSITIONS.out_for_delivery).not.toContain('label_created');
    expect(SHIPMENT_TRANSITIONS.label_created).toContain('label_created');
  });
  it('lets a failed attempt be retried but not marked delivered without an out-for-delivery scan', () => {
    expect(SHIPMENT_TRANSITIONS.failed).toEqual(
      expect.arrayContaining(['in_transit', 'out_for_delivery', 'returned_to_origin']),
    );
    expect(SHIPMENT_TRANSITIONS.failed).not.toContain('delivered');
    expect(SHIPMENT_TRANSITIONS.label_created).not.toContain('delivered');
  });
});
