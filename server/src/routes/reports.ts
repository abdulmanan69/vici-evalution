import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { alias } from 'drizzle-orm/pg-core';
import { and, desc, eq, gte, lte, type SQL } from 'drizzle-orm';
import { db } from '../db/client.js';
import { calls, dialerServers, evaluations, qaFormVersions, qaForms, transfers, users, viciAgents } from '../db/schema.js';
import { companyScope, requirePermission } from '../auth/plugin.js';
import { audit } from '../lib/audit.js';

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

const exportQuery = z.object({
  companyId: z.string().uuid().optional(),
  dateFrom: z.coerce.date().optional(),
  dateTo: z.coerce.date().optional(),
  queueStatus: z.enum(['transfer', 'unclosed', 'closed']).optional(),
});

export async function reportRoutes(app: FastifyInstance): Promise<void> {
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
