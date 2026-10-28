import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, eq, isNull, type SQL } from 'drizzle-orm';
import { db } from '../db/client.js';
import { dispositionMappings } from '../db/schema.js';
import { companyScope, requiredCompanyScope, requirePermission } from '../auth/plugin.js';
import { audit } from '../lib/audit.js';
import { ConflictError, NotFoundError } from '../lib/errors.js';
import { requestBackfill } from '../services/defaultMappings.js';

/**
 * Transfers and sales are derived from these meanings: changing one makes
 * the company's dialers re-read the last 7 days, so the queues reflect it.
 */
function affectsQueues(meaning: string): boolean {
  return meaning === 'transfer' || meaning === 'sale';
}

const mappingSchema = z.object({
  companyId: z.string().uuid().optional(),
  dialerServerId: z.string().uuid().nullable().optional(),
  campaignId: z.string().uuid().nullable().optional(),
  dispositionCode: z.string().min(1).max(50),
  meaning: z.enum(['transfer', 'sale', 'no_sale', 'callback', 'dnc', 'other']),
  active: z.boolean().default(true),
});

export async function dispositionRoutes(app: FastifyInstance): Promise<void> {
  app.get('/', { preHandler: [requirePermission('queues.view')] }, async (req) => {
    const q = req.query as { companyId?: string };
    const scope = companyScope(req, q.companyId);
    const where: SQL[] = [];
    if (scope) where.push(eq(dispositionMappings.companyId, scope));
    const rows = await db
      .select()
      .from(dispositionMappings)
      .where(where.length ? and(...where) : undefined)
      .orderBy(dispositionMappings.dispositionCode);
    return { mappings: rows };
  });

  app.post('/', { preHandler: [requirePermission('admin.dispositions')] }, async (req, reply) => {
    const body = mappingSchema.parse(req.body);
    const companyId = requiredCompanyScope(req, body.companyId);
    // Postgres unique indexes treat NULLs as distinct, so enforce one mapping
    // per (scope, code) here.
    const dupe = await db
      .select()
      .from(dispositionMappings)
      .where(
        and(
          eq(dispositionMappings.companyId, companyId),
          eq(dispositionMappings.dispositionCode, body.dispositionCode.trim().toUpperCase()),
          body.dialerServerId
            ? eq(dispositionMappings.dialerServerId, body.dialerServerId)
            : isNull(dispositionMappings.dialerServerId),
          body.campaignId
            ? eq(dispositionMappings.campaignId, body.campaignId)
            : isNull(dispositionMappings.campaignId),
        ),
      );
    if (dupe.length > 0) throw new ConflictError('A mapping for this disposition and scope already exists');

    const [row] = await db
      .insert(dispositionMappings)
      .values({
        companyId,
        dialerServerId: body.dialerServerId ?? null,
        campaignId: body.campaignId ?? null,
        dispositionCode: body.dispositionCode.trim().toUpperCase(),
        meaning: body.meaning,
        active: body.active,
        createdBy: req.auth.userId,
      })
      .returning();
    await audit(req, { action: 'dispo.create', entityType: 'disposition_mapping', entityId: row.id, after: row, companyId });
    if (affectsQueues(row.meaning)) await requestBackfill(companyId);
    return reply.status(201).send({ mapping: row });
  });

  app.patch('/:id', { preHandler: [requirePermission('admin.dispositions')] }, async (req) => {
    const { id } = req.params as { id: string };
    const body = mappingSchema.partial().parse(req.body);
    const [before] = await db.select().from(dispositionMappings).where(eq(dispositionMappings.id, id));
    if (!before) throw new NotFoundError('Mapping not found');
    companyScope(req, before.companyId);
    const [row] = await db
      .update(dispositionMappings)
      .set({
        meaning: body.meaning ?? before.meaning,
        active: body.active ?? before.active,
        updatedAt: new Date(),
      })
      .where(eq(dispositionMappings.id, id))
      .returning();
    await audit(req, { action: 'dispo.update', entityType: 'disposition_mapping', entityId: id, before, after: row, companyId: before.companyId });
    if ((affectsQueues(before.meaning) || affectsQueues(row.meaning)) && (before.meaning !== row.meaning || before.active !== row.active)) {
      await requestBackfill(before.companyId);
    }
    return { mapping: row };
  });

  app.delete('/:id', { preHandler: [requirePermission('admin.dispositions')] }, async (req) => {
    const { id } = req.params as { id: string };
    const [before] = await db.select().from(dispositionMappings).where(eq(dispositionMappings.id, id));
    if (!before) throw new NotFoundError('Mapping not found');
    companyScope(req, before.companyId);
    await db.delete(dispositionMappings).where(eq(dispositionMappings.id, id));
    await audit(req, { action: 'dispo.delete', entityType: 'disposition_mapping', entityId: id, before, companyId: before.companyId });
    if (affectsQueues(before.meaning)) await requestBackfill(before.companyId);
    return { ok: true };
  });
}
