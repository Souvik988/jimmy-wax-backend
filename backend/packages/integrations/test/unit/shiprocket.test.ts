import { describe, expect, it, vi } from 'vitest';
import { ShiprocketProvider } from '../../src/shipping.ts';

describe('deferred Shiprocket activation', () => {
  it('uses a supplied bearer token without login and refuses to replay a rejected token', async () => {
    const fetcher = vi.fn(async () => new Response('{}', { status: 401 }));
    const provider = new ShiprocketProvider(
      { apiToken: 'test-only-token', webhookToken: 'test-only-webhook' },
      fetcher as typeof fetch,
    );
    await expect(provider.listPickupLocations()).rejects.toMatchObject({ code: 'auth', retryable: false });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect((fetcher.mock.calls[0] as unknown as [string, RequestInit])[1].headers).toMatchObject({
      Authorization: 'Bearer test-only-token',
    });
  });

  it('requires complete reverse logistics data before contacting the provider', async () => {
    const fetcher = vi.fn();
    const provider = new ShiprocketProvider(
      { apiToken: 'test-only-token', webhookToken: 'test-only-webhook' },
      fetcher,
    );
    await expect(
      provider.createReturn({
        reference: 'return-1',
        originalProviderOrderId: '10',
        package: { weightGrams: 500, lengthMm: 100, widthMm: 100, heightMm: 100 },
      }),
    ).rejects.toMatchObject({ code: 'invalid_request' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('maps buyer pickup, warehouse destination, immutable line prices and parcel units', async () => {
    const fetcher = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      Response.json({ order_id: 20, shipment_id: 30 }),
    );
    const provider = new ShiprocketProvider(
      { apiToken: 'test-only-token', webhookToken: 'test-only-webhook' },
      fetcher,
    );
    const address = {
      name: 'Buyer',
      phone: '9999999999',
      email: null,
      line1: '1 Test Road',
      line2: '',
      city: 'Mumbai',
      state: 'Maharashtra',
      pincode: '400001',
    };
    expect(
      await provider.createReturn({
        reference: 'return-1',
        originalProviderOrderId: '10',
        pickup: address,
        drop: { ...address, name: 'Warehouse' },
        items: [
          { name: 'Polish', sku: 'large', units: 2, sellingPricePaise: 29900, taxPaise: 4561, hsn: null },
        ],
        package: { weightGrams: 500, lengthMm: 120, widthMm: 100, heightMm: 80 },
      }),
    ).toEqual({ providerOrderId: '20', providerShipmentId: '30' });
    expect(String(fetcher.mock.calls[0]![0])).toBe(
      'https://apiv2.shiprocket.in/v1/external/orders/create/return',
    );
    expect(JSON.parse(fetcher.mock.calls[0]![1]!.body as string)).toMatchObject({
      pickup_customer_name: 'Buyer',
      shipping_customer_name: 'Warehouse',
      sub_total: 598,
      weight: 0.5,
      length: 12,
      breadth: 10,
      height: 8,
      order_items: [{ sku: 'large', units: 2, selling_price: 299 }],
    });
  });
});
