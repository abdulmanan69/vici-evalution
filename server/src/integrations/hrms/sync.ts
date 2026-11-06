/**
 * Jobs that keep the VICIdial QA platform and WaveTech HRMS in step.
 *
 *   pushQaScores()   monthly average QA score per agent → HRMS (metric qa_score, %)
 *   pushSales()      closed sales, credited to closer and fronter → HRMS sales incentive
 *   employeesFor()   HRMS employee details for a company's agents, cached 5 min
 *
 * Both are read-only on the QA side: nothing in the QA database is changed.
 */
import { and, eq, gte, inArray, isNotNull, lt, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { alias } from 'drizzle-orm/pg-core';
import { agentDispositions, calls, companies, dialerServers, evaluations, transfers, viciAgents } from '../../db/schema.js';
import { hrmsFor, type HrmsPerson, type MetricItem, type SaleItem, type SalesResult } from './client.js';

/** 'dialer' = HRMS links tell apart equal user names by dialer name (HRMS_CONTEXT=dialer). */
const useDialerContext = () => process.env.HRMS_CONTEXT === 'dialer';

function monthStart(offset: number): Date {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + offset, 1));
}
const ym = (d: Date) => d.toISOString().slice(0, 7);

/**
 * Sends each agent's average QA score for the current and previous month to
 * the HRMS. Safe to run as often as you like: HRMS replaces the value for the
 * same agent and month. Returns what was sent per company.
 */
export async function pushQaScores(months = 2): Promise<Array<{ company: string; saved: number; unknown: string[] }>> {
  const result: Array<{ company: string; saved: number; unknown: string[] }> = [];
  const list = await db.select({ id: companies.id, slug: companies.slug }).from(companies).where(eq(companies.status, 'active'));
  for (const c of list) {
    const hrms = hrmsFor(c.slug);
    if (!hrms) continue;
    const items: MetricItem[] = [];
    for (let m = 0; m < months; m++) {
      const from = monthStart(-m);
      const to = monthStart(-m + 1);
      const rows = await db
        .select({
          viciUser: viciAgents.viciUser,
          dialer: dialerServers.name,
          avg: sql<string>`avg(${evaluations.percent})`,
          n: sql<number>`count(*)::int`,
          min: sql<string>`min(${evaluations.percent})`,
          max: sql<string>`max(${evaluations.percent})`,
        })
        .from(evaluations)
        .innerJoin(viciAgents, eq(evaluations.targetAgentId, viciAgents.id))
        .innerJoin(dialerServers, eq(viciAgents.dialerServerId, dialerServers.id))
        .where(
          and(
            eq(evaluations.companyId, c.id),
            eq(evaluations.status, 'completed'),
            isNotNull(evaluations.percent),
            gte(evaluations.completedAt, from),
            lt(evaluations.completedAt, to),
          ),
        )
        .groupBy(viciAgents.viciUser, dialerServers.name);
      for (const r of rows) {
        items.push({
          externalId: r.viciUser,
          context: useDialerContext() ? r.dialer : '',
          metric: 'qa_score',
          period: ym(from),
          value: Math.round(Number(r.avg) * 10) / 10,
          unit: '%',
          details: { evaluations: r.n, lowest: Number(r.min), highest: Number(r.max), dialer: r.dialer },
        });
      }
    }
    if (items.length === 0) continue;
    const r = await hrms.pushMetrics(items);
    result.push({ company: c.slug, ...r });
  }
  return result;
}

/** The HR calendar: a sale counts on its date in this time zone (HRMS_TZ, default Asia/Karachi). */
const hrTz = () => process.env.HRMS_TZ || 'Asia/Karachi';
const localDate = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: hrTz() }).format(d);
const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/**
 * Sends every closed sale from the first day of last month until today to the
 * HRMS, credited to the closer (the agent on the sale call) and the fronter
 * (the agent who dispositioned the XFER). HRMS pays the sales incentive from
 * these. Safe to run as often as you like: each run replaces the window, so a
 * sale that is no longer closed here is voided in HRMS. Months whose HRMS
 * payroll is approved are left alone by HRMS.
 */
