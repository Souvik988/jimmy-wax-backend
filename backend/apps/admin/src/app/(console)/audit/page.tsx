import { api } from '@/lib/api';

interface A {
  items: Array<{
    id: number;
    actorId: string | null;
    actorRole: string | null;
    action: string;
    resourceType: string;
    resourceId: string | null;
    reason: string | null;
    before: unknown;
    after: unknown;
    createdAt: string;
  }>;
}

export default async function Audit({ searchParams }: { searchParams: Promise<{ resourceType?: string }> }) {
  const { resourceType } = await searchParams;
  const { items } = await api<A>(
    `/audit${resourceType ? `?resourceType=${encodeURIComponent(resourceType)}` : ''}`,
  );
  return (
    <>
      <h1>Audit log</h1>
      <p className="sub">
        Append-only. Shows who changed what, why, and the before/after values. The latest 100 entries.
      </p>
      <form className="filters">
        <label>
          Resource type
          <select name="resourceType" defaultValue={resourceType ?? ''}>
            <option value="">All</option>
            {['order', 'variant', 'refund', 'store_settings', 'outbox'].map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
        </label>
        <button className="btn">Filter</button>
      </form>
      <div className="tablewrap">
        <table>
          <caption className="skip">Audit entries</caption>
          <thead>
            <tr>
              <th>When (UTC)</th>
              <th>Actor</th>
              <th>Action</th>
              <th>Resource</th>
              <th>Reason</th>
              <th>Change</th>
            </tr>
          </thead>
          <tbody>
            {items.map((a) => (
              <tr key={a.id}>
                <td>{a.createdAt.slice(0, 19).replace('T', ' ')}</td>
                <td>
                  {a.actorRole}
                  <br />
                  <small>{a.actorId?.slice(0, 8)}</small>
                </td>
                <td>{a.action}</td>
                <td>
                  {a.resourceType}
                  <br />
                  <small>{a.resourceId?.slice(0, 12)}</small>
                </td>
                <td>{a.reason}</td>
                <td>
                  <small>
                    {a.before ? `before ${JSON.stringify(a.before)}` : ''}
                    <br />
                    {a.after ? `after ${JSON.stringify(a.after)}` : ''}
                  </small>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
