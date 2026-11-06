import { and, eq, gte, isNotNull, lt, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { dialerServers, evaluations, qaFormVersions, qaForms, transfers } from '../db/schema.js';
import { evaluatedAgentId, evaluationAliases } from './evaluationFilters.js';

/**
 * Monthly QA score per agent, from completed evaluations: the numbers the
 * HRMS and CRM pushes and the machine API's /scores send.
 *
 * Each evaluation counts for the agent it is ABOUT, by the same rule as the
 * QA performance report (services/evaluationFilters.ts): the explicit target
 * agent, else the leg the form reviews.
 */
export interface AgentScoreRow {
  agentId: string;
  viciUser: string;
  fullName: string | null;
  dialer: string;
  n: number;
  avg: number;
  min: number;
  max: number;
  passed: number;
}

/** First instant of a UTC month, `offset` months from now. */
export function monthStart(offset: number, now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1));
}

export const ym = (d: Date) => d.toISOString().slice(0, 7);

/** [from, to) of a 'YYYY-MM' period in UTC. */
export function periodRange(period: string): { from: Date; to: Date } {
  const [y, m] = period.split('-').map(Number);
  return { from: new Date(Date.UTC(y, m - 1, 1)), to: new Date(Date.UTC(y, m, 1)) };
}

export async function agentScores(companyId: string, from: Date, to: Date): Promise<AgentScoreRow[]> {
  const a = evaluationAliases();
  const { fc, cc, ea } = a;
  const rows = await db
    .select({
      agentId: ea.id,
      viciUser: ea.viciUser,
      fullName: ea.fullName,
      dialer: dialerServers.name,
      avg: sql<string>`avg(${evaluations.percent})`,
      n: sql<number>`count(*)::int`,
      min: sql<string>`min(${evaluations.percent})`,
      max: sql<string>`max(${evaluations.percent})`,
      passed: sql<number>`count(*) filter (where ${evaluations.passed})::int`,
    })
    .from(evaluations)
    .innerJoin(qaFormVersions, eq(evaluations.formVersionId, qaFormVersions.id))
    .innerJoin(qaForms, eq(qaFormVersions.formId, qaForms.id))
    .leftJoin(transfers, eq(evaluations.transferId, transfers.id))
    .leftJoin(fc, eq(transfers.fronterCallId, fc.id))
    .leftJoin(cc, eq(transfers.closerCallId, cc.id))
    .innerJoin(ea, eq(ea.id, evaluatedAgentId(a)))
    .innerJoin(dialerServers, eq(ea.dialerServerId, dialerServers.id))
    .where(
      and(
        eq(evaluations.companyId, companyId),
        eq(evaluations.status, 'completed'),
        isNotNull(evaluations.percent),
        gte(evaluations.completedAt, from),
        lt(evaluations.completedAt, to),
      ),
    )
    .groupBy(ea.id, ea.viciUser, ea.fullName, dialerServers.name);
  return rows.map((r) => ({
    agentId: r.agentId,
    viciUser: r.viciUser,
    fullName: r.fullName,
    dialer: r.dialer,
    n: r.n,
    avg: Number(r.avg),
    min: Number(r.min),
    max: Number(r.max),
    passed: r.passed,
  }));
}

const round1 = (v: number) => Math.round(v * 10) / 10;

/**
 * The same agent user on several dialers of one company counts as one person
 * for apps that know agents by user only (the CRM): their rows are merged,
 * weighted by evaluation count. Keys are upper-case users.
 */
export function mergeByUser(rows: AgentScoreRow[]): Map<string, { n: number; avg: number; min: number; max: number; passRate: number }> {
  const acc = new Map<string, { n: number; sum: number; min: number; max: number; passed: number }>();
  for (const r of rows) {
    const k = r.viciUser.trim().toUpperCase();
    if (!k) continue;
    const cur = acc.get(k) ?? { n: 0, sum: 0, min: Infinity, max: -Infinity, passed: 0 };
    cur.n += r.n;
    cur.sum += r.avg * r.n;
    cur.min = Math.min(cur.min, r.min);
    cur.max = Math.max(cur.max, r.max);
    cur.passed += r.passed;
    acc.set(k, cur);
  }
  const out = new Map<string, { n: number; avg: number; min: number; max: number; passRate: number }>();
  for (const [k, v] of acc) {
    if (v.n === 0) continue;
    out.set(k, { n: v.n, avg: round1(v.sum / v.n), min: v.min, max: v.max, passRate: round1((v.passed / v.n) * 100) });
  }
  return out;
}
