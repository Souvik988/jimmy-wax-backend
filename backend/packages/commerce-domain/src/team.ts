import { createHash, randomBytes } from 'node:crypto';
import type { PoolClient } from '@jw/database';
import { AppError } from '@jw/contracts';
import { audit, type AdminRole } from './admin.ts';
import {
  hashPassword,
  normaliseEmail,
  revokeAllSessions,
  revokeFamily,
  validatePassword,
} from './identity.ts';
import { queueEmail } from './notify.ts';

interface Ctx {
  adminId: string;
  role: AdminRole;
  requestId?: string;
}

export const ADMIN_ROLES = ['support', 'catalog', 'fulfillment', 'finance', 'designer', 'admin'] as const;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const INVITE_TTL_HOURS = 72;

export async function listTeam(c: PoolClient) {
  const r = await c.query(
    `SELECT a.user_id, u.email, a.role, a.disabled, a.created_at,
            (SELECT max(t.created_at) FROM auth.refresh_tokens t WHERE t.user_id = a.user_id AND t.client = 'admin') AS last_login,
            EXISTS (SELECT 1 FROM auth.admin_totp m WHERE m.user_id = a.user_id AND m.verified_at IS NOT NULL) AS mfa_enrolled
       FROM admin_users a JOIN auth.users u ON u.id = a.user_id
      ORDER BY a.created_at`,
  );
  const inv = await c.query(
    `SELECT id, email, role, expires_at, created_at FROM admin_invites
      WHERE accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now() ORDER BY created_at DESC`,
  );
  return {
    members: r.rows.map((x) => ({
      userId: x.user_id as string,
      email: x.email as string,
      role: x.role as AdminRole,
      disabled: x.disabled as boolean,
      mfaEnrolled: x.mfa_enrolled as boolean,
      lastLoginAt: x.last_login ? new Date(x.last_login).toISOString() : null,
      createdAt: new Date(x.created_at).toISOString(),
    })),
    invites: inv.rows.map((x) => ({
      id: x.id as string,
      email: x.email as string,
      role: x.role as AdminRole,
      expiresAt: new Date(x.expires_at).toISOString(),
      createdAt: new Date(x.created_at).toISOString(),
    })),
  };
}

/** The raw invite token only ever leaves the server inside the invitation email. */
export async function inviteMember(c: PoolClient, x: Ctx, input: { email: string; role: AdminRole }) {
  const email = normaliseEmail(input.email);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    throw new AppError('VALIDATION_FAILED', 'Invalid email', { fields: { email: 'invalid email address' } });
  }
  const member = await c.query(
    `SELECT 1 FROM admin_users a JOIN auth.users u ON u.id = a.user_id WHERE lower(u.email) = $1`,
    [email],
  );
  if (member.rowCount) {
    throw new AppError('VALIDATION_FAILED', 'This person already has operator access', {
      fields: { email: 'already a team member' },
    });
  }
  // Re-inviting replaces the previous open invite.
  await c.query(
    `UPDATE admin_invites SET revoked_at = now() WHERE email = $1 AND accepted_at IS NULL AND revoked_at IS NULL`,
    [email],
  );
  const raw = randomBytes(32).toString('base64url');
  const r = await c.query(
    `INSERT INTO admin_invites (email, role, token_hash, invited_by, expires_at)
     VALUES ($1,$2,$3,$4, now() + make_interval(hours => $5)) RETURNING id, expires_at`,
    [email, input.role, sha(raw), x.adminId, INVITE_TTL_HOURS],
  );
  await queueEmail(c, {
    dedupeKey: `admin.invite:${r.rows[0].id}`,
    to: email,
    template: 'admin.invite',
    payload: { token: raw, role: input.role },
  });
  await audit(c, {
    actorId: x.adminId,
    actorRole: x.role,
    action: 'team.invite',
    resourceType: 'admin_invite',
    resourceId: r.rows[0].id,
    after: { email, role: input.role },
    requestId: x.requestId,
  });
  return {
    id: r.rows[0].id as string,
    email,
    role: input.role,
    expiresAt: new Date(r.rows[0].expires_at).toISOString(),
  };
}

