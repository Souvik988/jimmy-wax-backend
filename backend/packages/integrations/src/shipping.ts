import { createHash, timingSafeEqual, randomUUID } from 'node:crypto';
import { WebhookVerificationError } from './index.ts';

/**
 * Shipping provider boundary. Callers (domain code) never talk HTTP: they use this interface, so the manual flow,
 * the scripted FakeShippingProvider (tests/dev) and Shiprocket are interchangeable.
 * Money is integer paise, weights grams, dimensions millimetres (converted to the provider's units inside the adapter).
 */
export type ShippingErrorCode =
  | 'not_serviceable'
  | 'wallet_low'
  | 'auth'
  | 'rate_limited'
  | 'invalid_request'
  | 'not_found'
  | 'unavailable'
  | 'unknown';

export class ShippingError extends Error {
  constructor(
    readonly code: ShippingErrorCode,
    message: string,
    /** Safe to retry the SAME call later (timeouts, 5xx, rate limits). */
    readonly retryable = false,
  ) {
    super(message);
  }
}

export interface PackageDims {
  weightGrams: number;
  lengthMm: number;
  widthMm: number;
  heightMm: number;
}
export interface ShipmentItem {
  name: string;
  sku: string;
  units: number;
  /** GST-inclusive unit selling price (our prices are tax-inclusive). */
  sellingPricePaise: number;
  hsn: string | null;
  /** GST contained in one unit's price. */
  taxPaise: number;
}
export interface ShipmentAddress {
  name: string;
  phone: string;
  email: string | null;
  line1: string;
  line2: string;
  city: string;
  state: string;
  pincode: string;
}
export interface ShipmentRequest {
  /** Our idempotent reference (JW-<orderNumber>[-Rn]); the provider's own order id is separate. */
  reference: string;
  orderDate: Date;
  pickupLocation: string;
  address: ShipmentAddress;
  items: ShipmentItem[];
  paymentMethod: 'prepaid' | 'cod';
  /** Order value to show on the label (items − discount + shipping + COD fee, GST included). */
  orderTotalPaise: number;
  /** What the courier must collect. 0 for prepaid; equals the order total for COD. */
  codAmountPaise: number;
  package: PackageDims;
}
export interface ServiceabilityQuery {
  pickupPin: string;
  deliveryPin: string;
  weightGrams: number;
  cod: boolean;
  declaredValuePaise: number;
}
export interface CourierOption {
  courierId: string;
  name: string;
  freightPaise: number;
  codChargesPaise: number;
  etdDays: number | null;
  etd: string | null;
  rating: number | null;
}
export interface ProviderOrderRef {
  providerOrderId: string;
  providerShipmentId: string;
}
export interface AwbAssignment {
  awb: string;
  courierId: string;
  courierName: string;
  chargesPaise: number | null;
}
export interface TrackingEvent {
  status: string;
  statusId: number | null;
  activity: string;
  location: string;
  at: string; // ISO
}
export interface TrackingResult {
  awb: string;
  currentStatus: string;
  currentStatusId: number | null;
  etd: string | null;
  events: TrackingEvent[];
}
export interface ProviderWebhook {
  dedupeKey: string;
  awb: string;
  currentStatus: string;
  currentStatusId: number | null;
  occurredAt: string;
  etd: string | null;
  isReturn: boolean;
  events: TrackingEvent[];
  payload: unknown;
}

export interface ShippingProvider {
  readonly name: 'shiprocket' | 'fake';
  checkServiceability(q: ServiceabilityQuery): Promise<{ serviceable: boolean; couriers: CourierOption[] }>;
  listPickupLocations(): Promise<string[]>;
  walletBalancePaise(): Promise<number | null>;
  /** Recover from a timeout after the provider accepted the order: look it up by OUR reference before creating again. */
  findOrderByReference(reference: string): Promise<ProviderOrderRef | null>;
  createOrder(req: ShipmentRequest): Promise<ProviderOrderRef>;
  assignAwb(providerShipmentId: string, courierId?: string): Promise<AwbAssignment>;
  schedulePickup(providerShipmentId: string): Promise<{ scheduledFor: string | null }>;
  /** Returns the label PDF bytes (provider-hosted URLs are fetched server-side and never exposed to browsers). */
  fetchLabel(providerShipmentId: string): Promise<Buffer>;
  fetchManifest(providerShipmentIds: string[]): Promise<Buffer>;
  track(awb: string): Promise<TrackingResult>;
  cancel(args: { providerOrderId: string; awb?: string }): Promise<void>;
  createReturn(args: {
    reference: string;
    originalProviderOrderId: string;
    package: PackageDims;
    pickup?: ShipmentAddress;
    drop?: ShipmentAddress;
    items?: ShipmentItem[];
  }): Promise<ProviderOrderRef>;
  verifyWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): ProviderWebhook;
}

