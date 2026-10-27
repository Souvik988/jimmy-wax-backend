import type { Db, PoolClient } from '@jw/database';
import { emailTemplates, renderEmail, type EmailSender } from '@jw/integrations';
import type { Handler } from './ops.ts';

export async function queueEmail(
  c: PoolClient,
  e: { dedupeKey?: string; to: string; template: string; payload: Record<string, unknown> },
) {
  await c.query(
    `INSERT INTO email_outbox (dedupe_key, to_email, template, payload) VALUES ($1,$2,$3,$4) ON CONFLICT (dedupe_key) DO NOTHING`,
    [e.dedupeKey ?? null, e.to, e.template, JSON.stringify(e.payload)],
  );
}

const IN_APP: Record<string, [string, string]> = {
  'order.placed': ['Order placed', 'Your JIMMY WAX order has been placed.'],
  'payment.captured': ['Payment received', 'We received your payment.'],
  'payment.failed': ['Payment failed', 'Your payment did not go through. You can try again.'],
  'order.cancelled': ['Order cancelled', 'Your order has been cancelled.'],
  'order.expired': ['Order expired', 'Your order expired because payment was not completed.'],
  'order.shipped': ['Order shipped', 'Your order is on its way.'],
  'order.delivered': ['Order delivered', 'Your order was delivered.'],
  'return.decided': ['Return request update', 'There is an update on your return request.'],
  'refund.processed': ['Refund issued', 'A refund was issued for your order.'],
};

/**
 * Order-event consumer (run inside `deliver`, so effects are deduplicated by the inbox):
 * writes the in-app notification and queues the transactional email, honouring the customer's
 * "order updates" preference. Marketing is a separate consented workflow (not implemented).
 */
export const notifyHandler: Handler = async (row, c) => {
  const userId = row.payload.userId as string | undefined;
  const msg = IN_APP[row.event_type];
  if (!userId || !msg) return;
  const pref = await c.query(`SELECT order_updates FROM notification_preferences WHERE user_id = $1`, [
    userId,
  ]);
  if (pref.rows[0] && pref.rows[0].order_updates === false) return;
  await c.query(`INSERT INTO notifications (user_id, kind, title, body, data) VALUES ($1,$2,$3,$4,$5)`, [
    userId,
    row.event_type.replace('.', '_'),
    msg[0],
    msg[1],
    { orderId: row.aggregate_id },
  ]);
  if (!emailTemplates().includes(row.event_type)) return;
  const u = await c.query(`SELECT email, status FROM auth.users WHERE id = $1`, [userId]);
  if (!u.rows[0] || u.rows[0].status !== 'active' || !u.rows[0].email) return;
  const o = await c.query(`SELECT order_number, total_paise, payment_method FROM orders WHERE id = $1`, [
    row.aggregate_id,
  ]);
  await queueEmail(c, {
    dedupeKey: `${row.event_type}:${row.id}`,
    to: u.rows[0].email,
    template: row.event_type,
    payload: {
      ...row.payload,
      orderNumber: o.rows[0]?.order_number,
      totalPaise: o.rows[0]?.total_paise,
      paymentMethod: o.rows[0]?.payment_method,
    },
  });
};

export type SuppressionReason = 'hard_bounce' | 'complaint' | 'manual';

/** Adds an address to the do-not-mail list (idempotent; the first reason wins). */
export async function suppressEmail(
  c: PoolClient,
  email: string,
  reason: SuppressionReason,
  detail?: string,
) {
  await c.query(
    `INSERT INTO email_suppressions (email, reason, detail) VALUES (lower($1), $2, $3) ON CONFLICT (email) DO NOTHING`,
    [email.trim(), reason, detail?.slice(0, 300) ?? null],
  );
}

/** A permanent SMTP failure (5xx: no such mailbox, domain, policy block) as opposed to a retryable one (4xx, network). */
export function isPermanentMailFailure(err: unknown): boolean {
  const e = err as { responseCode?: number; code?: string };
  return typeof e.responseCode === 'number' && e.responseCode >= 500 && e.responseCode < 600;
}

/**
 * Provider callbacks (bounce / complaint) arrive as { events: [{ type, email, detail? }] }. Hard bounces and complaints suppress the
 * address; delivery/soft-bounce events are ignored. Returns how many addresses were newly suppressed.
 */
