import { sql, type SQL } from 'drizzle-orm';
import { db } from '../db/client.js';
import { transfers } from '../db/schema.js';
import { hasPermission } from '../auth/permissions.js';
import type { AuthContext } from '../auth/session.js';

type QueueName = 'transfer' | 'unclosed' | 'closed';

/** Managers and admins are never narrowed by reviewer assignments. */
export function isAgentScoped(auth: AuthContext): boolean {
  return auth.agentScoped && !hasPermission(auth.permissions, 'qa.forms.manage');
}

/**
 * SQL condition: one of the reviewer's agents with this method is on the
 * call. Transfer reviews the fronter, so it is the fronter leg; Unclosed and
 * Closed review the outcome, so any leg counts — a reviewer given fronters
 * with the Unclosed method gets those fronters' unclosed calls, one given
 * closers gets the closers' (before, only the closer leg was checked, so the
 * first case came up nearly empty).
 */
export function agentScopeCondition(auth: AuthContext, queue: QueueName): SQL {
  const legs =
    queue === 'transfer'
      ? sql`c.id = ${transfers.fronterCallId}`
      : sql`c.id in (${transfers.fronterCallId}, ${transfers.closerCallId}, ${transfers.saleCallId})`;
  return sql`exists (
    select 1
      from reviewer_agent_assignments a
      join calls c on c.vici_agent_id = a.vici_agent_id
     where a.reviewer_user_id = ${auth.userId}
       and ${legs}
       and a.methods @> ${JSON.stringify([queue])}::jsonb
  )`;
}

/** An open or in-progress task on this call — a manager's explicit assignment. */
export async function hasActiveTask(userId: string, transferId: string): Promise<boolean> {
  const result = await db.execute(
    sql`select 1 from qa_assignments
         where assigned_to = ${userId} and transfer_id = ${transferId}
           and status in ('open', 'in_progress') limit 1`,
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Whether an agent-scoped reviewer may open/evaluate this transfer: either
 * its fronter is theirs for 'transfer', or its closer is theirs for the
 * transfer's current queue. A task assigned by a manager always grants it.
 */
export async function canReviewTransfer(
  auth: AuthContext,
  transfer: { id: string; queueStatus: QueueName },
): Promise<boolean> {
  if (!isAgentScoped(auth)) return true;
  if (await hasActiveTask(auth.userId, transfer.id)) return true;
  const checks: QueueName[] = ['transfer'];
  if (transfer.queueStatus !== 'transfer') checks.push(transfer.queueStatus);
  const conds = checks.map((q) => agentScopeCondition(auth, q));
  const result = await db.execute(
    sql`select 1 from transfers where id = ${transfer.id} and (${sql.join(conds, sql` or `)}) limit 1`,
  );
  return (result.rowCount ?? 0) > 0;
}
