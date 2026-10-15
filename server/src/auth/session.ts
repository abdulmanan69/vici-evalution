import { and, eq, gt, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { qaForms, reviewerAgentAssignments, roles, sessions, users } from '../db/schema.js';
import { config } from '../config.js';
import { newSessionToken, sha256, verifyPassword } from '../lib/crypto.js';

export interface AuthContext {
  userId: string;
  email: string;
  name: string;
  companyId: string | null;
  roleName: string;
  permissions: string[];
  /** non-empty = the only QA forms this reviewer may see and use */
  allowedFormIds: string[] | null;
  /** the only queues this reviewer may see; null = all */
  allowedQueues: Array<'transfer' | 'unclosed' | 'closed'> | null;
  /** true = the reviewer only sees calls of their assigned dialer agents */
  agentScoped: boolean;
}

type QueueName = 'transfer' | 'unclosed' | 'closed';

/**
 * Two independent limits narrow a reviewer's queues: forms assigned to them
 * (a form without a queue lifts that limit) and dialer agents assigned to
 * them with methods. When both apply, only queues allowed by both remain.
 */
async function withAllowedQueues(auth: AuthContext): Promise<AuthContext> {
  let formQueues: QueueName[] | null = null;
  if (auth.allowedFormIds) {
    const forms = await db
      .select({ queue: qaForms.queue })
      .from(qaForms)
      .where(inArray(qaForms.id, auth.allowedFormIds));
    if (forms.length > 0 && forms.every((f) => f.queue !== null)) {
      formQueues = [...new Set(forms.map((f) => f.queue!))];
    }
  }

  const assignments = await db
    .select({ methods: reviewerAgentAssignments.methods })
    .from(reviewerAgentAssignments)
    .where(eq(reviewerAgentAssignments.reviewerUserId, auth.userId));
  const agentQueues: QueueName[] | null =
    assignments.length > 0 ? [...new Set(assignments.flatMap((a) => a.methods))] : null;

  let allowedQueues = formQueues ?? agentQueues;
  if (formQueues && agentQueues) allowedQueues = formQueues.filter((q) => agentQueues.includes(q));
  return { ...auth, allowedQueues, agentScoped: assignments.length > 0 };
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
    auth: await withAllowedQueues(toAuthContext(row.user, row.role)),
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
  return withAllowedQueues(toAuthContext(row.user, row.role));
}

/** A user's effective access (form, queue and agent limits) without a session. */
export async function authContextForUser(userId: string): Promise<AuthContext | null> {
  const rows = await db
    .select({ user: users, role: roles })
    .from(users)
    .innerJoin(roles, eq(users.roleId, roles.id))
    .where(eq(users.id, userId));
  const row = rows[0];
  if (!row) return null;
  return withAllowedQueues(toAuthContext(row.user, row.role));
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
    allowedFormIds: user.allowedFormIds && user.allowedFormIds.length > 0 ? user.allowedFormIds : null,
    allowedQueues: null,
    agentScoped: false,
  };
}
