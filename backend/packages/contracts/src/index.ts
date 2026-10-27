import { z } from 'zod';

/** Stable machine-readable error codes (mirrors components/schemas/ErrorCode in openapi.yaml). */
export const ERROR_CODES = {
  VALIDATION_FAILED: { status: 400, retryable: false },
  UNAUTHENTICATED: { status: 401, retryable: false },
  FORBIDDEN: { status: 403, retryable: false },
  MFA_REQUIRED: { status: 403, retryable: false },
  COUPON_INVALID: { status: 422, retryable: false },
  ETAG_MISMATCH: { status: 409, retryable: false },
  NOT_FOUND: { status: 404, retryable: false },
  CART_VERSION_CONFLICT: { status: 409, retryable: false },
  QUOTE_EXPIRED: { status: 409, retryable: false },
  QUOTE_STALE: { status: 409, retryable: false },
  QUOTE_ALREADY_USED: { status: 409, retryable: false },
  ITEM_UNAVAILABLE: { status: 409, retryable: false },
  STOCK_SHORTAGE: { status: 409, retryable: false },
  UNSUPPORTED_PAYMENT_METHOD: { status: 422, retryable: false },
  NOT_SERVICEABLE: { status: 422, retryable: false },
  POLICY_NOT_CONFIGURED: { status: 503, retryable: true },
  CHECKOUT_DISABLED: { status: 503, retryable: true },
  DUPLICATE_REQUEST_MISMATCH: { status: 422, retryable: false },
  REQUEST_IN_PROGRESS: { status: 409, retryable: true },
  ILLEGAL_STATE: { status: 409, retryable: false },
  RATE_LIMITED: { status: 429, retryable: true },
  PAYLOAD_TOO_LARGE: { status: 413, retryable: false },
  OTP_INVALID: { status: 401, retryable: false },
  OTP_EXPIRED: { status: 401, retryable: false },
  OTP_UNAVAILABLE: { status: 503, retryable: false },
  INTERNAL: { status: 500, retryable: true },
  UNAVAILABLE: { status: 503, retryable: true },
} as const;
export type ErrorCode = keyof typeof ERROR_CODES;

export class AppError extends Error {
  readonly status: number;
  readonly retryable: boolean;
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: {
      fields?: Record<string, string>;
      lines?: unknown[];
      reason?: string;
      paused?: boolean;
    },
  ) {
    super(message);
    this.status = ERROR_CODES[code].status;
    this.retryable = ERROR_CODES[code].retryable;
  }
}

export interface ErrorBody {
  error: {
    code: ErrorCode;
    message: string;
    requestId: string;
    retryable: boolean;
    fields?: Record<string, string>;
    lines?: unknown[];
    reason?: string;
    paused?: boolean;
  };
}

// ------------------------------------------------------------------ primitives
export const idString = z
  .string()
  .regex(/^[a-z0-9-]+$/)
  .max(100);
export const uuid = z.string().uuid();
export const paise = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const PaymentMethod = z.enum(['cod', 'online']);
export type PaymentMethod = z.infer<typeof PaymentMethod>;

// -------------------------------------------------------------------- requests
export const AddressInput = z.object({
  recipientName: z.string().trim().min(1).max(120),
  phone: z.string().regex(/^[0-9+() -]{7,20}$/),
  line1: z.string().trim().min(1).max(240),
  landmark: z.string().trim().max(240).default(''),
  city: z.string().trim().min(1).max(100),
  state: z.string().trim().min(1).max(100),
  postalCode: z.string().regex(/^[0-9]{6}$/),
  isDefault: z.boolean().default(false),
});
export type AddressInput = z.infer<typeof AddressInput>;

export const CartLineMutation = z.object({
  quantity: z.number().int().min(0).max(99), // 0 removes the line
  expectedVersion: z.number().int().min(1).optional(),
});

export const ApplyCouponRequest = z.object({ code: z.string().trim().min(3).max(32) });

export const CartMergeRequest = z.object({ guestCartToken: z.string().min(20).max(200) });

export const CreateQuoteRequest = z.object({
  addressId: uuid,
  paymentMethod: PaymentMethod,
  couponCode: z.string().trim().min(3).max(32).optional(),
});

export const CreateOrderRequest = z.object({ quoteId: uuid });

export const CreatePaymentAttemptRequest = z.object({ method: z.string().max(40).optional() });

export const ConfirmPaymentRequest = z.object({
  providerOrderId: z.string().min(3).max(100),
  providerPaymentId: z.string().min(3).max(100),
  signature: z.string().min(16).max(256),
});

export const CancelOrderRequest = z.object({ reason: z.string().trim().min(1).max(300) });

export const PageQuery = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().max(300).optional(),
});

// -------------------------------------------------------------------- cursors
/** Opaque keyset cursor: base64url(JSON). Deterministic tie-break on id. */
export function encodeCursor(v: unknown): string {
  return Buffer.from(JSON.stringify(v)).toString('base64url');
}
export function decodeCursor<T>(raw: string | undefined, schema: z.ZodType<T>): T | undefined {
  if (!raw) return undefined;
  try {
    return schema.parse(JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')));
  } catch {
    throw new AppError('VALIDATION_FAILED', 'Invalid cursor', { fields: { cursor: 'invalid' } });
  }
}

// ------------------------------------------------------------- route table
/**
 * Records every route registered on a router/app so contract-check can prove the served surface
 * equals the documented surface (Express 5 hides nested mount paths from introspection).
 */
export function trackRoutes<R extends object>(router: R, prefix: string, sink: string[]): R {
  for (const m of ['get', 'post', 'put', 'patch', 'delete'] as const) {
    const r = router as unknown as Record<string, (...a: unknown[]) => unknown>;
    const orig = r[m];
    if (!orig) continue;
    r[m] = (...args: unknown[]) => {
      if (typeof args[0] === 'string')
        sink.push(`${m.toUpperCase()} ${prefix}${args[0]}`.replace(/:(\w+)/g, '{$1}'));
      return orig.apply(router, args);
    };
  }
  return router;
}
