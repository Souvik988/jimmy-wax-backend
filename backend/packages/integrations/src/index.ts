import { createHmac, timingSafeEqual, randomUUID } from 'node:crypto';

// ---------------------------------------------------------------- payments
export type ProviderPaymentStatus = 'created' | 'authorized' | 'captured' | 'failed';

export interface CreateProviderOrderInput {
  /** Our local payment_attempts.id; used as the provider receipt for reconciliation. */
  receipt: string;
  amountPaise: number;
  currency: 'INR';
}
export interface ProviderOrder {
  providerOrderId: string;
  status: ProviderPaymentStatus;
  publicConfig: Record<string, string>; // safe to hand to the client SDK (key id, order id)
}
export interface ProviderPaymentLookup {
  providerOrderId: string;
  providerPaymentId?: string;
  status: ProviderPaymentStatus;
  amountPaise: number;
  currency: string;
}
export interface VerifiedWebhook {
  providerEventId: string;
  eventType: string;
  payload: unknown;
  /** Normalised facts extracted from the verified payload. */
  providerOrderId?: string;
  providerPaymentId?: string;
  status?: ProviderPaymentStatus;
  amountPaise?: number;
  currency?: string;
}

export interface PaymentGateway {
  readonly name: string;
  createOrder(input: CreateProviderOrderInput, opts?: { signal?: AbortSignal }): Promise<ProviderOrder>;
  /** Lookup by OUR receipt (recovers from a timeout after the provider accepted the order). */
  findOrderByReceipt(receipt: string, opts?: { signal?: AbortSignal }): Promise<ProviderPaymentLookup | null>;
  getOrder(providerOrderId: string, opts?: { signal?: AbortSignal }): Promise<ProviderPaymentLookup | null>;
  /** Must verify against RAW bytes. Throws WebhookVerificationError on failure. */
  verifyWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): VerifiedWebhook;
  /**
   * Verifies the signature a client SDK hands back after checkout (Razorpay: HMAC-SHA256 of
   * `order_id|payment_id` with the key secret). A valid signature only proves the payment belongs to this
   * order; the caller must still ask the provider for the order status before marking anything paid.
   */
  verifyCheckoutSignature(providerOrderId: string, providerPaymentId: string, signature: string): boolean;
  /** What a client needs to (re)open checkout for an existing provider order (key id is public, never the secret). */
  publicConfigFor(providerOrderId: string): Record<string, string>;
  refund(input: {
    providerPaymentId: string;
    amountPaise: number;
    idempotencyKey: string;
  }): Promise<{ providerRefundId: string }>;
}

export class WebhookVerificationError extends Error {}

function safeEqualHex(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/**
 * Deterministic in-memory gateway for local development and automated tests.
 * It is NOT evidence of live gateway behaviour and refuses to be built in production.
 */
export class TestPaymentGateway implements PaymentGateway {
  readonly name = 'test';
  readonly orders = new Map<string, ProviderPaymentLookup & { receipt: string }>();
  /** Test hook: simulate a timeout AFTER the provider accepted the order. */
  failNextCreateAfterAccept = false;
  constructor(private readonly webhookSecret = 'test-webhook-secret') {}

  async createOrder(input: CreateProviderOrderInput): Promise<ProviderOrder> {
    const providerOrderId = `order_test_${randomUUID().slice(0, 12)}`;
    this.orders.set(providerOrderId, {
      providerOrderId,
      status: 'created',
      amountPaise: input.amountPaise,
      currency: input.currency,
      receipt: input.receipt,
    });
    if (this.failNextCreateAfterAccept) {
      this.failNextCreateAfterAccept = false;
      throw new Error('simulated provider timeout after accept');
    }
    return {
      providerOrderId,
      status: 'created',
      publicConfig: { orderId: providerOrderId, keyId: 'test_key' },
    };
  }
  async findOrderByReceipt(receipt: string) {
    for (const o of this.orders.values()) if (o.receipt === receipt) return o;
    return null;
  }
  async getOrder(id: string) {
    return this.orders.get(id) ?? null;
  }
  sign(raw: Buffer | string): string {
    return createHmac('sha256', this.webhookSecret).update(raw).digest('hex');
  }
  publicConfigFor(providerOrderId: string): Record<string, string> {
    return { orderId: providerOrderId, keyId: 'test_key' };
  }
  /** Test helper: the signature a client would receive for this order/payment pair. */
  signCheckout(providerOrderId: string, providerPaymentId: string): string {
    return this.sign(`${providerOrderId}|${providerPaymentId}`);
  }
  verifyCheckoutSignature(providerOrderId: string, providerPaymentId: string, signature: string): boolean {
    return safeEqualHex(signature, this.signCheckout(providerOrderId, providerPaymentId));
  }
  verifyWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): VerifiedWebhook {
    const sig = String(headers['x-test-signature'] ?? '');
    if (!sig || !safeEqualHex(sig, this.sign(rawBody))) throw new WebhookVerificationError('bad signature');
    const body = JSON.parse(rawBody.toString('utf8')) as {
      id: string;
      type: string;
      providerOrderId: string;
      providerPaymentId?: string;
      status: ProviderPaymentStatus;
      amountPaise: number;
      currency: string;
    };
    return {
      providerEventId: body.id,
      eventType: body.type,
      payload: body,
      providerOrderId: body.providerOrderId,
      providerPaymentId: body.providerPaymentId,
      status: body.status,
      amountPaise: body.amountPaise,
      currency: body.currency,
    };
  }
  async refund(input: { providerPaymentId: string; amountPaise: number; idempotencyKey: string }) {
    return { providerRefundId: `rfnd_test_${input.idempotencyKey.slice(0, 12)}` };
  }
}

