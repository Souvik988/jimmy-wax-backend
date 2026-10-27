import { api } from '@/lib/api';
import { ActionForm, ConfirmAction } from '@/components/ui';
import { activateCheckoutAction, disableCheckoutAction, updateSettingsAction } from '@/lib/actions';

interface S {
  settings: {
    shippingFeePaise: number;
    freeShippingThresholdPaise: number | null;
    codEnabled: boolean;
    codMaxOrderPaise: number | null;
    codFeePaise: number;
    gstRateBps: number;
    taxInclusive: boolean;
    returnWindowDays: number | null;
    merchantLegalName: string | null;
    merchantGstin: string | null;
    merchantState: string | null;
    merchantAddress: string | null;
    onlinePaymentsEnabled: boolean;
    paymentWindowMinutes: number | null;
    checkoutEnabled: boolean;
    checkoutPolicyConfirmed: boolean;
    checkoutAuthority: string;
    version: number;
  };
  readiness: {
    allOk: boolean;
    checks: Array<{ id: string; ok: boolean; detail: string; manual?: boolean; blocking?: boolean }>;
  };
}
const rupees = (p: number | null) => (p === null ? '' : (p / 100).toFixed(2));

export default async function Settings() {
  const { settings: s, readiness } = await api<S>('/settings');
  return (
    <>
      <h1>Store settings &amp; checkout activation</h1>
      <p className="sub">
        Customers cannot check out until every blocking prerequisite below passes and an administrator
        explicitly activates checkout. All changes need MFA and are audited with a reason.
      </p>
      <div className={`notice ${s.checkoutEnabled ? 'ok' : 'warn'}`} role="status">
        Checkout is <b>{s.checkoutEnabled ? 'ACTIVE' : 'OFF'}</b> · policy confirmed:{' '}
        {s.checkoutPolicyConfirmed ? 'yes' : 'no'}
      </div>

      <h2>Readiness</h2>
      <ul className="checks card">
        {readiness.checks.map((c) => (
          <li key={c.id}>
            <span className={`badge ${c.ok ? 'ok' : c.blocking === false ? 'warn' : 'err'}`}>
              {c.ok ? 'OK' : c.blocking === false ? 'Warning' : 'Blocked'}
            </span>{' '}
            <b>{c.id}</b> — {c.detail}
            {c.manual ? ' (merchant to confirm)' : ''}
          </li>
        ))}
      </ul>
      {!s.checkoutEnabled ? (
        <ConfirmAction
          action={activateCheckoutAction}
          label="Activate checkout"
          danger={false}
          warning={
            readiness.allOk
              ? 'This opens purchasing to customers. Confirm that prices, stock, shipping, COD rules and GST have been approved.'
              : 'Blocked: resolve the blocking checks above first. The server will refuse activation.'
          }
          hidden={{ version: s.version, confirm: 'on' }}
        />
      ) : (
        <ConfirmAction
          action={disableCheckoutAction}
          label="Disable checkout now"
          warning="Stops new orders immediately (kill switch). In-flight orders and payments are unaffected."
          hidden={{}}
        />
      )}

      <h2>Shipping, payment &amp; tax policy</h2>
      <ActionForm action={updateSettingsAction} submit="Save policy">
        <input type="hidden" name="version" value={s.version} />
        <input type="hidden" name="policyForm" value="1" />
        <label>
          Shipping fee (₹)
          <input
            name="shippingFee"
            type="number"
            step="0.01"
            min="0"
            required
            defaultValue={rupees(s.shippingFeePaise)}
          />
        </label>
        <label>
          Free shipping from (₹, blank = never)
          <input
            name="freeShipping"
            type="number"
            step="0.01"
            min="0"
            defaultValue={rupees(s.freeShippingThresholdPaise)}
          />
        </label>
        <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <input name="cod" type="checkbox" defaultChecked={s.codEnabled} style={{ minHeight: 0 }} /> Allow
          Cash on Delivery
        </label>
        <label>
          COD handling fee (₹, charged per COD order)
          <input
            name="codFee"
            type="number"
            step="0.01"
            min="0"
            required
            defaultValue={rupees(s.codFeePaise)}
          />
        </label>
        <label>
          COD order limit (₹, blank = none)
          <input name="codMax" type="number" step="0.01" min="0" defaultValue={rupees(s.codMaxOrderPaise)} />
        </label>
        <label>
          GST rate (%)
          <input
            name="gstRate"
            type="number"
            step="0.01"
            min="0"
            max="40"
            required
            defaultValue={(s.gstRateBps / 100).toString()}
          />
        </label>
        <label>
          Listed prices are
          <select name="taxBasis" defaultValue={s.taxInclusive ? 'inclusive' : 'exclusive'}>
            <option value="inclusive">GST-inclusive (MRP style)</option>
            <option value="exclusive">GST added on top</option>
          </select>
        </label>
        <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <input
            name="online"
            type="checkbox"
            defaultChecked={s.onlinePaymentsEnabled}
            style={{ minHeight: 0 }}
          />{' '}
          Allow online payment
        </label>
        <label>
          Payment window (minutes, 5–1440)
          <input name="window" type="number" min="5" max="1440" defaultValue={s.paymentWindowMinutes ?? ''} />
        </label>
        <label>
          Return window (days after delivery; blank = returns off)
          <input name="returnDays" type="number" min="1" max="90" defaultValue={s.returnWindowDays ?? ''} />
        </label>
        <label>
          Reason
          <input name="reason" required minLength={3} maxLength={300} />
        </label>
      </ActionForm>

      <h2>Seller details for GST invoices</h2>
      <p className="sub">
        Required before any invoice can be issued. Use exactly what is on your GST registration.
      </p>
      <ActionForm action={updateSettingsAction} submit="Save seller details">
        <input type="hidden" name="version" value={s.version} />
        <label>
          Legal / trade name
          <input name="merchantLegalName" defaultValue={s.merchantLegalName ?? ''} maxLength={200} />
        </label>
        <label>
          GSTIN (15 characters)
          <input
            name="merchantGstin"
            defaultValue={s.merchantGstin ?? ''}
            maxLength={15}
            style={{ textTransform: 'uppercase' }}
          />
        </label>
        <label>
          State of registration
          <input name="merchantState" defaultValue={s.merchantState ?? ''} maxLength={60} />
        </label>
        <label>
          Registered address
          <input
            name="merchantAddress"
            defaultValue={s.merchantAddress ?? ''}
            maxLength={400}
            style={{ width: 320 }}
          />
        </label>
        <label>
          Reason
          <input name="reason" required minLength={3} maxLength={300} />
        </label>
      </ActionForm>
    </>
  );
}
