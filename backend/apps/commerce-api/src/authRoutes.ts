import express, { type Request, type RequestHandler } from 'express';
import { z } from 'zod';
import { AppError, trackRoutes } from '@jw/contracts';
import {
  acceptInvite,
  authenticate,
  checkPhoneOtp,
  consumeRecoveryCode,
  rotateRecoveryCodes,
  constantTimeEqual,
  issuePhoneOtp,
  maskPhoneE164,
  normalisePhone,
  userForPhone,
  beginTotpEnrollment,
  checkTotp,
  consumeOneTimeToken,
  createOneTimeToken,
  deleteAccount,
  deleteAccountWithOtp,
  exportAccount,
  hasVerifiedTotp,
  issueSession,
  normaliseEmail,
  queueEmail,
  registerUser,
  revokeAllSessions,
  revokeFamily,
  rotateRefresh,
  setPassword,
  upgradeFamilyToAal2,
  verifyPassword,
} from '@jw/commerce-domain';
import type { Deps } from './app.ts';

export type LimitBy = (
  name: string,
  windowMs: number,
  max: number,
  key: (r: Request) => string,
) => RequestHandler;

const email = z.string().trim().max(254).email();
const password = z.string().min(1).max(128);

function parse<T>(schema: z.ZodType<T>, v: unknown): T {
  const r = schema.safeParse(v);
  if (!r.success) {
    throw new AppError('VALIDATION_FAILED', 'Invalid request', {
      fields: Object.fromEntries(r.error.issues.map((i) => [i.path.join('.') || '_', i.message])),
    });
  }
  return r.data;
}

/**
 * Own identity API. Public: register, login, refresh, logout, password reset, email verify.
 * Bearer: MFA enrol/verify, password change, export, delete (mounted by the app under requireAuth).
 */
