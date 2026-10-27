import { notFound } from 'next/navigation';
import { api, ApiError, inr } from '@/lib/api';
import { ActionForm, ConfirmAction } from '@/components/ui';
import {
  codCollectedAction,
  createShipmentAction,
  orderCancelAction,
  orderStatusAction,
  shipmentEventAction,
} from '@/lib/actions';

interface Shipments {
  items: Array<{
    id: string;
    courier: string;
    trackingNumber: string;
    trackingUrl: string | null;
    status: string;
    events: Array<{ status: string; description: string; occurredAt: string }>;
  }>;
}

interface Order {
  id: string;
  orderNumber: string;
  status: string;
  paymentStatus: string;
  paymentMethod: string;
  version: number;
  codFeePaise: number;
  taxInclusive: boolean;
  subtotalPaise: number;
  discountPaise: number;
  taxPaise: number;
  shippingPaise: number;
  totalPaise: number;
  address: Record<string, string>;
  createdAt: string;
  lines: Array<{
    sku: string;
    productName: string;
    variantTitle: string;
    unitPricePaise: number;
    quantity: number;
    lineTotalPaise: number;
  }>;
  paymentAttempts: Array<{
    id: string;
    status: string;
    amountPaise: number;
    provider: string;
    createdAt: string;
  }>;
  refunds: Array<{ id: string; status: string; amountPaise: number; reason: string }>;
}
const NEXT: Record<string, string[]> = {
  placed: ['confirmed'],
  confirmed: ['processing'],
  processing: ['shipped'],
  shipped: ['out_for_delivery', 'delivered'],
  out_for_delivery: ['delivered'],
};

