'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { api, ApiError } from './api';
import { apiEnrollMfa, apiLogin, apiLogout, apiVerifyMfa } from './auth';
import { clearSession, readSession, writeSession } from './session';

export interface FormState {
  ok: boolean;
  message: string;
  requestId?: string;
}
const idle: FormState = { ok: false, message: '' };
export type Action = (prev: FormState, data: FormData) => Promise<FormState>;

const str = (d: FormData, k: string) => String(d.get(k) ?? '').trim();
const int = (d: FormData, k: string) => Number.parseInt(str(d, k), 10);
const rupeesToPaise = (v: string) => Math.round(Number.parseFloat(v) * 100);

/** Wraps a mutation: server-side error → readable state (never a stack), safe revalidation. */
async function run(paths: string[], fn: () => Promise<unknown>, okMessage: string): Promise<FormState> {
  try {
    await fn();
  } catch (e) {
    if (e instanceof ApiError) {
      const hint =
        e.code === 'CART_VERSION_CONFLICT'
          ? ' Someone else changed this record — the page was refreshed; review and retry.'
          : '';
      for (const p of paths) revalidatePath(p);
      return { ok: false, message: `${e.message}${hint}`, requestId: e.requestId };
    }
    if (
      typeof e === 'object' &&
      e &&
      'digest' in e &&
      String((e as { digest: string }).digest).startsWith('NEXT_REDIRECT')
    )
      throw e;
    return { ok: false, message: 'Something went wrong. Nothing was changed; try again.' };
  }
  for (const p of paths) revalidatePath(p);
  return { ok: true, message: okMessage };
}

// ---------------------------------------------------------------- session
export async function loginAction(_: FormState, d: FormData): Promise<FormState> {
  const email = str(d, 'email');
  try {
    const t = await apiLogin(email, String(d.get('password') ?? ''));
    if (t.mfa.required) {
      const code = str(d, 'code');
      if (!/^\d{6}$/.test(code)) {
        return {
          ok: false,
          message: 'Enter the 6-digit code from your authenticator app, then sign in again.',
        };
      }
      const up = await apiVerifyMfa(t.accessToken, t.refreshToken, code);
      await writeSession({ accessToken: up.accessToken, refreshToken: up.refreshToken, email, exp: up.exp });
    } else {
      // Not enrolled yet: signed in at AAL1. Sensitive actions stay refused until MFA is set up (Security page).
      await writeSession({ accessToken: t.accessToken, refreshToken: t.refreshToken, email, exp: t.exp });
    }
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'Sign-in is not available right now.' };
  }
  redirect('/');
}

export async function logoutAction(): Promise<void> {
  const s = await readSession({ allowExpired: true });
  if (s) await apiLogout(s.refreshToken);
  await clearSession();
  redirect('/login');
}

export async function enrollMfaAction(): Promise<{ secret?: string; otpauthUri?: string; error?: string }> {
  const s = await readSession();
  if (!s) redirect('/login');
  try {
    return await apiEnrollMfa(s.accessToken);
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'Could not start enrolment.' };
  }
}

export const verifyMfaAction: Action = async (_, d) => {
  const s = await readSession();
  if (!s) redirect('/login');
  try {
    const up = await apiVerifyMfa(s.accessToken, s.refreshToken, str(d, 'code'));
    await writeSession({
      accessToken: up.accessToken,
      refreshToken: up.refreshToken,
      email: s.email,
      exp: up.exp,
    });
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'That code is not valid.' };
  }
  revalidatePath('/', 'layout');
  return { ok: true, message: 'MFA verified. Sensitive actions are now unlocked for this session.' };
};

export async function requireSession() {
  const s = await readSession();
  if (!s) redirect('/login');
  return s;
}

// ------------------------------------------------------------------ orders
export const orderStatusAction: Action = async (_, d) =>
  run(
    ['/orders', `/orders/${str(d, 'id')}`],
    () =>
      api(`/orders/${str(d, 'id')}/status`, {
        method: 'POST',
        body: {
          to: str(d, 'to'),
          expectedVersion: int(d, 'version'),
          ...(str(d, 'reason') ? { reason: str(d, 'reason') } : {}),
        },
      }),
    'Order updated.',
  );
