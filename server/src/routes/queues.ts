import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { alias } from 'drizzle-orm/pg-core';
import { and, count, desc, eq, gte, ilike, lte, or, sql, type SQL } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  calls,
  campaigns,
  dialerServers,
  evaluations,
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
import { findFronterOnLead, recordingBundle, toRecordingRows } from '../services/callRecordings.js';

/** A reviewer limited to certain forms only reaches the matching queues. */
function assertQueueAllowed(auth: AuthContext, queue: string): void {
  if (!auth.allowedQueues || hasPermission(auth.permissions, 'qa.forms.manage')) return;
  if (!auth.allowedQueues.includes(queue as 'transfer' | 'unclosed' | 'closed')) {
    throw new ForbiddenError('This queue is not assigned to you');
  }
}

/**
 * Who may open a call: the Transfers queue lists every transfer, so access
 * to it covers any call; a task assigned by a manager grants access regardless.
 */
async function assertTransferAccess(req: FastifyRequest, transfer: typeof transfers.$inferSelect): Promise<void> {
  companyScope(req, transfer.companyId);
  if (await hasActiveTask(req.auth.userId, transfer.id)) return;
  if (!req.auth.allowedQueues?.includes('transfer')) assertQueueAllowed(req.auth, transfer.queueStatus);
  if (!(await canReviewTransfer(req.auth, transfer))) {
    throw new ForbiddenError("This call's agent is not assigned to you");
  }
}

type LeadFields = Record<string, unknown> | null;

/**
 * Lead details, fetched live from the dialer by primary key through a cached
 * pool. Capped at 2.5 s and always optional — a page never waits on or fails
 * because of lead info. Dialer-local timestamps become ISO (UTC) so the UI
 * shows them in the viewer's chosen zone; the list's name and campaign ride
 * along as list_name / list_campaign.
 */
async function loadLeadInfo(dialerServerId: string, leadId: number | null): Promise<{ lead: LeadFields; leadCustom: LeadFields }> {
  const empty = { lead: null, leadCustom: null };
  if (leadId == null) return empty;
  try {
    const [dialerRow] = await db.select().from(dialerServers).where(eq(dialerServers.id, dialerServerId));
    if (!dialerRow) return empty;
    const conn = toConnection(dialerRow);
    const client = getPooledDbClient(conn);
    if (!client) return empty;
    const info = await Promise.race([
      client.fetchLead(leadId),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 2500)),
    ]);
    if (!info) return empty;
    const toIso = (rec: Record<string, unknown>) => {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(rec)) {
        out[k] =
          typeof v === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(v) && !v.startsWith('0000')
            ? localToUtc(v, conn.timezone).toISOString()
            : v;
      }
      return out;
    };
    return {
      lead: {
        ...toIso(info.lead),
        list_name: info.list?.list_name ?? null,
        list_campaign: info.list?.campaign_id ?? null,
        list_active: info.list?.active ?? null,
      },
      leadCustom: info.custom ? toIso(info.custom) : null,
    };
  } catch {
    return empty;
  }
}