export async function revokeInvite(c: PoolClient, x: Ctx, inviteId: string) {
  const r = await c.query(
    `UPDATE admin_invites SET revoked_at = now() WHERE id = $1 AND accepted_at IS NULL AND revoked_at IS NULL RETURNING email`,
    [inviteId],
  );
  if (r.rowCount === 0) throw new AppError('NOT_FOUND', 'Invite not found');
  await audit(c, {
    actorId: x.adminId,
    actorRole: x.role,
    action: 'team.invite.revoke',
    resourceType: 'admin_invite',
    resourceId: inviteId,
    before: { email: r.rows[0].email },
    requestId: x.requestId,
  });
}

/** Runs as the system actor (the invitee has no role yet). The invitation proves control of the email address. */
export async function acceptInvite(
  c: PoolClient,
  input: { token: string; password: string; fullName: string },
): Promise<{ userId: string; email: string; role: AdminRole }> {
  const inv = await c.query(
    `SELECT * FROM admin_invites WHERE token_hash = $1 AND accepted_at IS NULL AND revoked_at IS NULL
        AND expires_at > now() FOR UPDATE`,
    [sha(input.token)],
  );
  if (inv.rowCount === 0)
    throw new AppError('VALIDATION_FAILED', 'This invitation is invalid or has expired');
  const i = inv.rows[0];
  validatePassword(input.password, i.email);
  const exists = await c.query(`SELECT 1 FROM auth.users WHERE lower(email) = $1`, [i.email]);
  if (exists.rowCount) {
    throw new AppError(
      'VALIDATION_FAILED',
      'An account with this email already exists. Ask an administrator to grant it access instead.',
    );
  }
  const u = await c.query(
    `INSERT INTO auth.users (email, password_hash, email_verified_at, raw_user_meta_data) VALUES ($1,$2, now(), $3) RETURNING id`,
    [i.email, await hashPassword(input.password), JSON.stringify({ full_name: input.fullName.trim() })],
  );
  const userId = u.rows[0].id as string;
  await c.query(`INSERT INTO admin_users (user_id, role) VALUES ($1,$2)`, [userId, i.role]);
  await c.query(`UPDATE admin_invites SET accepted_at = now() WHERE id = $1`, [i.id]);
  await audit(c, {
    actorId: userId,
    actorRole: i.role,
    action: 'team.invite.accept',
    resourceType: 'admin_user',
    resourceId: userId,
    after: { email: i.email, role: i.role },
  });
  return { userId, email: i.email as string, role: i.role as AdminRole };
}

async function otherActiveAdmins(c: PoolClient, exceptUserId: string): Promise<number> {
  const r = await c.query(
    `SELECT count(*)::int n FROM admin_users WHERE role = 'admin' AND NOT disabled AND user_id <> $1`,
    [exceptUserId],
  );
  return r.rows[0].n as number;
}

export async function updateMember(
  c: PoolClient,
  x: Ctx,
  userId: string,
  patch: { role?: AdminRole; disabled?: boolean },
) {
  const cur = await c.query(`SELECT * FROM admin_users WHERE user_id = $1 FOR UPDATE`, [userId]);
  if (cur.rowCount === 0) throw new AppError('NOT_FOUND', 'Team member not found');
  const before = cur.rows[0];
  if (userId === x.adminId && (patch.disabled === true || (patch.role && patch.role !== before.role))) {
    throw new AppError('ILLEGAL_STATE', 'You cannot change your own role or disable yourself');
  }
  const losingAdmin =
    before.role === 'admin' &&
    !before.disabled &&
    ((patch.role !== undefined && patch.role !== 'admin') || patch.disabled === true);
  if (losingAdmin && (await otherActiveAdmins(c, userId)) === 0) {
    throw new AppError('ILLEGAL_STATE', 'At least one active administrator is required');
  }
  const role = patch.role ?? before.role;
  const disabled = patch.disabled ?? before.disabled;
  await c.query(`UPDATE admin_users SET role = $2, disabled = $3, updated_at = now() WHERE user_id = $1`, [
    userId,
    role,
    disabled,
  ]);
  // A role change or disablement must not leave a live session with the old authority.
  if (role !== before.role || disabled) await revokeAllSessions(c, userId);
  await audit(c, {
    actorId: x.adminId,
    actorRole: x.role,
    action: 'team.update',
    resourceType: 'admin_user',
    resourceId: userId,
    before: { role: before.role, disabled: before.disabled },
    after: { role, disabled },
    requestId: x.requestId,
  });
  return { userId, role: role as AdminRole, disabled: disabled as boolean };
}

