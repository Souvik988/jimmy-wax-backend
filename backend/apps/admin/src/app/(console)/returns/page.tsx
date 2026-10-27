import Link from 'next/link';
import { api } from '@/lib/api';
import { ConfirmAction } from '@/components/ui';
import { decideReturnAction, receiveReturnAction } from '@/lib/actions';

interface R {
  items: Array<{
    id: string;
    orderId: string;
    orderNumber: string;
    status: string;
    reason: string;
    items: Array<{ sku: string; name: string; quantity: number }>;
    createdAt: string;
  }>;
}

export default async function Returns({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const { status } = await searchParams;
  const { items } = await api<R>(`/returns${status ? `?status=${encodeURIComponent(status)}` : ''}`);
  return (
    <>
      <h1>Returns</h1>
      <p className="sub">
        Stock is restored only when the parcel is physically <b>received</b> — once per return. Online-paid
        orders get a refund for the item value queued for finance; Cash on Delivery refunds are sent manually.
      </p>
      <form className="filters">
        <label>
          Status
          <select name="status" defaultValue={status ?? ''}>
            <option value="">All</option>
            {['requested', 'approved', 'rejected', 'received'].map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </label>
        <button className="btn">Filter</button>
      </form>
      {items.length === 0 ? (
        <p className="card">No returns.</p>
      ) : (
        <div className="tablewrap">
          <table>
            <caption className="skip">Returns</caption>
            <thead>
              <tr>
                <th>Order</th>
                <th>Items</th>
                <th>Reason</th>
                <th>Status</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {items.map((r) => (
                <tr key={r.id}>
                  <td>
                    <Link href={`/orders/${r.orderId}`}>{r.orderNumber}</Link>
                  </td>
                  <td>{r.items.map((i) => `${i.quantity} × ${i.name}`).join(', ')}</td>
                  <td>{r.reason}</td>
                  <td>
                    <span className="badge">{r.status}</span>
                  </td>
                  <td>
                    {r.status === 'requested' ? (
                      <>
                        <ConfirmAction
                          action={decideReturnAction}
                          label="Approve"
                          danger={false}
                          warning="The customer will be told to send the item back."
                          hidden={{ id: r.id, approve: 'yes' }}
                        />{' '}
                        <ConfirmAction
                          action={decideReturnAction}
                          label="Decline"
                          warning="The customer is told the return was declined; your reason is shown to them."
                          hidden={{ id: r.id, approve: 'no' }}
                        />
                      </>
                    ) : null}
                    {r.status === 'approved' ? (
                      <ConfirmAction
                        action={receiveReturnAction}
                        label="Mark received"
                        danger={false}
                        warning="Confirms the goods are back. Stock is restored (once) and a refund is queued where applicable. Requires MFA."
                        hidden={{ id: r.id }}
                      />
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
