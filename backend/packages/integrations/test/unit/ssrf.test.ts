import { describe, expect, it } from 'vitest';
import {
  MAX_DOCUMENT_BYTES,
  ShiprocketProvider,
  ShippingError,
  isSafeDocumentUrl,
} from '../../src/shipping.ts';

describe('provider document URLs (SSRF guard)', () => {
  it('allows https documents on the provider hosts', () => {
    expect(isSafeDocumentUrl('https://kr-shipmultichannel.s3.ap-south-1.amazonaws.com/labels/1.pdf')).toBe(
      true,
    );
    expect(isSafeDocumentUrl('https://apiv2.shiprocket.in/files/label.pdf')).toBe(true);
    expect(isSafeDocumentUrl('https://cdn.partner.example/x.pdf', ['partner.example'])).toBe(true);
  });

  it.each([
    'http://apiv2.shiprocket.in/label.pdf', // not https
    'https://127.0.0.1/label.pdf',
    'https://169.254.169.254/latest/meta-data',
    'https://[::1]/label.pdf',
    'https://localhost/label.pdf',
    'https://shiprocket.in.attacker.example/label.pdf', // suffix trick
    'https://attackershiprocket.in/label.pdf',
    'https://db.internal/label.pdf',
    'https://intranet/label.pdf', // single label
    'https://user:pass@apiv2.shiprocket.in/label.pdf',
    'https://apiv2.shiprocket.in:8443/label.pdf',
    'file:///etc/passwd',
    'not a url',
  ])('refuses %s', (url) => {
    expect(isSafeDocumentUrl(url)).toBe(false);
  });

  const provider = (fetchImpl: typeof fetch) =>
    new ShiprocketProvider({ email: 'a@b.test', password: 'pw', webhookToken: 'w' }, fetchImpl);
  const respond = (doc: () => Response) =>
    (async (url: string) => {
      const u = String(url);
      if (u.endsWith('/auth/login')) return Response.json({ token: 't' });
      if (u.includes('generate/label'))
        return Response.json({ label_url: 'https://kr-shipmultichannel.s3.ap-south-1.amazonaws.com/l.pdf' });
      return doc();
    }) as unknown as typeof fetch;

  it('downloads an allowed document and refuses oversized or redirecting ones', async () => {
    const ok = provider(respond(() => new Response(Buffer.from('%PDF-1.4 ok'))));
    expect((await ok.fetchLabel('1')).toString()).toContain('%PDF');
    const big = provider(
      respond(() => new Response('x', { headers: { 'content-length': String(MAX_DOCUMENT_BYTES + 1) } })),
    );
    await expect(big.fetchLabel('1')).rejects.toBeInstanceOf(ShippingError);
    let sawRedirectMode = '';
    const redirecting = provider((async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith('/auth/login')) return Response.json({ token: 't' });
      if (u.includes('generate/label'))
        return Response.json({ label_url: 'https://kr-shipmultichannel.s3.ap-south-1.amazonaws.com/l.pdf' });
      sawRedirectMode = String(init?.redirect);
      return new Response('x');
    }) as unknown as typeof fetch);
    await redirecting.fetchLabel('1');
    expect(sawRedirectMode).toBe('error'); // the download never follows redirects
  });

  it('a label URL on an internal address is refused before any request is made', async () => {
    let downloads = 0;
    const evil = provider((async (url: string) => {
      const u = String(url);
      if (u.endsWith('/auth/login')) return Response.json({ token: 't' });
      if (u.includes('generate/label'))
        return Response.json({ label_url: 'https://169.254.169.254/latest/meta-data/' });
      downloads += 1;
      return new Response('secret');
    }) as unknown as typeof fetch);
    await expect(evil.fetchLabel('1')).rejects.toBeInstanceOf(ShippingError);
    expect(downloads).toBe(0);
  });
});
