import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { alias } from 'drizzle-orm/pg-core';
import { and, count, desc, eq, gte, lte, sum, type SQL } from 'drizzle-orm';
import { db } from '../db/client.js';
import { calls, dialerServers, evaluations, qaFormVersions, qaForms, transfers, users, viciAgents } from '../db/schema.js';
import { companyScope, requirePermission } from '../auth/plugin.js';
import { audit } from '../lib/audit.js';
import { NotFoundError, ValidationError } from '../lib/errors.js';
import { toConnection } from '../vicidial/credentials.js';
import { ViciApiClient } from '../vicidial/apiClient.js';
import { localToUtc } from '../vicidial/timezone.js';
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

export async function reportRoutes(app: FastifyInstance): Promise<void> {
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
      try {
        // live table first; empty/absent means the range was archived — retry
        // with the archive search the way VICIdial's own report page does
        let parsed;
        try {
          parsed = parseAgentStatusDetail(await fetchAgentStatusDetail(conn, q.dateFrom, q.dateTo, false));
        } catch {
          parsed = parseAgentStatusDetail(await fetchAgentStatusDetail(conn, q.dateFrom, q.dateTo, true));
        }
        for (const pr of parsed.rows) {
          if (!pr.user) continue;
          const r = ensure(pr.user);
          if (!r.fullName) r.fullName = pr.name;
          if (r.viciCalls == null) r.viciCalls = pr.calls;
          r.viciXfers = pr.statusCounts.XFER ?? 0;
          r.viciSales = pr.statusCounts.SALE ?? 0;
        }
        if (viciError) {
          source = 'archived_report';
          viciError = null;
        }
      } catch (err) {
        if (viciError) {
          viciError = `${viciError}; archived report fallback failed: ${
            err instanceof Error ? err.message : String(err)
          }`;
        }
        // live stats succeeded — missing status columns are not an error
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
    const xferAgg = await db
      .select({ user: fronterCall.viciUserRaw, n: count() })
      .from(transfers)
      .innerJoin(fronterCall, eq(transfers.fronterCallId, fronterCall.id))
      .where(
        and(
          eq(transfers.dialerServerId, dialer.id),
          eq(transfers.isMock, false),
          gte(transfers.xferTime, startUtc),
          lte(transfers.xferTime, endUtc),
        ),
      )
      .groupBy(fronterCall.viciUserRaw);
    for (const a of xferAgg) {
      if (a.user) ensure(a.user).transfersStarted = a.n;
    }

    const closerCall = alias(calls, 'cc');
    const saleAgg = await db
      .select({ user: closerCall.viciUserRaw, n: count() })
      .from(transfers)
      .innerJoin(closerCall, eq(transfers.closerCallId, closerCall.id))
      .where(
        and(
          eq(closerCall.dialerServerId, dialer.id),
          eq(transfers.isMock, false),
          eq(transfers.queueStatus, 'closed'),
          gte(transfers.xferTime, startUtc),
          lte(transfers.xferTime, endUtc),
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
    if (q.dateFrom) where.push(gte(transfers.xferTime, q.dateFrom));
    if (q.dateTo) where.push(lte(transfers.xferTime, q.dateTo));
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
      .innerJoin(fronterCall, eq(transfers.fronterCallId, fronterCall.id))
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
    const q = exportQuery.parse(req.query);
    const scope = companyScope(req, q.companyId);
    const where: SQL[] = [eq(evaluations.status, 'completed')];
    if (scope) where.push(eq(evaluations.companyId, scope));
    if (q.dateFrom) where.push(gte(evaluations.completedAt, q.dateFrom));
    if (q.dateTo) where.push(lte(evaluations.completedAt, q.dateTo));

    const rows = await db
      .select({
        completedAt: evaluations.completedAt,
        score: evaluations.score,
        maxScore: evaluations.maxScore,
        percent: evaluations.percent,
        passed: evaluations.passed,
        autoFailed: evaluations.autoFailed,
        reviewer: users.name,
        formName: qaForms.name,
        formVersion: qaFormVersions.version,
        agentUser: viciAgents.viciUser,
        agentName: viciAgents.fullName,
      })
      .from(evaluations)
      .innerJoin(users, eq(evaluations.reviewerId, users.id))
      .innerJoin(qaFormVersions, eq(evaluations.formVersionId, qaFormVersions.id))
      .innerJoin(qaForms, eq(qaFormVersions.formId, qaForms.id))
      .leftJoin(viciAgents, eq(evaluations.targetAgentId, viciAgents.id))
      .where(and(...where))
      .orderBy(desc(evaluations.completedAt))
      .limit(EXPORT_LIMIT);

    await audit(req, { action: 'report.export_evaluations', after: { rows: rows.length } });
    const csv = toCsv(
      ['completed_at', 'score', 'max_score', 'percent', 'passed', 'auto_failed', 'reviewer', 'form', 'form_version', 'agent_user', 'agent_name'],
      rows.map((r) => [
        r.completedAt, r.score, r.maxScore, r.percent, r.passed, r.autoFailed,
        r.reviewer, r.formName, r.formVersion, r.agentUser, r.agentName,
      ]),
    );
    reply.header('content-type', 'text/csv; charset=utf-8');
    reply.header('content-disposition', 'attachment; filename="evaluations.csv"');
    return reply.send(csv);
  });
}