export const orderCancelAction: Action = async (_, d) =>
  run(
    ['/orders', `/orders/${str(d, 'id')}`],
    () =>
      api(`/orders/${str(d, 'id')}/cancel`, {
        method: 'POST',
        body: { reason: str(d, 'reason'), expectedVersion: int(d, 'version') },
      }),
    'Order cancelled and stock returned.',
  );
export const codCollectedAction: Action = async (_, d) =>
  run(
    [`/orders/${str(d, 'id')}`],
    () =>
      api(`/orders/${str(d, 'id')}/cod-collected`, {
        method: 'POST',
        body: { expectedVersion: int(d, 'version') },
      }),
    'Cash collection recorded.',
  );

// --------------------------------------------------------------- inventory
export const adjustStockAction: Action = async (_, d) =>
  run(
    ['/inventory'],
    () =>
      api(`/inventory/${str(d, 'variantId')}/adjust`, {
        method: 'POST',
        body: { delta: int(d, 'delta'), reason: str(d, 'reason'), expectedVersion: int(d, 'version') },
      }),
    'Stock adjusted and recorded in the ledger.',
  );

// ----------------------------------------------------------------- catalog
export const updateVariantAction: Action = async (_, d) =>
  run(
    ['/catalog'],
    () =>
      api(`/catalog/variants/${str(d, 'id')}`, {
        method: 'PATCH',
        body: {
          pricePaise: rupeesToPaise(str(d, 'price')),
          comparePaise: str(d, 'mrp') ? rupeesToPaise(str(d, 'mrp')) : null,
          active: d.get('active') === 'on',
          reason: str(d, 'reason'),
          expectedUpdatedAt: str(d, 'updatedAt'),
        },
      }),
    'Variant updated.',
  );

// ---------------------------------------------------------------- settings
/** Sends ONLY the fields present in the submitted form, so the policy form and the GST-profile form can share this action. */
export const updateSettingsAction: Action = async (_, d) => {
  const has = (k: string) => d.has(k);
  const blankNull = (k: string) => (str(d, k) ? str(d, k) : null);
  const body: Record<string, unknown> = { expectedVersion: int(d, 'version'), reason: str(d, 'reason') };
  if (has('shippingFee')) body.shippingFeePaise = rupeesToPaise(str(d, 'shippingFee'));
  if (has('freeShipping'))
    body.freeShippingThresholdPaise = str(d, 'freeShipping') ? rupeesToPaise(str(d, 'freeShipping')) : null;
  if (has('policyForm')) {
    body.codEnabled = d.get('cod') === 'on';
    body.onlinePaymentsEnabled = d.get('online') === 'on';
  }
  if (has('codMax')) body.codMaxOrderPaise = str(d, 'codMax') ? rupeesToPaise(str(d, 'codMax')) : null;
  if (has('codFee')) body.codFeePaise = rupeesToPaise(str(d, 'codFee') || '0');
  if (has('gstRate')) body.gstRateBps = Math.round(Number.parseFloat(str(d, 'gstRate') || '0') * 100);
  if (has('taxBasis')) body.taxInclusive = str(d, 'taxBasis') !== 'exclusive';
  if (has('returnDays')) body.returnWindowDays = str(d, 'returnDays') ? int(d, 'returnDays') : null;
  if (has('window')) body.paymentWindowMinutes = str(d, 'window') ? int(d, 'window') : null;
  if (has('merchantLegalName')) body.merchantLegalName = blankNull('merchantLegalName');
  if (has('merchantGstin')) body.merchantGstin = blankNull('merchantGstin');
  if (has('merchantState')) body.merchantState = blankNull('merchantState');
  if (has('merchantAddress')) body.merchantAddress = blankNull('merchantAddress');
  return run(
    ['/settings'],
    () => api('/settings', { method: 'PATCH', body }),
    'Settings saved. Outstanding quotes were invalidated if pricing changed.',
  );
};
export const activateCheckoutAction: Action = async (_, d) =>
  run(
    ['/settings'],
    () =>
      api('/checkout/activate', {
        method: 'POST',
        body: {
          confirm: d.get('confirm') === 'on',
          reason: str(d, 'reason'),
          expectedVersion: int(d, 'version'),
        },
      }),
    'Checkout is now ACTIVE for customers.',
  );
