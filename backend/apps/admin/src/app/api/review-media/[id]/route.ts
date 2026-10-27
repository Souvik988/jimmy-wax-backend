import { readSession } from '@/lib/session';

/** Streams a quarantined review photo to a signed-in moderator. The browser never sees the API token. */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return new Response('Not found', { status: 404 });
  const s = await readSession();
  if (!s) return new Response('Unauthorised', { status: 401 });
  const upstream = await fetch(
    `${process.env.COMMERCE_API_URL ?? 'http://127.0.0.1:4000'}/v1/admin/review-media/${id}/image`,
    {
      headers: { authorization: `Bearer ${s.accessToken}` },
      cache: 'no-store',
    },
  );
  if (!upstream.ok) return new Response('Not found', { status: upstream.status === 403 ? 403 : 404 });
  return new Response(upstream.body, {
    headers: {
      'content-type': upstream.headers.get('content-type') ?? 'image/webp',
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}