export async function resetMfa(c: PoolClient, x: Ctx, userId: string) {
  const m = await c.query(`SELECT 1 FROM admin_users WHERE user_id = $1`, [userId]);
  if (m.rowCount === 0) throw new AppError('NOT_FOUND', 'Team member not found');
  await c.query(`DELETE FROM auth.admin_totp WHERE user_id = $1`, [userId]);
  await c.query(`DELETE FROM auth.mfa_recovery_codes WHERE user_id = $1`, [userId]);
  await revokeAllSessions(c, userId);
  await audit(c, {
    actorId: x.adminId,
    actorRole: x.role,
    action: 'team.mfa_reset',
    resourceType: 'admin_user',
    resourceId: userId,
    requestId: x.requestId,
  });
}

// ------------------------------------------------------------------ sessions
export async function listSessions(c: PoolClient, userId: string, currentFamily?: string) {
  const r = await c.query(
    `SELECT family_id, min(created_at) AS started_at, max(created_at) AS last_seen_at,
            (array_agg(client ORDER BY created_at DESC))[1] AS client,
            (array_agg(aal ORDER BY created_at DESC))[1] AS aal
       FROM auth.refresh_tokens
      WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now()
      GROUP BY family_id ORDER BY max(created_at) DESC`,
    [userId],
  );
  return r.rows.map((x) => ({
    id: x.family_id as string,
    client: x.client as string,
    aal: x.aal as string,
    startedAt: new Date(x.started_at).toISOString(),
    lastSeenAt: new Date(x.last_seen_at).toISOString(),
    current: x.family_id === currentFamily,
  }));
}

export async function revokeOwnSession(c: PoolClient, userId: string, familyId: string) {
  const own = await c.query(
    `SELECT 1 FROM auth.refresh_tokens WHERE family_id = $1 AND user_id = $2 LIMIT 1`,
    [familyId, userId],
  );
  if (own.rowCount === 0) throw new AppError('NOT_FOUND', 'Session not found');
  await revokeFamily(c, familyId);
}

// ------------------------------------------------------------ recovery codes
const CODE_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
function newCode(): string {
  const b = randomBytes(8);
  const ch = [...b].map((v) => CODE_ALPHABET[v % CODE_ALPHABET.length]).join('');
  return `${ch.slice(0, 4)}-${ch.slice(4)}`;
}

/** Replaces any existing codes. Plaintext is returned exactly once; only hashes are stored. */
export async function rotateRecoveryCodes(c: PoolClient, userId: string): Promise<string[]> {
  await c.query(`DELETE FROM auth.mfa_recovery_codes WHERE user_id = $1`, [userId]);
  const codes = Array.from({ length: 8 }, newCode);
  for (const code of codes) {
    await c.query(`INSERT INTO auth.mfa_recovery_codes (user_id, code_hash) VALUES ($1,$2)`, [
      userId,
      sha(code),
    ]);
  }
  return codes;
}

export async function consumeRecoveryCode(c: PoolClient, userId: string, code: string): Promise<boolean> {
  const r = await c.query(
    `UPDATE auth.mfa_recovery_codes SET used_at = now() WHERE user_id = $1 AND code_hash = $2 AND used_at IS NULL`,
    [userId, sha(code.trim().toLowerCase())],
  );
  return (r.rowCount ?? 0) > 0;
}

export async function recoveryCodesRemaining(c: PoolClient, userId: string): Promise<number> {
  const r = await c.query(
    `SELECT count(*)::int n FROM auth.mfa_recovery_codes WHERE user_id = $1 AND used_at IS NULL`,
    [userId],
  );
  return r.rows[0].n as number;
}
