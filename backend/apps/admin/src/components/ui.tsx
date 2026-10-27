'use client';

import { useActionState, type ReactNode } from 'react';
import type { Action, FormState } from '@/lib/actions';

const initial: FormState = { ok: false, message: '' };

export function Notice({ state }: { state: FormState }) {
  if (!state.message) return null;
  return (
    <p role={state.ok ? 'status' : 'alert'} className={`notice ${state.ok ? 'ok' : 'err'}`}>
      {state.message}
      {state.requestId ? <small> (ref {state.requestId.slice(0, 8)})</small> : null}
    </p>
  );
}

/** A form bound to a server action. The submit button is disabled while pending, so an accidental double-click never double-submits. */
export function ActionForm({
  action,
  children,
  submit,
  className = 'inline',
  danger = false,
}: {
  action: Action;
  children: ReactNode;
  submit: string;
  className?: string;
  danger?: boolean;
}) {
  const [state, run, pending] = useActionState(action, initial);
  return (
    <>
      <Notice state={state} />
      <form action={run} className={className} aria-busy={pending}>
        {children}
        <button className={`btn${danger ? ' danger' : ''}`} disabled={pending}>
          {pending ? 'Working…' : submit}
        </button>
      </form>
    </>
  );
}

/** Irreversible/financial actions sit behind an explicit confirmation panel that requires a written reason. */
export function ConfirmAction({
  action,
  label,
  warning,
  hidden,
  danger = true,
}: {
  action: Action;
  label: string;
  warning: string;
  hidden: Record<string, string | number>;
  danger?: boolean;
}) {
  return (
    <details className="confirm">
      <summary className={`btn ${danger ? 'danger' : 'secondary'}`} role="button">
        {label}
      </summary>
      <p className="notice warn">{warning}</p>
      <ActionForm action={action} submit={`Confirm: ${label}`} danger={danger}>
        {Object.entries(hidden).map(([k, v]) => (
          <input key={k} type="hidden" name={k} value={String(v)} />
        ))}
        <label>
          Reason (required, recorded in the audit log)
          <input name="reason" required minLength={3} maxLength={300} autoComplete="off" />
        </label>
      </ActionForm>
    </details>
  );
}