const safeEq = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

// ------------------------------------------------------------------ status mapping
/** Our shipment statuses (DB check constraint mirrors this list). */
export const SHIPMENT_STATUS_ORDER = [
  'pending_provider',
  'label_created',
  'awb_assigned',
  'pickup_scheduled',
  'picked_up',
  'in_transit',
  'out_for_delivery',
  'delivered',
] as const;
export const EXCEPTION_STATUSES = [
  'undelivered',
  'rto_initiated',
  'rto_in_transit',
  'returned_to_origin',
  'cancelled',
  'lost',
  'damaged',
  'failed',
] as const;
export type NormalStatus = (typeof SHIPMENT_STATUS_ORDER)[number] | (typeof EXCEPTION_STATUSES)[number];

/**
 * Normalise a provider status BY NAME (case/space-insensitive). The id table is not assumed complete: unknown names
 * return null and the caller stores the raw status and raises an alert instead of guessing.
 * The names below come from Shiprocket's webhook sample (MANIFEST GENERATED, PICKED UP, SHIPPED, IN TRANSIT) plus the
 * conventional status vocabulary — VERIFY against the live status list before relying on the unmapped ones.
 */
export function normaliseStatus(raw: string): NormalStatus | null {
  const s = raw
    .trim()
    .toUpperCase()
    .replace(/[_\s]+/g, ' ');
  const map: Record<string, NormalStatus> = {
    NEW: 'pending_provider',
    'READY TO SHIP': 'awb_assigned',
    'AWB ASSIGNED': 'awb_assigned',
    'MANIFEST GENERATED': 'pickup_scheduled',
    'PICKUP SCHEDULED': 'pickup_scheduled',
    'PICKUP GENERATED': 'pickup_scheduled',
    'PICKUP QUEUED': 'pickup_scheduled',
    'PICKUP RESCHEDULED': 'pickup_scheduled',
    'OUT FOR PICKUP': 'pickup_scheduled',
    'PICKED UP': 'picked_up',
    SHIPPED: 'picked_up',
    'IN TRANSIT': 'in_transit',
    'REACHED AT DESTINATION HUB': 'in_transit',
    'REACHED DESTINATION HUB': 'in_transit',
    MISROUTED: 'in_transit',
    'OUT FOR DELIVERY': 'out_for_delivery',
    DELIVERED: 'delivered',
    UNDELIVERED: 'undelivered',
    'UNDELIVERED 1ST ATTEMPT': 'undelivered',
    'UNDELIVERED 2ND ATTEMPT': 'undelivered',
    'UNDELIVERED 3RD ATTEMPT': 'undelivered',
    'RTO INITIATED': 'rto_initiated',
    'RTO NDR': 'rto_initiated',
    'RTO IN TRANSIT': 'rto_in_transit',
    'RTO OFD': 'rto_in_transit',
    'RTO DELIVERED': 'returned_to_origin',
    CANCELED: 'cancelled',
    CANCELLED: 'cancelled',
    LOST: 'lost',
    DAMAGED: 'damaged',
    DESTROYED: 'damaged',
  };
  return map[s] ?? null;
}

