'use client';

import { useState } from 'react';
import { ActionForm } from '@/components/ui';
import { enrollMfaAction, verifyMfaAction } from '@/lib/actions';

export function MfaSetup({ alreadyVerified }: { alreadyVerified: boolean }) {
  const [secret, setSecret] = useState<{ secret: string; otpauthUri: string } | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function start() {
    setBusy(true);
    setError('');
    const r = await enrollMfaAction();
    setBusy(false);
    if (r.secret && r.otpauthUri) setSecret({ secret: r.secret, otpauthUri: r.otpauthUri });
    else setError(r.error ?? 'Could not start enrolment.');
  }

  return (
    <section className="card" aria-labelledby="mfa-h">
      <h2 id="mfa-h" style={{ marginTop: 0 }}>
        Authenticator app
      </h2>
      {error ? (
        <p role="alert" className="notice err">
          {error}
        </p>
      ) : null}
      {!secret ? (
        <>
          <p>
            {alreadyVerified
              ? 'Already set up. To use it on a new device, ask an administrator to reset your factor.'
              : 'Set up your authenticator app, then enter a code to finish.'}
          </p>
          {!alreadyVerified ? (
            <button className="btn" onClick={start} disabled={busy}>
              {busy ? 'Starting…' : 'Set up two-step verification'}
            </button>
          ) : null}
          {!alreadyVerified ? (
            <p className="sub">Already scanned a key earlier but not finished? Enter the code below.</p>
          ) : null}
        </>
      ) : (
        <>
          <p>
            Add this account in your authenticator app using <b>manual entry</b> with this key:
          </p>
          <p>
            <code style={{ fontSize: 18, letterSpacing: 2 }}>{secret.secret}</code>
          </p>
          <p className="sub">
            Account: JIMMY WAX Admin · time-based · 6 digits · 30 s. (The key is shown once.)
          </p>
        </>
      )}
      {!alreadyVerified ? (
        <ActionForm action={verifyMfaAction} submit="Verify code">
          <label>
            6-digit code
            <input name="code" inputMode="numeric" pattern="[0-9]{6}" required autoComplete="one-time-code" />
          </label>
        </ActionForm>
      ) : null}
    </section>
  );
}
