import nodemailer from 'nodemailer';

export interface RenderedEmail {
  subject: string;
  text: string;
}
export interface EmailSender {
  readonly name: string;
  send(msg: { to: string; subject: string; text: string }): Promise<void>;
}

const inr = (p: number) =>
  `₹${(p / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const sig = '\n\n— JIMMY WAX';

type P = Record<string, unknown>;
const TEMPLATES: Record<string, (p: P) => RenderedEmail> = {
  verify_email: (p) => ({
    subject: 'Confirm your JIMMY WAX email',
    text: `Hi ${p.name || 'there'},\n\nConfirm your email address using this code in the app:\n\n${p.token}\n\nIt expires in 48 hours. If you did not create an account you can ignore this message.${sig}`,
  }),
  password_reset: (p) => ({
    subject: 'Reset your JIMMY WAX password',
    text: `Use this code in the app to choose a new password:\n\n${p.token}\n\nIt expires in 30 minutes. If you did not ask for this, ignore this email — your password has not changed.${sig}`,
  }),
  'admin.invite': (p) => ({
    subject: 'You have been invited to the JIMMY WAX operator console',
    text: `You have been invited as ${p.role}. Open the operator console, choose "Accept invitation" and enter this code:

${p.token}

It expires in 72 hours. If you were not expecting this, ignore this email.${sig}`,
  }),
  'order.placed': (p) => ({
    subject: `Order ${p.orderNumber} received`,
    text: `Thank you! We received your order ${p.orderNumber} for ${inr(Number(p.totalPaise))} (${p.paymentMethod === 'cod' ? 'Cash on Delivery' : 'online payment'}).${sig}`,
  }),
  'payment.captured': (p) => ({
    subject: `Payment received for order ${p.orderNumber}`,
    text: `We received your payment for order ${p.orderNumber}. We will pack it shortly.${sig}`,
  }),
  'payment.failed': (p) => ({
    subject: `Payment failed for order ${p.orderNumber}`,
    text: `Your payment for order ${p.orderNumber} did not go through. You can try again from the app before the payment window ends.${sig}`,
  }),
  'order.shipped': (p) => ({
    subject: `Order ${p.orderNumber} is on its way`,
    text: `Your order ${p.orderNumber} has shipped with ${p.courier}. Tracking number: ${p.trackingNumber}.${p.trackingUrl ? `\nTrack it: ${p.trackingUrl}` : ''}${sig}`,
  }),
  'order.delivered': (p) => ({
    subject: `Order ${p.orderNumber} delivered`,
    text: `Your order ${p.orderNumber} was delivered. We hope you enjoy it!${sig}`,
  }),
  'order.cancelled': (p) => ({
    subject: `Order ${p.orderNumber} cancelled`,
    text: `Your order ${p.orderNumber} has been cancelled.${p.refund ? ' A refund will be issued to your original payment method.' : ''}${sig}`,
  }),
  'order.expired': (p) => ({
    subject: `Order ${p.orderNumber} expired`,
    text: `Order ${p.orderNumber} expired because payment was not completed in time.${sig}`,
  }),
  'refund.processed': (p) => ({
    subject: `Refund issued for order ${p.orderNumber}`,
    text: `We issued a refund of ${inr(Number(p.amountPaise))} for order ${p.orderNumber}. It may take a few business days to appear.${sig}`,
  }),
  'return.decided': (p) => ({
    subject: `Return request ${p.approved ? 'approved' : 'declined'}`,
    text: `Your return request for order ${p.orderNumber} was ${p.approved ? 'approved' : 'declined'}.${p.note ? `\n\nNote: ${p.note}` : ''}${sig}`,
  }),
};

/** Templates an operator may reword, with the variables each may use. Token-carrying templates are never editable. */
export const EDITABLE_TEMPLATES: Record<string, string[]> = {
  'order.placed': ['orderNumber', 'total', 'paymentMethod'],
  'payment.captured': ['orderNumber'],
  'payment.failed': ['orderNumber'],
  'order.shipped': ['orderNumber', 'courier', 'trackingNumber', 'trackingUrl'],
  'order.delivered': ['orderNumber'],
  'order.cancelled': ['orderNumber'],
  'order.expired': ['orderNumber'],
  'refund.processed': ['orderNumber', 'amount'],
  'return.decided': ['orderNumber', 'decision', 'note'],
};
export interface TemplateOverride {
  subject: string;
  body: string;
}
const vars = (payload: P): Record<string, string> => ({
  orderNumber: String(payload.orderNumber ?? ''),
  total: payload.totalPaise === undefined ? '' : inr(Number(payload.totalPaise)),
  amount: payload.amountPaise === undefined ? '' : inr(Number(payload.amountPaise)),
  paymentMethod:
    payload.paymentMethod === 'cod' ? 'Cash on Delivery' : payload.paymentMethod ? 'online payment' : '',
  courier: String(payload.courier ?? ''),
  trackingNumber: String(payload.trackingNumber ?? ''),
  trackingUrl: String(payload.trackingUrl ?? ''),
  decision: payload.approved === undefined ? '' : payload.approved ? 'approved' : 'declined',
  note: String(payload.note ?? ''),
});
/** Variables used by a template string that are not in the allowed list (for save-time validation). */
export function unknownVariables(text: string, allowed: string[]): string[] {
  return [...new Set([...text.matchAll(/{{s*([A-Za-z0-9_]+)s*}}/g)].map((m) => m[1]!))].filter(
    (v) => !allowed.includes(v),
  );
}
const fill = (text: string, v: Record<string, string>) =>
  text.replace(/{{s*([A-Za-z0-9_]+)s*}}/g, (_, k: string) => v[k] ?? '');

export function renderEmail(
  template: string,
  payload: P,
  override?: TemplateOverride | null,
): RenderedEmail | null {
  const t = TEMPLATES[template];
  if (!t) return null;
  if (override && EDITABLE_TEMPLATES[template]) {
    const v = vars(payload);
    return { subject: fill(override.subject, v), text: fill(override.body, v) + sig };
  }
  return t(payload);
}
export const emailTemplates = () => Object.keys(TEMPLATES);

/** Dev/default: logs instead of sending, so nothing leaves the machine unless SMTP is configured. */
export class ConsoleEmailSender implements EmailSender {
  readonly name = 'console';
  readonly sent: Array<{ to: string; subject: string; text: string }> = [];
  async send(msg: { to: string; subject: string; text: string }) {
    this.sent.push(msg);
    if (process.env.NODE_ENV !== 'test') console.log(`[email:console] to=${msg.to} subject=${msg.subject}`);
  }
}

export class SmtpEmailSender implements EmailSender {
  readonly name = 'smtp';
  private tx;
  constructor(
    cfg: { host: string; port: number; user?: string; pass?: string; from: string; secure?: boolean },
    private from = cfg.from,
  ) {
    this.tx = nodemailer.createTransport({
      host: cfg.host,
      port: cfg.port,
      secure: cfg.secure ?? cfg.port === 465,
      auth: cfg.user ? { user: cfg.user, pass: cfg.pass } : undefined,
      connectionTimeout: 8000,
      socketTimeout: 15000,
    });
  }
  /** Connects and authenticates without sending anything (used by the production preflight). */
  async verify(): Promise<void> {
    await this.tx.verify();
  }
  async send(msg: { to: string; subject: string; text: string }) {
    await this.tx.sendMail({ from: this.from, to: msg.to, subject: msg.subject, text: msg.text });
  }
}
