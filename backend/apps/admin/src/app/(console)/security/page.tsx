import { api, type Me } from '@/lib/api';
import { MfaSetup } from './MfaSetup';

export default async function Security() {
  const me = await api<Me>('/me');
  return (
    <>
      <h1>My security</h1>
      <p className="sub">
        Refunds, cancellations, stock changes, shipping areas and settings need a session that completed
        two-step verification (an authenticator app such as Google Authenticator or Authy).
      </p>
      <div className={`notice ${me.mfa ? 'ok' : 'warn'}`} role="status">
        This session: <b>{me.mfa ? 'two-step verified' : 'password only'}</b>.
      </div>
      <MfaSetup alreadyVerified={me.mfa} />
    </>
  );
}
