import type { Request } from 'express';
import { z } from 'zod';
import { AppError, PageQuery } from '@jw/contracts';
import {
  CouponInput,
  CouponPatch,
  audit,
  couponAnalytics,
  createCoupon,
  getCoupon,
  listCoupons,
  updateCoupon,
} from '@jw/commerce-domain';
import { EDITABLE_TEMPLATES, renderEmail, unknownVariables } from '@jw/integrations';
import type { AdminKit } from './adminKit.ts';

const SAMPLE = {
  orderNumber: 'JW-20260101-SAMPLE01',
  totalPaise: 129900,
  amountPaise: 49900,
  paymentMethod: 'cod',
  courier: 'Sample Courier',
  trackingNumber: 'AWB1234567',
  trackingUrl: 'https://example.com/track/AWB1234567',
  approved: true,
  note: 'Sample note',
};

/** Coupons, message templates and the email outbox viewer (phase B12). */
export function registerB12(k: AdminKit) {
  const { r, db, need, actor, ctx, parse, uuid } = k;
  const tx = <T>(req: Request, fn: Parameters<typeof db.tx<T>>[1]) => db.tx(actor(req), fn);

  // ------------------------------------------------------------------ coupons
  r.get('/coupons', need('coupons:read'), async (req, res) => {
    const q = parse(
      PageQuery.extend({
        status: z.enum(['live', 'scheduled', 'expired', 'exhausted', 'inactive']).optional(),
      }),
      req.query,
    );
    res.json(await tx(req, (c) => listCoupons(c, q)));
  });
  r.get('/coupons/analytics', need('coupons:read'), async (req, res) => {
    res.json(await tx(req, (c) => couponAnalytics(c)));
  });
  r.get('/coupons/:id', need('coupons:read'), async (req, res) => {
    res.json(await tx(req, (c) => getCoupon(c, uuid(req.params.id))));
  });
  r.post('/coupons', need('coupons:write'), async (req, res) => {
    res.status(201).json(await tx(req, (c) => createCoupon(c, ctx(req), parse(CouponInput, req.body))));
  });
  r.patch('/coupons/:id', need('coupons:write'), async (req, res) => {
    res.json(
      await tx(req, (c) => updateCoupon(c, ctx(req), uuid(req.params.id), parse(CouponPatch, req.body))),
    );
  });
  r.post('/coupons/:id/deactivate', need('coupons:write'), async (req, res) => {
    res.json(await tx(req, (c) => updateCoupon(c, ctx(req), uuid(req.params.id), { active: false })));
  });

  // --------------------------------------------------------- message templates
  const dto = async (c: Parameters<Parameters<typeof db.tx<unknown>>[1]>[0], key: string) => {
    const o = (
      await c.query(`SELECT subject, body, enabled, updated_at FROM message_templates WHERE key = $1`, [key])
    ).rows[0];
    const def = renderEmail(key, SAMPLE)!;
    return {
      key,
      variables: EDITABLE_TEMPLATES[key]!,
      default: { subject: def.subject, body: def.text },
      override: o
        ? {
            subject: o.subject as string,
            body: o.body as string,
            enabled: o.enabled as boolean,
            updatedAt: new Date(o.updated_at).toISOString(),
          }
        : null,
    };
  };
  const key = (v: unknown) => {
    const kx = parse(z.string(), v);
    if (!EDITABLE_TEMPLATES[kx]) throw new AppError('NOT_FOUND', 'This message cannot be edited');
    return kx;
  };
  r.get('/message-templates', need('settings:read'), async (req, res) => {
    res.json({
      items: await tx(req, async (c) => Promise.all(Object.keys(EDITABLE_TEMPLATES).map((x) => dto(c, x)))),
    });
  });
  r.put('/message-templates/:key', need('settings:write'), async (req, res) => {
    const kx = key(req.params.key);
    const b = parse(
      z.object({
        subject: z.string().trim().min(1).max(200),
        body: z.string().trim().min(1).max(8000),
        enabled: z.boolean().default(true),
      }),
      req.body,
    );
    const bad = [
      ...unknownVariables(b.subject, EDITABLE_TEMPLATES[kx]!),
      ...unknownVariables(b.body, EDITABLE_TEMPLATES[kx]!),
    ];
    if (bad.length)
      throw new AppError('VALIDATION_FAILED', 'Unknown placeholder(s) in the message', {
        fields: { body: `unknown: ${[...new Set(bad)].join(', ')}` },
      });
    res.json(
      await tx(req, async (c) => {
        await c.query(
          `INSERT INTO message_templates (key, subject, body, enabled, updated_by) VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (key) DO UPDATE SET subject = excluded.subject, body = excluded.body, enabled = excluded.enabled, updated_by = excluded.updated_by, updated_at = now()`,
          [kx, b.subject, b.body, b.enabled, ctx(req).adminId],
        );
        const x = ctx(req);
        await audit(c, {
          actorId: x.adminId,
          actorRole: x.role,
          action: 'message_template.set',
          resourceType: 'message_template',
          resourceId: kx,
          after: b,
          requestId: x.requestId,
        });
        return dto(c, kx);
      }),
    );
  });
  r.delete('/message-templates/:key', need('settings:write'), async (req, res) => {
    const kx = key(req.params.key);
    await tx(req, async (c) => {
      await c.query(`DELETE FROM message_templates WHERE key = $1`, [kx]);
      const x = ctx(req);
      await audit(c, {
        actorId: x.adminId,
        actorRole: x.role,
        action: 'message_template.reset',
        resourceType: 'message_template',
        resourceId: kx,
        requestId: x.requestId,
      });
    });
    res.status(204).end();
  });
  // Preview with sample data; with a configured sender also mails it to the operator's own address.
  r.post('/message-templates/:key/test', need('settings:write'), async (req, res) => {
    const kx = key(req.params.key);
    const b = parse(
      z.object({
        subject: z.string().max(200).optional(),
        body: z.string().max(8000).optional(),
        send: z.boolean().default(false),
      }),
      req.body ?? {},
    );
    const stored = await tx(
      req,
      async (c) =>
        (await c.query(`SELECT subject, body FROM message_templates WHERE key = $1 AND enabled`, [kx]))
          .rows[0] as { subject: string; body: string } | undefined,
    );
    const override = b.subject && b.body ? { subject: b.subject, body: b.body } : (stored ?? null);
    const rendered = renderEmail(kx, SAMPLE, override)!;
    let sent = false;
    if (b.send && k.deps.email) {
      const me = await tx(
        req,
        async (c) =>
          (await c.query(`SELECT email FROM auth.users WHERE id = $1`, [req.admin!.userId])).rows[0]
            ?.email as string | undefined,
      );
      if (me) {
        await k.deps.email.send({ to: me, subject: `[TEST] ${rendered.subject}`, text: rendered.text });
        sent = true;
      }
    }
    res.json({ subject: rendered.subject, body: rendered.text, sent, sender: k.deps.email?.name ?? 'none' });
  });

  // Outbox viewer: the API role cannot read recipient addresses or payloads (column grants), only delivery state.
  r.get('/outbox/emails', need('ops:read'), async (req, res) => {
    const q = parse(
      z.object({ status: z.enum(['pending', 'sent', 'failed', 'suppressed']).optional() }),
      req.query,
    );
    const rows = await tx(req, (c) =>
      c.query(
        `SELECT id, template, status, created_at FROM email_outbox WHERE ($1::text IS NULL OR status = $1) ORDER BY id DESC LIMIT 100`,
        [q.status ?? null],
      ),
    );
    res.json({
      items: rows.rows.map((e) => ({
        id: Number(e.id),
        template: e.template as string,
        status: e.status as string,
        createdAt: new Date(e.created_at).toISOString(),
      })),
    });
  });

  // Addresses that hard-bounced or complained are never mailed again until an operator lifts the entry (with a reason, audited).
  r.get('/outbox/suppressions', need('ops:read'), async (req, res) => {
    const rows = await tx(req, (c) =>
      c.query(
        `SELECT email, reason, detail, created_at FROM email_suppressions ORDER BY created_at DESC LIMIT 200`,
      ),
    );
    res.json({
      items: rows.rows.map((x) => ({
        email: x.email as string,
        reason: x.reason as string,
        detail: (x.detail as string | null) ?? null,
        createdAt: new Date(x.created_at).toISOString(),
      })),
    });
  });
  r.post('/outbox/suppressions/lift', need('settings:write'), async (req, res) => {
    const b = parse(
      z.object({
        email: z.string().trim().toLowerCase().email().max(320),
        reason: z.string().trim().min(3).max(300),
      }),
      req.body,
    );
    await tx(req, async (c) => {
      const del = await c.query(`DELETE FROM email_suppressions WHERE email = $1 RETURNING reason`, [
        b.email,
      ]);
      if (!del.rowCount) throw new AppError('NOT_FOUND', 'That address is not suppressed');
      await audit(c, {
        actorId: ctx(req).adminId,
        actorRole: ctx(req).role,
        action: 'email.suppression.lift',
        resourceType: 'email_suppression',
        resourceId: b.email,
        reason: b.reason,
        before: { reason: del.rows[0].reason },
        requestId: ctx(req).requestId,
      });
    });
    res.status(204).end();
  });
}
