import { api, inr } from '@/lib/api';

interface Dashboard {
  definitions: { window: string; currency: string; ordersByStatus: string };
  ordersByStatus: Array<{ status: string; count: number; totalPaise: number }>;
  lowStockVariants: number;
  paymentExceptions: number;
  refundsOpen: number;
  outbox: { pending: number; deadLetters: number; oldestPendingSeconds: number };
}

export default async function Dashboard() {
  const d = await api<Dashboard>('/dashboard');
  const total = d.ordersByStatus.reduce((n, o) => n + o.count, 0);
  return (
    <>
      <h1>Dashboard</h1>
      <p className="sub">
        All figures are computed from live records. Window: {d.definitions.window}. Currency:{' '}
        {d.definitions.currency}.
      </p>
      <div className="grid">
        <div className="card stat">
          <b>{total}</b>
          <span>Orders in window</span>
        </div>
        <div className="card stat">
          <b>{d.paymentExceptions}</b>
          <span>Payment exceptions {d.paymentExceptions ? '— needs finance review' : ''}</span>
        </div>
        <div className="card stat">
          <b>{d.refundsOpen}</b>
          <span>Refunds awaiting processing</span>
        </div>
        <div className="card stat">
          <b>{d.lowStockVariants}</b>
          <span>Variants at/below low-stock threshold</span>
        </div>
        <div className="card stat">
          <b>{d.outbox.deadLetters}</b>
          <span>Dead-lettered events</span>
        </div>
        <div className="card stat">
          <b>{d.outbox.oldestPendingSeconds}s</b>
          <span>Oldest pending event ({d.outbox.pending} pending)</span>
        </div>
      </div>
      <h2>Orders by current status</h2>
      <p className="sub">{d.definitions.ordersByStatus}</p>
      {d.ordersByStatus.length === 0 ? (
        <p className="card">No orders in this window yet.</p>
      ) : (
        <div className="tablewrap">
          <table>
            <caption className="skip">Orders by status</caption>
            <thead>
              <tr>
                <th>Status</th>
                <th className="num">Orders</th>
                <th className="num">Value (incl. shipping)</th>
              </tr>
            </thead>
            <tbody>
              {d.ordersByStatus.map((o) => (
                <tr key={o.status}>
                  <td>{o.status}</td>
                  <td className="num">{o.count}</td>
                  <td className="num">{inr(o.totalPaise)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
