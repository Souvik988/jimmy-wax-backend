import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { RazorpayGateway, TestPaymentGateway, WebhookVerificationError } from '../../src/index.ts';

describe('Razorpay webhook verification (raw-body HMAC-SHA256)', () => {
  const secret = 'whsec_unit_test_secret';
  const gw = new RazorpayGateway({ keyId: 'k', keySecret: 's', webhookSecret: secret });
  const body = Buffer.from(
    JSON.stringify({
      event: 'payment.captured',
      payload: { payment: { entity: { id: 'pay_1', order_id: 'order_1', amount: 29900, currency: 'INR' } } },
    }),
  );
  const sig = (b: Buffer) => createHmac('sha256', secret).update(b).digest('hex');

  it('accepts a correctly signed payload and normalises it', () => {
    const v = gw.verifyWebhook(body, { 'x-razorpay-signature': sig(body), 'x-razorpay-event-id': 'evt_1' });
    expect(v).toMatchObject({
      providerEventId: 'evt_1',
      status: 'captured',
      providerOrderId: 'order_1',
      amountPaise: 29900,
    });
  });
  it('rejects a tampered body (re-serialised JSON changes the bytes)', () => {
    const tampered = Buffer.from(JSON.stringify(JSON.parse(body.toString()), null, 2));
    expect(() =>
      gw.verifyWebhook(tampered, { 'x-razorpay-signature': sig(body), 'x-razorpay-event-id': 'evt_1' }),
    ).toThrow(WebhookVerificationError);
  });
  it('rejects missing signature or event id', () => {
    expect(() => gw.verifyWebhook(body, {})).toThrow(WebhookVerificationError);
    expect(() => gw.verifyWebhook(body, { 'x-razorpay-signature': sig(body) })).toThrow(
      WebhookVerificationError,
    );
  });
});

describe('Razorpay checkout signature (order_id|payment_id, key secret)', () => {
  const gw = new RazorpayGateway({ keyId: 'k', keySecret: 'unit_key_secret', webhookSecret: 'w' });
  const good = createHmac('sha256', 'unit_key_secret').update('order_1|pay_1').digest('hex');
  it('accepts the documented signature and rejects any other pairing', () => {
    expect(gw.verifyCheckoutSignature('order_1', 'pay_1', good)).toBe(true);
    expect(gw.verifyCheckoutSignature('order_1', 'pay_2', good)).toBe(false);
    expect(gw.verifyCheckoutSignature('order_2', 'pay_1', good)).toBe(false);
    expect(gw.verifyCheckoutSignature('order_1', 'pay_1', 'short')).toBe(false);
  });
});

describe('TestPaymentGateway', () => {
  it('recovers a provider order created before a simulated timeout by receipt', async () => {
    const gw = new TestPaymentGateway();
    gw.failNextCreateAfterAccept = true;
    await expect(gw.createOrder({ receipt: 'att-1', amountPaise: 100, currency: 'INR' })).rejects.toThrow();
    expect(await gw.findOrderByReceipt('att-1')).not.toBeNull();
  });
});