/** Provider timestamps look like "23 05 2023 11:43:52" (webhook sample). Timezone is UNVERIFIED; IST is assumed. */
export function parseProviderDate(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const m = /^(\d{2}) (\d{2}) (\d{4}) (\d{2}):(\d{2}):(\d{2})$/.exec(raw.trim());
  if (m) return new Date(`${m[3]}-${m[2]}-${m[1]}T${m[4]}:${m[5]}:${m[6]}+05:30`).toISOString();
  const m2 = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(raw.trim());
  if (m2) return new Date(`${m2[1]}-${m2[2]}-${m2[3]}T${m2[4]}:${m2[5]}:${m2[6]}+05:30`).toISOString();
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// ------------------------------------------------------------------ fake provider
/** Deterministic, scriptable provider for tests and local development. NOT evidence of live Shiprocket behaviour. */
export class FakeShippingProvider implements ShippingProvider {
  readonly name = 'fake' as const;
  readonly orders = new Map<
    string,
    { ref: ProviderOrderRef; req: ShipmentRequest; awb?: string; cancelled?: boolean }
  >();
  readonly calls: string[] = [];
  balancePaise: number | null = 500_000;
  unserviceablePins = new Set<string>();
  couriers: CourierOption[] = [
    {
      courierId: '10',
      name: 'FastCourier Air',
      freightPaise: 9500,
      codChargesPaise: 3000,
      etdDays: 2,
      etd: null,
      rating: 4.4,
    },
    {
      courierId: '11',
      name: 'ValueExpress Surface',
      freightPaise: 6200,
      codChargesPaise: 2500,
      etdDays: 5,
      etd: null,
      rating: 4.1,
    },
    {
      courierId: '12',
      name: 'MidWay Standard',
      freightPaise: 7400,
      codChargesPaise: 2800,
      etdDays: 3,
      etd: null,
      rating: 4.6,
    },
  ];
  /** one-shot failure hooks */
  failNext: Partial<
    Record<'createOrder' | 'assignAwb' | 'schedulePickup' | 'fetchLabel' | 'cancel' | 'track', ShippingError>
  > = {};
  /** createOrder succeeds at the provider but the caller sees a timeout */
  timeoutAfterCreate = false;
  readonly webhookSecret: string;
  private seq = 1000;
  constructor(webhookSecret = 'fake-shipping-secret') {
    this.webhookSecret = webhookSecret;
  }
  private hit<K extends keyof FakeShippingProvider['failNext']>(k: K) {
    this.calls.push(k);
    const e = this.failNext[k];
    if (e) {
      delete this.failNext[k];
      throw e;
    }
  }
  async checkServiceability(q: ServiceabilityQuery) {
    this.calls.push('checkServiceability');
    if (this.unserviceablePins.has(q.deliveryPin)) return { serviceable: false, couriers: [] };
    return {
      serviceable: true,
      couriers: this.couriers.map((c) => ({ ...c, codChargesPaise: q.cod ? c.codChargesPaise : 0 })),
    };
  }
  async listPickupLocations() {
    return ['Primary warehouse'];
  }
  async walletBalancePaise() {
    return this.balancePaise;
  }
  async findOrderByReference(reference: string) {
    this.calls.push('findOrderByReference');
    return this.orders.get(reference)?.ref ?? null;
  }
  async createOrder(req: ShipmentRequest) {
    this.hit('createOrder');
    const existing = this.orders.get(req.reference);
    if (existing) return existing.ref; // the real API may create a duplicate; the domain never calls twice
    const ref = { providerOrderId: `FO${++this.seq}`, providerShipmentId: `FS${this.seq}` };
    this.orders.set(req.reference, { ref, req });
    if (this.timeoutAfterCreate) {
      this.timeoutAfterCreate = false;
      throw new ShippingError('unavailable', 'simulated timeout after the provider accepted the order', true);
    }
    return ref;
  }
  private byShipment(id: string) {
    for (const o of this.orders.values()) if (o.ref.providerShipmentId === id) return o;
    throw new ShippingError('not_found', 'unknown shipment');
  }
  async assignAwb(providerShipmentId: string, courierId?: string) {
    this.hit('assignAwb');
    if (this.balancePaise !== null && this.balancePaise < 10000)
      throw new ShippingError('wallet_low', 'Insufficient wallet balance');
    const o = this.byShipment(providerShipmentId);
    const c = this.couriers.find((x) => x.courierId === courierId) ?? this.couriers[0]!;
    o.awb = o.awb ?? `AWB${randomUUID().slice(0, 8).toUpperCase()}`;
    return { awb: o.awb, courierId: c.courierId, courierName: c.name, chargesPaise: c.freightPaise };
  }
  async schedulePickup(providerShipmentId: string) {
    this.hit('schedulePickup');
    this.byShipment(providerShipmentId);
    return { scheduledFor: new Date(Date.now() + 86_400_000).toISOString() };
  }
  async fetchLabel(providerShipmentId: string) {
    this.hit('fetchLabel');
    this.byShipment(providerShipmentId);
    return Buffer.from(`%PDF-1.4\n% fake label ${providerShipmentId}\n%%EOF\n`);
  }
  async fetchManifest(ids: string[]) {
    this.calls.push('fetchManifest');
    return Buffer.from(`%PDF-1.4\n% fake manifest ${ids.join(',')}\n%%EOF\n`);
  }
  async track(awb: string): Promise<TrackingResult> {
    this.hit('track');
    return {
      awb,
      currentStatus: 'IN TRANSIT',
      currentStatusId: 18,
      etd: null,
      events: [
        {
          status: 'IN TRANSIT',
          statusId: 18,
          activity: 'In transit',
          location: 'Hub',
          at: new Date().toISOString(),
        },
      ],
    };
  }
  async cancel(args: { providerOrderId: string; awb?: string }) {
    this.hit('cancel');
    for (const o of this.orders.values())
      if (o.ref.providerOrderId === args.providerOrderId) o.cancelled = true;
  }
  async createReturn(args: { reference: string; originalProviderOrderId: string }) {
    this.calls.push('createReturn');
    const ref = { providerOrderId: `FR${++this.seq}`, providerShipmentId: `FRS${this.seq}` };
    return ref;
  }
  sign(): string {
    return this.webhookSecret;
  }
  verifyWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): ProviderWebhook {
    return parseShiprocketWebhook(rawBody, headers, this.webhookSecret);
  }
}

