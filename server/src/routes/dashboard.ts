import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, avg, count, eq, gte, sql, type SQL } from 'drizzle-orm';
import { db } from '../db/client.js';
import { evaluations, recordings, transfers } from '../db/schema.js';
import { companyScope, requirePermission } from '../auth/plugin.js';

const statsQuery = z.object({
  companyId: z.string().uuid().optional(),
  days: z.coerce.number().int().min(1).max(365).default(30),
  /** IANA zone for day bucketing (the browser sends its own); default UTC */
  tz: z
    .string()
    .regex(/^[A-Za-z0-9_/+-]{1,64}$/)
    .optional(),
});

export async function dashboardRoutes(app: FastifyInstance): Promise<void> {
  app.get('/stats', { preHandler: [requirePermission('dashboard.view')] }, async (req) => {
    const q = statsQuery.parse(req.query);
    const scope = companyScope(req, q.companyId);
    const since = new Date(Date.now() - q.days * 24 * 3600 * 1000);

    const tWhere: SQL[] = [gte(transfers.xferTime, since), eq(transfers.isMock, false)];
    if (scope) tWhere.push(eq(transfers.companyId, scope));

    const byQueue = await db
      .select({ queueStatus: transfers.queueStatus, n: count() })
      .from(transfers)
      .where(and(...tWhere))
      .groupBy(transfers.queueStatus);

    const flagged = await db
      .select({ n: count() })
      .from(transfers)
      .where(and(...tWhere, eq(transfers.matchStatus, 'flagged')));

    const rWhere: SQL[] = [eq(recordings.status, 'missing'), eq(recordings.isMock, false)];
    if (scope) rWhere.push(eq(recordings.companyId, scope));
    const missingRecordings = await db
      .select({ n: count() })
      .from(recordings)
      .where(and(...rWhere));

    const eWhere: SQL[] = [eq(evaluations.status, 'completed'), gte(evaluations.createdAt, since)];
    if (scope) eWhere.push(eq(evaluations.companyId, scope));
    const [evalStats] = await db
      .select({ n: count(), avgPercent: avg(evaluations.percent) })
      .from(evaluations)
      .where(and(...eWhere));

    // daily trend: transfers vs closed, bucketed in the requested timezone so
    // day counts line up with what people see on their own clock
    const tz = q.tz ?? 'UTC';
    const trend = await db
      .select({
        day: sql<string>`to_char(date_trunc('day', ${transfers.xferTime} AT TIME ZONE ${tz}), 'YYYY-MM-DD')`,
        total: count(),
        closed: sql<number>`count(*) filter (where ${transfers.queueStatus} = 'closed')`,
      })
      .from(transfers)
      .where(and(...tWhere))
      // ordinal grouping: the tz bind parameter would otherwise appear as two
      // different placeholders in SELECT vs GROUP BY and Postgres rejects it
      .groupBy(sql`1`)
      .orderBy(sql`1`);

    const totals: Record<string, number> = { transfer: 0, unclosed: 0, closed: 0 };
    for (const row of byQueue) totals[row.queueStatus] = row.n;
    const totalTransfers = totals.transfer + totals.unclosed + totals.closed;

    return {
      days: q.days,
      totals: {
        transfers: totalTransfers,
        transfer: totals.transfer,
        unclosed: totals.unclosed,
        closed: totals.closed,
        closeRate: totalTransfers > 0 ? Math.round((totals.closed / totalTransfers) * 1000) / 10 : 0,
        flaggedMatches: flagged[0]?.n ?? 0,
        missingRecordings: missingRecordings[0]?.n ?? 0,
        evaluationsCompleted: evalStats?.n ?? 0,
        avgQaScore: evalStats?.avgPercent ? Math.round(Number(evalStats.avgPercent) * 10) / 10 : null,
      },
      trend,
    };
  });
}
