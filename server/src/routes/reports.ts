import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { alias } from 'drizzle-orm/pg-core';
import { and, count, desc, eq, gte, inArray, lte, sql, sum, type SQL } from 'drizzle-orm';
import { db } from '../db/client.js';
import { agentDispositions, calls, dialerServers, evaluations, qaFormVersions, qaForms, transfers, users, viciAgents } from '../db/schema.js';
import { companyScope, requirePermission } from '../auth/plugin.js';
import { audit } from '../lib/audit.js';
import { NotFoundError, ValidationError } from '../lib/errors.js';
import { toConnection } from '../vicidial/credentials.js';
import { ViciApiClient } from '../vicidial/apiClient.js';
import { localToUtc, utcToLocalString } from '../vicidial/timezone.js';
import { fetchAgentStatusDetail, parseAgentStatusDetail } from '../vicidial/webReport.js';

const EXPORT_LIMIT = 50_000;

function csvEscape(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = v instanceof Date ? v.toISOString() : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(headers: string[], rows: unknown[][]): string {
  const lines = [headers.join(',')];
  for (const row of rows) lines.push(row.map(csvEscape).join(','));
  return lines.join('\r\n') + '\r\n';
}

/** '1:23:45' / '23:45' / '824' (plain seconds) -> seconds. VICIdial mixes both. */
export function viciTimeToSec(v: string | undefined | null): number {
  if (!v) return 0;
  const t = v.trim();
  if (/^\d+$/.test(t)) return Number(t);
  const parts = t.split(':').map(Number);
  if (parts.some((n) => !Number.isFinite(n))) return 0;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

const agentActivityQuery = z.object({
  dialerServerId: z.string().uuid(),
  dateFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  dateTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

interface AgentActivityRow {
  user: string;
  fullName: string | null;
  userGroup: string | null;
  viciCalls: number | null;
  /** XFER / SALE counts straight from the dialer's report (archived fallback) */
  viciXfers: number | null;
  viciSales: number | null;
  talkSec: number | null;
  waitSec: number | null;
  pauseSec: number | null;
  loginSec: number | null;
  recordedCalls: number;
  recordedSec: number;
  transfersStarted: number;
  salesClosed: number;
}

const exportQuery = z.object({
  companyId: z.string().uuid().optional(),
  dateFrom: z.coerce.date().optional(),
  dateTo: z.coerce.date().optional(),
  queueStatus: z.enum(['transfer', 'unclosed', 'closed']).optional(),
});

const qaPerformanceQuery = z.object({
  companyId: z.string().uuid().optional(),
  dateFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  dateTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  groupBy: z.enum(['agent', 'reviewer']).default('agent'),
  formId: z.string().uuid().optional(),
  format: z.enum(['json', 'csv']).default('json'),
});

const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));
const pct1 = (part: number, whole: number): number => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : 0);

export async function reportRoutes(app: FastifyInstance): Promise<void> {
  /**
   * QA performance for a dialer-day range, grouped by the evaluated agent
   * (fronter leg for fronter forms, closer leg for closer forms) or by the
   * reviewer who scored them — with task completion for reviewers.
   */
  app.get('/qa-performance', { preHandler: [requirePermission('reports.view')] }, async (req, reply) => {
    const q = qaPerformanceQuery.parse(req.query);
    if (q.dateTo < q.dateFrom) throw new ValidationError('dateTo must not be before dateFrom');
    if ((Date.parse(q.dateTo) - Date.parse(q.dateFrom)) / 86_400_000 > 366) {
      throw new ValidationError('Range too large — pick at most a year');
    }
    const scope = companyScope(req, q.companyId);
    const [dialerRow] = await db
      .select({ timezone: dialerServers.timezone })
      .from(dialerServers)
      .where(scope ? eq(dialerServers.companyId, scope) : eq(dialerServers.active, true))
      .limit(1);
    const tz = dialerRow?.timezone ?? 'UTC';
    const start = localToUtc(`${q.dateFrom} 00:00:00`, tz);
    const end = localToUtc(`${q.dateTo} 23:59:59`, tz);

    const filters: SQL[] = [
      sql`e.status = 'completed'`,
      sql`e.completed_at >= ${start}`,
      sql`e.completed_at <= ${end}`,
    ];
    if (scope) filters.push(sql`e.company_id = ${scope}`);
    if (q.formId) filters.push(sql`f.id = ${q.formId}`);
    const base = sql`
      select e.id, e.reviewer_id, e.percent, e.passed, e.auto_failed, f.queue as form_queue,
             case when f.target = 'fronter' then fc.vici_agent_id
                  when f.target = 'closer' then cc.vici_agent_id
                  else coalesce(cc.vici_agent_id, fc.vici_agent_id) end as agent_id
        from evaluations e
        join qa_form_versions v on v.id = e.form_version_id
        join qa_forms f on f.id = v.form_id
        left join transfers t on t.id = e.transfer_id
        left join calls fc on fc.id = t.fronter_call_id
        left join calls cc on cc.id = t.closer_call_id
       where ${sql.join(filters, sql` and `)}`;
    const aggregates = sql`
      count(*)::int as evaluations,
      round(avg(ev.percent)::numeric, 1) as avg_percent,
      min(ev.percent) as lowest,
      max(ev.percent) as highest,
      count(*) filter (where ev.passed)::int as passed,
      count(*) filter (where not ev.passed and not ev.auto_failed)::int as failed,
      count(*) filter (where ev.auto_failed)::int as auto_failed,
      count(*) filter (where ev.form_queue = 'transfer')::int as transfer_evals,
      count(*) filter (where ev.form_queue = 'unclosed')::int as unclosed_evals,
      count(*) filter (where ev.form_queue = 'closed')::int as closed_evals`;

    type Row = Record<string, unknown>;
    let rows: Array<Record<string, string | number | null>> = [];

    if (q.groupBy === 'agent') {
      const result = await db.execute(sql`
        with ev as (${base})
        select ev.agent_id, a.full_name, a.vici_user, a.agent_role, ${aggregates}
          from ev left join vici_agents a on a.id = ev.agent_id
         group by ev.agent_id, a.full_name, a.vici_user, a.agent_role
         order by evaluations desc, a.full_name`);
      rows = (result.rows as Row[]).map((r) => {
        const evals = num(r.evaluations);
        return {
          id: (r.agent_id as string | null) ?? null,
          name: (r.full_name as string | null) ?? (r.vici_user as string | null) ?? 'Unknown agent',
          user: (r.vici_user as string | null) ?? null,
          role: (r.agent_role as string | null) ?? null,
          evaluations: evals,
          avgPercent: r.avg_percent === null ? null : num(r.avg_percent),
          lowest: r.lowest === null ? null : num(r.lowest),
          highest: r.highest === null ? null : num(r.highest),
          passed: num(r.passed),
          failed: num(r.failed),
          autoFailed: num(r.auto_failed),
          passRate: pct1(num(r.passed), evals),
          transferEvals: num(r.transfer_evals),
          unclosedEvals: num(r.unclosed_evals),
          closedEvals: num(r.closed_evals),
        };
      });
    } else {
      const evalResult = await db.execute(sql`
        with ev as (${base})
        select ev.reviewer_id, ${aggregates} from ev group by ev.reviewer_id`);
      const taskWhere: SQL[] = [
        sql`x.status <> 'cancelled'`,
        sql`x.task_date >= ${q.dateFrom}::date`,
        sql`x.task_date <= ${q.dateTo}::date`,
      ];
      if (scope) taskWhere.push(sql`x.company_id = ${scope}`);
      const taskResult = await db.execute(sql`
        select x.assigned_to,
               count(*)::int as tasks,
               count(*) filter (where x.status = 'done')::int as tasks_done,
               count(*) filter (where x.status = 'done' and x.due_at is not null
                                  and x.completed_at > x.due_at)::int as tasks_late
          from qa_assignments x
         where ${sql.join(taskWhere, sql` and `)}
         group by x.assigned_to`);
      const evalBy = new Map((evalResult.rows as Row[]).map((r) => [r.reviewer_id as string, r]));
      const taskBy = new Map((taskResult.rows as Row[]).map((r) => [r.assigned_to as string, r]));
      const ids = [...new Set([...evalBy.keys(), ...taskBy.keys()])];
      const names = ids.length
        ? await db.select({ id: users.id, name: users.name, email: users.email }).from(users).where(inArray(users.id, ids))
        : [];
      rows = names
        .map((u) => {
          const e = evalBy.get(u.id) ?? {};
          const t = taskBy.get(u.id) ?? {};
          const evals = num(e.evaluations);
          const tasks = num(t.tasks);
          return {
            id: u.id,
            name: u.name,
            user: u.email,
            role: null,
            evaluations: evals,
            avgPercent: e.avg_percent === undefined || e.avg_percent === null ? null : num(e.avg_percent),
            lowest: e.lowest === undefined || e.lowest === null ? null : num(e.lowest),
            highest: e.highest === undefined || e.highest === null ? null : num(e.highest),
            passed: num(e.passed),
            failed: num(e.failed),
            autoFailed: num(e.auto_failed),
            passRate: pct1(num(e.passed), evals),
            transferEvals: num(e.transfer_evals),
            unclosedEvals: num(e.unclosed_evals),
            closedEvals: num(e.closed_evals),
            tasks,
            tasksDone: num(t.tasks_done),
            tasksLate: num(t.tasks_late),
            taskCompletion: pct1(num(t.tasks_done), tasks),
          };
        })
        .sort((a, b) => b.evaluations - a.evaluations || a.name.localeCompare(b.name));
    }

    const totalEvals = rows.reduce((s, r) => s + num(r.evaluations), 0);
    const totalPassed = rows.reduce((s, r) => s + num(r.passed), 0);
    const weightedAvg = totalEvals
      ? Math.round((rows.reduce((s, r) => s + num(r.avgPercent) * num(r.evaluations), 0) / totalEvals) * 10) / 10
      : null;
    const summary = {
      evaluations: totalEvals,
      avgPercent: weightedAvg,
      passRate: pct1(totalPassed, totalEvals),
      autoFailed: rows.reduce((s, r) => s + num(r.autoFailed), 0),
      people: rows.filter((r) => num(r.evaluations) > 0).length,
      tasks: rows.reduce((s, r) => s + num(r.tasks), 0),
      tasksDone: rows.reduce((s, r) => s + num(r.tasksDone), 0),
    };

    if (q.format === 'csv') {
      const isAgent = q.groupBy === 'agent';
      const header = [
        isAgent ? 'agent' : 'reviewer', isAgent ? 'agent_user' : 'email', 'evaluations', 'avg_percent',
        'pass_rate', 'passed', 'failed', 'auto_failed', 'lowest', 'highest',
        'transfer_evals', 'unclosed_evals', 'closed_evals',
        ...(isAgent ? [] : ['tasks', 'tasks_done', 'task_completion_percent', 'tasks_late']),
      ];
      const body = rows.map((r) => [
        r.name, r.user, r.evaluations, r.avgPercent, r.passRate, r.passed, r.failed, r.autoFailed,
        r.lowest, r.highest, r.transferEvals, r.unclosedEvals, r.closedEvals,
        ...(isAgent ? [] : [r.tasks, r.tasksDone, r.taskCompletion, r.tasksLate]),
      ]);
      await audit(req, { action: 'report.export_qa_performance', after: { groupBy: q.groupBy, rows: rows.length } });
      reply.header('content-type', 'text/csv; charset=utf-8');
      reply.header('content-disposition', `attachment; filename="qa-performance-${q.groupBy}-${q.dateFrom}_${q.dateTo}.csv"`);
      return reply.send(toCsv(header, body));
    }

    return { dateFrom: q.dateFrom, dateTo: q.dateTo, timezone: tz, groupBy: q.groupBy, summary, rows };
  });

  /**
   * Per-agent activity for a dialer-local date range — the platform's
   * counterpart to VICIdial's "Agent Status Detail" report.
   *
   * Calls and time columns are fetched LIVE from the dialer's own
   * agent_stats_export (the same data VICIdial's reports aggregate), so they
   * match the dialer exactly. Recorded calls / transfers / sales are this
   * platform's synced view and are listed separately.
   */
  app.get('/agent-activity', { preHandler: [requirePermission('reports.view')] }, async (req) => {
    const q = agentActivityQuery.parse(req.query);
    if (q.dateTo < q.dateFrom) throw new ValidationError('dateTo must not be before dateFrom');
    const spanDays = (Date.parse(q.dateTo) - Date.parse(q.dateFrom)) / 86_400_000;
    if (spanDays > 62) throw new ValidationError('Range too large — pick at most 62 days');

    const [dialer] = await db.select().from(dialerServers).where(eq(dialerServers.id, q.dialerServerId));
    if (!dialer) throw new NotFoundError('Dialer not found');
    companyScope(req, dialer.companyId);

    // --- live VICIdial aggregates (exact, same source as its own reports) ---
    const rows = new Map<string, AgentActivityRow>();
    const ensure = (user: string): AgentActivityRow => {
      let r = rows.get(user);
      if (!r) {
        r = {
          user,
          fullName: null,
          userGroup: null,
          viciCalls: null,
          viciXfers: null,
          viciSales: null,
          talkSec: null,
          waitSec: null,
          pauseSec: null,
          loginSec: null,
          recordedCalls: 0,
          recordedSec: 0,
          transfersStarted: 0,
          salesClosed: 0,
        };
        rows.set(user, r);
      }
      return r;
    };

    let viciError: string | null = null;
    const conn = toConnection(dialer);
    if (conn.apiUser) {
      try {
        const stats = await new ViciApiClient(conn).agentStatsExport(
          `${q.dateFrom} 00:00:00`,
          `${q.dateTo} 23:59:59`,
        );
        for (const s of stats) {
          const user = (s.user ?? '').trim();
          if (!user) continue;
          const r = ensure(user);
          r.fullName = s.full_name ?? null;
          r.userGroup = s.user_group ?? null;
          r.viciCalls = /^\d+$/.test(s.calls ?? '') ? Number(s.calls) : 0;
          r.talkSec = viciTimeToSec(s.total_talk_time);
          r.waitSec = viciTimeToSec(s.wait_time);
          r.pauseSec = viciTimeToSec(s.pause_time);
          r.loginSec = viciTimeToSec(s.login_time);
        }
      } catch (err) {
        viciError = err instanceof Error ? err.message : String(err);
      }
    } else {
      viciError = 'No API credentials configured for this dialer';
    }

    // VICIdial's Agent Status Detail web report supplies what the stats
    // export cannot: per-status counts (XFER/SALE) and — because it searches
    // the archive — data for past dates on dialers that archive nightly.
    // It is merged in every time; when the stats export came back empty it
    // becomes the authoritative source for the call counts too.
    let source: 'live_api' | 'archived_report' | 'platform_only' = viciError ? 'platform_only' : 'live_api';
    if (conn.apiUser) {
      // A day being archived SPLITS its rows between the live tables and the
      // archive: the live report can return a partial table for a past date.
      // So both variants are fetched and summed per agent — live-only for
      // today, live+archived for any range touching past days.
      const todayLocal = utcToLocalString(new Date(), dialer.timezone).slice(0, 10);
      const reportCalls = new Map<string, { name: string; calls: number; xfers: number; sales: number }>();
      let anyReport = false;
      const variants: boolean[] = q.dateFrom < todayLocal ? [false, true] : [false];
      let lastReportError: string | null = null;
      for (const archived of variants) {
        try {
          const parsed = parseAgentStatusDetail(
            await fetchAgentStatusDetail(conn, q.dateFrom, q.dateTo, archived),
          );
          anyReport = true;
          for (const pr of parsed.rows) {
            if (!pr.user) continue;
            const acc = reportCalls.get(pr.user) ?? { name: pr.name, calls: 0, xfers: 0, sales: 0 };
            acc.calls += pr.calls;
            acc.xfers += pr.statusCounts.XFER ?? 0;
            acc.sales += pr.statusCounts.SALE ?? 0;
            reportCalls.set(pr.user, acc);
          }
        } catch (err) {
          // an empty table throws — normal for one of the two variants
          lastReportError = err instanceof Error ? err.message : String(err);
        }
      }
      if (anyReport) {
        for (const [user, acc] of reportCalls) {
          const r = ensure(user);
          if (!r.fullName) r.fullName = acc.name;
          if (r.viciCalls == null) r.viciCalls = acc.calls;
          r.viciXfers = acc.xfers;
          r.viciSales = acc.sales;
        }
        if (viciError) {
          source = 'archived_report';
          viciError = null;
        }
      } else if (viciError && lastReportError) {
        viciError = `${viciError}; report fallback failed: ${lastReportError}`;
      }
    }

    // --- platform-synced aggregates over the same dialer-local window ---
    const startUtc = localToUtc(`${q.dateFrom} 00:00:00`, dialer.timezone);
    const endUtc = localToUtc(`${q.dateTo} 23:59:59`, dialer.timezone);

    const callAgg = await db
      .select({ user: calls.viciUserRaw, n: count(), talk: sum(calls.lengthSec) })
      .from(calls)
      .where(
        and(
          eq(calls.dialerServerId, dialer.id),
          eq(calls.isMock, false),
          gte(calls.callDate, startUtc),
          lte(calls.callDate, endUtc),
        ),
      )
      .groupBy(calls.viciUserRaw);
    for (const a of callAgg) {
      if (!a.user) continue;
      const r = ensure(a.user);
      r.recordedCalls = a.n;
      r.recordedSec = a.talk ? Number(a.talk) : 0;
    }

    const fronterCall = alias(calls, 'fc');
    // credited like the dialer does: to the agent who dispositioned the XFER
    const xferUser = sql<string | null>`coalesce(${agentDispositions.viciUser}, ${fronterCall.viciUserRaw})`;
    const xferAgg = await db
      .select({ user: xferUser, n: count() })
      .from(transfers)
      .leftJoin(fronterCall, eq(transfers.fronterCallId, fronterCall.id))
      .leftJoin(
        agentDispositions,
        and(
          eq(agentDispositions.dialerServerId, transfers.dialerServerId),
          eq(agentDispositions.agentLogId, transfers.agentLogId),
        ),
      )
      .where(
        and(
          eq(transfers.dialerServerId, dialer.id),
          eq(transfers.isMock, false),
          eq(transfers.kind, 'transfer'),
          sql`coalesce(${transfers.countedAt}, ${transfers.xferTime}) >= ${startUtc}`,
          sql`coalesce(${transfers.countedAt}, ${transfers.xferTime}) <= ${endUtc}`,
        ),
      )
      .groupBy(sql`1`);
    for (const a of xferAgg) {
      if (a.user) ensure(a.user).transfersStarted = a.n;
    }

    const closerCall = alias(calls, 'cc');
    const saleAgg = await db
      .select({ user: closerCall.viciUserRaw, n: count() })
      .from(transfers)
      // the sale leg (a later callback when the closer leg was not the sale),
      // credited on its own day like the dialer's SALE column
      .innerJoin(closerCall, sql`${closerCall.id} = coalesce(${transfers.saleCallId}, ${transfers.closerCallId})`)
      .where(
        and(
          eq(closerCall.dialerServerId, dialer.id),
          eq(transfers.isMock, false),
          eq(transfers.queueStatus, 'closed'),
          gte(closerCall.callDate, startUtc),
          lte(closerCall.callDate, endUtc),
        ),
      )
      .groupBy(closerCall.viciUserRaw);
    for (const a of saleAgg) {
      if (a.user) ensure(a.user).salesClosed = a.n;
    }

    // fill names for rows the live export didn't cover
    const missingNames = [...rows.values()].filter((r) => !r.fullName).map((r) => r.user);
    if (missingNames.length > 0) {
      for (const a of await db
        .select({ user: viciAgents.viciUser, fullName: viciAgents.fullName, group: viciAgents.userGroup })
        .from(viciAgents)
        .where(eq(viciAgents.dialerServerId, dialer.id))) {
        const r = rows.get(a.user);
        if (r && !r.fullName) {
          r.fullName = a.fullName;
          r.userGroup = r.userGroup ?? a.group;
        }
      }
    }

    const list = [...rows.values()].sort((a, b) => (b.viciCalls ?? 0) - (a.viciCalls ?? 0) || a.user.localeCompare(b.user));
    const totals = list.reduce(
      (t, r) => ({
        viciCalls: t.viciCalls + (r.viciCalls ?? 0),
        viciXfers: t.viciXfers + (r.viciXfers ?? 0),
        viciSales: t.viciSales + (r.viciSales ?? 0),
        talkSec: t.talkSec + (r.talkSec ?? 0),
        recordedCalls: t.recordedCalls + r.recordedCalls,
        transfersStarted: t.transfersStarted + r.transfersStarted,
        salesClosed: t.salesClosed + r.salesClosed,
      }),
      { viciCalls: 0, viciXfers: 0, viciSales: 0, talkSec: 0, recordedCalls: 0, transfersStarted: 0, salesClosed: 0 },
    );

    await audit(req, {
      action: 'report.agent_activity',
      after: { dialerServerId: dialer.id, dateFrom: q.dateFrom, dateTo: q.dateTo },
      companyId: dialer.companyId,
    });
    return {
      dialer: { id: dialer.id, name: dialer.name, timezone: dialer.timezone },
      dateFrom: q.dateFrom,
      dateTo: q.dateTo,
      source,
      viciError,
      rows: list,
      totals,
    };
  });

  app.get('/transfers.csv', { preHandler: [requirePermission('reports.export')] }, async (req, reply) => {
    const q = exportQuery.parse(req.query);
    const scope = companyScope(req, q.companyId);
    const fronterCall = alias(calls, 'fc');
    const fronterAgent = alias(viciAgents, 'fa');
    const closerCall = alias(calls, 'cc');
    const closerAgent = alias(viciAgents, 'ca');

    const where: SQL[] = [eq(transfers.isMock, false)];
    if (scope) where.push(eq(transfers.companyId, scope));
    if (q.dateFrom) where.push(sql`coalesce(${transfers.countedAt}, ${transfers.xferTime}) >= ${q.dateFrom}`);
    if (q.dateTo) where.push(sql`coalesce(${transfers.countedAt}, ${transfers.xferTime}) <= ${q.dateTo}`);
    if (q.queueStatus) where.push(eq(transfers.queueStatus, q.queueStatus));

    const rows = await db
      .select({
        xferTime: transfers.xferTime,
        queueStatus: transfers.queueStatus,
        matchStatus: transfers.matchStatus,
        matchConfidence: transfers.matchConfidence,
        phoneNumber: transfers.phoneNumber,
        viciLeadId: transfers.viciLeadId,
        saleDisposition: transfers.saleDisposition,
        closedAt: transfers.closedAt,
        dialerName: dialerServers.name,
        fronterUser: fronterAgent.viciUser,
        fronterName: fronterAgent.fullName,
        fronterStatus: fronterCall.status,
        closerUser: closerAgent.viciUser,
        closerName: closerAgent.fullName,
        closerStatus: closerCall.status,
      })
      .from(transfers)
      .leftJoin(fronterCall, eq(transfers.fronterCallId, fronterCall.id))
      .leftJoin(fronterAgent, eq(fronterCall.viciAgentId, fronterAgent.id))
      .leftJoin(closerCall, eq(transfers.closerCallId, closerCall.id))
      .leftJoin(closerAgent, eq(closerCall.viciAgentId, closerAgent.id))
      .innerJoin(dialerServers, eq(transfers.dialerServerId, dialerServers.id))
      .where(and(...where))
      .orderBy(desc(transfers.xferTime))
      .limit(EXPORT_LIMIT);

    await audit(req, { action: 'report.export_transfers', after: { rows: rows.length } });
    const csv = toCsv(
      ['xfer_time', 'queue_status', 'match_status', 'confidence', 'phone', 'lead_id', 'sale_dispo', 'closed_at', 'dialer', 'fronter_user', 'fronter_name', 'fronter_dispo', 'closer_user', 'closer_name', 'closer_dispo'],
      rows.map((r) => [
        r.xferTime, r.queueStatus, r.matchStatus, r.matchConfidence, r.phoneNumber, r.viciLeadId,
        r.saleDisposition, r.closedAt, r.dialerName, r.fronterUser, r.fronterName, r.fronterStatus,
        r.closerUser, r.closerName, r.closerStatus,
      ]),
    );
    reply.header('content-type', 'text/csv; charset=utf-8');
    reply.header('content-disposition', 'attachment; filename="transfers.csv"');
    return reply.send(csv);
  });

  app.get('/evaluations.csv', { preHandler: [requirePermission('reports.export')] }, async (req, reply) => {
    const q = z
      .object({
        companyId: z.string().uuid().optional(),
        formId: z.string().uuid().optional(),
        reviewerId: z.string().uuid().optional(),
        result: z.enum(['pass', 'fail', 'auto_fail']).optional(),
        agent: z.string().max(60).optional(),
        dateFrom: z.string().max(40).optional(),
        dateTo: z.string().max(40).optional(),
      })
      .parse(req.query);
    const scope = companyScope(req, q.companyId);
    const fc = alias(calls, 'efc');
    const cc = alias(calls, 'ecc');
    const fa = alias(viciAgents, 'efa');
    const ca = alias(viciAgents, 'eca');

    const [dialerRow] = await db
      .select()
      .from(dialerServers)
      .where(scope ? eq(dialerServers.companyId, scope) : eq(dialerServers.active, true))
      .limit(1);
    const tz = dialerRow?.timezone ?? 'UTC';

    const where: SQL[] = [eq(evaluations.status, 'completed')];
    if (scope) where.push(eq(evaluations.companyId, scope));
    if (q.formId) where.push(eq(qaForms.id, q.formId));
    if (q.reviewerId) where.push(eq(evaluations.reviewerId, q.reviewerId));
    if (q.result === 'pass') where.push(eq(evaluations.passed, true));
    if (q.result === 'fail') where.push(and(eq(evaluations.passed, false), eq(evaluations.autoFailed, false))!);
    if (q.result === 'auto_fail') where.push(eq(evaluations.autoFailed, true));
    if (q.agent) {
      const pat = `%${q.agent}%`;
      where.push(
        sql`(${fa.fullName} ilike ${pat} or ${fa.viciUser} ilike ${pat} or ${ca.fullName} ilike ${pat} or ${ca.viciUser} ilike ${pat})`,
      );
    }
    const parseDay = (v: string, end: boolean) =>
      /^\d{4}-\d{2}-\d{2}$/.test(v) ? localToUtc(`${v} ${end ? '23:59:59' : '00:00:00'}`, tz) : new Date(v);
    if (q.dateFrom) where.push(gte(evaluations.completedAt, parseDay(q.dateFrom, false)));
    if (q.dateTo) where.push(lte(evaluations.completedAt, parseDay(q.dateTo, true)));

    const rows = await db
      .select({
        evaluation: evaluations,
        reviewer: users.name,
        formName: qaForms.name,
        formTarget: qaForms.target,
        formVersion: qaFormVersions.version,
        formVersionId: qaFormVersions.id,
        schema: qaFormVersions.schema,
        phone: transfers.phoneNumber,
        fronterAgent: fa.fullName,
        fronterUser: fa.viciUser,
        closerAgent: ca.fullName,
        closerUser: ca.viciUser,
      })
      .from(evaluations)
      .innerJoin(users, eq(evaluations.reviewerId, users.id))
      .innerJoin(qaFormVersions, eq(evaluations.formVersionId, qaFormVersions.id))
      .innerJoin(qaForms, eq(qaFormVersions.formId, qaForms.id))
      .leftJoin(transfers, eq(evaluations.transferId, transfers.id))
      .leftJoin(fc, eq(transfers.fronterCallId, fc.id))
      .leftJoin(fa, eq(fc.viciAgentId, fa.id))
      .leftJoin(cc, eq(transfers.closerCallId, cc.id))
      .leftJoin(ca, eq(cc.viciAgentId, ca.id))
      .where(and(...where))
      .orderBy(desc(evaluations.completedAt))
      .limit(EXPORT_LIMIT);

    // one column per scored AND informational question for EVERY form in the
    // export, grouped per form — rows fill their own form's columns and leave
    // the others blank, so a mixed export still carries all parameters
    type Q = { id: string; text: string; type: string; weight: number; scaleMax?: number; options?: Array<{ value: string; label: string; scorePct: number }> };
    const newestByForm = new Map<string, { formName: string; formVersion: number; schema: unknown; formId: string }>();
    for (const r of rows) {
      const key = `${r.formName}`;
      const prev = newestByForm.get(key);
      if (!prev || r.formVersion > prev.formVersion) {
        newestByForm.set(key, { formName: r.formName, formVersion: r.formVersion, schema: r.schema, formId: key });
      }
    }
    const questionCols: Array<{ formName: string; q: Q }> = [];
    for (const f of newestByForm.values()) {
      const schema = f.schema as { sections: Array<{ questions: Q[] }> };
      for (const qq of schema.sections.flatMap((s) => s.questions)) {
        questionCols.push({ formName: f.formName, q: qq });
      }
    }
    const prefix = newestByForm.size > 1 ? (c: { formName: string; q: Q }) => `${c.formName.split(' ')[0]}: ` : () => '';

    const header = [
      'date', 'time', 'number', 'agent', 'evaluator', 'method', 'result', 'score_percent',
      ...questionCols.map((c) => `${prefix(c)}${c.q.text}${c.q.weight > 0 ? ` (/${c.q.weight})` : ''}`),
      'comments',
    ];
    const body = rows.map((r) => {
      const local = r.evaluation.completedAt ? utcToLocalString(r.evaluation.completedAt, tz) : '';
      const agent = r.formTarget === 'fronter' ? (r.fronterAgent ?? r.fronterUser) : (r.closerAgent ?? r.closerUser);
      const answers = (r.evaluation.answers ?? {}) as Record<string, unknown>;
      const qCells = questionCols.map((c) => {
        if (c.formName !== r.formName) return '';
        const v = answers[c.q.id];
        if (v === null || v === undefined || v === '') return '';
        if (c.q.type === 'rating') return `${v}/${c.q.scaleMax ?? 5}`;
        if (c.q.type === 'dropdown') return c.q.options?.find((o) => o.value === String(v))?.label ?? String(v);
        return String(v);
      });
      return [
        local.slice(0, 10), local.slice(11, 16), r.phone, agent, r.reviewer, `${r.formName} v${r.formVersion}`,
        r.evaluation.autoFailed ? 'auto-fail' : r.evaluation.passed ? 'pass' : 'fail',
        r.evaluation.percent,
        ...qCells,
        r.evaluation.comments,
      ];
    });

    await audit(req, { action: 'report.export_evaluations', after: { rows: rows.length, formId: q.formId ?? null } });
    const csv = toCsv(header, body);
    reply.header('content-type', 'text/csv; charset=utf-8');
    reply.header('content-disposition', 'attachment; filename="evaluations.csv"');
    return reply.send(csv);
  });
}