// ------------------------------------------------------------------ webhook parsing
interface SrScan {
  date?: string;
  status?: string;
  activity?: string;
  location?: string;
  'sr-status'?: string;
  'sr-status-label'?: string;
}
/**
 * Parses the webhook payload shape seen in Shiprocket's sample (awb, current_status, current_status_id,
 * current_timestamp, scans[], etd, is_return, ...). The authentication mechanism (here: a shared token in the
 * `x-api-key` header) is UNVERIFIED and must be confirmed against Shiprocket's webhook settings.
 */
export function parseShiprocketWebhook(
  rawBody: Buffer,
  headers: Record<string, string | string[] | undefined>,
  secret: string,
): ProviderWebhook {
  const token = String(headers['x-api-key'] ?? '');
  if (!secret || !token || !safeEq(token, secret)) throw new WebhookVerificationError('bad webhook token');
  let b: Record<string, unknown>;
  try {
    b = JSON.parse(rawBody.toString('utf8')) as Record<string, unknown>;
  } catch {
    throw new WebhookVerificationError('malformed body');
  }
  const awb = String(b.awb ?? '');
  const cs = String(b.current_status ?? b.shipment_status ?? '');
  if (!awb || !cs) throw new WebhookVerificationError('missing awb/status');
  const ts = parseProviderDate(b.current_timestamp as string) ?? new Date().toISOString();
  const id = b.current_status_id !== undefined ? Number(b.current_status_id) : null;
  const scans = ((b.scans as SrScan[] | undefined) ?? []).slice(0, 200);
  return {
    dedupeKey: createHash('sha256')
      .update(`${awb}|${id ?? cs}|${b.current_timestamp ?? ts}`)
      .digest('hex'),
    awb,
    currentStatus: cs,
    currentStatusId: id,
    occurredAt: ts,
    etd: parseProviderDate(b.etd as string),
    isReturn: Number(b.is_return ?? 0) === 1,
    events: scans.map((s) => ({
      status: String(
        s['sr-status-label'] && s['sr-status-label'] !== 'NA' ? s['sr-status-label'] : (s.status ?? ''),
      ),
      statusId: s['sr-status'] && s['sr-status'] !== 'NA' ? Number(s['sr-status']) : null,
      activity: String(s.activity ?? ''),
      location: String(s.location ?? ''),
      at: parseProviderDate(s.date) ?? ts,
    })),
    payload: b,
  };
}

