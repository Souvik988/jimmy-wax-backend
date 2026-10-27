import { pino, type Logger } from 'pino';
import client from 'prom-client';

const REDACT = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-razorpay-signature"]',
  '*.password',
  '*.token',
  '*.phone',
  '*.line1',
];

export function createLogger(level = 'info', name = 'jw'): Logger {
  return pino({ level, name, redact: { paths: REDACT, censor: '[redacted]' } });
}

export const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry });

// Low-cardinality labels only: never user or order IDs.
export const httpDuration = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request latency by route template',
  labelNames: ['method', 'route', 'status'] as const,
  buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [registry],
});
export const dbPoolGauge = new client.Gauge({
  name: 'db_pool_connections',
  help: 'pg pool connections by state',
  labelNames: ['state'] as const,
  registers: [registry],
});
export const outboxLag = new client.Gauge({
  name: 'outbox_oldest_pending_age_seconds',
  help: 'Age of the oldest unpublished outbox row',
  registers: [registry],
});
export const businessCounter = new client.Counter({
  name: 'commerce_events_total',
  help: 'Business events (orders, payments, reservations) by outcome',
  labelNames: ['event', 'outcome'] as const,
  registers: [registry],
});
export type { Logger };

/** Publishes pg pool state (total/idle/waiting) every few seconds; 'waiting' > 0 means requests queue for connections. */
export function watchPool(
  pool: { totalCount: number; idleCount: number; waitingCount: number },
  everyMs = 5000,
) {
  const t = setInterval(() => {
    dbPoolGauge.set({ state: 'total' }, pool.totalCount);
    dbPoolGauge.set({ state: 'idle' }, pool.idleCount);
    dbPoolGauge.set({ state: 'waiting' }, pool.waitingCount);
  }, everyMs);
  t.unref();
  return () => clearInterval(t);
}
