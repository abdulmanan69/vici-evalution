import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { alias } from 'drizzle-orm/pg-core';
import { and, count, desc, eq, gte, ilike, lte, or, sql, type SQL } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  calls,
  campaigns,
  dialerServers,
  evaluations,
  recordings,
  transferEvents,
  transfers,
  viciAgents,
} from '../db/schema.js';
import { companyScope, requirePermission } from '../auth/plugin.js';
import { audit } from '../lib/audit.js';
import { ForbiddenError, NotFoundError, ValidationError } from '../lib/errors.js';
import { hasPermission } from '../auth/permissions.js';
import type { AuthContext } from '../auth/session.js';
import { agentScopeCondition, canReviewTransfer, hasActiveTask, isAgentScoped } from '../lib/reviewScope.js';
import { offsetOf, pageMeta, paginationSchema } from '../lib/pagination.js';
import { scoreCandidate, DEFAULT_MATCH_OPTIONS } from '../vicidial/matcher.js';
import { localToUtc } from '../vicidial/timezone.js';
import { toConnection } from '../vicidial/credentials.js';
import { getPooledDbClient } from '../vicidial/dbPool.js';

/** A reviewer limited to certain forms only reaches the matching queues. */
function assertQueueAllowed(auth: AuthContext, queue: string): void {
  if (!auth.allowedQueues || hasPermission(auth.permissions, 'qa.forms.manage')) return;
  if (!auth.allowedQueues.includes(queue as 'transfer' | 'unclosed' | 'closed')) {
    throw new ForbiddenError('This queue is not assigned to you');
  }
}

const fronterCall = alias(calls, 'fronter_call');
const closerCall = alias(calls, 'closer_call');
const fronterAgent = alias(viciAgents, 'fronter_agent');
const closerAgent = alias(viciAgents, 'closer_agent');

const listQuery = paginationSchema.extend({
  companyId: z.string().uuid().optional(),
  dialerServerId: z.string().uuid().optional(),
  campaignId: z.string().uuid().optional(),
  matchStatus: z.enum(['pending_match', 'matched', 'flagged', 'unmatched']).optional(),
  // YYYY-MM-DD = dialer-local day (like VICIdial's own reports); ISO datetimes also accepted
  dateFrom: z.string().max(40).optional(),
  dateTo: z.string().max(40).optional(),
  search: z.string().max(60).optional(), // phone or lead id
  includeMock: z.coerce.boolean().default(false),
});

