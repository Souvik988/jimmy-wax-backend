import { api } from '@/lib/api';
import { ConfirmAction } from '@/components/ui';
import { replayOutboxAction } from '@/lib/actions';

interface O {
  items: Array<{
    id: number;
    eventType: string;
    aggregateId: string;
    attempts: number;
    lastError: string | null;
    createdAt: string;
    dead: boolean;
  }>;
}

export default async function Ops() {
  const [dead, pending] = await Promise.all([
    api<O>('/ops/outbox?state=dead'),
    api<O>('/ops/outbox?state=pending'),
  ]);
  return (
    <>
      <h1>Queues</h1>
      <p className="sub">
        Events are written to the database in the same transaction as the business change. Dead letters failed
        repeatedly; replaying one re-runs its handlers, which are idempotent.
      </p>
      <h2>Dead-lettered ({dead.items.length})</h2>
      {dead.items.length === 0 ? (
        <p className="card">None.</p>
      ) : (
        <div className="tablewrap">
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>Event</th>
                <th>Aggregate</th>
                <th>Attempts</th>
                <th>Last error</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {dead.items.map((e) => (
                <tr key={e.id}>
                  <td>{e.id}</td>
                  <td>{e.eventType}</td>
                  <td>{e.aggregateId.slice(0, 8)}</td>
                  <td>{e.attempts}</td>
                  <td>{e.lastError}</td>
                  <td>
                    <ConfirmAction
                      action={replayOutboxAction}
                      label="Replay"
                      danger={false}
                      warning="Re-queues this event. Requires MFA."
                      hidden={{ id: e.id }}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <h2>Pending ({pending.items.length})</h2>
      {pending.items.length === 0 ? (
        <p className="card">Queue is empty.</p>
      ) : (
        <div className="tablewrap">
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>Event</th>
                <th>Created</th>
                <th>Attempts</th>
              </tr>
            </thead>
            <tbody>
              {pending.items.map((e) => (
                <tr key={e.id}>
                  <td>{e.id}</td>
                  <td>{e.eventType}</td>
                  <td>{e.createdAt.slice(0, 19).replace('T', ' ')}</td>
                  <td>{e.attempts}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
