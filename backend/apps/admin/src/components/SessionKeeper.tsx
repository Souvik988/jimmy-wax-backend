'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

/** Keeps an ACTIVE operator signed in (short-lived access tokens) and sends idle/revoked sessions to the login page. */
export function SessionKeeper({ everyMs = 8 * 60_000 }: { everyMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    const id = setInterval(async () => {
      try {
        const r = await fetch('/api/session/refresh', { method: 'POST' });
        if (r.status === 401) router.replace('/login?expired=1');
      } catch {
        /* offline: try again next tick */
      }
    }, everyMs);
    return () => clearInterval(id);
  }, [everyMs, router]);
  return null;
}
