/**
 * QA scores → CRM.
 *
 *   pushCrmQaScores()   hourly job `crm-qa-scores` (worker.ts): each agent's
 *                       average QA score for the current and previous month
 *
 * Read-only on the QA side. Safe to run as often as you like: the CRM
 * replaces the value for the same agent, metric and month.
 */
import { eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { companies } from '../../db/schema.js';
import { agentScores, mergeByUser, monthStart, ym } from '../../services/agentScores.js';
import { crmClient, type CrmMetricItem, type CrmMetricsResult } from './client.js';

/**
 * The CRM knows agents by user only, so an agent user found in several
 * companies or dialers is one agent there: their evaluations are merged.
 */
export async function buildCrmQaItems(months = 2, now = new Date()): Promise<CrmMetricItem[]> {
  const list = await db.select({ id: companies.id }).from(companies).where(eq(companies.status, 'active'));
  const items: CrmMetricItem[] = [];
  for (let m = 0; m < months; m++) {
    const from = monthStart(-m, now);
    const to = monthStart(-m + 1, now);
    const rows = [];
    for (const c of list) rows.push(...(await agentScores(c.id, from, to)));
    for (const [agent, s] of mergeByUser(rows)) {
      items.push({
        agent,
        metric: 'qa_score',
        period: ym(from),
        value: s.avg,
        unit: '%',
        details: { count: s.n, min: s.min, max: s.max, passRate: s.passRate },
      });
    }
  }
  return items;
}

export async function pushCrmQaScores(months = 2): Promise<CrmMetricsResult | { skipped: string }> {
  const crm = crmClient();
  if (!crm) return { skipped: 'CRM_URL / CRM_API_KEY not set' };
  const items = await buildCrmQaItems(months);
  if (items.length === 0) return { received: 0, saved: 0, unknown: [] };
  return crm.pushMetrics(items);
}
