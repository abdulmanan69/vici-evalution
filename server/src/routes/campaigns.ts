import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, eq, type SQL } from 'drizzle-orm';
import { db } from '../db/client.js';
import { campaigns, dialerServers, ingroups } from '../db/schema.js';
import { companyScope, requirePermission } from '../auth/plugin.js';

const listQuery = z.object({
  companyId: z.string().uuid().optional(),
  dialerServerId: z.string().uuid().optional(),
});

export async function campaignRoutes(app: FastifyInstance): Promise<void> {
  app.get('/', { preHandler: [requirePermission('queues.view')] }, async (req) => {
    const q = listQuery.parse(req.query);
    const scope = companyScope(req, q.companyId);
    const where: SQL[] = [];
    if (scope) where.push(eq(campaigns.companyId, scope));
    if (q.dialerServerId) where.push(eq(campaigns.dialerServerId, q.dialerServerId));
    const rows = await db
      .select({ campaign: campaigns, dialerName: dialerServers.name })
      .from(campaigns)
      .innerJoin(dialerServers, eq(campaigns.dialerServerId, dialerServers.id))
      .where(where.length ? and(...where) : undefined)
      .orderBy(campaigns.viciCampaignId);
    return { campaigns: rows.map((r) => ({ ...r.campaign, dialerName: r.dialerName })) };
  });

  app.get('/ingroups', { preHandler: [requirePermission('queues.view')] }, async (req) => {
    const q = listQuery.parse(req.query);
    const scope = companyScope(req, q.companyId);
    const where: SQL[] = [];
    if (scope) where.push(eq(ingroups.companyId, scope));
    if (q.dialerServerId) where.push(eq(ingroups.dialerServerId, q.dialerServerId));
    const rows = await db
      .select()
      .from(ingroups)
      .where(where.length ? and(...where) : undefined)
      .orderBy(ingroups.viciGroupId);
    return { ingroups: rows };
  });
}
