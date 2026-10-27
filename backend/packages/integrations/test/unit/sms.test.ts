import { describe, it, expect, vi } from 'vitest';
import { TwilioSmsSender } from '../../src/sms.ts';
describe('Twilio SMS boundary', () => {
  it('sends server-side credentials with a bounded request and no URL secrets', async () => {
    const fetcher = vi.fn(async () => new Response('{}', { status: 201 }));
    const sender = new TwilioSmsSender(
      { accountSid: 'AC' + 'a'.repeat(32), authToken: 'private', messagingServiceSid: 'MGtest' },
      fetcher as typeof fetch,
    );
    await sender.send({ to: '+919876543210', text: '123456 is your code' });
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).not.toContain('private');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(String(init.body)).toContain('MessagingServiceSid=MGtest');
    expect(init.headers).toHaveProperty('authorization');
  });
  it('does not surface provider error bodies or replay a failed send', async () => {
    const fetcher = vi.fn(async () => new Response('sensitive provider response', { status: 429 }));
    const sender = new TwilioSmsSender(
      { accountSid: 'AC' + 'a'.repeat(32), authToken: 'private', from: 'JIMMYWAX' },
      fetcher as typeof fetch,
    );
    await expect(sender.send({ to: '+919876543210', text: 'code' })).rejects.toThrow(
      'SMS provider did not accept',
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