export async function pushSales(): Promise<Array<{ company: string } & SalesResult>> {
  const result: Array<{ company: string } & SalesResult> = [];
  const today = localDate(new Date());
  const from = `${addDays(`${today.slice(0, 7)}-01`, -1).slice(0, 7)}-01`;
  // a day's margin either side in UTC; the exact HR date is filtered below
  const fromUtc = new Date(Date.parse(`${from}T00:00:00Z`) - 86_400_000);
  const list = await db.select({ id: companies.id, slug: companies.slug }).from(companies).where(eq(companies.status, 'active'));
  const closerCall = alias(calls, 'hrms_cc');
  const fronterCall = alias(calls, 'hrms_fc');
  for (const c of list) {
    const hrms = hrmsFor(c.slug);
    if (!hrms) continue;
    const saleDay = sql<string>`to_char(${closerCall.callDate} at time zone ${hrTz()}, 'YYYY-MM-DD')`;
    const rows = await db
      .select({
        ref: transfers.id,
        saleDate: saleDay,
        closer: closerCall.viciUserRaw,
        fronter: sql<string | null>`coalesce(${agentDispositions.viciUser}, ${fronterCall.viciUserRaw})`,
        lead: transfers.viciLeadId,
        dialer: dialerServers.name,
      })
      .from(transfers)
      .innerJoin(closerCall, sql`${closerCall.id} = coalesce(${transfers.saleCallId}, ${transfers.closerCallId})`)
      .innerJoin(dialerServers, eq(transfers.dialerServerId, dialerServers.id))
      .leftJoin(fronterCall, eq(transfers.fronterCallId, fronterCall.id))
      .leftJoin(agentDispositions, and(eq(agentDispositions.dialerServerId, transfers.dialerServerId), eq(agentDispositions.agentLogId, transfers.agentLogId)))
      .where(and(eq(transfers.companyId, c.id), eq(transfers.isMock, false), eq(transfers.queueStatus, 'closed'), gte(closerCall.callDate, fromUtc)));

    // one HRMS context per dialer when equal user names exist on several dialers
    const byContext = new Map<string, Array<SaleItem>>();
    for (const r of rows) {
      if (r.saleDate < from || r.saleDate > today || (!r.closer && !r.fronter)) continue;
      const ctx = useDialerContext() ? r.dialer : '';
      const items = byContext.get(ctx) ?? [];
      items.push({
        externalRef: r.ref,
        saleDate: r.saleDate,
        ...(r.closer ? { closer: r.closer } : {}),
        ...(r.fronter && r.fronter !== r.closer ? { fronter: r.fronter } : {}),
        reference: r.lead ? `Lead ${r.lead}` : null,
      });
      byContext.set(ctx, items);
    }
    if (!useDialerContext() && !byContext.has('')) byContext.set('', []);

    const total: SalesResult = { received: 0, inserted: 0, updated: 0, unchanged: 0, voided: 0, locked: 0, unknown: [] };
    for (const [ctx, items] of byContext) {
      // whole days per request, at most 2,000 sales each; the windows cover every day
      items.sort((a, b) => (a.saleDate < b.saleDate ? -1 : 1));
      let start = from;
      let batch: SaleItem[] = [];
      const flush = async (to: string) => {
        const r = await hrms.pushSales(batch, { from: start, to }, ctx);
        for (const k of ['received', 'inserted', 'updated', 'unchanged', 'voided', 'locked'] as const) total[k] += r[k];
        total.unknown.push(...r.unknown);
        batch = [];
        start = addDays(to, 1);
      };
      let i = 0;
      for (let day = from; day <= today; day = addDays(day, 1)) {
        const dayItems: SaleItem[] = [];
        while (i < items.length && items[i].saleDate === day) dayItems.push(items[i++]);
        if (batch.length && batch.length + dayItems.length > 2000) await flush(addDays(day, -1));
        batch.push(...dayItems);
      }
      await flush(today);
    }
    total.unknown = [...new Set(total.unknown)];
    result.push({ company: c.slug, ...total });
  }
  return result;
}

const cache = new Map<string, { at: number; people: Map<string, HrmsPerson> }>();
const CACHE_MS = 5 * 60_000;

/** Forget cached HRMS details for a company (call when an HRMS webhook arrives). */
export function forgetHrmsCache(companyId?: string): void {
  if (companyId) cache.delete(companyId);
  else cache.clear();
}

/**
 * HRMS details for the agents of one QA company, keyed by agent user:
 * real name, SIP ID, department, team lead, active or left, on leave today.
 * Returns an empty map when HRMS is not configured for the company.
 */
export async function employeesFor(companyId: string, agentUsers?: string[]): Promise<Map<string, HrmsPerson>> {
  const [c] = await db.select({ slug: companies.slug }).from(companies).where(eq(companies.id, companyId));
  const hrms = c ? hrmsFor(c.slug) : null;
  if (!hrms) return new Map();
  const hit = cache.get(companyId);
  if (hit && Date.now() - hit.at < CACHE_MS && (!agentUsers || agentUsers.every((u) => hit.people.has(u)))) return hit.people;

  const users =
    agentUsers ??
    (await db.select({ u: viciAgents.viciUser }).from(viciAgents).where(and(eq(viciAgents.companyId, companyId), eq(viciAgents.active, true)))).map((r) => r.u);
  const people = await hrms.people(users);
  const merged = new Map([...(hit?.people ?? []), ...people]);
  cache.set(companyId, { at: Date.now(), people: merged });
  return merged;
}

/** QA agent ids whose linked employee has left, or is on leave today. Useful to skip them when assigning QA tasks. */
export async function unavailableAgents(companyId: string): Promise<{ left: string[]; onLeave: string[] }> {
  const people = await employeesFor(companyId);
  const left: string[] = [];
  const onLeave: string[] = [];
  for (const [user, p] of people) {
    if (!p.found) continue;
    if (p.employee.status === 'inactive') left.push(user);
    else if (p.employee.onLeaveToday) onLeave.push(user);
  }
  if (!left.length && !onLeave.length) return { left: [], onLeave: [] };
  const ids = await db
    .select({ id: viciAgents.id, u: viciAgents.viciUser })
    .from(viciAgents)
    .where(and(eq(viciAgents.companyId, companyId), inArray(viciAgents.viciUser, [...left, ...onLeave])));
  return {
    left: ids.filter((r) => left.includes(r.u)).map((r) => r.id),
    onLeave: ids.filter((r) => onLeave.includes(r.u)).map((r) => r.id),
  };
}