export async function queueRoutes(app: FastifyInstance): Promise<void> {
  app.get('/:status', { preHandler: [requirePermission('queues.view')] }, async (req) => {
    const { status } = req.params as { status: string };
    if (!['transfer', 'unclosed', 'closed'].includes(status)) {
      throw new ValidationError('Queue must be transfer, unclosed or closed');
    }
    assertQueueAllowed(req.auth, status);
    const q = listQuery.parse(req.query);
    const scope = companyScope(req, q.companyId);

    // The Transfer section is the full log of fronter transfers — every
    // transferred call regardless of what happened downstream. Unclosed and
    // Closed are the state-filtered views.
    // Transfers lists fronter XFERs only; Closed also holds sales that had no
    // transfer (callback/inbound), so its count matches the dialer's SALEs.
    const where: SQL[] =
      status === 'transfer'
        ? [eq(transfers.kind, 'transfer')]
        : [eq(transfers.queueStatus, status as 'unclosed' | 'closed')];
    if (scope) where.push(eq(transfers.companyId, scope));
    // a reviewer assigned to specific agents only sees those agents' calls
    if (isAgentScoped(req.auth)) {
      where.push(agentScopeCondition(req.auth, status as 'transfer' | 'unclosed' | 'closed'));
    }
    if (q.dialerServerId) where.push(eq(transfers.dialerServerId, q.dialerServerId));
    if (q.campaignId) where.push(eq(fronterCall.campaignId, q.campaignId));
    if (q.matchStatus) where.push(eq(transfers.matchStatus, q.matchStatus));
    if (q.dateFrom || q.dateTo) {
      // plain dates mean the DIALER's day, so queue day-counts line up with
      // the agent report and VICIdial's own reports
      let tz = 'UTC';
      const [dialerRow] = q.dialerServerId
        ? await db.select().from(dialerServers).where(eq(dialerServers.id, q.dialerServerId))
        : await db
            .select()
            .from(dialerServers)
            .where(scope ? eq(dialerServers.companyId, scope) : eq(dialerServers.active, true))
            .limit(1);
      if (dialerRow) tz = dialerRow.timezone;
      const parseDay = (v: string, endOfDay: boolean): Date =>
        /^\d{4}-\d{2}-\d{2}$/.test(v)
          ? localToUtc(`${v} ${endOfDay ? '23:59:59' : '00:00:00'}`, tz)
          : new Date(v);
      if (q.dateFrom) where.push(sql`coalesce(${transfers.countedAt}, ${transfers.xferTime}) >= ${parseDay(q.dateFrom, false)}`);
      if (q.dateTo) where.push(sql`coalesce(${transfers.countedAt}, ${transfers.xferTime}) <= ${parseDay(q.dateTo, true)}`);
    }
    if (!q.includeMock) where.push(eq(transfers.isMock, false));
    if (q.search) {
      const digits = q.search.replace(/\D/g, '');
      where.push(
        or(
          ilike(transfers.phoneNumber, `%${digits || q.search}%`),
          digits ? sql`${transfers.viciLeadId}::text like ${'%' + digits + '%'}` : sql`false`,
        )!,
      );
    }
    const whereAll = and(...where);

    const [total] = await db
      .select({ n: count() })
      .from(transfers)
      .leftJoin(fronterCall, eq(transfers.fronterCallId, fronterCall.id))
      .where(whereAll);

    const rows = await db
      .select({
        transfer: transfers,
        fronterCall: fronterCall,
        fronterAgentUser: fronterAgent.viciUser,
        fronterAgentName: fronterAgent.fullName,
        closerCallDate: closerCall.callDate,
        closerStatus: closerCall.status,
        closerLength: closerCall.lengthSec,
        closerAgentUser: closerAgent.viciUser,
        closerAgentName: closerAgent.fullName,
        dialerName: dialerServers.name,
        campaignName: campaigns.name,
        viciCampaignId: campaigns.viciCampaignId,
      })
      .from(transfers)
      .leftJoin(fronterCall, eq(transfers.fronterCallId, fronterCall.id))
      .leftJoin(fronterAgent, eq(fronterCall.viciAgentId, fronterAgent.id))
      .leftJoin(closerCall, eq(transfers.closerCallId, closerCall.id))
      .leftJoin(closerAgent, eq(closerCall.viciAgentId, closerAgent.id))
      .innerJoin(dialerServers, eq(transfers.dialerServerId, dialerServers.id))
      .leftJoin(campaigns, eq(fronterCall.campaignId, campaigns.id))
      .where(whereAll)
      .orderBy(desc(transfers.xferTime))
      .limit(q.pageSize)
      .offset(offsetOf(q));

    return { items: rows, meta: pageMeta(q, total.n) };
  });

  // Full detail: both call legs, agents, recordings, status history, evaluations.
  app.get('/detail/:transferId', { preHandler: [requirePermission('calls.view')] }, async (req) => {
    const { transferId } = req.params as { transferId: string };
    const [row] = await db
      .select({
        transfer: transfers,
        fronterCall: fronterCall,
        closerCall: closerCall,
        fronterAgentUser: fronterAgent.viciUser,
        fronterAgentName: fronterAgent.fullName,
        closerAgentUser: closerAgent.viciUser,
        closerAgentName: closerAgent.fullName,
        dialerName: dialerServers.name,
      })
      .from(transfers)
      .leftJoin(fronterCall, eq(transfers.fronterCallId, fronterCall.id))
      .leftJoin(fronterAgent, eq(fronterCall.viciAgentId, fronterAgent.id))
      .leftJoin(closerCall, eq(transfers.closerCallId, closerCall.id))
      .leftJoin(closerAgent, eq(closerCall.viciAgentId, closerAgent.id))
      .innerJoin(dialerServers, eq(transfers.dialerServerId, dialerServers.id))
      .where(eq(transfers.id, transferId));
    if (!row) throw new NotFoundError('Transfer not found');
    companyScope(req, row.transfer.companyId);
    // the Transfers queue lists every transfer, so access to it covers any call
    // a task assigned by a manager grants access to that call regardless
    if (!(await hasActiveTask(req.auth.userId, row.transfer.id))) {
      if (!req.auth.allowedQueues?.includes('transfer')) {
        assertQueueAllowed(req.auth, row.transfer.queueStatus);
      }
      if (!(await canReviewTransfer(req.auth, row.transfer))) {
        throw new ForbiddenError("This call's agent is not assigned to you");
      }
    }

    // a sale made on a later call of the lead is shown as its own leg
    let saleCall: (typeof calls.$inferSelect & { agentName: string | null }) | null = null;
    if (row.transfer.saleCallId) {
      const [s] = await db
        .select({ call: calls, agentName: viciAgents.fullName })
        .from(calls)
        .leftJoin(viciAgents, eq(calls.viciAgentId, viciAgents.id))
        .where(eq(calls.id, row.transfer.saleCallId));
      if (s) saleCall = { ...s.call, agentName: s.agentName };
    }

    const callIds = [row.fronterCall?.id, row.closerCall?.id, saleCall?.id].filter((x): x is string => !!x);
    const recRows = await db
      .select()
      .from(recordings)
      .where(or(...callIds.map((id) => eq(recordings.callId, id))));
    const events = await db
      .select()
      .from(transferEvents)
      .where(eq(transferEvents.transferId, transferId))
      .orderBy(transferEvents.createdAt);
    const evals = await db
      .select()
      .from(evaluations)
      .where(eq(evaluations.transferId, transferId))
      .orderBy(desc(evaluations.createdAt));

    // Lead details, fetched live from the dialer by primary key through a
    // cached pool. Capped at 2.5s and always optional — the page never
    // waits on or fails because of lead info.
    let lead: Record<string, unknown> | null = null;
    const leadId = row.transfer.viciLeadId ?? row.fronterCall?.viciLeadId ?? row.closerCall?.viciLeadId ?? null;
    if (leadId != null) {
      try {
        const [dialerRow] = await db
          .select()
          .from(dialerServers)
          .where(eq(dialerServers.id, row.transfer.dialerServerId));
        const client = dialerRow ? getPooledDbClient(toConnection(dialerRow)) : null;
        if (client) {
          lead = await Promise.race([
            client.fetchLead(leadId),
            new Promise<null>((resolve) => setTimeout(() => resolve(null), 2500)),
          ]);
        }
      } catch {
        lead = null;
      }
    }

    return { ...row, saleCall, lead, recordings: recRows, events, evaluations: evals };
  });

  // Candidate closer calls for a flagged transfer, scored — for manual resolution.
  app.get('/detail/:transferId/candidates', { preHandler: [requirePermission('qa.assign')] }, async (req) => {
    const { transferId } = req.params as { transferId: string };
    const [t] = await db.select().from(transfers).where(eq(transfers.id, transferId));
    if (!t) throw new NotFoundError('Transfer not found');
    companyScope(req, t.companyId);

    const winStart = new Date(t.xferTime.getTime() - 2 * 60 * 1000);
    const winEnd = new Date(t.xferTime.getTime() + 10 * 60 * 1000);
    const rows = await db
      .select({
        call: calls,
        agentUser: viciAgents.viciUser,
        agentName: viciAgents.fullName,
        dialerName: dialerServers.name,
      })
      .from(calls)
      .leftJoin(viciAgents, eq(calls.viciAgentId, viciAgents.id))
      .innerJoin(dialerServers, eq(calls.dialerServerId, dialerServers.id))
      .where(
        and(
          eq(calls.companyId, t.companyId),
          eq(calls.source, 'vicidial_closer_log'),
          gte(calls.callDate, winStart),
          lte(calls.callDate, winEnd),
        ),
      )
      .limit(100);

    const scored = rows
      .map((r) => ({
        ...r,
        match: scoreCandidate(
          {
            dialerServerId: t.dialerServerId,
            viciLeadId: t.viciLeadId,
            phoneNumber: t.phoneNumber,
            xferTime: t.xferTime,
          },
          {
            callId: r.call.id,
            dialerServerId: r.call.dialerServerId,
            viciLeadId: r.call.viciLeadId,
            phoneNumber: r.call.phoneNumber,
            callDate: r.call.callDate,
          },
          DEFAULT_MATCH_OPTIONS,
        ),
      }))
      .sort((a, b) => b.match.score - a.match.score);
    return { candidates: scored };
  });

  // Manual match resolution for flagged/unmatched transfers.
  app.post('/detail/:transferId/resolve', { preHandler: [requirePermission('qa.assign')] }, async (req) => {
    const { transferId } = req.params as { transferId: string };
    const body = z
      .object({
        closerCallId: z.string().uuid().nullable(),
        note: z.string().max(500).optional(),
      })
      .parse(req.body);
    const [t] = await db.select().from(transfers).where(eq(transfers.id, transferId));
    if (!t) throw new NotFoundError('Transfer not found');
    companyScope(req, t.companyId);

    if (body.closerCallId) {
      const [closer] = await db.select().from(calls).where(eq(calls.id, body.closerCallId));
      if (!closer || closer.companyId !== t.companyId) {
        throw new ValidationError('Closer call not found in this company');
      }
      await db
        .update(transfers)
        .set({
          closerCallId: closer.id,
          closerLeadId: closer.viciLeadId,
          matchStatus: 'matched',
          matchMethod: 'manual',
          matchNotes: body.note ?? 'manually resolved',
          queueStatus: 'unclosed', // next sync pass applies the sale mapping
          updatedAt: new Date(),
        })
        .where(eq(transfers.id, transferId));
    } else {
      await db
        .update(transfers)
        .set({
          closerCallId: null,
          matchStatus: 'unmatched',
          matchMethod: 'manual',
          matchNotes: body.note ?? 'manually marked unmatched',
          queueStatus: 'transfer',
          updatedAt: new Date(),
        })
        .where(eq(transfers.id, transferId));
    }
    await db.insert(transferEvents).values({
      transferId,
      fromStatus: t.matchStatus,
      toStatus: body.closerCallId ? 'matched' : 'unmatched',
      reason: `manual resolution: ${body.note ?? ''}`.trim(),
      actorUserId: req.auth.userId,
    });
    await audit(req, {
      action: 'transfer.resolve_match',
      entityType: 'transfer',
      entityId: transferId,
      before: { matchStatus: t.matchStatus, closerCallId: t.closerCallId },
      after: { matchStatus: body.closerCallId ? 'matched' : 'unmatched', closerCallId: body.closerCallId },
      companyId: t.companyId,
    });
    return { ok: true };
  });
}
