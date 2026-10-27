import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { and, eq, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  companies,
  companyMemberships,
  qaAssignments,
  qaForms,
  reviewerAgentAssignments,
  roles,
  sessions,
  users,
} from '../db/schema.js';
import { companyScope, isSuperAdmin, requiredCompanyScope, requirePermission } from '../auth/plugin.js';
import { audit } from '../lib/audit.js';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../lib/errors.js';
import { hashPassword } from '../lib/crypto.js';
import { revokeUserSessions } from '../auth/session.js';
import { companyPeople, personInCompany } from '../lib/people.js';

const createUserSchema = z.object({
  companyId: z.string().uuid().optional(),
  roleId: z.string().uuid(),
  email: z.string().email(),
  name: z.string().min(2).max(200),
  password: z.string().min(10).max(200),
});

async function assertAssignableRole(req: FastifyRequest, roleId: string, companyId: string | null) {
  const [role] = await db.select().from(roles).where(eq(roles.id, roleId));
  if (!role) throw new ValidationError('Role not found');
  if (isSuperAdmin(req.auth)) {
    // super admin may assign anything, but a company user cannot hold a global role
    if (companyId && role.companyId && role.companyId !== companyId) {
      throw new ValidationError('Role belongs to a different company');
    }
    return role;
  }
  // company admins may only assign their own company's roles — never global ones
  if (!role.companyId || role.companyId !== req.auth.companyId) {
    throw new ForbiddenError('Cannot assign this role');
  }
  return role;
}

/** QA-method limits must name forms of the company they apply in. */
async function assertCompanyForms(formIds: string[] | null | undefined, companyId: string): Promise<void> {
  if (!formIds || formIds.length === 0) return;
  const found = await db
    .select({ id: qaForms.id })
    .from(qaForms)
    .where(and(inArray(qaForms.id, formIds), eq(qaForms.companyId, companyId)));
  if (found.length !== new Set(formIds).size) {
    throw new ValidationError('One or more forms do not belong to this company');
  }
}

function assertSuperAdmin(req: FastifyRequest): void {
  if (!isSuperAdmin(req.auth)) throw new ForbiddenError('Only a super admin can give access to other companies');
}

