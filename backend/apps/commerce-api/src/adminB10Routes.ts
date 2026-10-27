import type { Request } from 'express';
import { z } from 'zod';
import { AppError, PageQuery } from '@jw/contracts';
import {
  ShipInput,
  ShippingSettingsPatch,
  cancelShipment,
  createBulkJob,
  getBulkJob,
  getShippingSettings,
  labelFor,
  listShipments,
  mapShippingError,
  planShipment,
  readyToShip,
  runBulkJob,
  shipOrder,
  shipmentDetail,
  shippingOverview,
  updateShippingSettings,
  ShippingSettingsGuard,
  type ShipDeps,
} from '@jw/commerce-domain';
import type { AdminKit } from './adminKit.ts';

const bool = z.enum(['true', 'false']).transform((v) => v === 'true');

/** Shipping Center API (phase B10): readiness queue, planning, shipping through the provider, bulk, labels, exceptions. */
export function registerB10(k: AdminKit) {
  const { r, db, need, actor, ctx, parse, uuid, config, storage } = k;
  const tx = <T>(req: Request, fn: Parameters<typeof db.tx<T>>[1]) => db.tx(actor(req), fn);
  const provider = () => {
    if (!k.deps.shipping)
      throw new AppError(
        'POLICY_NOT_CONFIGURED',
        'No shipping provider is configured; shipments are entered manually',
      );
    return k.deps.shipping;
  };
  const shipDeps = (): ShipDeps => ({ db, provider: provider(), storage });
  const mfa = (req: Request) => {
    if (config.ADMIN_REQUIRE_MFA && !req.admin!.mfa)
      throw new AppError('MFA_REQUIRED', 'Re-authenticate with MFA to perform this action');
  };

  r.get('/shipping/provider', need('shipping:read'), async (req, res) => {
    const base = await tx(req, async (c) => ({
      settings: await getShippingSettings(c),
      overview: await shippingOverview(c),
    }));
    const p = k.deps.shipping;
    let walletBalancePaise: number | null = null;
    let pickupLocations: string[] = [];
    let reachable: boolean | null = null;
    if (p) {
      try {
        [walletBalancePaise, pickupLocations] = await Promise.all([
          p.walletBalancePaise(),
          p.listPickupLocations(),
        ]);
        reachable = true;
      } catch {
        reachable = false;
      }
    }
    res.json({
      provider: p?.name ?? 'manual',
      configured: !!p,
      reachable,
      walletBalancePaise,
      pickupLocations,
      ...base,
    });
  });
  r.get('/shipping/settings', need('shipping:read'), async (req, res) => {
    res.json(await tx(req, (c) => getShippingSettings(c)));
  });
  r.put('/shipping/settings', need('shipping:write'), async (req, res) => {
    const { expectedUpdatedAt, reason, ...rest } = parse(ShippingSettingsGuard.passthrough(), req.body);
    res.json(
      await tx(req, (c) =>
        updateShippingSettings(c, ctx(req), parse(ShippingSettingsPatch, rest), {
          expectedUpdatedAt,
          reason,
        }),
      ),
    );
  });
  r.get('/shipping/pickup-locations', need('shipping:read'), async (_req, res) => {
    try {
      res.json({ items: await provider().listPickupLocations() });
    } catch (e) {
      throw mapShippingError(e);
    }
  });
  r.post('/shipping/serviceability/check', need('shipping:read'), async (req, res) => {
    const b = parse(
      z.object({
        pin: z.string().regex(/^[0-9]{6}$/),
        weightGrams: z.number().int().min(1).max(50000).default(300),
        cod: z.boolean().default(false),
        declaredValuePaise: z.number().int().min(0).default(50000),
      }),
      req.body,
    );
    const out = await tx(req, async (c) => {
      const allow = await c.query(
        `SELECT count(*)::int total, count(*) FILTER (WHERE $1 LIKE prefix || '%')::int hit FROM serviceable_pin_prefixes`,
        [b.pin],
      );
      return {
        allowListed: allow.rows[0].hit > 0,
        allowListConfigured: allow.rows[0].total > 0,
        settings: await getShippingSettings(c),
        pickupPin: (await c.query(`SELECT pickup_pin FROM shipping_settings WHERE id = 1`)).rows[0]
          .pickup_pin as string | null,
      };
    });
    let verdict: { serviceable: boolean; couriers: unknown[] } | null = null;
    if (k.deps.shipping && out.pickupPin) {
      try {
        verdict = await k.deps.shipping.checkServiceability({
          pickupPin: out.pickupPin,
          deliveryPin: b.pin,
          weightGrams: b.weightGrams,
          cod: b.cod,
          declaredValuePaise: b.declaredValuePaise,
        });
        await db.tx({ kind: 'system', reason: 'pin-cache' }, (c) =>
          c.query(
            `INSERT INTO pin_serviceability_cache (pin, serviceable, couriers) VALUES ($1,$2,$3) ON CONFLICT (pin) DO UPDATE SET serviceable = $2, couriers = $3, checked_at = now()`,
            [b.pin, verdict!.serviceable, verdict!.couriers.length],
          ),
        );
      } catch (e) {
        throw mapShippingError(e);
      }
    }
    res.json({
      pin: b.pin,
      allowListed: out.allowListed,
      allowListConfigured: out.allowListConfigured,
      provider: verdict,
      note: out.pickupPin ? undefined : 'Set the pickup PIN to check the provider',
    });
  });

  r.get('/shipping/ready', need('shipping:read'), async (req, res) => {
    res.json(await tx(req, (c) => readyToShip(c, parse(PageQuery, req.query))));
  });
  r.post('/orders/:id/shipments/plan', need('shipping:write'), async (req, res) => {
    try {
      res.json(await planShipment(db, provider(), ctx(req), uuid(req.params.id)));
    } catch (e) {
      throw mapShippingError(e);
    }
  });
  r.post('/orders/:id/ship', need('shipping:write'), async (req, res) => {
    const b = parse(ShipInput, req.body ?? {});
    res.status(201).json(await shipOrder(shipDeps(), ctx(req), uuid(req.params.id), b));
  });

  // ---- bulk (registered before /shipments/:id)
  r.post('/shipments/bulk', need('shipping:write'), async (req, res) => {
    const b = parse(
      z.object({
        orderIds: z.array(z.string().uuid()).min(1).max(100),
        strategy: z.enum(['cheapest', 'fastest', 'balanced', 'preferred', 'courier']),
        courierId: z.string().max(40).optional(),
      }),
      req.body,
    );
    const deps = shipDeps();
    const s = await tx(req, (c) => getShippingSettings(c));
    // Large batches spend real money: they need a fresh MFA session (the threshold is a setting).
    if (b.orderIds.length > s.bulkConfirmThreshold) mfa(req);
    const id = await tx(req, (c) => createBulkJob(c, ctx(req), b));
    runBulkJob(deps, id).catch(() => undefined); // best effort now; the worker sweep guarantees completion
    res.status(202).json({ id, status: 'queued', total: b.orderIds.length });
  });
  r.get('/shipments/bulk/:jobId', need('shipping:read'), async (req, res) => {
    res.json(await tx(req, (c) => getBulkJob(c, uuid(req.params.jobId))));
  });
  r.get('/shipments/overview', need('shipping:read'), async (req, res) => {
    res.json(await tx(req, (c) => shippingOverview(c)));
  });
  r.post('/shipments/manifest', need('shipping:write'), async (req, res) => {
    const b = parse(z.object({ shipmentIds: z.array(z.string().uuid()).min(1).max(100) }), req.body);
    const rows = await tx(req, (c) =>
      c.query(
        `SELECT provider_shipment_id FROM shipments WHERE id = ANY($1) AND provider <> 'manual' AND provider_shipment_id IS NOT NULL`,
        [b.shipmentIds],
      ),
    );
    if (!rows.rowCount)
      throw new AppError('VALIDATION_FAILED', 'None of these shipments were created through the provider');
    try {
      const pdf = await provider().fetchManifest(rows.rows.map((x) => x.provider_shipment_id as string));
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', 'attachment; filename="manifest.pdf"');
      res.setHeader('Cache-Control', 'private, no-store');
      res.send(pdf);
    } catch (e) {
      throw mapShippingError(e);
    }
  });

  r.get('/shipments', need('shipping:read'), async (req, res) => {
    const q = parse(
      PageQuery.extend({
        status: z.string().max(30).optional(),
        courier: z.string().max(60).optional(),
        q: z.string().trim().max(60).optional(),
        exception: bool.optional(),
        stuck: bool.optional(),
      }),
      req.query,
    );
    res.json(await tx(req, (c) => listShipments(c, q)));
  });
  r.get('/shipments/:id', need('shipping:read'), async (req, res) => {
    res.json(await shipmentDetail(db, ctx(req), uuid(req.params.id)));
  });
  r.post('/shipments/:id/cancel', need('shipping:write'), async (req, res) => {
    mfa(req);
    const b = parse(z.object({ reason: z.string().trim().min(3).max(200) }), req.body);
    // A manual shipment has no provider to call, so it can be cancelled even when none is configured (the domain only calls the provider for provider shipments).
    const deps: ShipDeps = k.deps.shipping
      ? shipDeps()
      : {
          db,
          storage,
          provider: {
            cancel: async () => {
              throw new AppError(
                'POLICY_NOT_CONFIGURED',
                'No shipping provider is configured; only manual shipments can be cancelled',
              );
            },
          } as unknown as ShipDeps['provider'],
        };
    res.json(await cancelShipment(deps, ctx(req), uuid(req.params.id), b.reason));
  });
  r.get('/shipments/:id/label', need('shipping:read'), async (req, res) => {
    const pdf = await labelFor(shipDeps(), ctx(req), uuid(req.params.id));
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="label.pdf"');
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(pdf);
  });
}
