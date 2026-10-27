import { NextResponse } from 'next/server';
import { apiRefresh } from '@/lib/auth';
import { clearSession, readSession, writeSession } from '@/lib/session';

/**
 * Called by <SessionKeeper/> every few minutes while an operator is active. Rotates the refresh token against
 * the API and rewrites the HTTP-only cookie. Same-origin POST only (SameSite=Strict + Origin check).
 */
export async function POST(req: Request) {
  const origin = req.headers.get('origin');
  if (origin && new URL(origin).host !== req.headers.get('host')) {
    return NextResponse.json({ ok: false }, { status: 403 });
  }
  const s = await readSession({ allowExpired: true });
  if (!s) return NextResponse.json({ ok: false }, { status: 401 });
  const t = await apiRefresh(s.refreshToken);
  if (!t) {
    await clearSession();
    return NextResponse.json({ ok: false }, { status: 401 });
  }
  await writeSession({
    accessToken: t.accessToken,
    refreshToken: t.refreshToken,
    email: s.email,
    exp: t.exp,
  });
  return NextResponse.json({ ok: true });
}
