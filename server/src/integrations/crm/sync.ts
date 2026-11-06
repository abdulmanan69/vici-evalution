/**
 * QA scores → CRM.
 *
 *   pushCrmQaScores()   hourly job `crm-qa-scores` (worker.ts): each agent's
 *                       average QA score for the current and previous month
 *
 * Which CRM and key: a company with a CRM link saved from the web (Admin →
 * Connections → Outgoing links) sends its own agents with its own key; every
 * other company goes, merged as before, with CRM_URL / CRM_API_KEY. A web link
 * that is switched off leaves that company out entirely.
 *
 * Read-only on the QA side. Safe to run as often as you like: the CRM
 * replaces the value for the same agent, metric and month.
 */
import { eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { companies } from '../../db/schema.js';
import { agentScores, mergeByUser, monthStart, ym } from '../../services/agentScores.js';
import { crmClientOf, crmLinkFor } from '../links/store.js';
import { crmEnvLink, type CrmMetricItem, type CrmMetricsResult } from './client.js';

/**
 * The CRM knows agents by user only, so an agent user found in several
 * companies or dialers is one agent there: their evaluations are merged.
 * `companyIds` limits it to those companies (default: every active one).
 */
export async function buildCrmQaItems(months = 2, now = new Date(), companyIds?: string[]): Promise<CrmMetricItem[]> {
  let list = await db.select({ id: companies.id }).from(companies).where(eq(companies.status, 'active'));
  if (companyIds) list = list.filter((c) => companyIds.includes(c.id));
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

export type CrmRun = { company: string; error?: string; companies?: number } & Partial<CrmMetricsResult>;

/**
 * With no web links at all this is exactly the old job: one push with the
 * environment's key, answering a CrmMetricsResult (or { skipped }). Once a
 * company has a web link the answer is a list: one entry per web-linked
 * company and one, company 'server settings', for the rest.
 *
 * `scope.companyId` ("Push now"): only that company's push. A company on the
 * environment's key is sent together with the other such companies, so agents
 * working for several of them keep their merged score.
 */
export async function pushCrmQaScores(months = 2, scope: { companyId?: string } = {}): Promise<CrmMetricsResult | CrmRun[] | { skipped: string }> {
  const list = await db.select({ id: companies.id, slug: companies.slug }).from(companies).where(eq(companies.status, 'active'));
  const web: Array<{ id: string; slug: string; link: Awaited<ReturnType<typeof crmLinkFor>> }> = [];
  const envIds: string[] = [];
  let fresh = true;
  for (const c of list) {
    const link = await crmLinkFor(c.id, fresh);
    fresh = false;
    if (link.source === 'web') web.push({ ...c, link });
    else if (link.source === 'env') envIds.push(c.id);
  }
  const env = crmEnvLink();
  const envClient = env && envIds.length ? crmClientOf({ source: 'env', url: env.url, apiKey: env.apiKey }) : null;

  // no web links: the push as it always was
  if (web.length === 0 && !scope.companyId) {
    if (!env) return { skipped: 'CRM_URL / CRM_API_KEY not set' };
    if (!envClient) return { received: 0, saved: 0, unknown: [] };
    const items = await buildCrmQaItems(months, new Date(), envIds.length === list.length ? undefined : envIds);
    if (items.length === 0) return { received: 0, saved: 0, unknown: [] };
    return envClient.pushMetrics(items);
  }

  const out: CrmRun[] = [];
  const errors: unknown[] = [];
  let tried = 0;
  const run = async (company: string, fn: () => Promise<Partial<CrmMetricsResult> & { companies?: number }>) => {
    tried++;
    try {
      out.push({ company, ...(await fn()) });
    } catch (err) {
      errors.push(err);
      out.push({ company, error: ((err as Error)?.message ?? String(err)).slice(0, 300) });
    }
  };
  for (const w of web) {
    if (scope.companyId && w.id !== scope.companyId) continue;
    const client = crmClientOf(w.link);
    if (!client) {
      tried++;
      errors.push(new Error(`${w.slug}: ${w.link.error ?? 'no key'}`));
      out.push({ company: w.slug, error: w.link.error ?? 'No API key saved' });
      continue;
    }
    await run(w.slug, async () => {
      const items = await buildCrmQaItems(months, new Date(), [w.id]);
      return items.length ? client.pushMetrics(items) : { received: 0, saved: 0, unknown: [] };
    });
  }
  if (envClient && (!scope.companyId || envIds.includes(scope.companyId))) {
    await run('server settings', async () => {
      const items = await buildCrmQaItems(months, new Date(), envIds);
      const r = items.length ? await envClient.pushMetrics(items) : { received: 0, saved: 0, unknown: [] };
      return { ...r, companies: envIds.length };
    });
  }
  if (tried > 0 && errors.length === tried) throw errors[0];
  return out;
}
