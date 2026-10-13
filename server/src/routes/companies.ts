import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, count, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { companies, dialerServers, roles, users } from '../db/schema.js';
import { requirePermission, isSuperAdmin } from '../auth/plugin.js';
import { audit } from '../lib/audit.js';
import { ConflictError, ForbiddenError, NotFoundError } from '../lib/errors.js';
import { ROLE_PRESETS } from '../auth/permissions.js';

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
    await audit(req, { action: 'company.create', entityType: 'company', entityId: row.id, after: row, companyId: row.id });
    return reply.status(201).send({ company: row });
  });

  app.patch('/:id', { preHandler: [requirePermission('admin.companies')] }, async (req) => {
    const { id } = req.params as { id: string };
    const body = companySchema.partial().parse(req.body);
    const [before] = await db.select().from(companies).where(eq(companies.id, id));
    if (!before) throw new NotFoundError('Company not found');
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
}
