import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, count, desc, eq, gte, lte, type SQL } from 'drizzle-orm';
import { db } from '../db/client.js';
import { auditLogs, users } from '../db/schema.js';
import { companyScope, requirePermission } from '../auth/plugin.js';
import { offsetOf, pageMeta, paginationSchema } from '../lib/pagination.js';

const listQuery = paginationSchema.extend({
  companyId: z.string().uuid().optional(),
  action: z.string().max(100).optional(),
  userId: z.string().uuid().optional(),
  dateFrom: z.coerce.date().optional(),
  dateTo: z.coerce.date().optional(),
});

export async function auditRoutes(app: FastifyInstance): Promise<void> {
  app.get('/', { preHandler: [requirePermission('admin.audit')] }, async (req) => {
    const q = listQuery.parse(req.query);
    const scope = companyScope(req, q.companyId);
    const where: SQL[] = [];
    if (scope) where.push(eq(auditLogs.companyId, scope));
    if (q.action) where.push(eq(auditLogs.action, q.action));
    if (q.userId) where.push(eq(auditLogs.userId, q.userId));
    if (q.dateFrom) where.push(gte(auditLogs.createdAt, q.dateFrom));
    if (q.dateTo) where.push(lte(auditLogs.createdAt, q.dateTo));
    const whereAll = where.length ? and(...where) : undefined;
    const [total] = await db.select({ n: count() }).from(auditLogs).where(whereAll);
    const rows = await db
      .select({
        log: auditLogs,
        userName: users.name,
        userEmail: users.email,
      })
      .from(auditLogs)
      .leftJoin(users, eq(auditLogs.userId, users.id))
      .where(whereAll)
      .orderBy(desc(auditLogs.createdAt))
      .limit(q.pageSize)
      .offset(offsetOf(q));
    return { logs: rows, meta: pageMeta(q, total.n) };
  });
}