export async function recordEmailEvents(
  c: PoolClient,
  events: Array<{ type: string; email: string; detail?: string }>,
): Promise<number> {
  let n = 0;
  for (const ev of events) {
    const reason: SuppressionReason | null =
      ev.type === 'bounce' || ev.type === 'hard_bounce'
        ? 'hard_bounce'
        : ev.type === 'complaint'
          ? 'complaint'
          : null;
    if (!reason || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(ev.email)) continue;
    const r = await c.query(
      `INSERT INTO email_suppressions (email, reason, detail) VALUES (lower($1), $2, $3) ON CONFLICT (email) DO NOTHING RETURNING email`,
      [ev.email.trim(), reason, ev.detail?.slice(0, 300) ?? null],
    );
    n += r.rowCount ?? 0;
  }
  return n;
}

/** Claims due emails with a short lease so concurrent workers never send the same message twice. */
export async function sendDueEmails(db: Db, sender: EmailSender, batch = 20): Promise<number> {
  const rows = await db.tx(
    { kind: 'system', reason: 'email_claim' },
    async (c) =>
      (
        await c.query(
          `WITH picked AS MATERIALIZED (SELECT id FROM email_outbox WHERE status = 'pending' AND available_at <= now() ORDER BY id FOR UPDATE SKIP LOCKED LIMIT $1)
         UPDATE email_outbox e SET attempts = attempts + 1, available_at = now() + interval '2 minutes'
           FROM picked WHERE e.id = picked.id RETURNING e.*`,
          [batch],
        )
      ).rows,
  );
  let sent = 0;
  for (const r of rows) {
    const ov = await db.tx(
      { kind: 'system', reason: 'email_template' },
      async (c) =>
        (
          await c.query(`SELECT subject, body FROM message_templates WHERE key = $1 AND enabled`, [
            r.template,
          ])
        ).rows[0] ?? null,
    );
    const msg = renderEmail(r.template, r.payload, ov);
    const blocked = await db.tx(
      { kind: 'system', reason: 'email_suppression_check' },
      async (c) =>
        (await c.query(`SELECT reason FROM email_suppressions WHERE email = lower($1)`, [r.to_email]))
          .rows[0] as { reason: string } | undefined,
    );
    if (blocked) {
      await db.tx({ kind: 'system', reason: 'email_suppress' }, (c) =>
        c.query(
          `UPDATE email_outbox SET status = 'suppressed', payload = '{}', last_error = $2 WHERE id = $1`,
          [r.id, `address suppressed (${blocked.reason})`],
        ),
      );
      continue;
    }
    try {
      if (!msg) {
        await db.tx({ kind: 'system', reason: 'email_suppress' }, (c) =>
          c.query(`UPDATE email_outbox SET status = 'suppressed', payload = '{}' WHERE id = $1`, [r.id]),
        );
        continue;
      }
      await sender.send({ to: r.to_email, subject: msg.subject, text: msg.text });
      // Tokens in the payload are redacted as soon as the message is sent.
      await db.tx({ kind: 'system', reason: 'email_sent' }, (c) =>
        c.query(
          `UPDATE email_outbox SET status = 'sent', sent_at = now(), payload = '{"redacted":true}', last_error = NULL WHERE id = $1`,
          [r.id],
        ),
      );
      sent++;
    } catch (err) {
      if (isPermanentMailFailure(err)) {
        // Hard bounce: stop retrying, remember the address, redact the payload (it may carry a token).
        await db.tx({ kind: 'system', reason: 'email_hard_bounce' }, async (c) => {
          await suppressEmail(c, r.to_email, 'hard_bounce', String(err));
          await c.query(
            `UPDATE email_outbox SET status = 'failed', payload = '{}', last_error = $2 WHERE id = $1`,
            [r.id, String(err).slice(0, 300)],
          );
        });
        continue;
      }
      const dead = r.attempts >= 6;
      await db.tx({ kind: 'system', reason: 'email_fail' }, (c) =>
        c.query(
          `UPDATE email_outbox SET status = $2, last_error = $3, available_at = now() + make_interval(secs => $4) WHERE id = $1`,
          [
            r.id,
            dead ? 'failed' : 'pending',
            String(err).slice(0, 300),
            Math.min(3600, 2 ** r.attempts * 30),
          ],
        ),
      );
    }
  }
  return sent;
}
