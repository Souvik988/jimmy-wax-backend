export interface SmsSender {
  readonly name: string;
  send(msg: { to: string; text: string }): Promise<void>;
}

/** Twilio accepts the message; delivery remains a provider-side result. Never log OTPs or provider responses. */
export class TwilioSmsSender implements SmsSender {
  readonly name = 'twilio';
  constructor(
    private config: { accountSid: string; authToken: string; messagingServiceSid?: string; from?: string },
    private fetcher: typeof fetch = fetch,
  ) {}
  async send(msg: { to: string; text: string }): Promise<void> {
    if (!/^\+[1-9][0-9]{7,14}$/.test(msg.to)) throw new Error('Invalid SMS destination');
    const body = new URLSearchParams({ To: msg.to, Body: msg.text });
    if (this.config.messagingServiceSid) body.set('MessagingServiceSid', this.config.messagingServiceSid);
    else if (this.config.from) body.set('From', this.config.from);
    else throw new Error('SMS sender is not configured');
    const response = await this.fetcher(
      `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(this.config.accountSid)}/Messages.json`,
      {
        method: 'POST',
        headers: {
          authorization:
            'Basic ' + Buffer.from(this.config.accountSid + ':' + this.config.authToken).toString('base64'),
          'content-type': 'application/x-www-form-urlencoded',
        },
        body,
        signal: AbortSignal.timeout(8000),
      },
    );
    if (!response.ok) throw new Error('SMS provider did not accept the message');
  }
}

/** Development only: logs instead of sending. Real SMS in India needs a DLT-registered sender/template (owner input). */
export class ConsoleSmsSender implements SmsSender {
  readonly name = 'console';
  readonly sent: Array<{ to: string; text: string }> = [];
  async send(msg: { to: string; text: string }) {
    this.sent.push(msg);
    if (process.env.NODE_ENV !== 'test') console.log(`[sms:console] to=${msg.to} text=${msg.text}`);
  }
}