export default async function OrderDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let o: Order;
  try {
    o = await api<Order>(`/orders/${id}`);
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) notFound();
    throw e;
  }
  const cancellable = ['pending_payment', 'placed', 'confirmed', 'processing'].includes(o.status);
  const steps = NEXT[o.status] ?? [];
  const shipments = await api<Shipments>(`/orders/${id}/shipments`);
  return (
    <>
      <h1>Order {o.orderNumber}</h1>
      <p className="sub">
        Placed {o.createdAt.replace('T', ' ').slice(0, 16)} UTC · record version {o.version}. This is the
        immutable purchase snapshot.
      </p>
      <div className="grid">
        <div className="card stat">
          <b>{o.status}</b>
          <span>Order status</span>
        </div>
        <div className="card stat">
          <b>{o.paymentStatus}</b>
          <span>Payment ({o.paymentMethod.toUpperCase()})</span>
        </div>
        <div className="card stat">
          <b>{inr(o.totalPaise)}</b>
          <span>Total</span>
        </div>
      </div>
      <h2>Items</h2>
      <div className="tablewrap">
        <table>
          <caption className="skip">Order lines</caption>
          <thead>
            <tr>
              <th>SKU</th>
              <th>Product</th>
              <th className="num">Unit</th>
              <th className="num">Qty</th>
              <th className="num">Line</th>
            </tr>
          </thead>
          <tbody>
            {o.lines.map((l) => (
              <tr key={l.sku}>
                <td>{l.sku}</td>
                <td>
                  {l.productName} <small>({l.variantTitle})</small>
                </td>
                <td className="num">{inr(l.unitPricePaise)}</td>
                <td className="num">{l.quantity}</td>
                <td className="num">{inr(l.lineTotalPaise)}</td>
              </tr>
            ))}
            <tr>
              <td colSpan={4} className="num">
                Subtotal
              </td>
              <td className="num">{inr(o.subtotalPaise)}</td>
            </tr>
            <tr>
              <td colSpan={4} className="num">
                Discount
              </td>
              <td className="num">−{inr(o.discountPaise)}</td>
            </tr>
            <tr>
              <td colSpan={4} className="num">
                Shipping
              </td>
              <td className="num">{inr(o.shippingPaise)}</td>
            </tr>
            {o.codFeePaise > 0 ? (
              <tr>
                <td colSpan={4} className="num">
                  COD handling fee
                </td>
                <td className="num">{inr(o.codFeePaise)}</td>
              </tr>
            ) : null}
            <tr>
              <td colSpan={4} className="num">
                of which GST {o.taxInclusive ? '(included)' : '(added)'}
              </td>
              <td className="num">{inr(o.taxPaise)}</td>
            </tr>
            <tr>
              <td colSpan={4} className="num">
                <b>Total</b>
              </td>
              <td className="num">
                <b>{inr(o.totalPaise)}</b>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <h2>Delivery address (snapshot)</h2>
      <p className="card">
        {Object.entries(o.address).map(([k, v]) => (
          <span key={k}>
            <b>{k}:</b> {v}{' '}
          </span>
        ))}
      </p>

      <h2>Fulfilment</h2>
      {steps.map((to) => (
        <ActionForm key={to} action={orderStatusAction} submit={`Mark ${to.replaceAll('_', ' ')}`}>
          <input type="hidden" name="id" value={o.id} />
          <input type="hidden" name="to" value={to} />
          <input type="hidden" name="version" value={o.version} />
        </ActionForm>
      ))}
      {o.status === 'shipped' || o.status === 'out_for_delivery' ? (
        <ConfirmAction
          action={orderStatusAction}
          label="Parcel came back undelivered (RTO)"
          danger={false}
          warning="Use only when the courier returned the undelivered parcel to you. Stock is restored once. Customer returns of delivered orders go through Returns."
          hidden={{ id: o.id, to: 'returned', version: o.version }}
        />
      ) : null}
      {o.paymentMethod === 'cod' && o.status === 'delivered' && o.paymentStatus === 'cod_due' ? (
        <ActionForm action={codCollectedAction} submit="Record cash collected">
          <input type="hidden" name="id" value={o.id} />
          <input type="hidden" name="version" value={o.version} />
        </ActionForm>
      ) : null}
      {cancellable ? (
        <ConfirmAction
          action={orderCancelAction}
          label="Cancel order"
          hidden={{ id: o.id, version: o.version }}
          warning={`Cancelling returns stock to inventory${o.paymentStatus === 'paid' ? ' and queues a full refund for finance' : ''}. Requires MFA.`}
        />
      ) : null}
      {steps.length === 0 && !cancellable && o.status !== 'delivered' ? (
        <p className="sub">No further actions are available for this status.</p>
      ) : null}

      <h2>Shipment &amp; tracking</h2>
      {o.status === 'processing' ? (
        <ActionForm action={createShipmentAction} submit="Create shipment (marks order shipped)">
          <input type="hidden" name="id" value={o.id} />
          <label>
            Courier
            <input name="courier" required minLength={2} maxLength={80} placeholder="e.g. Delhivery" />
          </label>
          <label>
            Tracking / AWB number
            <input name="trackingNumber" required minLength={3} maxLength={80} />
          </label>
          <label>
            Tracking link (https, optional)
            <input name="trackingUrl" type="url" pattern="https://.*" />
          </label>
        </ActionForm>
      ) : null}
      {shipments.items.length === 0 ? <p className="sub">No shipment yet.</p> : null}
      {shipments.items.map((sh) => (
        <div key={sh.id} className="card" style={{ marginBottom: 10 }}>
          <b>{sh.courier}</b> · {sh.trackingNumber} · <span className="badge">{sh.status}</span>
          {sh.trackingUrl ? (
            <>
              {' '}
              ·{' '}
              <a href={sh.trackingUrl} rel="noopener noreferrer" target="_blank">
                track
              </a>
            </>
          ) : null}
          <ol>
            {sh.events.map((e, i) => (
              <li key={i}>
                {e.occurredAt.slice(0, 16).replace('T', ' ')} — {e.status}
                {e.description ? `: ${e.description}` : ''}
              </li>
            ))}
          </ol>
          {!['delivered', 'returned_to_origin'].includes(sh.status) ? (
            <ActionForm action={shipmentEventAction} submit="Add tracking update">
              <input type="hidden" name="id" value={sh.id} />
              <input type="hidden" name="orderId" value={o.id} />
              <label>
                Status
                <select name="status">
                  {['in_transit', 'out_for_delivery', 'delivered', 'failed', 'returned_to_origin'].map(
                    (x) => (
                      <option key={x}>{x}</option>
                    ),
                  )}
                </select>
              </label>
              <label>
                Note
                <input name="description" maxLength={300} />
              </label>
            </ActionForm>
          ) : null}
        </div>
      ))}

      <h2>Payment attempts</h2>
      {o.paymentAttempts.length === 0 ? (
        <p className="sub">None (COD or not yet started).</p>
      ) : (
        <div className="tablewrap">
          <table>
            <thead>
              <tr>
                <th>Attempt</th>
                <th>Provider</th>
                <th>Status</th>
                <th className="num">Amount</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              {o.paymentAttempts.map((a) => (
                <tr key={a.id}>
                  <td>{a.id.slice(0, 8)}</td>
                  <td>{a.provider}</td>
                  <td>{a.status}</td>
                  <td className="num">{inr(a.amountPaise)}</td>
                  <td>{a.createdAt.slice(0, 16).replace('T', ' ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {o.refunds.length > 0 ? (
        <>
          <h2>Refunds</h2>
          <div className="tablewrap">
            <table>
              <thead>
                <tr>
                  <th>Refund</th>
                  <th>Status</th>
                  <th className="num">Amount</th>
                  <th>Reason</th>
                </tr>
              </thead>
              <tbody>
                {o.refunds.map((r) => (
                  <tr key={r.id}>
                    <td>{r.id.slice(0, 8)}</td>
                    <td>{r.status}</td>
                    <td className="num">{inr(r.amountPaise)}</td>
                    <td>{r.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
    </>
  );
}
