import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, avg, count, eq, gte, lte, sql, type SQL } from 'drizzle-orm';
import { db } from '../db/client.js';
import { dialerServers, evaluations, recordings, transfers } from '../db/schema.js';
import { companyScope, requirePermission } from '../auth/plugin.js';
import { localToUtc, utcToLocalString } from '../vicidial/timezone.js';
import { ValidationError } from '../lib/errors.js';

const statsQuery = z.object({
  companyId: z.string().uuid().optional(),
  /** last N dialer-local days including today (1 = today) */
  days: z.coerce.number().int().min(1).max(365).optional(),
  /** custom range as dialer-local days */
  dateFrom: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  dateTo: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  /** fallback zone when the scope has no dialer */
  tz: z
    .string()
    .regex(/^[A-Za-z0-9_/+-]{1,64}$/)
    .optional(),
});

function dayMinus(day: string, minusDays: number): string {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d - minusDays)).toISOString().slice(0, 10);
}

export async function dashboardRoutes(app: FastifyInstance): Promise<void> {
  app.get('/stats', { preHandler: [requirePermission('dashboard.view')] }, async (req) => {
    const q = statsQuery.parse(req.query);
    const scope = companyScope(req, q.companyId);

    // All ranges are DIALER-local days, so the dashboard's numbers line up
    // with the queues, the agent report, and VICIdial's own reports.
    const [dialerRow] = await db
      .select({ timezone: dialerServers.timezone })
      .from(dialerServers)
      .where(scope ? eq(dialerServers.companyId, scope) : eq(dialerServers.active, true))
      .limit(1);
    const tz = dialerRow?.timezone ?? q.tz ?? 'UTC';
    const todayLocal = utcToLocalString(new Date(), tz).slice(0, 10);

    let fromDay: string;
    let toDay: string;
    if (q.dateFrom && q.dateTo) {
      if (q.dateTo < q.dateFrom) throw new ValidationError('dateTo must not be before dateFrom');
      if ((Date.parse(q.dateTo) - Date.parse(q.dateFrom)) / 86_400_000 > 92) {
        throw new ValidationError('Range too large — pick at most 92 days');
      }
      fromDay = q.dateFrom;
      toDay = q.dateTo;
    } else {
      const days = q.days ?? 7;
      toDay = todayLocal;
      fromDay = dayMinus(todayLocal, days - 1);
    }
    const since = localToUtc(`${fromDay} 00:00:00`, tz);
    const until = localToUtc(`${toDay} 23:59:59`, tz);

    const tWhere: SQL[] = [
      gte(transfers.xferTime, since),
      lte(transfers.xferTime, until),
      eq(transfers.isMock, false),
    ];
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

    const eWhere: SQL[] = [
      eq(evaluations.status, 'completed'),
      gte(evaluations.createdAt, since),
      lte(evaluations.createdAt, until),
    ];
    if (scope) eWhere.push(eq(evaluations.companyId, scope));
    const [evalStats] = await db
      .select({ n: count(), avgPercent: avg(evaluations.percent) })
      .from(evaluations)
      .where(and(...eWhere));

    // daily trend: transfers vs closed, bucketed in dialer days
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
      dateFrom: fromDay,
      dateTo: toDay,
      timezone: tz,
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
