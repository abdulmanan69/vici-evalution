import { and, eq, gt } from 'drizzle-orm';
import { db } from '../db/client.js';
import { roles, sessions, users } from '../db/schema.js';
import { config } from '../config.js';
import { newSessionToken, sha256, verifyPassword } from '../lib/crypto.js';

export interface AuthContext {
  userId: string;
  email: string;
  name: string;
  companyId: string | null;
  roleName: string;
  permissions: string[];
}

export interface LoginResult {
  token: string;
  expiresAt: Date;
  auth: AuthContext;
}

export async function login(
  email: string,
  password: string,
  ip: string | undefined,
  userAgent: string | undefined,
): Promise<LoginResult | null> {
  const rows = await db
    .select({ user: users, role: roles })
    .from(users)
    .innerJoin(roles, eq(users.roleId, roles.id))
    .where(eq(users.email, email.toLowerCase().trim()));
  const row = rows[0];
  if (!row || row.user.status !== 'active') return null;
  const ok = await verifyPassword(password, row.user.passwordHash);
  if (!ok) return null;

  const { token, tokenHash } = newSessionToken();
  const expiresAt = new Date(Date.now() + config.SESSION_TTL_HOURS * 3600 * 1000);
  await db.insert(sessions).values({
    userId: row.user.id,
    tokenHash,
    expiresAt,
    ip: ip ?? null,
    userAgent: userAgent?.slice(0, 500) ?? null,
  });
  await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, row.user.id));

  return {
    token,
    expiresAt,
    auth: toAuthContext(row.user, row.role),
  };
}

export async function resolveSession(token: string): Promise<AuthContext | null> {
  const tokenHash = sha256(token);
  const rows = await db
    .select({ user: users, role: roles, session: sessions })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .innerJoin(roles, eq(users.roleId, roles.id))
    .where(and(eq(sessions.tokenHash, tokenHash), gt(sessions.expiresAt, new Date())));
  const row = rows[0];
  if (!row || row.user.status !== 'active') return null;
  return toAuthContext(row.user, row.role);
}

export async function logout(token: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.tokenHash, sha256(token)));
}

export async function revokeUserSessions(userId: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.userId, userId));
}

function toAuthContext(
  user: typeof users.$inferSelect,
  role: typeof roles.$inferSelect,
): AuthContext {
  return {
    userId: user.id,
    email: user.email,
    name: user.name,
    companyId: user.companyId,
    roleName: role.name,
    permissions: role.permissions,
  };
}
