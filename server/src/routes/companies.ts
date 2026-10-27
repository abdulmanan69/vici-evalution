import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { and, count, eq, inArray, isNull } from 'drizzle-orm';
import { db } from '../db/client.js';
import { companies, dialerServers, roles, sessions, users } from '../db/schema.js';
import { requirePermission, isSuperAdmin } from '../auth/plugin.js';
import { audit } from '../lib/audit.js';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../lib/errors.js';
import { ROLE_PRESETS } from '../auth/permissions.js';
import { ensureDefaultForms } from '../services/ensureDefaultForms.js';
import { companyUsage } from '../services/purge.js';
import { dropQueuedSyncs, enqueueCompanyPurge } from '../lib/queue.js';
import { closePooledDbClient } from '../vicidial/dbPool.js';
import { invalidateAuthCache } from '../auth/session.js';

/** Deleting a whole company is a platform decision: super admins only. */
function assertSuperAdmin(req: FastifyRequest): void {
  if (!isSuperAdmin(req.auth)) throw new ForbiddenError('Only a super admin can delete a company');
}

async function loadCompany(id: string) {
  if (!z.string().uuid().safeParse(id).success) throw new NotFoundError('Company not found');
  const [row] = await db.select().from(companies).where(eq(companies.id, id));
  if (!row) throw new NotFoundError('Company not found');
  return row;
}

const companySchema = z.object({
  name: z.string().min(2).max(200),
  slug: z
    .string()
    .min(2)
    .max(64)
    .regex(/^[a-z0-9-]+$/),
  status: z.enum(['active', 'suspended']).default('active'),
});

export async function companyRoutes(app: FastifyInstance): Promise<void> {
  // Any signed-in user may list the companies they can see (scoped).
  app.get('/', async (req) => {
    if (isSuperAdmin(req.auth)) {
      const rows = await db.select().from(companies).orderBy(companies.name);
      return { companies: rows };
    }
    if (!req.auth.companyId) return { companies: [] };
    const rows = await db.select().from(companies).where(eq(companies.id, req.auth.companyId));
    return { companies: rows };
  });

  app.get('/:id', async (req) => {
    const { id } = req.params as { id: string };
    if (!isSuperAdmin(req.auth) && req.auth.companyId !== id) {
      throw new ForbiddenError('Cross-company access denied');
    }
    const [row] = await db.select().from(companies).where(eq(companies.id, id));
    if (!row) throw new NotFoundError('Company not found');
    const [dialerCount] = await db
      .select({ n: count() })
      .from(dialerServers)
      .where(eq(dialerServers.companyId, id));
    const [userCount] = await db.select({ n: count() }).from(users).where(eq(users.companyId, id));
    return { company: row, stats: { dialers: dialerCount.n, users: userCount.n } };
  });

  app.post('/', { preHandler: [requirePermission('admin.companies')] }, async (req, reply) => {
    const body = companySchema.parse(req.body);
    const existing = await db.select().from(companies).where(eq(companies.slug, body.slug));
    if (existing.length > 0) throw new ConflictError('Slug already in use');
    const [row] = await db.insert(companies).values(body).returning();
    // provision the standard company roles
    for (const name of ['company_admin', 'qa_manager', 'qa_reviewer'] as const) {
      await db.insert(roles).values({
        companyId: row.id,
        name,
        description: ROLE_PRESETS[name].description,
        permissions: ROLE_PRESETS[name].permissions,
        isSystem: true,
      });
    }
    // every company starts with the built-in TRA / Unclosed / Closed scorecards
    await ensureDefaultForms(row.id, req.auth.userId);
    await audit(req, { action: 'company.create', entityType: 'company', entityId: row.id, after: row, companyId: row.id });
    return reply.status(201).send({ company: row });
  });

  app.patch('/:id', { preHandler: [requirePermission('admin.companies')] }, async (req) => {
    const { id } = req.params as { id: string };
    const body = companySchema.partial().parse(req.body);
    const before = await loadCompany(id);
    if (before.status === 'deleting') throw new ConflictError('This company is being deleted');
    if (body.slug && body.slug !== before.slug) {
      const dupe = await db
        .select()
        .from(companies)
        .where(and(eq(companies.slug, body.slug)));
      if (dupe.length > 0) throw new ConflictError('Slug already in use');
    }
    const [row] = await db
      .update(companies)
      .set({ ...body, updatedAt: new Date() })
      .where(eq(companies.id, id))
      .returning();
    await audit(req, { action: 'company.update', entityType: 'company', entityId: id, before, after: row, companyId: id });
    return { company: row };
  });

  // What deleting the company would remove — shown before confirming.
  app.get('/:id/usage', { preHandler: [requirePermission('admin.companies')] }, async (req) => {
    assertSuperAdmin(req);
    const { id } = req.params as { id: string };
    await loadCompany(id);
    return { usage: await companyUsage(id) };
  });

  // Delete a company with everything in it: dialers, calls, recordings,
  // evaluations, forms, users. The super admin types the company name to
  // confirm. Its users are signed out and disabled at once and its dialers
  // stop syncing; the worker removes the data in the background, then the
  // company itself (services/purge.ts).
  app.delete('/:id', { preHandler: [requirePermission('admin.companies')] }, async (req, reply) => {
    assertSuperAdmin(req);
    const { id } = req.params as { id: string };
    const body = z.object({ confirmName: z.string().max(200) }).parse(req.body ?? {});
    const before = await loadCompany(id);
    if (before.status === 'deleting') {
      await enqueueCompanyPurge(id);
      return reply.status(202).send({ deleting: true });
    }
    if (body.confirmName.trim() !== before.name.trim()) {
      throw new ValidationError('Type the company name exactly as shown to confirm');
    }
    const usage = await companyUsage(id);

    const dialerIds = await db.transaction(async (tx) => {
      // the slug is freed so a new company can take it straight away
      await tx
        .update(companies)
        .set({ status: 'deleting', slug: `deleted-${id}`, updatedAt: new Date() })
        .where(eq(companies.id, id));
      const companyUsers = tx.select({ id: users.id }).from(users).where(eq(users.companyId, id));
      await tx.delete(sessions).where(inArray(sessions.userId, companyUsers));
      await tx.update(users).set({ status: 'disabled', updatedAt: new Date() }).where(eq(users.companyId, id));
      const marked = await tx
        .update(dialerServers)
        .set({ active: false, deletingAt: new Date(), updatedAt: new Date() })
        .where(and(eq(dialerServers.companyId, id), isNull(dialerServers.deletingAt)))
        .returning({ id: dialerServers.id });
      return marked.map((d) => d.id);
    });
    invalidateAuthCache();
    for (const dialerId of dialerIds) {
      await dropQueuedSyncs(dialerId);
      closePooledDbClient(dialerId);
    }
    await enqueueCompanyPurge(id);
    await audit(req, {
      action: 'company.delete',
      entityType: 'company',
      entityId: id,
      before,
      after: { usage },
      // the company row goes away; keep the record on the platform log
      companyId: null,
    });
    return reply.status(202).send({ deleting: true, usage });
  });
}
