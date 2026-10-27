import 'server-only';
import { redirect } from 'next/navigation';
import { readSession } from './session';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly requestId?: string,
    readonly lines?: unknown[],
  ) {
    super(message);
  }
}

const BASE = () => process.env.COMMERCE_API_URL ?? 'http://127.0.0.1:4000';

/** Server-side call to the Express admin API. Business rules live THERE; this only forwards the operator's token. */
export async function api<T = unknown>(
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  const s = await readSession();
  if (!s) redirect('/login');
  const res = await fetch(`${BASE()}/v1/admin${path}`, {
    method: init.method ?? 'GET',
    headers: {
      authorization: `Bearer ${s.accessToken}`,
      ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    cache: 'no-store',
    signal: AbortSignal.timeout(10_000),
  });
  if (res.status === 401) redirect('/login?expired=1');
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const e = json?.error ?? {};
    throw new ApiError(res.status, e.code ?? 'INTERNAL', e.message ?? 'Request failed', e.requestId, e.lines);
  }
  return json as T;
}

export interface Me {
  userId: string;
  role: string;
  permissions: string[];
  mfa: boolean;
}
export const inr = (paise: number) =>
  `₹${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
