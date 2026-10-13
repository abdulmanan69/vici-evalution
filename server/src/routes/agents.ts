import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, count, eq, ilike, or, type SQL } from 'drizzle-orm';
import { db } from '../db/client.js';
import { dialerServers, viciAgents } from '../db/schema.js';
import { companyScope, requirePermission } from '../auth/plugin.js';
import { audit } from '../lib/audit.js';
import { NotFoundError } from '../lib/errors.js';
import { offsetOf, pageMeta, paginationSchema } from '../lib/pagination.js';

const listQuery = paginationSchema.extend({
  companyId: z.string().uuid().optional(),
  dialerServerId: z.string().uuid().optional(),
  role: z.enum(['fronter', 'closer', 'blended', 'unknown']).optional(),
  search: z.string().max(100).optional(),
});

export async function agentRoutes(app: FastifyInstance): Promise<void> {
  app.get('/', { preHandler: [requirePermission('queues.view')] }, async (req) => {
    const q = listQuery.parse(req.query);
    const scope = companyScope(req, q.companyId);
    const where: SQL[] = [];
    if (scope) where.push(eq(viciAgents.companyId, scope));
    if (q.dialerServerId) where.push(eq(viciAgents.dialerServerId, q.dialerServerId));
    if (q.role) where.push(eq(viciAgents.agentRole, q.role));
    if (q.search) {
      where.push(
        or(ilike(viciAgents.viciUser, `%${q.search}%`), ilike(viciAgents.fullName, `%${q.search}%`))!,
      );
    }
    const whereAll = where.length ? and(...where) : undefined;
    const [total] = await db.select({ n: count() }).from(viciAgents).where(whereAll);
    const rows = await db
      .select({
        agent: viciAgents,
        dialerName: dialerServers.name,
      })
      .from(viciAgents)
      .innerJoin(dialerServers, eq(viciAgents.dialerServerId, dialerServers.id))
      .where(whereAll)
      .orderBy(viciAgents.viciUser)
      .limit(q.pageSize)
      .offset(offsetOf(q));
    return {
      agents: rows.map((r) => ({ ...r.agent, dialerName: r.dialerName })),
      meta: pageMeta(q, total.n),
    };
  });

  // Classify an agent (fronter / closer / blended) — used for QA form targeting.
  app.patch('/:id', { preHandler: [requirePermission('admin.agents')] }, async (req) => {
    const { id } = req.params as { id: string };
    const body = z
      .object({ agentRole: z.enum(['fronter', 'closer', 'blended', 'unknown']) })
      .parse(req.body);
    const [before] = await db.select().from(viciAgents).where(eq(viciAgents.id, id));
    if (!before) throw new NotFoundError('Agent not found');
    companyScope(req, before.companyId);
    const [row] = await db
      .update(viciAgents)
      .set({ agentRole: body.agentRole })
      .where(eq(viciAgents.id, id))
      .returning();
    await audit(req, {
      action: 'agent.update_role',
      entityType: 'vici_agent',
      entityId: id,
      before: { agentRole: before.agentRole },
      after: { agentRole: row.agentRole },
      companyId: before.companyId,
    });
    return { agent: row };
  });
}
