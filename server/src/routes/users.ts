import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, eq, isNull, or, type SQL } from 'drizzle-orm';
import { db } from '../db/client.js';
import { roles, users } from '../db/schema.js';
import { companyScope, isSuperAdmin, requiredCompanyScope, requirePermission } from '../auth/plugin.js';
import { audit } from '../lib/audit.js';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../lib/errors.js';
import { hashPassword } from '../lib/crypto.js';
import { revokeUserSessions } from '../auth/session.js';

const createUserSchema = z.object({
  companyId: z.string().uuid().optional(),
  roleId: z.string().uuid(),
  email: z.string().email(),
  name: z.string().min(2).max(200),
  password: z.string().min(10).max(200),
});

async function assertAssignableRole(req: Parameters<typeof companyScope>[0], roleId: string, companyId: string | null) {
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

export async function userRoutes(app: FastifyInstance): Promise<void> {
  app.get('/', { preHandler: [requirePermission('admin.users')] }, async (req) => {
    const q = req.query as { companyId?: string };
    const scope = companyScope(req, q.companyId);
    const where: SQL[] = [];
    if (scope) where.push(eq(users.companyId, scope));
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
      })
      .from(users)
      .innerJoin(roles, eq(users.roleId, roles.id))
      .where(where.length ? and(...where) : undefined)
      .orderBy(users.email);
    return { users: rows };
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
    if (existing.length > 0) throw new ConflictError('Email already in use');

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
        name: z.string().min(2).max(200).optional(),
        roleId: z.string().uuid().optional(),
        status: z.enum(['active', 'disabled']).optional(),
        password: z.string().min(10).max(200).optional(),
      })
      .parse(req.body);
    const [before] = await db.select().from(users).where(eq(users.id, id));
    if (!before) throw new NotFoundError('User not found');
    companyScope(req, before.companyId ?? undefined);
    if (!isSuperAdmin(req.auth) && before.companyId === null) {
      throw new ForbiddenError('Cannot modify platform users');
    }
    if (body.roleId) await assertAssignableRole(req, body.roleId, before.companyId);

    const set: Partial<typeof users.$inferInsert> = { updatedAt: new Date() };
    if (body.name) set.name = body.name;
    if (body.roleId) set.roleId = body.roleId;
    if (body.status) set.status = body.status;
    if (body.password) set.passwordHash = await hashPassword(body.password);

    const [row] = await db.update(users).set(set).where(eq(users.id, id)).returning();
    if (body.status === 'disabled' || body.password || body.roleId) {
      await revokeUserSessions(id); // permission or credential change kills sessions
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
}