export async function userRoutes(app: FastifyInstance): Promise<void> {
  // Everyone who works in the company in scope — its own users and people
  // shared from other companies (with their role here). Super admins without
  // a company in scope see every account once, with how many extra
  // companies each one works in.
  app.get('/', { preHandler: [requirePermission('admin.users')] }, async (req) => {
    const q = req.query as { companyId?: string };
    const scope = companyScope(req, q.companyId);
    if (scope) {
      const people = await companyPeople(scope);
      return {
        users: people.map((p) => ({
          id: p.id,
          companyId: p.homeCompanyId,
          email: p.email,
          name: p.name,
          status: p.status,
          lastLoginAt: p.lastLoginAt,
          createdAt: p.createdAt,
          roleId: p.roleId,
          roleName: p.roleName,
          allowedFormIds: p.allowedFormIds,
          shared: p.shared,
        })),
      };
    }
    const rows = await db
      .select({
        id: users.id,
        companyId: users.companyId,
        email: users.email,
        name: users.name,
        status: users.status,
        lastLoginAt: users.lastLoginAt,
        createdAt: users.createdAt,
        roleId: users.roleId,
        roleName: roles.name,
        allowedFormIds: users.allowedFormIds,
        extraCompanies: sql<number>`(select count(*)::int from company_memberships m where m.user_id = ${users.id})`,
      })
      .from(users)
      .innerJoin(roles, eq(users.roleId, roles.id))
      .orderBy(users.email);
    return { users: rows.map((r) => ({ ...r, shared: false })) };
  });

  app.get('/roles', { preHandler: [requirePermission('admin.users')] }, async (req) => {
    const q = req.query as { companyId?: string };
    if (isSuperAdmin(req.auth)) {
      const scope = q.companyId;
      const rows = await db
        .select()
        .from(roles)
        .where(scope ? or(eq(roles.companyId, scope), isNull(roles.companyId)) : undefined)
        .orderBy(roles.name);
      return { roles: rows };
    }
    const rows = await db
      .select()
      .from(roles)
      .where(eq(roles.companyId, req.auth.companyId!))
      .orderBy(roles.name);
    return { roles: rows };
  });

  app.post('/', { preHandler: [requirePermission('admin.users')] }, async (req, reply) => {
    const body = createUserSchema.parse(req.body);
    // Super admin may create platform users (companyId omitted) or company users;
    // company admins always create inside their own company.
    const companyId = isSuperAdmin(req.auth)
      ? (body.companyId ?? null)
      : requiredCompanyScope(req, body.companyId);
    await assertAssignableRole(req, body.roleId, companyId);

    const email = body.email.toLowerCase().trim();
    const existing = await db.select().from(users).where(eq(users.email, email));
    if (existing.length > 0) {
      throw new ConflictError(
        'This email already has an account — a super admin can give that person access to this company instead',
      );
    }

    const [row] = await db
      .insert(users)
      .values({
        companyId,
        roleId: body.roleId,
        email,
        name: body.name,
        passwordHash: await hashPassword(body.password),
      })
      .returning();
    await audit(req, {
      action: 'user.create',
      entityType: 'user',
      entityId: row.id,
      after: { email: row.email, name: row.name, roleId: row.roleId },
      companyId,
    });
    return reply.status(201).send({ user: { id: row.id, email: row.email, name: row.name } });
  });

  app.patch('/:id', { preHandler: [requirePermission('admin.users')] }, async (req) => {
    const { id } = req.params as { id: string };
    const body = z
      .object({
        /** the company the change applies in (super admins; others use their active company) */
        companyId: z.string().uuid().optional(),
        name: z.string().min(2).max(200).optional(),
        roleId: z.string().uuid().optional(),
        status: z.enum(['active', 'disabled']).optional(),
        password: z.string().min(10).max(200).optional(),
        /** restrict a reviewer to specific QA forms; null clears */
        allowedFormIds: z.array(z.string().uuid()).max(50).nullable().optional(),
      })
      .parse(req.body);
    const [before] = await db.select().from(users).where(eq(users.id, id));
    if (!before) throw new NotFoundError('User not found');
    const superAdmin = isSuperAdmin(req.auth);
    const ctx = superAdmin ? (body.companyId ?? before.companyId) : req.auth.companyId;

    // Someone shared from another company: here only their role and QA
    // methods in this company can change. Their account (name, password,
    // status) belongs to their own company.
    if (ctx && before.companyId !== ctx) {
      const person = await personInCompany(id, ctx);
      if (!person) throw new NotFoundError('User not found');
      if ((body.name || body.password || body.status) && !superAdmin) {
        throw new ForbiddenError("This person's account belongs to another company — remove their access here instead");
      }
      if (body.roleId) await assertAssignableRole(req, body.roleId, ctx);
      if (body.allowedFormIds !== undefined) await assertCompanyForms(body.allowedFormIds, ctx);
      const set: Partial<typeof companyMemberships.$inferInsert> = {};
      if (body.roleId) set.roleId = body.roleId;
      if (body.allowedFormIds !== undefined) {
        set.allowedFormIds = body.allowedFormIds && body.allowedFormIds.length > 0 ? body.allowedFormIds : null;
      }
      if (Object.keys(set).length > 0) {
        await db
          .update(companyMemberships)
          .set(set)
          .where(and(eq(companyMemberships.userId, id), eq(companyMemberships.companyId, ctx)));
      }
      // a super admin may still fix the account itself from here
      const accountSet: Partial<typeof users.$inferInsert> = { updatedAt: new Date() };
      if (body.name) accountSet.name = body.name;
      if (body.status) accountSet.status = body.status;
      if (body.password) accountSet.passwordHash = await hashPassword(body.password);
      if (body.name || body.status || body.password) await db.update(users).set(accountSet).where(eq(users.id, id));
      if (body.status === 'disabled' || body.password) await revokeUserSessions(id);
      await audit(req, {
        action: 'user.update_membership',
        entityType: 'user',
        entityId: id,
        before: { roleId: person.roleId, allowedFormIds: person.allowedFormIds },
        after: { roleId: set.roleId ?? person.roleId, allowedFormIds: set.allowedFormIds ?? person.allowedFormIds },
        companyId: ctx,
      });
      return {
        user: {
          id,
          email: before.email,
          name: body.name ?? before.name,
          status: body.status ?? before.status,
          roleId: body.roleId ?? person.roleId,
        },
      };
    }

    companyScope(req, before.companyId ?? undefined);
    if (!superAdmin && before.companyId === null) {
      throw new ForbiddenError('Cannot modify platform users');
    }
    if (body.roleId) await assertAssignableRole(req, body.roleId, before.companyId);
    if (body.allowedFormIds !== undefined && before.companyId) await assertCompanyForms(body.allowedFormIds, before.companyId);

    const set: Partial<typeof users.$inferInsert> = { updatedAt: new Date() };
    if (body.name) set.name = body.name;
    if (body.roleId) set.roleId = body.roleId;
    if (body.status) set.status = body.status;
    if (body.password) set.passwordHash = await hashPassword(body.password);
    if (body.allowedFormIds !== undefined) {
      set.allowedFormIds = body.allowedFormIds && body.allowedFormIds.length > 0 ? body.allowedFormIds : null;
    }

    const [row] = await db.update(users).set(set).where(eq(users.id, id)).returning();
    if (body.status === 'disabled' || body.password || body.roleId || body.allowedFormIds !== undefined) {
      await revokeUserSessions(id); // permission or restriction change kills sessions
    }
    await audit(req, {
      action: 'user.update',
      entityType: 'user',
      entityId: id,
      before: { name: before.name, roleId: before.roleId, status: before.status },
      after: { name: row.name, roleId: row.roleId, status: row.status },
      companyId: before.companyId,
    });
    return { user: { id: row.id, email: row.email, name: row.name, status: row.status, roleId: row.roleId } };
  });

  // ---- access to other companies (super admins) ------------------------------

  /** The person's own company and every other company they can work in. */
  app.get('/:id/companies', { preHandler: [requirePermission('admin.users')] }, async (req) => {
    assertSuperAdmin(req);
    const { id } = req.params as { id: string };
    const [u] = await db.select().from(users).where(eq(users.id, id));
    if (!u) throw new NotFoundError('User not found');
    const [home] = u.companyId
      ? await db
          .select({ id: companies.id, name: companies.name, roleName: roles.name })
          .from(companies)
          .innerJoin(roles, eq(roles.id, u.roleId))
          .where(eq(companies.id, u.companyId))
      : [];
    const memberships = await db
      .select({
        companyId: companyMemberships.companyId,
        companyName: companies.name,
        roleId: companyMemberships.roleId,
        roleName: roles.name,
        allowedFormIds: companyMemberships.allowedFormIds,
        createdAt: companyMemberships.createdAt,
      })
      .from(companyMemberships)
      .innerJoin(companies, eq(companyMemberships.companyId, companies.id))
      .innerJoin(roles, eq(companyMemberships.roleId, roles.id))
      .where(and(eq(companyMemberships.userId, id), ne(companies.status, 'deleting')))
      .orderBy(companies.name);
    return { home: home ?? null, memberships };
  });

  /** Give the person access to another company with a role there (or change that role). */
  app.put('/:id/companies/:companyId', { preHandler: [requirePermission('admin.users')] }, async (req) => {
    assertSuperAdmin(req);
    const { id, companyId } = req.params as { id: string; companyId: string };
    const body = z.object({ roleId: z.string().uuid() }).parse(req.body);
    if (!z.string().uuid().safeParse(companyId).success) throw new NotFoundError('Company not found');
    const [u] = await db.select().from(users).where(eq(users.id, id));
    if (!u) throw new NotFoundError('User not found');
    if (u.companyId === null) throw new ValidationError('Super admins already see every company');
    if (u.companyId === companyId) throw new ValidationError('This is already their own company');
    const [company] = await db.select().from(companies).where(eq(companies.id, companyId));
    if (!company || company.status === 'deleting') throw new NotFoundError('Company not found');
    const [role] = await db.select().from(roles).where(eq(roles.id, body.roleId));
    // a company's own roles only — never a platform role or template
    if (!role || role.companyId !== companyId) throw new ValidationError('Pick one of this company’s roles');

    const [before] = await db
      .select()
      .from(companyMemberships)
      .where(and(eq(companyMemberships.userId, id), eq(companyMemberships.companyId, companyId)));
    await db
      .insert(companyMemberships)
      .values({ userId: id, companyId, roleId: body.roleId, createdBy: req.auth.userId })
      .onConflictDoUpdate({
        target: [companyMemberships.userId, companyMemberships.companyId],
        set: { roleId: body.roleId },
      });
    await audit(req, {
      action: before ? 'user.membership_role' : 'user.membership_add',
      entityType: 'user',
      entityId: id,
      before: before ? { companyId, roleId: before.roleId } : null,
      after: { companyId, roleId: body.roleId, roleName: role.name },
      companyId,
    });
    return { ok: true };
  });

  /**
   * Take away the person's access to a company that is not their own: super
   * admins, or that company's own admins. Their reviewer assignments and open
   * tasks there end; their finished evaluations stay.
   */
  app.delete('/:id/companies/:companyId', { preHandler: [requirePermission('admin.users')] }, async (req) => {
    const { id, companyId } = req.params as { id: string; companyId: string };
    if (!z.string().uuid().safeParse(companyId).success) throw new NotFoundError('Company not found');
    if (!isSuperAdmin(req.auth) && req.auth.companyId !== companyId) {
      throw new ForbiddenError('Cross-company access denied');
    }
    const [m] = await db
      .select()
      .from(companyMemberships)
      .where(and(eq(companyMemberships.userId, id), eq(companyMemberships.companyId, companyId)));
    if (!m) throw new NotFoundError('This person has no access to that company');

    await db.transaction(async (tx) => {
      await tx
        .delete(companyMemberships)
        .where(and(eq(companyMemberships.userId, id), eq(companyMemberships.companyId, companyId)));
      await tx
        .delete(reviewerAgentAssignments)
        .where(and(eq(reviewerAgentAssignments.reviewerUserId, id), eq(reviewerAgentAssignments.companyId, companyId)));
      await tx
        .update(qaAssignments)
        .set({ status: 'cancelled', updatedAt: new Date() })
        .where(
          and(
            eq(qaAssignments.assignedTo, id),
            eq(qaAssignments.companyId, companyId),
            inArray(qaAssignments.status, ['open', 'in_progress']),
          ),
        );
      // sessions working there go back to the person's own company
      await tx
        .update(sessions)
        .set({ activeCompanyId: null })
        .where(and(eq(sessions.userId, id), eq(sessions.activeCompanyId, companyId)));
      await tx
        .update(users)
        .set({ lastCompanyId: null })
        .where(and(eq(users.id, id), eq(users.lastCompanyId, companyId)));
    });
    await audit(req, {
      action: 'user.membership_remove',
      entityType: 'user',
      entityId: id,
      before: { companyId, roleId: m.roleId },
      companyId,
    });
    return { ok: true };
  });
}
