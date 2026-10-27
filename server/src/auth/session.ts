import { and, asc, eq, gt, inArray, ne } from 'drizzle-orm';
import { db } from '../db/client.js';
import { companies, companyMemberships, qaForms, reviewerAgentAssignments, roles, sessions, users } from '../db/schema.js';
import { config } from '../config.js';
import { newSessionToken, sha256, verifyPassword } from '../lib/crypto.js';

export interface AuthContext {
  userId: string;
  email: string;
  name: string;
  /** the company this session works in (null = platform user / super admin) */
  companyId: string | null;
  /** the person's own company — differs from companyId while working in another one */
  homeCompanyId: string | null;
  /** the role in the active company */
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
type UserRow = typeof users.$inferSelect;
type RoleRow = typeof roles.$inferSelect;

/** A person's role and QA-method limits in one company. */
interface Workplace {
  companyId: string | null;
  role: RoleRow;
  allowedFormIds: string[] | null;
}

/**
 * Two independent limits narrow a reviewer's queues: forms assigned to them
 * (a form without a queue lifts that limit) and dialer agents assigned to
 * them with methods. When both apply, only queues allowed by both remain.
 * Both are per company — only the active company's limits apply.
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
    .where(
      and(
        eq(reviewerAgentAssignments.reviewerUserId, auth.userId),
        auth.companyId ? eq(reviewerAgentAssignments.companyId, auth.companyId) : undefined,
      ),
    );
  const agentQueues: QueueName[] | null =
    assignments.length > 0 ? [...new Set(assignments.flatMap((a) => a.methods))] : null;

  let allowedQueues = formQueues ?? agentQueues;
  if (formQueues && agentQueues) allowedQueues = formQueues.filter((q) => agentQueues.includes(q));
  return { ...auth, allowedQueues, agentScoped: assignments.length > 0 };
}

function homeWorkplace(user: UserRow, role: RoleRow): Workplace {
  return { companyId: user.companyId, role, allowedFormIds: user.allowedFormIds ?? null };
}

/**
 * The person's role and limits in `companyId`: their own company, or one they
 * were given access to (and which is not being deleted). Null = no access.
 */
async function workplaceIn(user: UserRow, homeRole: RoleRow, companyId: string | null | undefined): Promise<Workplace | null> {
  if (!companyId || companyId === user.companyId) return homeWorkplace(user, homeRole);
  // platform users (super admins) see every company already and join none
  if (user.companyId === null) return null;
  const [m] = await db
    .select({ membership: companyMemberships, role: roles })
    .from(companyMemberships)
    .innerJoin(roles, eq(companyMemberships.roleId, roles.id))
    .innerJoin(companies, eq(companyMemberships.companyId, companies.id))
    .where(
      and(
        eq(companyMemberships.userId, user.id),
        eq(companyMemberships.companyId, companyId),
        ne(companies.status, 'deleting'),
      ),
    );
  if (!m) return null;
  return { companyId, role: m.role, allowedFormIds: m.membership.allowedFormIds ?? null };
}

function toAuthContext(user: UserRow, work: Workplace): AuthContext {
  return {
    userId: user.id,
    email: user.email,
    name: user.name,
    companyId: work.companyId,
    homeCompanyId: user.companyId,
    roleName: work.role.name,
    permissions: work.role.permissions,
    allowedFormIds: work.allowedFormIds && work.allowedFormIds.length > 0 ? work.allowedFormIds : null,
    allowedQueues: null,
    agentScoped: false,
  };
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

  // someone who works for several companies opens where they worked last
  const last = row.user.lastCompanyId ? await workplaceIn(row.user, row.role, row.user.lastCompanyId) : null;
  const work = last ?? homeWorkplace(row.user, row.role);

  const { token, tokenHash } = newSessionToken();
  const expiresAt = new Date(Date.now() + config.SESSION_TTL_HOURS * 3600 * 1000);
  await db.insert(sessions).values({
    userId: row.user.id,
    tokenHash,
    expiresAt,
    ip: ip ?? null,
    userAgent: userAgent?.slice(0, 500) ?? null,
    activeCompanyId: work.companyId !== row.user.companyId ? work.companyId : null,
  });
  await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, row.user.id));

  return {
    token,
    expiresAt,
    auth: await withAllowedQueues(toAuthContext(row.user, work)),
  };
}

/**
 * Every API request resolves its session (three queries). A page load fires
 * several requests at once and open call pages poll, so the result is kept
 * for a few seconds. Any successful write through the API clears the whole
 * cache (see app.ts), as do logout and session revocation, so role, access
 * and status changes still apply on the next request.
 */
