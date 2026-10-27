import Link from 'next/link';
import { api, inr } from '@/lib/api';
import { ConfirmAction } from '@/components/ui';
import { processRefundAction } from '@/lib/actions';

interface R {
  items: Array<{
    id: string;
    orderId: string;
    amountPaise: number;
    status: string;
    reason: string;
    createdAt: string;
  }>;
}

export default async function Refunds() {
  const { items } = await api<R>('/refunds');
  return (
    <>
      <h1>Refunds</h1>
      <p className="sub">
        Refunds can never exceed the order total (enforced in the database). Processing is idempotent:
        retrying a pending refund reuses the same provider key, so the customer is refunded once.
      </p>
      {items.length === 0 ? (
        <p className="card">No refunds.</p>
      ) : (
        <div className="tablewrap">
          <table>
            <caption className="skip">Refunds</caption>
            <thead>
              <tr>
                <th>Refund</th>
                <th>Order</th>
                <th>Reason</th>
                <th>Status</th>
                <th className="num">Amount</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {items.map((f) => (
                <tr key={f.id}>
                  <td>{f.id.slice(0, 8)}</td>
                  <td>
                    <Link href={`/orders/${f.orderId}`}>{f.orderId.slice(0, 8)}</Link>
                  </td>
                  <td>{f.reason}</td>
                  <td>
                    <span
                      className={`badge ${f.status === 'processed' ? 'ok' : f.status === 'failed' ? 'err' : 'warn'}`}
                    >
                      {f.status}
                    </span>
                  </td>
                  <td className="num">{inr(f.amountPaise)}</td>
                  <td>
                    {f.status !== 'processed' ? (
                      <ConfirmAction
                        action={processRefundAction}
                        label="Process refund"
                        danger={false}
                        warning={`Sends ${inr(f.amountPaise)} back to the customer's original payment method. Requires MFA.`}
                        hidden={{ id: f.id }}
                      />
                    ) : (
                      '—'
                    )}
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