export const disableCheckoutAction: Action = async (_, d) =>
  run(
    ['/settings'],
    () => api('/checkout/disable', { method: 'POST', body: { reason: str(d, 'reason') } }),
    'Checkout disabled.',
  );

// ----------------------------------------------------------------- finance / ops
export const processRefundAction: Action = async (_, d) =>
  run(
    ['/refunds'],
    () => api(`/refunds/${str(d, 'id')}/process`, { method: 'POST' }),
    'Refund submitted to the provider.',
  );
export const replayOutboxAction: Action = async (_, d) =>
  run(
    ['/ops'],
    () => api(`/ops/outbox/${str(d, 'id')}/replay`, { method: 'POST', body: { reason: str(d, 'reason') } }),
    'Event queued for replay.',
  );

// -------------------------------------------------- shipping, returns, moderation, content
export const createShipmentAction: Action = async (_, d) =>
  run(
    [`/orders/${str(d, 'id')}`],
    () =>
      api(`/orders/${str(d, 'id')}/shipments`, {
        method: 'POST',
        body: {
          courier: str(d, 'courier'),
          trackingNumber: str(d, 'trackingNumber'),
          trackingUrl: str(d, 'trackingUrl') || null,
        },
      }),
    'Shipment created; order marked shipped.',
  );
export const shipmentEventAction: Action = async (_, d) =>
  run(
    [`/orders/${str(d, 'orderId')}`],
    () =>
      api(`/shipments/${str(d, 'id')}/events`, {
        method: 'POST',
        body: { status: str(d, 'status'), description: str(d, 'description') || undefined },
      }),
    'Tracking updated.',
  );
export const pinsAction: Action = async (_, d) => {
  const list = (k: string) =>
    str(d, k)
      .split(/[\s,]+/)
      .filter(Boolean);
  return run(
    ['/shipping'],
    () =>
      api('/shipping/pins', {
        method: 'PUT',
        body: { add: list('add'), remove: list('remove'), note: str(d, 'note') || undefined },
      }),
    'Serviceable PIN list updated. Existing quotes were invalidated.',
  );
};
export const decideReturnAction: Action = async (_, d) =>
  run(
    ['/returns'],
    () =>
      api(`/returns/${str(d, 'id')}/decide`, {
        method: 'POST',
        body: { approve: str(d, 'approve') === 'yes', note: str(d, 'reason') },
      }),
    'Decision recorded.',
  );
export const receiveReturnAction: Action = async (_, d) =>
  run(
    ['/returns'],
    () => api(`/returns/${str(d, 'id')}/receive`, { method: 'POST' }),
    'Return received; stock restored once.',
  );
export const moderateReviewAction: Action = async (_, d) =>
  run(
    ['/reviews'],
    () =>
      api(`/reviews/${str(d, 'id')}/moderate`, {
        method: 'POST',
        body: { approve: str(d, 'approve') === 'yes', note: str(d, 'reason') },
      }),
    'Review moderated.',
  );
export const moderateMediaAction: Action = async (_, d) =>
  run(
    ['/reviews'],
    () =>
      api(`/review-media/${str(d, 'id')}/moderate`, {
        method: 'POST',
        body: { approve: str(d, 'approve') === 'yes' },
      }),
    'Photo moderated.',
  );
export const saveContentAction: Action = async (_, d) =>
  run(
    ['/content'],
    () =>
      api(`/content/${str(d, 'slug')}`, {
        method: 'PUT',
        body: {
          kind: str(d, 'kind'),
          title: str(d, 'title'),
          bodyMd: String(d.get('bodyMd') ?? ''),
          ...(str(d, 'version') ? { expectedVersion: int(d, 'version') } : {}),
        },
      }),
    'Saved as a new version (draft until published).',
  );
export const publishContentAction: Action = async (_, d) =>
  run(['/content'], () => api(`/content/${str(d, 'slug')}/publish`, { method: 'POST' }), 'Published.');
