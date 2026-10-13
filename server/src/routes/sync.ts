import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, count, desc, eq, inArray, type SQL } from 'drizzle-orm';
import { db } from '../db/client.js';
import { dialerServers, syncCursors, syncJobs } from '../db/schema.js';
import { companyScope, requirePermission } from '../auth/plugin.js';
import { audit } from '../lib/audit.js';
import { offsetOf, pageMeta, paginationSchema } from '../lib/pagination.js';
import { enqueueDialerSync } from '../lib/queue.js';

export async function syncRoutes(app: FastifyInstance): Promise<void> {
  /** Per-dialer sync health: last job, cursors, last error. */
  app.get('/status', { preHandler: [requirePermission('admin.sync')] }, async (req) => {
    const q = req.query as { companyId?: string };
    const scope = companyScope(req, q.companyId);
    const where: SQL[] = [];
    if (scope) where.push(eq(dialerServers.companyId, scope));
    const dialers = await db
      .select()
      .from(dialerServers)
      .where(where.length ? and(...where) : undefined)
      .orderBy(dialerServers.name);

    const ids = dialers.map((d) => d.id);
    const cursors = ids.length
      ? await db.select().from(syncCursors).where(inArray(syncCursors.dialerServerId, ids))
      : [];

    const statuses = [];
    for (const d of dialers) {
      const [lastJob] = await db
        .select()
        .from(syncJobs)
        .where(eq(syncJobs.dialerServerId, d.id))
        .orderBy(desc(syncJobs.createdAt))
        .limit(1);
      statuses.push({
        dialerServerId: d.id,
        name: d.name,
        active: d.active,
        sourceMode: d.sourceMode,
        lastSeenAt: d.lastSeenAt,
        timezone: d.timezone,
        tzOffsetMin: d.tzOffsetMin,
        clockDriftSec: d.clockDriftSec,
        timeCheckedAt: d.timeCheckedAt,
        lastJob: lastJob ?? null,
        cursors: cursors.filter((c) => c.dialerServerId === d.id),
      });
    }
    return { statuses };
  });

  app.get('/jobs', { preHandler: [requirePermission('admin.sync')] }, async (req) => {
    const q = paginationSchema
      .extend({
        companyId: z.string().uuid().optional(),
        dialerServerId: z.string().uuid().optional(),
        status: z.enum(['queued', 'running', 'success', 'failed']).optional(),
      })
      .parse(req.query);
    const scope = companyScope(req, q.companyId);

    const where: SQL[] = [];
    if (q.dialerServerId) where.push(eq(syncJobs.dialerServerId, q.dialerServerId));
    if (q.status) where.push(eq(syncJobs.status, q.status));
    if (scope) where.push(eq(dialerServers.companyId, scope));
    const whereAll = where.length ? and(...where) : undefined;

    const [total] = await db
      .select({ n: count() })
      .from(syncJobs)
      .innerJoin(dialerServers, eq(syncJobs.dialerServerId, dialerServers.id))
      .where(whereAll);
    const rows = await db
      .select({ job: syncJobs, dialerName: dialerServers.name })
      .from(syncJobs)
      .innerJoin(dialerServers, eq(syncJobs.dialerServerId, dialerServers.id))
      .where(whereAll)
      .orderBy(desc(syncJobs.createdAt))
      .limit(q.pageSize)
      .offset(offsetOf(q));
    return { jobs: rows, meta: pageMeta(q, total.n) };
  });

  /** Queue a sync for every active dialer in scope. */
  app.post('/run', { preHandler: [requirePermission('admin.sync')] }, async (req) => {
    const body = z
      .object({ companyId: z.string().uuid().optional(), full: z.boolean().default(false) })
      .parse(req.body ?? {});
    const scope = companyScope(req, body.companyId);
    const where: SQL[] = [eq(dialerServers.active, true)];
    if (scope) where.push(eq(dialerServers.companyId, scope));
    const dialers = await db
      .select({ id: dialerServers.id })
      .from(dialerServers)
      .where(and(...where));
    for (const d of dialers) {
      await enqueueDialerSync(d.id, body.full);
    }
    await audit(req, { action: 'sync.run_all', after: { count: dialers.length, full: body.full } });
    return { queued: dialers.length };
  });
}
