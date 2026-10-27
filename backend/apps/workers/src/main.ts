import { loadConfig } from '@jw/config';
import { createDb } from '@jw/database';
import {
  ConsoleEmailSender,
  createObjectStorage,
  createShippingProvider,
  RazorpayGateway,
  SmtpEmailSender,
  TestPaymentGateway,
  type EmailSender,
  type PaymentGateway,
} from '@jw/integrations';
import { createLogger, outboxLag } from '@jw/observability';
import {
  claimOutbox,
  cleanupIdempotency,
  deliver,
  expireReservations,
  markFailed,
  markPublished,
  notifyHandler,
  processPendingPaymentEvents,
  reconcilePendingAttempts,
  sendDueEmails,
  exp,
  reconcileShipments,
  sweepBulkJobs,
  sweepShippingEvents,
} from '@jw/commerce-domain';

/**
 * Worker process. The database is the source of truth for every unit of work (outbox rows,
 * reservation expiry, unprocessed webhook events, pending payment attempts). Loops here only
 * DISCOVER work; losing Redis or restarting this process loses nothing, because everything
 * unfinished is still in PostgreSQL and is re-discovered on the next tick.
 * (BullMQ is reserved for external-effect fan-out — email/SMS/push — once providers exist.)
 */
const config = loadConfig();
const logger = createLogger(config.LOG_LEVEL, 'workers');
const db = createDb({
  url: config.DATABASE_URL,
  poolMax: config.DB_POOL_MAX,
  statementTimeoutMs: config.DB_STATEMENT_TIMEOUT_MS,
  lockTimeoutMs: config.DB_LOCK_TIMEOUT_MS,
  appName: 'workers',
});
const gateway: PaymentGateway | null =
  config.PAYMENT_PROVIDER === 'razorpay'
    ? new RazorpayGateway({
        keyId: config.RAZORPAY_KEY_ID!,
        keySecret: config.RAZORPAY_KEY_SECRET!,
        webhookSecret: config.RAZORPAY_WEBHOOK_SECRET!,
      })
    : config.PAYMENT_PROVIDER === 'test'
      ? new TestPaymentGateway()
      : null;

// Without SMTP settings nothing leaves the machine: emails are logged instead of sent.
const email: EmailSender = config.SMTP_HOST
  ? new SmtpEmailSender({
      host: config.SMTP_HOST,
      port: config.SMTP_PORT,
      user: config.SMTP_USER,
      pass: config.SMTP_PASS,
      from: config.EMAIL_FROM,
    })
  : new ConsoleEmailSender();

// Shipping provider (null = manual shipments only) and the object store label PDFs live in.
const shipping = createShippingProvider(config);
const storage = createObjectStorage(config);

const id = `worker-${process.pid}`;
let stopping = false;

async function relayOnce() {
  const rows = await claimOutbox(db, id, 50);
  for (const row of rows) {
    try {
      await deliver(db, 'notifications', row, notifyHandler);
      await markPublished(db, row.id);
    } catch (err) {
      logger.error({ outboxId: row.id, event: row.event_type, err: String(err) }, 'outbox delivery failed');
      await markFailed(db, row, String(err));
    }
  }
  const lag = await db.pool.query(
    `SELECT extract(epoch FROM now() - min(created_at)) AS s FROM outbox WHERE published_at IS NULL AND dead_at IS NULL`,
  );
  outboxLag.set(Number(lag.rows[0]?.s ?? 0));
  return rows.length;
}

const tasks: Array<{ name: string; everyMs: number; run: () => Promise<unknown> }> = [
  { name: 'outbox-relay', everyMs: 1_000, run: relayOnce },
  { name: 'email-sender', everyMs: 2_000, run: () => sendDueEmails(db, email) },
  { name: 'reservation-expiry', everyMs: 15_000, run: () => expireReservations(db) },
  { name: 'payment-event-sweep', everyMs: 10_000, run: () => processPendingPaymentEvents(db) },
  {
    name: 'payment-reconcile',
    everyMs: 60_000,
    run: () => (gateway ? reconcilePendingAttempts(db, gateway) : Promise.resolve(0)),
  },
  { name: 'idempotency-cleanup', everyMs: 3_600_000, run: () => cleanupIdempotency(db) },
  // Webhook events that were stored but not applied (handler crashed / was restarted).
  { name: 'shipping-event-sweep', everyMs: 10_000, run: () => sweepShippingEvents(db) },
  {
    name: 'shipping-bulk-sweep',
    everyMs: 15_000,
    run: () => (shipping ? sweepBulkJobs({ db, provider: shipping, storage }) : Promise.resolve(0)),
  },
  // Missed webhooks: poll active shipments that have been silent for a while.
  {
    name: 'shipping-reconcile',
    everyMs: 1_800_000,
    run: () => (shipping ? reconcileShipments(db, shipping) : Promise.resolve(0)),
  },
  // Scheduled Studio releases: keeps statuses honest (the public view already serves a due release on time).
  {
    name: 'experience-activate',
    everyMs: 30_000,
    run: () => db.tx({ kind: 'system', reason: 'experience-activate' }, (c) => exp.activateDueReleases(c)),
  },
];

for (const t of tasks) {
  const loop = async () => {
    while (!stopping) {
      try {
        const n = await t.run();
        if (n) logger.info({ task: t.name, handled: n }, 'task tick');
      } catch (err) {
        logger.error({ task: t.name, err: String(err) }, 'task failed');
      }
      await new Promise((r) => setTimeout(r, t.everyMs));
    }
  };
  void loop();
}
logger.info({ id, tasks: tasks.map((t) => t.name) }, 'workers started');

async function shutdown() {
  stopping = true;
  setTimeout(async () => {
    await db.close().catch(() => undefined);
    process.exit(0);
  }, 2_000);
}
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