// ------------------------------------------------------------------ Shiprocket
/**
 * Shiprocket adapter. Verified from Shiprocket's API helpsheet: base URL, API-user login (token valid ~10 days, sent as
 * Bearer), and the call flow serviceability → orders/create/adhoc → courier/assign/awb → courier/generate/pickup →
 * courier/generate/label → manifests → track/awb. Request/response FIELD NAMES, cancel/return/pickup-location/wallet
 * endpoints and the webhook auth mechanism are written from general knowledge and are UNVERIFIED against a live account
 * (the official docs site was unreachable when this was written). Everything is covered by tests against a mocked
 * transport only; do NOT treat this as proof of live behaviour.
 */
/** Labels and manifests are small PDFs. */
export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;
/** Hosts Shiprocket serves label/manifest documents from (its own domains and the S3 buckets behind them). */
const DOCUMENT_HOST_SUFFIXES = ['shiprocket.in', 'shiprocket.co', 'shipmultichannel.com', 'amazonaws.com'];

/**
 * SSRF guard for server-side document downloads: https only, a registered DNS name (never an IP literal, localhost or a
 * single-label/internal name), no credentials, and the host must belong to the provider's document hosts.
 */
export function isSafeDocumentUrl(raw: string, extraHostSuffixes: string[] = []): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' || u.username || u.password) return false;
  if (u.port && u.port !== '443') return false;
  const h = u.hostname.toLowerCase();
  if (!h.includes('.') || /^[0-9.]+$/.test(h) || h.includes(':') || h.startsWith('[')) return false;
  if (/(^|\.)(localhost|local|internal|lan|home|corp)$/.test(h)) return false;
  return [...DOCUMENT_HOST_SUFFIXES, ...extraHostSuffixes].some((s) => h === s || h.endsWith(`.${s}`));
}

