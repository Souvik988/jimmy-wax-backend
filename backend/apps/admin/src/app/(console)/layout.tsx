import { api, ApiError, type Me } from '@/lib/api';
import { logoutAction, requireSession } from '@/lib/actions';
import { Nav } from '@/components/Nav';
import { SessionKeeper } from '@/components/SessionKeeper';

export default async function ConsoleLayout({ children }: { children: React.ReactNode }) {
  const session = await requireSession();
  let me: Me | null = null;
  let denied: string | null = null;
  try {
    me = await api<Me>('/me');
  } catch (e) {
    if (e instanceof ApiError && e.status === 403) denied = e.message;
    else throw e;
  }

  if (!me) {
    return (
      <main className="login">
        <p className="brand">
          JIMMY WAX<small>Operator console</small>
        </p>
        <h1>Access denied</h1>
        <p role="alert" className="notice err">
          {denied}
        </p>
        <p>
          You are signed in as <b>{session.email}</b>, but this account has no operator role. Ask an
          administrator to grant one.
        </p>
        <form action={logoutAction}>
          <button className="btn secondary">Sign out</button>
        </form>
      </main>
    );
  }
  return (
    <div className="shell">
      <SessionKeeper />
      <a className="skip" href="#main">
        Skip to content
      </a>
      <aside className="side">
        <p className="brand">
          JIMMY WAX<small>Operator console</small>
        </p>
        <Nav permissions={me.permissions} />
        <div className="who">
          <div>{session.email}</div>
          <div>
            Role: <b>{me.role}</b> · MFA: {me.mfa ? 'verified' : 'not verified'}
          </div>
          <form action={logoutAction}>
            <button
              className="btn secondary"
              style={{ marginTop: 8, color: '#fff6e8', borderColor: '#81776d' }}
            >
              Sign out
            </button>
          </form>
        </div>
      </aside>
      <main id="main" className="main" tabIndex={-1}>
        {!me.mfa ? (
          <p className="notice warn" role="status">
            Your session has not completed MFA. Refunds, cancellations, stock changes, and settings changes
            will be refused until you sign in with MFA.
          </p>
        ) : null}
        {children}
      </main>
    </div>
  );
}
