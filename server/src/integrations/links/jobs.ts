/**
 * The hourly push jobs behind each outgoing link, shared by the worker (which
 * runs them) and the API ("Push now" queues them for one company).
 *
 * Server-wide switches stay in the environment and apply to web links too:
 *   HRMS_PUSH_SALES=true        dialer sales → HRMS (off by default)
 *   HRMS_PUSH_ATTENDANCE=false  turns dialer attendance → HRMS off
 */
import { getMaintenanceQueue } from '../../lib/queue.js';
import type { LinkKind } from './resolve.js';

export const LINK_JOBS: Record<LinkKind, string[]> = {
  hrms: ['hrms-qa-scores', 'hrms-attendance', 'hrms-sales'],
  crm: ['crm-qa-scores'],
};

/** Is this job switched on for the whole server? */
export function jobSwitchedOn(name: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (name === 'hrms-sales') return env.HRMS_PUSH_SALES === 'true';
  if (name === 'hrms-attendance') return env.HRMS_PUSH_ATTENDANCE !== 'false';
  return true;
}

/** Does the environment set up this link (for at least the companies it names)? Same test as before web links. */
export function envSetsUp(kind: LinkKind, env: NodeJS.ProcessEnv = process.env): boolean {
  if (kind === 'hrms') return !!env.HRMS_URL;
  return !!env.CRM_URL?.trim() && !!env.CRM_API_KEY?.trim();
}

export const kindOf = (job: string): LinkKind => (job.startsWith('crm-') ? 'crm' : 'hrms');

/** Where a one-company run records its result: job:<name>@<companyId>. */
export const companyJobName = (job: string, companyId: string) => `${job}@${companyId}`;

/** Queues this link's switched-on jobs for one company now. Returns the job names. */
export async function enqueueLinkPush(kind: LinkKind, companyId: string): Promise<string[]> {
  const names = LINK_JOBS[kind].filter((n) => jobSwitchedOn(n));
  const q = getMaintenanceQueue();
  for (const name of names) {
    await q.add(
      name,
      { companyId },
      // one queued run per company and job; removed when done so the next click queues again
      { jobId: `push-${name}-${companyId}`, removeOnComplete: true, removeOnFail: true, attempts: 1 },
    );
  }
  return names;
}