export class ShiprocketProvider implements ShippingProvider {
  readonly name = 'shiprocket' as const;
  private token: { value: string; expiresAt: number } | null = null;
  private refreshing: Promise<string> | null = null;
  constructor(
    private readonly cfg: {
      email?: string;
      password?: string;
      apiToken?: string;
      webhookToken: string;
      baseUrl?: string;
      timeoutMs?: number;
    },
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}
  private url(p: string) {
    return `${this.cfg.baseUrl ?? 'https://apiv2.shiprocket.in'}${p}`;
  }
  /** Single-flight login; refreshed well before the documented 240 h expiry. */
  private async auth(force = false): Promise<string> {
    if (this.cfg.apiToken) {
      if (force)
        throw new ShippingError(
          'auth',
          'Shiprocket token expired or was rejected; replace the server-side token',
          false,
        );
      return this.cfg.apiToken;
    }
    if (!force && this.token && this.token.expiresAt > Date.now() + 3600_000) return this.token.value;
    this.refreshing ??= (async () => {
      const res = await this.fetchImpl(this.url('/v1/external/auth/login'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: this.cfg.email, password: this.cfg.password }),
        signal: AbortSignal.timeout(this.cfg.timeoutMs ?? 10_000),
      });
      if (!res.ok) throw new ShippingError('auth', `Shiprocket login failed (${res.status})`, false);
      const j = (await res.json()) as { token?: string };
      if (!j.token) throw new ShippingError('auth', 'Shiprocket login returned no token', false);
      this.token = { value: j.token, expiresAt: Date.now() + 9 * 24 * 3600_000 }; // documented 10 days; refresh at 9
      return j.token;
    })().finally(() => (this.refreshing = null));
    return this.refreshing;
  }
  private async call<T>(method: 'GET' | 'POST', path: string, body?: unknown, retried = false): Promise<T> {
    const token = await this.auth(retried);
    let res: Response;
    try {
      res = await this.fetchImpl(this.url(path), {
        method,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.cfg.timeoutMs ?? 12_000),
      });
    } catch (e) {
      throw new ShippingError('unavailable', `Shiprocket unreachable: ${(e as Error).name}`, true);
    }
    if (res.status === 401 && !retried) return this.call<T>(method, path, body, true);
    const text = await res.text();
    let json: Record<string, unknown> = {};
    try {
      json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      /* non-JSON error body */
    }
    if (!res.ok) {
      const msg = String(json.message ?? json.error ?? `HTTP ${res.status}`);
      if (res.status === 429) throw new ShippingError('rate_limited', msg, true);
      if (res.status >= 500) throw new ShippingError('unavailable', msg, true);
      if (/balance|recharge|wallet/i.test(msg)) throw new ShippingError('wallet_low', msg, false);
      if (/serviceab|pincode/i.test(msg)) throw new ShippingError('not_serviceable', msg, false);
      if (res.status === 404) throw new ShippingError('not_found', msg, false);
      if (res.status === 401 || res.status === 403) throw new ShippingError('auth', msg, false);
      throw new ShippingError('invalid_request', msg, false);
    }
    return json as T;
  }
  private async download(url: string): Promise<Buffer> {
    if (!isSafeDocumentUrl(url))
      throw new ShippingError(
        'invalid_request',
        'Provider returned a document URL outside the allowed hosts',
      );
    // redirects are refused: an allowed host must not be able to bounce the server to an internal address
    const res = await this.fetchImpl(url, { signal: AbortSignal.timeout(20_000), redirect: 'error' });
    if (!res.ok) throw new ShippingError('unavailable', `Document download failed (${res.status})`, true);
    const declared = Number(res.headers.get('content-length') ?? 0);
    if (declared > MAX_DOCUMENT_BYTES)
      throw new ShippingError('invalid_request', 'Provider document is too large');
    const data = Buffer.from(await res.arrayBuffer());
    if (data.length > MAX_DOCUMENT_BYTES)
      throw new ShippingError('invalid_request', 'Provider document is too large');
    return data;
  }

  async checkServiceability(q: ServiceabilityQuery) {
    const qs = new URLSearchParams({
      pickup_postcode: q.pickupPin,
      delivery_postcode: q.deliveryPin,
      weight: String(Math.max(q.weightGrams, 1) / 1000),
      cod: q.cod ? '1' : '0',
      declared_value: String(Math.round(q.declaredValuePaise / 100)),
    });
    const r = await this.call<{ data?: { available_courier_companies?: Array<Record<string, unknown>> } }>(
      'GET',
      `/v1/external/courier/serviceability/?${qs}`,
    );
    const list = r.data?.available_courier_companies ?? [];
    const couriers: CourierOption[] = list.map((c) => ({
      courierId: String(c.courier_company_id),
      name: String(c.courier_name),
      freightPaise: Math.round(Number(c.rate ?? c.freight_charge ?? 0) * 100),
      codChargesPaise: Math.round(Number(c.cod_charges ?? 0) * 100),
      etdDays: c.estimated_delivery_days != null ? Number(c.estimated_delivery_days) : null,
      etd: c.etd ? String(c.etd) : null,
      rating: c.rating != null ? Number(c.rating) : null,
    }));
    return { serviceable: couriers.length > 0, couriers };
  }
  async listPickupLocations() {
    const r = await this.call<{ data?: { shipping_address?: Array<{ pickup_location?: string }> } }>(
      'GET',
      '/v1/external/settings/company/pickup',
    );
    return (r.data?.shipping_address ?? []).map((a) => String(a.pickup_location)).filter(Boolean);
  }
  async walletBalancePaise() {
    try {
      const r = await this.call<{ data?: { balance_amount?: number } }>(
        'GET',
        '/v1/external/account/details/wallet-balance',
      );
      return r.data?.balance_amount != null ? Math.round(Number(r.data.balance_amount) * 100) : null;
    } catch {
      return null; // endpoint unverified; absence must not block shipping
    }
  }
  async findOrderByReference(reference: string) {
    try {
      const r = await this.call<{
        data?: Array<{ id?: number; channel_order_id?: string; shipments?: Array<{ id?: number }> }>;
      }>('GET', `/v1/external/orders?channel_order_id=${encodeURIComponent(reference)}`);
      const hit = r.data?.find((o) => o.channel_order_id === reference);
      const sid = hit?.shipments?.[0]?.id;
      return hit?.id && sid ? { providerOrderId: String(hit.id), providerShipmentId: String(sid) } : null;
    } catch (e) {
      if (e instanceof ShippingError && e.code === 'not_found') return null;
      throw e;
    }
  }
  async createOrder(req: ShipmentRequest) {
    const a = req.address;
    const rupees = (p: number) => Math.round(p) / 100;
    const r = await this.call<{ order_id?: number; shipment_id?: number }>(
      'POST',
      '/v1/external/orders/create/adhoc',
      {
        order_id: req.reference,
        order_date: req.orderDate.toISOString().slice(0, 16).replace('T', ' '),
        pickup_location: req.pickupLocation,
        billing_customer_name: a.name.split(' ')[0] ?? a.name,
        billing_last_name: a.name.split(' ').slice(1).join(' '),
        billing_address: a.line1,
        billing_address_2: a.line2,
        billing_city: a.city,
        billing_pincode: a.pincode,
        billing_state: a.state,
        billing_country: 'India',
        billing_email: a.email ?? '',
        billing_phone: a.phone.replace(/\D/g, '').slice(-10),
        shipping_is_billing: true,
        order_items: req.items.map((i) => ({
          name: i.name,
          sku: i.sku,
          units: i.units,
          selling_price: rupees(i.sellingPricePaise),
          tax: rupees(i.taxPaise),
          hsn: i.hsn ?? '',
        })),
        payment_method: req.paymentMethod === 'cod' ? 'COD' : 'Prepaid',
        sub_total: rupees(req.paymentMethod === 'cod' ? req.codAmountPaise : req.orderTotalPaise),
        length: Math.max(1, Math.round(req.package.lengthMm / 10)),
        breadth: Math.max(1, Math.round(req.package.widthMm / 10)),
        height: Math.max(1, Math.round(req.package.heightMm / 10)),
        weight: Math.max(0.01, req.package.weightGrams / 1000),
      },
    );
    if (!r.order_id || !r.shipment_id)
      throw new ShippingError('invalid_request', 'Shiprocket did not return order/shipment ids');
    return { providerOrderId: String(r.order_id), providerShipmentId: String(r.shipment_id) };
  }
  async assignAwb(providerShipmentId: string, courierId?: string) {
    const r = await this.call<{
      response?: {
        data?: {
          awb_code?: string;
          courier_company_id?: number;
          courier_name?: string;
          freight_charges?: number;
        };
      };
    }>('POST', '/v1/external/courier/assign/awb', {
      shipment_id: providerShipmentId,
      ...(courierId ? { courier_id: courierId } : {}),
    });
    const d = r.response?.data;
    if (!d?.awb_code) throw new ShippingError('invalid_request', 'Courier assignment returned no AWB');
    return {
      awb: d.awb_code,
      courierId: String(d.courier_company_id ?? courierId ?? ''),
      courierName: String(d.courier_name ?? ''),
      chargesPaise: d.freight_charges != null ? Math.round(d.freight_charges * 100) : null,
    };
  }
  async schedulePickup(providerShipmentId: string) {
    const r = await this.call<{ response?: { pickup_scheduled_date?: string } }>(
      'POST',
      '/v1/external/courier/generate/pickup',
      { shipment_id: [providerShipmentId] },
    );
    return { scheduledFor: parseProviderDate(r.response?.pickup_scheduled_date) };
  }
  async fetchLabel(providerShipmentId: string) {
    const r = await this.call<{ label_url?: string }>('POST', '/v1/external/courier/generate/label', {
      shipment_id: [providerShipmentId],
    });
    if (!r.label_url) throw new ShippingError('unavailable', 'Label not ready yet', true);
    return this.download(r.label_url);
  }
  async fetchManifest(ids: string[]) {
    await this.call('POST', '/v1/external/manifests/generate', { shipment_id: ids });
    const r = await this.call<{ manifest_url?: string }>('POST', '/v1/external/manifests/print', {
      order_ids: ids,
    });
    if (!r.manifest_url) throw new ShippingError('unavailable', 'Manifest not ready yet', true);
    return this.download(r.manifest_url);
  }
  async track(awb: string): Promise<TrackingResult> {
    const r = await this.call<{
      tracking_data?: {
        shipment_status?: number;
        shipment_track?: Array<{ current_status?: string }>;
        shipment_track_activities?: Array<{
          date?: string;
          status?: string;
          activity?: string;
          location?: string;
          'sr-status'?: string;
        }>;
        etd?: string;
      };
    }>('GET', `/v1/external/courier/track/awb/${encodeURIComponent(awb)}`);
    const t = r.tracking_data ?? {};
    const acts = t.shipment_track_activities ?? [];
    return {
      awb,
      currentStatus: String(t.shipment_track?.[0]?.current_status ?? acts[0]?.activity ?? ''),
      currentStatusId: t.shipment_status != null ? Number(t.shipment_status) : null,
      etd: parseProviderDate(t.etd),
      events: acts.map((a) => ({
        status: String(a.activity ?? a.status ?? ''),
        statusId: a['sr-status'] ? Number(a['sr-status']) : null,
        activity: String(a.activity ?? ''),
        location: String(a.location ?? ''),
        at: parseProviderDate(a.date) ?? new Date().toISOString(),
      })),
    };
  }
  async cancel(args: { providerOrderId: string; awb?: string }) {
    await this.call('POST', '/v1/external/orders/cancel', { ids: [Number(args.providerOrderId)] });
  }
  async createReturn(args: {
    reference: string;
    originalProviderOrderId: string;
    package: PackageDims;
    pickup?: ShipmentAddress;
    drop?: ShipmentAddress;
    items?: ShipmentItem[];
  }): Promise<ProviderOrderRef> {
    if (!args.pickup || !args.drop || !args.items?.length)
      throw new ShippingError(
        'invalid_request',
        'Return pickup needs the buyer address, warehouse return address and selected order lines',
      );
    const party = (prefix: string, a: ShipmentAddress) => ({
      [prefix + '_customer_name']: a.name,
      [prefix + '_address']: a.line1,
      [prefix + '_address_2']: a.line2,
      [prefix + '_city']: a.city,
      [prefix + '_state']: a.state,
      [prefix + '_country']: 'India',
      [prefix + '_pincode']: a.pincode,
      [prefix + '_phone']: a.phone,
      [prefix + '_email']: a.email ?? '',
    });
    const data = await this.call<Record<string, unknown>>('POST', '/v1/external/orders/create/return', {
      order_id: args.reference,
      existing_order_id: Number(args.originalProviderOrderId),
      order_date: new Date().toISOString().slice(0, 10),
      ...party('pickup', args.pickup),
      ...party('shipping', args.drop),
      payment_method: 'Prepaid',
      sub_total: args.items.reduce((n, i) => n + i.sellingPricePaise * i.units, 0) / 100,
      order_items: args.items.map((i) => ({
        name: i.name,
        sku: i.sku,
        units: i.units,
        selling_price: i.sellingPricePaise / 100,
        tax: i.taxPaise / 100,
        hsn: i.hsn ?? '',
      })),
      length: args.package.lengthMm / 10,
      breadth: args.package.widthMm / 10,
      height: args.package.heightMm / 10,
      weight: args.package.weightGrams / 1000,
    });
    if (!data.order_id || !data.shipment_id)
      throw new ShippingError(
        'unavailable',
        'Shiprocket did not confirm return order and shipment IDs; reconcile before retrying',
        true,
      );
    return { providerOrderId: String(data.order_id), providerShipmentId: String(data.shipment_id) };
  }
  verifyWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): ProviderWebhook {
    return parseShiprocketWebhook(rawBody, headers, this.cfg.webhookToken);
  }
}

/** Builds the configured provider (null = manual shipments only). */
export function createShippingProvider(cfg: {
  SHIPPING_PROVIDER: 'none' | 'fake' | 'shiprocket';
  SHIPROCKET_EMAIL?: string;
  SHIPROCKET_PASSWORD?: string;
  SHIPROCKET_API_TOKEN?: string;
  SHIPROCKET_WEBHOOK_TOKEN?: string;
  SHIPROCKET_BASE_URL?: string;
}): ShippingProvider | null {
  if (cfg.SHIPPING_PROVIDER === 'fake') return new FakeShippingProvider();
  if (cfg.SHIPPING_PROVIDER === 'shiprocket')
    return new ShiprocketProvider({
      email: cfg.SHIPROCKET_EMAIL!,
      password: cfg.SHIPROCKET_PASSWORD!,
      apiToken: cfg.SHIPROCKET_API_TOKEN,
      webhookToken: cfg.SHIPROCKET_WEBHOOK_TOKEN!,
      baseUrl: cfg.SHIPROCKET_BASE_URL,
    });
  return null;
}