const SESSION_CACHE_MS = 10_000;
const SESSION_CACHE_MAX = 5_000;
const sessionCache = new Map<string, { at: number; expiresAt: number; auth: AuthContext }>();

export function invalidateAuthCache(): void {
  sessionCache.clear();
}

export async function resolveSession(token: string): Promise<AuthContext | null> {
  const tokenHash = sha256(token);
  const now = Date.now();
  const hit = sessionCache.get(tokenHash);
  if (hit && now - hit.at < SESSION_CACHE_MS && hit.expiresAt > now) return { ...hit.auth };

  const rows = await db
    .select({ user: users, role: roles, session: sessions })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .innerJoin(roles, eq(users.roleId, roles.id))
    .where(and(eq(sessions.tokenHash, tokenHash), gt(sessions.expiresAt, new Date())));
  const row = rows[0];
  if (!row || row.user.status !== 'active') {
    sessionCache.delete(tokenHash);
    return null;
  }
  // the session's chosen company; access taken away meanwhile falls back home
  const work =
    (row.session.activeCompanyId ? await workplaceIn(row.user, row.role, row.session.activeCompanyId) : null) ??
    homeWorkplace(row.user, row.role);
  const auth = await withAllowedQueues(toAuthContext(row.user, work));
  if (sessionCache.size >= SESSION_CACHE_MAX) sessionCache.clear();
  sessionCache.set(tokenHash, { at: now, expiresAt: row.session.expiresAt.getTime(), auth });
  return { ...auth };
}

/**
 * A user's effective access (role, form, queue and agent limits) without a
 * session — in `companyId` when given (null when they have no access there),
 * otherwise in their own company.
 */
export async function authContextForUser(userId: string, companyId?: string | null): Promise<AuthContext | null> {
  const rows = await db
    .select({ user: users, role: roles })
    .from(users)
    .innerJoin(roles, eq(users.roleId, roles.id))
    .where(eq(users.id, userId));
  const row = rows[0];
  if (!row) return null;
  const work = await workplaceIn(row.user, row.role, companyId);
  if (!work) return null;
  return withAllowedQueues(toAuthContext(row.user, work));
}

export interface UserCompany {
  id: string;
  name: string;
  roleName: string;
  /** the person's own company */
  home: boolean;
}

/** Every company a person works in: their own first, then the others by name. */
export async function companiesForUser(userId: string): Promise<UserCompany[]> {
  const [home] = await db
    .select({ id: companies.id, name: companies.name, status: companies.status, roleName: roles.name })
    .from(users)
    .innerJoin(companies, eq(users.companyId, companies.id))
    .innerJoin(roles, eq(users.roleId, roles.id))
    .where(eq(users.id, userId));
  const others = await db
    .select({ id: companies.id, name: companies.name, roleName: roles.name })
    .from(companyMemberships)
    .innerJoin(companies, eq(companyMemberships.companyId, companies.id))
    .innerJoin(roles, eq(companyMemberships.roleId, roles.id))
    .where(and(eq(companyMemberships.userId, userId), ne(companies.status, 'deleting')))
    .orderBy(asc(companies.name));
  const list: UserCompany[] = [];
  if (home && home.status !== 'deleting') list.push({ id: home.id, name: home.name, roleName: home.roleName, home: true });
  for (const o of others) list.push({ ...o, home: false });
  return list;
}

/**
 * Moves a session to another company the person works in. Returns false when
 * they have no access there. The choice is remembered for their next sign-in.
 */
export async function switchSessionCompany(token: string, userId: string, companyId: string): Promise<boolean> {
  const [row] = await db
    .select({ user: users, role: roles })
    .from(users)
    .innerJoin(roles, eq(users.roleId, roles.id))
    .where(eq(users.id, userId));
  if (!row || row.user.companyId === null) return false;
  const work = await workplaceIn(row.user, row.role, companyId);
  if (!work) return false;
  const tokenHash = sha256(token);
  await db
    .update(sessions)
    .set({ activeCompanyId: companyId === row.user.companyId ? null : companyId })
    .where(and(eq(sessions.tokenHash, tokenHash), eq(sessions.userId, userId)));
  await db.update(users).set({ lastCompanyId: companyId }).where(eq(users.id, userId));
  sessionCache.delete(tokenHash);
  return true;
}

export async function logout(token: string): Promise<void> {
  const tokenHash = sha256(token);
  sessionCache.delete(tokenHash);
  await db.delete(sessions).where(eq(sessions.tokenHash, tokenHash));
}

export async function revokeUserSessions(userId: string): Promise<void> {
  invalidateAuthCache();
  await db.delete(sessions).where(eq(sessions.userId, userId));
}
