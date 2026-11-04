import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { alias } from 'drizzle-orm/pg-core';
import { and, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { db } from '../db/client.js';
import { calls, dialerServers, evaluations, qaForms, viciAgents } from '../db/schema.js';
import { hasPermission } from '../auth/permissions.js';
import { localToUtc } from '../vicidial/timezone.js';

/**
 * One definition of "which evaluations" and "whose evaluation", shared by
 * the Evaluations page, its CSV export and the QA performance report — so
 * the export holds exactly the rows on screen and the report's counts open
 * onto the same rows.
 *
 * The evaluated agent is the agent the evaluation is ABOUT: an explicit
 * target agent, else the leg the form reviews (fronter forms → fronter,
 * closer forms → closer, 'any' → closer, or the fronter without a closer).
 * Filtering by agent matches only that agent — never the other person on
 * the call, whose own evaluations of the same transfer are theirs.
 */

export const evaluationFilterSchema = z.object({
  companyId: z.string().uuid().optional(),
  status: z.enum(['draft', 'completed']).optional(),
  reviewerId: z.string().uuid().optional(),
  transferId: z.string().uuid().optional(),
  formId: z.string().uuid().optional(),
  result: z.enum(['pass', 'fail', 'auto_fail']).optional(),
  /** search: the evaluated agent's name or user id contains this */
  agent: z.string().max(60).optional(),
  /** exactly this evaluated agent (report drill-downs) */
  agentId: z.string().uuid().optional(),
  /** YYYY-MM-DD = dialer-local day */
  dateFrom: z.string().max(40).optional(),
  dateTo: z.string().max(40).optional(),
  /** reviewers: only my own evaluations */
  mine: z
    .enum(['true', 'false', '1', '0'])
    .optional()
    .transform((v) => v === 'true' || v === '1'),
});

export type EvaluationFilters = z.infer<typeof evaluationFilterSchema>;

/** The joined tables every evaluation listing uses (aliases are SQL names). */
export function evaluationAliases() {
  return {
    fc: alias(calls, 'fc'),
    cc: alias(calls, 'cc'),
    fa: alias(viciAgents, 'fa'),
    ca: alias(viciAgents, 'ca'),
    /** the evaluated agent — join with `eq(ea.id, evaluatedAgentId(a))` */
    ea: alias(viciAgents, 'ea'),
  };
}

export type EvaluationAliases = ReturnType<typeof evaluationAliases>;

/** SQL: the id of the agent the evaluation is about (see the rule above). */
export function evaluatedAgentId(a: Pick<EvaluationAliases, 'fc' | 'cc'>): SQL {
  return sql`coalesce(${evaluations.targetAgentId}, case
    when ${qaForms.target} = 'fronter' then ${a.fc.viciAgentId}
    when ${qaForms.target} = 'closer' then ${a.cc.viciAgentId}
    else coalesce(${a.cc.viciAgentId}, ${a.fc.viciAgentId}) end)`;
}

/** The time zone dialer-day filters are read in: the company's dialer's. */
export async function filterTimezone(scope: string | undefined): Promise<string> {
  const [dialerRow] = await db
    .select({ timezone: dialerServers.timezone })
    .from(dialerServers)
    .where(scope ? eq(dialerServers.companyId, scope) : eq(dialerServers.active, true))
    .limit(1);
  return dialerRow?.timezone ?? 'UTC';
}

/**
 * WHERE conditions for a filtered evaluation listing. The query must join
 * qa_forms and the `ea` alias (the evaluated agent) of evaluationAliases().
 */
export function evaluationWhere(
  req: FastifyRequest,
  q: EvaluationFilters,
  a: Pick<EvaluationAliases, 'ea'>,
  scope: string | undefined,
  tz: string,
): SQL[] {
  const where: SQL[] = [];
  if (scope) where.push(eq(evaluations.companyId, scope));
  if (q.status) where.push(eq(evaluations.status, q.status));
  if (q.mine) where.push(eq(evaluations.reviewerId, req.auth.userId));
  else if (q.reviewerId) where.push(eq(evaluations.reviewerId, q.reviewerId));
  if (q.transferId) where.push(eq(evaluations.transferId, q.transferId));
  if (q.formId) where.push(eq(qaForms.id, q.formId));
  if (q.result === 'pass') where.push(eq(evaluations.passed, true));
  if (q.result === 'fail') where.push(and(eq(evaluations.passed, false), eq(evaluations.autoFailed, false))!);
  if (q.result === 'auto_fail') where.push(eq(evaluations.autoFailed, true));
  // a restricted reviewer only ever sees their assigned methods
  if (req.auth.allowedFormIds && !hasPermission(req.auth.permissions, 'qa.forms.manage')) {
    where.push(inArray(qaForms.id, req.auth.allowedFormIds));
  }
  if (q.agentId) where.push(eq(a.ea.id, q.agentId));
  if (q.agent?.trim()) {
    const pat = `%${q.agent.trim()}%`;
    where.push(sql`(${a.ea.fullName} ilike ${pat} or ${a.ea.viciUser} ilike ${pat})`);
  }
  // plain dates mean the dialer's day, like everywhere else
  const evDate = sql`coalesce(${evaluations.completedAt}, ${evaluations.createdAt})`;
  const parseDay = (v: string, end: boolean): Date =>
    /^\d{4}-\d{2}-\d{2}$/.test(v) ? localToUtc(`${v} ${end ? '23:59:59' : '00:00:00'}`, tz) : new Date(v);
  if (q.dateFrom) where.push(sql`${evDate} >= ${parseDay(q.dateFrom, false)}`);
  if (q.dateTo) where.push(sql`${evDate} <= ${parseDay(q.dateTo, true)}`);
  return where;
}
