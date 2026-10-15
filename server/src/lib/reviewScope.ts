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
 * SQL condition: the transfer's evaluated leg belongs to one of the
 * reviewer's agents with this method — fronter leg for 'transfer', closer
 * leg for 'unclosed' and 'closed'.
 */
export function agentScopeCondition(auth: AuthContext, queue: QueueName): SQL {
  const leg = queue === 'transfer' ? transfers.fronterCallId : transfers.closerCallId;
  return sql`exists (
    select 1
      from reviewer_agent_assignments a
      join calls c on c.vici_agent_id = a.vici_agent_id
     where a.reviewer_user_id = ${auth.userId}
       and c.id = ${leg}
       and a.methods @> ${JSON.stringify([queue])}::jsonb
  )`;
}

/**
 * Whether an agent-scoped reviewer may open/evaluate this transfer: either
 * its fronter is theirs for 'transfer', or its closer is theirs for the
 * transfer's current queue.
 */
export async function canReviewTransfer(
  auth: AuthContext,
  transfer: { id: string; queueStatus: QueueName },
): Promise<boolean> {
  if (!isAgentScoped(auth)) return true;
  const checks: QueueName[] = ['transfer'];
  if (transfer.queueStatus !== 'transfer') checks.push(transfer.queueStatus);
  const conds = checks.map((q) => agentScopeCondition(auth, q));
  const result = await db.execute(
    sql`select 1 from transfers where id = ${transfer.id} and (${sql.join(conds, sql` or `)}) limit 1`,
  );
  return (result.rowCount ?? 0) > 0;
}
