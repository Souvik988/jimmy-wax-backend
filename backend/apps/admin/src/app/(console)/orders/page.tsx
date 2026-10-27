import Link from 'next/link';
import { api, inr } from '@/lib/api';

interface Page {
  items: Array<{
    id: string;
    orderNumber: string;
    status: string;
    paymentStatus: string;
    paymentMethod: string;
    totalPaise: number;
    createdAt: string;
    demo?: boolean;
  }>;
  nextCursor: string | null;
}
const tone = (s: string) =>
  ['cancelled', 'expired', 'exception', 'failed'].includes(s)
    ? 'err'
    : ['delivered', 'paid', 'cod_collected'].includes(s)
      ? 'ok'
      : ['pending_payment', 'cod_due', 'pending'].includes(s)
        ? 'warn'
        : '';

export default async function Orders({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const sp = await searchParams;
  const qs = new URLSearchParams();
  for (const k of ['status', 'paymentStatus', 'q', 'cursor']) if (sp[k]) qs.set(k, sp[k]!);
  qs.set('limit', '25');
  const page = await api<Page>(`/orders?${qs}`);
  const next = new URLSearchParams(qs);
  if (page.nextCursor) next.set('cursor', page.nextCursor);
  return (
    <>
      <h1>Orders</h1>
      <p className="sub">Newest first. Filters apply server-side; pages are cursor-based.</p>
      <form className="filters" role="search">
        <label>
          Order number starts with
          <input name="q" defaultValue={sp.q ?? ''} maxLength={40} />
        </label>
        <label>
          Status
          <select name="status" defaultValue={sp.status ?? ''}>
            <option value="">Any</option>
            {[
              'pending_payment',
              'placed',
              'confirmed',
              'processing',
              'shipped',
              'out_for_delivery',
              'delivered',
              'cancelled',
              'returned',
              'expired',
            ].map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </label>
        <label>
          Payment
          <select name="paymentStatus" defaultValue={sp.paymentStatus ?? ''}>
            <option value="">Any</option>
            {[
              'pending',
              'paid',
              'cod_due',
              'cod_collected',
              'exception',
              'refunded',
              'partially_refunded',
            ].map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </label>
        <button className="btn">Filter</button>
        <Link className="btn secondary" href="/orders">
          Reset
        </Link>
      </form>
      {page.items.length === 0 ? (
        <p className="card">No orders match.</p>
      ) : (
        <div className="tablewrap">
          <table>
            <caption className="skip">Orders</caption>
            <thead>
              <tr>
                <th>Order</th>
                <th>Placed (UTC)</th>
                <th>Status</th>
                <th>Payment</th>
                <th>Method</th>
                <th className="num">Total</th>
              </tr>
            </thead>
            <tbody>
              {page.items.map((o) => (
                <tr key={o.id}>
                  <td>
                    <Link href={`/orders/${o.id}`}>{o.orderNumber}</Link>
                    {o.demo ? (
                      <span className="badge warn" title="Placed by the demo account">
                        {' '}
                        demo
                      </span>
                    ) : null}
                  </td>
                  <td>{o.createdAt.replace('T', ' ').slice(0, 16)}</td>
                  <td>
                    <span className={`badge ${tone(o.status)}`}>{o.status}</span>
                  </td>
                  <td>
                    <span className={`badge ${tone(o.paymentStatus)}`}>{o.paymentStatus}</span>
                  </td>
                  <td>{o.paymentMethod.toUpperCase()}</td>
                  <td className="num">{inr(o.totalPaise)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {page.nextCursor ? (
        <p>
          <Link className="btn secondary" href={`/orders?${next}`}>
            Next page →
          </Link>
        </p>
      ) : null}
    </>
  );
}
