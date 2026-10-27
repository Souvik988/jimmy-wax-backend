import { api } from '@/lib/api';
import { ActionForm } from '@/components/ui';
import { pinsAction } from '@/lib/actions';

interface Pins {
  items: Array<{ prefix: string; note: string | null }>;
}

export default async function Shipping() {
  const { items } = await api<Pins>('/shipping/pins');
  return (
    <>
      <h1>Shipping areas</h1>
      <p className="sub">
        A PIN code is deliverable when it starts with one of these prefixes (3–6 digits, e.g. <code>400</code>{' '}
        for Mumbai). An empty list means <b>nothing</b> is deliverable and checkout cannot be activated.
        Changing the list invalidates outstanding quotes. Requires MFA.
      </p>
      <h2>Serviceable prefixes ({items.length})</h2>
      {items.length === 0 ? (
        <p className="notice warn">No PIN prefixes configured yet.</p>
      ) : (
        <p className="card">
          {items.map((p) => (
            <span key={p.prefix} className="badge" style={{ margin: 3 }} title={p.note ?? ''}>
              {p.prefix}
            </span>
          ))}
        </p>
      )}
      <h2>Change the list</h2>
      <ActionForm action={pinsAction} submit="Save changes">
        <label>
          Add prefixes (comma or space separated)
          <textarea name="add" rows={3} placeholder="400 401 410 411" style={{ width: 280 }} />
        </label>
        <label>
          Remove prefixes
          <textarea name="remove" rows={3} style={{ width: 220 }} />
        </label>
        <label>
          Note (optional)
          <input name="note" maxLength={100} placeholder="e.g. Maharashtra" />
        </label>
      </ActionForm>
    </>
  );
}
