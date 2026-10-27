'use client';

import { useActionState } from 'react';
import { loginAction, type FormState } from '@/lib/actions';
import { Notice } from '@/components/ui';

const initial: FormState = { ok: false, message: '' };

export function LoginForm() {
  const [state, run, pending] = useActionState(loginAction, initial);
  return (
    <>
      <Notice state={state} />
      <form action={run} className="card" style={{ display: 'grid', gap: 12 }} aria-busy={pending}>
        <label>
          Work email
          <input name="email" type="email" autoComplete="username" required />
        </label>
        <label>
          Password
          <input name="password" type="password" autoComplete="current-password" required />
        </label>
        <label>
          Authenticator code (required once MFA is set up)
          <input name="code" inputMode="numeric" pattern="[0-9]{6}" autoComplete="one-time-code" />
        </label>
        <button className="btn" disabled={pending}>
          {pending ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </>
  );
}