const fronterCall = alias(calls, 'fronter_call');
const closerCall = alias(calls, 'closer_call');
const saleCallLeg = alias(calls, 'sale_call');
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
    await assertTransferAccess(req, row.transfer);

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

    const leadId = row.transfer.viciLeadId ?? row.fronterCall?.viciLeadId ?? row.closerCall?.viciLeadId ?? null;
    let fronterFromLead = false;
    if (!row.fronterCall && leadId != null) {
      const f = await findFronterOnLead(row.transfer, leadId);
      if (f) {
        row.fronterCall = f.call;
        row.fronterAgentUser = f.agentUser;
        row.fronterAgentName = f.agentName;
        fronterFromLead = true;
      }
    }
    // the snapshot for the first paint — the page then follows the live
    // endpoint below, which re-checks the dialer
    const bundle = await recordingBundle(row.transfer, {
      fronter: row.fronterCall,
      closer: row.closerCall,
      sale: saleCall,
    });
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

    const { lead, leadCustom } = await loadLeadInfo(row.transfer.dialerServerId, leadId);

    return {
      ...row,
      fronterFromLead,
      saleCall,
      lead,
      leadCustom,
      ...toRecordingRows(bundle),
      legs: bundle.legs,
      live: bundle.live,
      events,
      evaluations: evals,
    };
  });

  // Live recordings for a call: re-checked against the dialer on every
  // request (a throttled lead lookup plus HEAD probes, capped at 2.5 s). The
  // page polls this while a call is up or a file is still being prepared, so
  // recordings show up without a refresh and without waiting for a sync cycle.
  const liveRecordings = async (req: FastifyRequest, transferId: string, force: boolean) => {
    const [row] = await db
      .select({ transfer: transfers, fronterCall, closerCall, saleCall: saleCallLeg, dialer: dialerServers })
      .from(transfers)
      .leftJoin(fronterCall, eq(transfers.fronterCallId, fronterCall.id))
      .leftJoin(closerCall, eq(transfers.closerCallId, closerCall.id))
      .leftJoin(saleCallLeg, eq(transfers.saleCallId, saleCallLeg.id))
      .innerJoin(dialerServers, eq(transfers.dialerServerId, dialerServers.id))
      .where(eq(transfers.id, transferId));
    if (!row) throw new NotFoundError('Transfer not found');
    await assertTransferAccess(req, row.transfer);

    let fronter = row.fronterCall;
    let fronterFromLead = false;
    const leadId = row.transfer.viciLeadId ?? fronter?.viciLeadId ?? row.closerCall?.viciLeadId ?? null;
    if (!fronter && leadId != null) {
      const f = await findFronterOnLead(row.transfer, leadId);
      if (f) {
        fronter = f.call;
        fronterFromLead = true;
      }
    }
    const bundle = await recordingBundle(
      row.transfer,
      { fronter, closer: row.closerCall, sale: row.saleCall },
      { refresh: !row.transfer.isMock, force, conn: toConnection(row.dialer) },
    );
    return { ...bundle, fronterFromLead };
  };
  app.get('/detail/:transferId/recordings', { preHandler: [requirePermission('calls.view')] }, async (req) => {
    const { transferId } = req.params as { transferId: string };
    return liveRecordings(req, transferId, false);
  });
  // Lead details for the evaluation page — same access rules as the call
  app.get('/detail/:transferId/lead', { preHandler: [requirePermission('calls.view')] }, async (req) => {
    const { transferId } = req.params as { transferId: string };
    const [t] = await db.select().from(transfers).where(eq(transfers.id, transferId));
    if (!t) throw new NotFoundError('Transfer not found');
    await assertTransferAccess(req, t);
    let leadId = t.viciLeadId;
    const legId = t.fronterCallId ?? t.closerCallId ?? t.saleCallId;
    if (leadId == null && legId) {
      const [c] = await db.select({ leadId: calls.viciLeadId }).from(calls).where(eq(calls.id, legId));
      leadId = c?.leadId ?? null;
    }
    return loadLeadInfo(t.dialerServerId, leadId);
  });

  // "Fetch from dialer": a reviewer's explicit retry — ignores the throttles,
  // re-asks the dialer for the lead and re-probes every file, missing ones too
  app.post('/detail/:transferId/recordings/fetch', { preHandler: [requirePermission('calls.view')] }, async (req) => {
    const { transferId } = req.params as { transferId: string };
    const before = await liveRecordings(req, transferId, false);
    const after = await liveRecordings(req, transferId, true);
    const playableBefore = before.items.filter((i) => i.status === 'available').length;
    const playableAfter = after.items.filter((i) => i.status === 'available').length;
    return { ...after, found: Math.max(0, playableAfter - playableBefore) };
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
