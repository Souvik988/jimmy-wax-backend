import { api } from '@/lib/api';
import { ActionForm } from '@/components/ui';
import { adjustStockAction } from '@/lib/actions';

interface Inv {
  items: Array<{
    variantId: string;
    sku: string;
    name: string;
    variantTitle: string;
    onHand: number;
    reserved: number;
    available: number;
    lowStockThreshold: number | null;
    version: number;
  }>;
}

export default async function Inventory() {
  const { items } = await api<Inv>('/inventory');
  return (
    <>
      <h1>Inventory</h1>
      <p className="sub">
        Stock changes are ledger entries with a reason and your name. Adjustments use the version shown here:
        if someone else changed it first, yours is rejected instead of overwriting theirs. Requires MFA.
      </p>
      <div className="tablewrap">
        <table>
          <caption className="skip">Inventory positions</caption>
          <thead>
            <tr>
              <th>SKU</th>
              <th>Product</th>
              <th className="num">On hand</th>
              <th className="num">Reserved</th>
              <th className="num">Available</th>
              <th>Adjust</th>
            </tr>
          </thead>
          <tbody>
            {items.map((i) => (
              <tr key={i.variantId}>
                <td>{i.sku}</td>
                <td>
                  {i.name}
                  <br />
                  <small>{i.variantTitle}</small>
                </td>
                <td className="num">{i.onHand}</td>
                <td className="num">{i.reserved}</td>
                <td className="num">
                  <b>{i.available}</b>
                  {i.lowStockThreshold !== null && i.available <= i.lowStockThreshold ? (
                    <span className="badge warn"> low</span>
                  ) : null}
                </td>
                <td>
                  <ActionForm action={adjustStockAction} submit="Apply">
                    <input type="hidden" name="variantId" value={i.variantId} />
                    <input type="hidden" name="version" value={i.version} />
                    <label>
                      Change (+/−)
                      <input name="delta" type="number" step={1} required style={{ width: 90 }} />
                    </label>
                    <label>
                      Reason
                      <input
                        name="reason"
                        required
                        minLength={3}
                        maxLength={300}
                        placeholder="e.g. opening stock count"
                      />
                    </label>
                  </ActionForm>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
