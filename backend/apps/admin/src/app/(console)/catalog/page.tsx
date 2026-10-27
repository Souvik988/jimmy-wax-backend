import { api } from '@/lib/api';
import { ActionForm } from '@/components/ui';
import { updateVariantAction } from '@/lib/actions';

interface Variants {
  items: Array<{
    id: string;
    sku: string;
    name: string;
    title: string;
    pricePaise: number;
    comparePaise: number | null;
    active: boolean;
    updatedAt: string;
  }>;
}

export default async function Catalog() {
  const { items } = await api<Variants>('/catalog/variants');
  return (
    <>
      <h1>Catalog &amp; prices</h1>
      <p className="sub">
        Prices are entered in rupees and stored as exact paise. Existing orders keep the price they were
        bought at. Every change is audited with a reason.
      </p>
      <div className="tablewrap">
        <table>
          <caption className="skip">Variants</caption>
          <thead>
            <tr>
              <th>Product</th>
              <th>Edit</th>
            </tr>
          </thead>
          <tbody>
            {items.map((v) => (
              <tr key={v.id}>
                <td>
                  {v.name}
                  <br />
                  <small>
                    {v.sku} · {v.title}
                  </small>
                </td>
                <td>
                  <ActionForm action={updateVariantAction} submit="Save">
                    <input type="hidden" name="id" value={v.id} />
                    <input type="hidden" name="updatedAt" value={v.updatedAt} />
                    <label>
                      Selling price (₹)
                      <input
                        name="price"
                        type="number"
                        step="0.01"
                        min="0"
                        required
                        defaultValue={(v.pricePaise / 100).toFixed(2)}
                        style={{ width: 120 }}
                      />
                    </label>
                    <label>
                      MRP (₹)
                      <input
                        name="mrp"
                        type="number"
                        step="0.01"
                        min="0"
                        defaultValue={v.comparePaise === null ? '' : (v.comparePaise / 100).toFixed(2)}
                        style={{ width: 120 }}
                      />
                    </label>
                    <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                      <input
                        name="active"
                        type="checkbox"
                        defaultChecked={v.active}
                        style={{ minHeight: 0 }}
                      />{' '}
                      Published
                    </label>
                    <label>
                      Reason
                      <input
                        name="reason"
                        required
                        minLength={3}
                        maxLength={300}
                        placeholder="e.g. merchant approved MRP"
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