/**
 * Razorpay adapter. Webhook verification follows Razorpay's documented scheme
 * (HMAC-SHA256 of the raw body with the webhook secret, header X-Razorpay-Signature; the
 * delivery id is X-Razorpay-Event-Id). Order creation/lookup was exercised against the Razorpay TEST API
 * (2026-10-13); webhook delivery and refunds are still unverified against a live account.
 */
export class RazorpayGateway implements PaymentGateway {
  readonly name = 'razorpay';
  constructor(
    private readonly cfg: { keyId: string; keySecret: string; webhookSecret: string; baseUrl?: string },
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}
  private get auth() {
    return 'Basic ' + Buffer.from(`${this.cfg.keyId}:${this.cfg.keySecret}`).toString('base64');
  }
  private url(p: string) {
    return `${this.cfg.baseUrl ?? 'https://api.razorpay.com/v1'}${p}`;
  }
  private async call(path: string, init: RequestInit = {}, signal?: AbortSignal) {
    const res = await this.fetchImpl(this.url(path), {
      ...init,
      signal: signal ?? AbortSignal.timeout(8000),
      headers: { Authorization: this.auth, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
    });
    if (!res.ok) throw new Error(`razorpay ${res.status}`);
    return (await res.json()) as Record<string, unknown>;
  }
  async createOrder(
    input: CreateProviderOrderInput,
    opts?: { signal?: AbortSignal },
  ): Promise<ProviderOrder> {
    const o = await this.call(
      '/orders',
      {
        method: 'POST',
        body: JSON.stringify({ amount: input.amountPaise, currency: input.currency, receipt: input.receipt }),
      },
      opts?.signal,
    );
    return {
      providerOrderId: String(o.id),
      status: 'created',
      publicConfig: { orderId: String(o.id), keyId: this.cfg.keyId },
    };
  }
  private normalise(o: Record<string, unknown>): ProviderPaymentLookup {
    const st = String(o.status);
    return {
      providerOrderId: String(o.id),
      status: st === 'paid' ? 'captured' : st === 'attempted' ? 'authorized' : 'created',
      amountPaise: Number(o.amount),
      currency: String(o.currency),
    };
  }
  async findOrderByReceipt(receipt: string, opts?: { signal?: AbortSignal }) {
    // Razorpay's `receipt` list filter returned nothing for existing orders when checked against the live
    // test API, so scan the last day's orders (receipts are our payment_attempts ids) and match locally.
    const from = Math.floor(Date.now() / 1000) - 24 * 3600;
    const r = await this.call(`/orders?from=${from}&count=100`, {}, opts?.signal);
    const hit = (r.items as Record<string, unknown>[] | undefined)?.find((o) => o.receipt === receipt);
    return hit ? this.normalise(hit) : null;
  }
  async getOrder(id: string, opts?: { signal?: AbortSignal }) {
    return this.normalise(await this.call(`/orders/${encodeURIComponent(id)}`, {}, opts?.signal));
  }
  publicConfigFor(providerOrderId: string): Record<string, string> {
    return { orderId: providerOrderId, keyId: this.cfg.keyId };
  }
  verifyCheckoutSignature(providerOrderId: string, providerPaymentId: string, signature: string): boolean {
    const expected = createHmac('sha256', this.cfg.keySecret)
      .update(`${providerOrderId}|${providerPaymentId}`)
      .digest('hex');
    return safeEqualHex(signature, expected);
  }
  verifyWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): VerifiedWebhook {
    const sig = String(headers['x-razorpay-signature'] ?? '');
    const expected = createHmac('sha256', this.cfg.webhookSecret).update(rawBody).digest('hex');
    if (!sig || !safeEqualHex(sig, expected)) throw new WebhookVerificationError('bad signature');
    const eventId = String(headers['x-razorpay-event-id'] ?? '');
    if (!eventId) throw new WebhookVerificationError('missing event id');
    const body = JSON.parse(rawBody.toString('utf8')) as {
      event: string;
      payload?: { payment?: { entity?: Record<string, unknown> } };
    };
    const p = body.payload?.payment?.entity;
    const map: Record<string, ProviderPaymentStatus | undefined> = {
      'payment.authorized': 'authorized',
      'payment.captured': 'captured',
      'payment.failed': 'failed',
      'order.paid': 'captured',
    };
    return {
      providerEventId: eventId,
      eventType: body.event,
      payload: body,
      providerOrderId: p?.order_id ? String(p.order_id) : undefined,
      providerPaymentId: p?.id ? String(p.id) : undefined,
      status: map[body.event],
      amountPaise: p?.amount !== undefined ? Number(p.amount) : undefined,
      currency: p?.currency ? String(p.currency) : undefined,
    };
  }
  async refund(input: { providerPaymentId: string; amountPaise: number; idempotencyKey: string }) {
    const r = await this.call(`/payments/${encodeURIComponent(input.providerPaymentId)}/refund`, {
      method: 'POST',
      body: JSON.stringify({ amount: input.amountPaise, receipt: input.idempotencyKey }),
      headers: { 'X-Refund-Idempotency': input.idempotencyKey },
    });
    return { providerRefundId: String(r.id) };
  }
}

export * from './email.ts';
export * from './media.ts';
export * from './sms.ts';
export * from './library.ts';
export * from './shipping.ts';
export * from './s3.ts';