export function authRouter(deps: Deps, limitBy: LimitBy, requireAuth: RequestHandler, routeTable: string[]) {
  const { db, tokens } = deps;
  const r = trackRoutes(express.Router(), '/v1/auth', routeTable);
  const byEmail = (req: Request) => `e:${normaliseEmail(String(req.body?.email ?? ''))}`;
  const byIp = (req: Request) => `ip:${req.ip ?? 'x'}`;

  async function tokenPair(
    userId: string,
    client: 'app' | 'admin',
    familyId: string,
    aal: 'aal1' | 'aal2',
    refreshToken: string,
  ) {
    const a = await tokens.sign({ userId, sid: familyId, aal, client });
    return { accessToken: a.accessToken, expiresIn: a.expiresIn, refreshToken, tokenType: 'Bearer', aal };
  }

  r.post('/register', limitBy('register', 3600_000, 20, byIp), async (req, res) => {
    const b = parse(z.object({ email, password, fullName: z.string().trim().min(1).max(120) }), req.body);
    const out = await db.tx({ kind: 'anonymous' }, async (c) => {
      const u = await registerUser(c, b);
      await queueEmail(c, {
        dedupeKey: `verify:${u.id}`,
        to: normaliseEmail(b.email),
        template: 'verify_email',
        payload: { name: b.fullName, token: u.verifyToken },
      });
      const s = await issueSession(c, u.id, 'app');
      return { u, s };
    });
    res.status(201).json({
      user: { id: out.u.id, email: normaliseEmail(b.email), phone: null, emailVerified: false },
      ...(await tokenPair(out.u.id, 'app', out.s.familyId, 'aal1', out.s.refreshToken)),
    });
  });

  r.post(
    '/login',
    limitBy('login', 60_000, 10, byEmail),
    limitBy('login-ip', 60_000, 60, byIp),
    async (req, res) => {
      const b = parse(
        z.object({ email, password, client: z.enum(['app', 'admin']).default('app') }),
        req.body,
      );
      const out = await db.tx({ kind: 'anonymous' }, async (c) => {
        const a = await authenticate(c, b.email, b.password); // commits failure counters / lockout either way
        if (!a.ok) return { error: a.error } as const;
        let aal: 'aal1' = 'aal1';
        let mfa = { required: false, enrolled: false };
        if (b.client === 'admin') {
          const staff = await c.query(`SELECT 1 FROM admin_users WHERE user_id = $1 AND NOT disabled`, [
            a.user.id,
          ]);
          if (staff.rowCount === 0)
            return { error: new AppError('FORBIDDEN', 'This account has no operator role') } as const;
          const enrolled = await hasVerifiedTotp(c, a.user.id);
          mfa = { required: enrolled, enrolled };
        }
        const s = await issueSession(c, a.user.id, b.client, aal);
        return { user: a.user, s, mfa };
      });
      if ('error' in out) throw out.error;
      res.json({
        user: {
          id: out.user.id,
          email: out.user.email,
          phone: out.user.phone ? maskPhoneE164(out.user.phone) : null,
          emailVerified: !!out.user.email_verified_at,
        },
        mfa: out.mfa,
        ...(await tokenPair(out.user.id, b.client, out.s.familyId, 'aal1', out.s.refreshToken)),
      });
    },
  );

  r.post('/refresh', limitBy('refresh', 60_000, 60, byIp), async (req, res) => {
    const b = parse(z.object({ refreshToken: z.string().min(20).max(200) }), req.body);
    const out = await db.tx({ kind: 'anonymous' }, (c) => rotateRefresh(c, b.refreshToken));
    if (!out.ok) throw out.error;
    const s = out.session;
    res.json(await tokenPair(s.userId, s.client, s.familyId, s.aal, s.refreshToken));
  });

  r.post('/logout', limitBy('logout', 60_000, 60, byIp), async (req, res) => {
    const b = parse(z.object({ refreshToken: z.string().min(20).max(200) }), req.body);
    await db.tx({ kind: 'anonymous' }, async (c) => {
      const t = await c.query(
        `SELECT family_id FROM auth.refresh_tokens WHERE token_hash = encode(sha256($1::bytea), 'hex')`,
        [Buffer.from(b.refreshToken)],
      );
      if (t.rows[0]) await revokeFamily(c, t.rows[0].family_id);
    });
    res.status(204).end(); // idempotent: unknown tokens are not an error
  });

  r.post(
    '/password/forgot',
    limitBy('forgot', 3600_000, 5, byEmail),
    limitBy('forgot-ip', 3600_000, 30, byIp),
    async (req, res) => {
      const b = parse(z.object({ email }), req.body);
      await db.tx({ kind: 'anonymous' }, async (c) => {
        const u = await c.query(
          `SELECT id, email FROM auth.users WHERE lower(email) = $1 AND status = 'active'`,
          [normaliseEmail(b.email)],
        );
        if (u.rows[0]) {
          const token = await createOneTimeToken(c, u.rows[0].id, 'password_reset', 30 * 60);
          await queueEmail(c, { to: u.rows[0].email, template: 'password_reset', payload: { token } });
        }
      });
      res.status(202).json({ accepted: true }); // identical response whether or not the account exists
    },
  );

  r.post('/password/reset', limitBy('reset', 3600_000, 20, byIp), async (req, res) => {
    const b = parse(z.object({ token: z.string().min(20).max(200), password }), req.body);
    await db.tx({ kind: 'anonymous' }, async (c) => {
      const userId = await consumeOneTimeToken(c, b.token, 'password_reset');
      const u = await c.query(`SELECT email FROM auth.users WHERE id = $1`, [userId]);
      await setPassword(c, userId, b.password, u.rows[0].email);
      await revokeAllSessions(c, userId); // every device must sign in again
    });
    res.status(204).end();
  });

  r.post('/email/verify', limitBy('verify', 3600_000, 30, byIp), async (req, res) => {
    const b = parse(z.object({ token: z.string().min(20).max(200) }), req.body);
    await db.tx({ kind: 'anonymous' }, async (c) => {
      const userId = await consumeOneTimeToken(c, b.token, 'email_verify');
      await c.query(
        `UPDATE auth.users SET email_verified_at = coalesce(email_verified_at, now()) WHERE id = $1`,
        [userId],
      );
    });
    res.status(204).end();
  });

  // ---- phone one-time code (own identity). Real SMS needs a provider; the demo number works without one.
  const demoOn = deps.config.AUTH_DEMO_ENABLED ?? deps.config.NODE_ENV !== 'production';
  const demoPhone = deps.config.AUTH_DEMO_PHONE;
  const byPhone = (req: Request) => {
    try {
      return `p:${normalisePhone(String(req.body?.phone ?? ''))}`;
    } catch {
      return `p:invalid:${req.ip ?? 'x'}`;
    }
  };

  r.post(
    '/otp/request',
    limitBy('otp-req', 600_000, 5, byPhone),
    limitBy('otp-req-ip', 3600_000, 60, byIp),
    async (req, res) => {
      const b = parse(z.object({ phone: z.string().min(10).max(20) }), req.body);
      const phone = normalisePhone(b.phone);
      if (demoOn && phone === demoPhone) {
        res.status(202).json({ accepted: true, expiresInSeconds: 300 }); // nothing is sent; the fixed demo code is used
        return;
      }
      if (!deps.sms)
        throw new AppError('OTP_UNAVAILABLE', 'Mobile sign-in is not available right now. Please use email.');
      const issued = await db.tx({ kind: 'anonymous' }, (c) => issuePhoneOtp(c, phone));
      if (!issued.ok) throw issued.error;
      try {
        await deps.sms.send({
          to: phone,
          text: deps.config.SMS_OTP_TEMPLATE.replaceAll('{{code}}', issued.code),
        });
      } catch {
        throw new AppError('OTP_UNAVAILABLE', 'We could not send the code. Please try again or use email.');
      }
      res.status(202).json({ accepted: true, expiresInSeconds: 300 });
    },
  );

  r.post(
    '/otp/verify',
    limitBy('otp-verify', 3600_000, 20, byPhone),
    limitBy('otp-verify-ip', 3600_000, 120, byIp),
    async (req, res) => {
      const b = parse(
        z.object({ phone: z.string().min(10).max(20), code: z.string().regex(/^[0-9]{6}$/) }),
        req.body,
      );
      const phone = normalisePhone(b.phone);
      const isDemo = demoOn && phone === demoPhone;
      const out = await db.tx({ kind: 'anonymous' }, async (c) => {
        if (isDemo) {
          const a = Buffer.from(b.code);
          const e = Buffer.from(deps.config.AUTH_DEMO_OTP);
          if (a.length !== e.length || !constantTimeEqual(a, e))
            return { error: new AppError('OTP_INVALID', 'That code is not correct') } as const;
        } else {
          const chk = await checkPhoneOtp(c, phone, b.code); // failed guesses are committed
          if (!chk.ok) return { error: chk.error } as const;
        }
        const u = await userForPhone(c, phone, isDemo);
        if (!u) return { error: new AppError('UNAUTHENTICATED', 'This account cannot sign in') } as const;
        const s = await issueSession(c, u.id, 'app');
        return { u, s };
      });
      if ('error' in out) throw out.error;
      res.json({
        user: { id: out.u.id, email: out.u.email, phone: maskPhoneE164(out.u.phone), emailVerified: false },
        ...(await tokenPair(out.u.id, 'app', out.s.familyId, 'aal1', out.s.refreshToken)),
      });
    },
  );

  // ---- authenticated
  r.post(
    '/mfa/enroll',
    requireAuth,
    limitBy('mfa', 60_000, 10, (q) => q.principal!.userId),
    async (req, res) => {
      const out = await db.tx({ kind: 'anonymous' }, async (c) => {
        const staff = await c.query(
          `SELECT u.email FROM admin_users a JOIN auth.users u ON u.id = a.user_id WHERE a.user_id = $1 AND NOT a.disabled`,
          [req.principal!.userId],
        );
        if (!staff.rows[0]) throw new AppError('FORBIDDEN', 'MFA is for operator accounts');
        return beginTotpEnrollment(c, req.principal!.userId, staff.rows[0].email, tokens.totpKey);
      });
      res.status(201).json(out);
    },
  );

  r.post(
    '/mfa/verify',
    requireAuth,
    limitBy('mfa-verify', 60_000, 10, (q) => q.principal!.userId),
    async (req, res) => {
      const b = parse(
        z.union([
          z.object({ code: z.string().regex(/^\d{6}$/) }),
          z.object({ recoveryCode: z.string().trim().min(8).max(20) }),
        ]),
        req.body,
      );
      const p = req.principal!;
      const ok = await db.tx({ kind: 'anonymous' }, async (c) => {
        const good =
          'code' in b
            ? await checkTotp(c, p.userId, b.code, tokens.totpKey)
            : await consumeRecoveryCode(c, p.userId, b.recoveryCode);
        if (good) await upgradeFamilyToAal2(c, p.sid);
        return good;
      });
      if (!ok) throw new AppError('UNAUTHENTICATED', 'That code is not valid');
      const a = await tokens.sign({ userId: p.userId, sid: p.sid, aal: 'aal2', client: 'admin' });
      res.json({ accessToken: a.accessToken, expiresIn: a.expiresIn, aal: 'aal2', tokenType: 'Bearer' });
    },
  );

  // Recovery codes: operators only, and only from an MFA-verified session. Plaintext is shown exactly once.
  r.post(
    '/mfa/recovery-codes',
    requireAuth,
    limitBy('mfa-codes', 3600_000, 5, (q) => q.principal!.userId),
    async (req, res) => {
      if (req.principal!.aal !== 'aal2')
        throw new AppError('MFA_REQUIRED', 'Verify your authenticator code first');
      const codes = await db.tx({ kind: 'anonymous' }, async (c) => {
        const staff = await c.query(`SELECT 1 FROM admin_users WHERE user_id = $1 AND NOT disabled`, [
          req.principal!.userId,
        ]);
        if (!staff.rows[0]) throw new AppError('FORBIDDEN', 'Recovery codes are for operator accounts');
        return rotateRecoveryCodes(c, req.principal!.userId);
      });
      res.status(201).json({ codes });
    },
  );

  // Public: accepting an operator invitation (the emailed code proves control of the address).
  r.post('/invite/accept', limitBy('invite', 3600_000, 20, byIp), async (req, res) => {
    const b = parse(
      z.object({
        token: z.string().min(20).max(200),
        password,
        fullName: z.string().trim().min(2).max(120),
      }),
      req.body,
    );
    const out = await db.tx({ kind: 'system', reason: 'admin-invite-accept' }, (c) => acceptInvite(c, b));
    res.status(201).json({ email: out.email, role: out.role });
  });

  r.post(
    '/password/change',
    requireAuth,
    limitBy('pwchange', 3600_000, 10, (q) => q.principal!.userId),
    async (req, res) => {
      const b = parse(z.object({ currentPassword: password, newPassword: password }), req.body);
      const p = req.principal!;
      const done = await db.tx({ kind: 'anonymous' }, async (c) => {
        const u = (
          await c.query(`SELECT email, password_hash FROM auth.users WHERE id = $1 FOR UPDATE`, [p.userId])
        ).rows[0];
        if (!u || !(await verifyPassword(b.currentPassword, u.password_hash))) return false;
        await setPassword(c, p.userId, b.newPassword, u.email);
        await revokeAllSessions(c, p.userId, p.sid); // other devices are signed out, this one stays
        return true;
      });
      if (!done) throw new AppError('UNAUTHENTICATED', 'Current password is incorrect');
      res.status(204).end();
    },
  );

  r.post(
    '/account/delete',
    requireAuth,
    limitBy('delete', 3600_000, 5, (q) => q.principal!.userId),
    async (req, res) => {
      const b = parse(
        z.union([
          z.object({ password }).strict(),
          z.object({ code: z.string().regex(/^[0-9]{6}$/) }).strict(),
        ]),
        req.body,
      );
      const outcome = await db.tx<Awaited<ReturnType<typeof deleteAccountWithOtp>>>(
        { kind: 'customer', userId: req.principal!.userId },
        async (c) => {
          if ('password' in b) {
            await deleteAccount(c, req.principal!.userId, b.password);
            return { ok: true };
          }
          return deleteAccountWithOtp(c, req.principal!.userId, b.code);
        },
      );
      if (!outcome.ok) throw outcome.error;
      res.status(204).end();
    },
  );

  r.get(
    '/account/export',
    requireAuth,
    limitBy('export', 3600_000, 5, (q) => q.principal!.userId),
    async (req, res) => {
      const data = await db.tx({ kind: 'customer', userId: req.principal!.userId }, (c) =>
        exportAccount(c, req.principal!.userId),
      );
      res.setHeader('Content-Disposition', 'attachment; filename="jimmywax-account-export.json"');
      res.json(data);
    },
  );

  return r;
}
