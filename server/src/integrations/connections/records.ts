/**
 * The transfer and evaluation records other apps see, through the machine
 * API and in webhook payloads. One query each, so both always agree.
 */
import { sql, type SQL } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { evaluatedAgentId, evaluationAliases } from '../../services/evaluationFilters.js';

/** full-precision UTC text of a timestamp column, for cursors */
export const cursorText = (col: SQL) => sql`to_char(${col} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

const iso = (v: unknown): string | null => (v == null ? null : v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString());
const num = (v: unknown): number | null => (v == null ? null : Number(v));

export interface TransferRecord {
  id: string;
  company: string;
  kind: string;
  queue_status: string;
  xfer_time: string | null;
  closed_at: string | null;
  updated_at: string | null;
  dialer: string;
  phone?: string | null;
  vici_lead_id: number | null;
  fronter_user: string | null;
  closer_user: string | null;
  sale_disposition: string | null;
  match_status: string;
}

/**
 * Transfers matching `where` (SQL over alias `t`), ordered by `order`.
 * The fronter is the agent who dispositioned the XFER, the closer the agent
 * on the sale call (else the closer leg), as in the HRMS sales push.
 */
export async function selectTransfers(where: SQL, order: SQL, limit: number, opts: { pii: boolean }): Promise<Array<TransferRecord & { _cursor: string }>> {
  const r = await db.execute(sql`
    select t.id, co.slug as company, t.kind, t.queue_status, t.xfer_time, t.closed_at, t.updated_at,
           ${cursorText(sql`t.updated_at`)} as cursor_at,
           d.name as dialer, t.phone_number, t.vici_lead_id,
           coalesce(ad.vici_user, fa.vici_user, nullif(fc.vici_user_raw, '')) as fronter_user,
           coalesce(sa.vici_user, nullif(sc.vici_user_raw, ''), ca.vici_user, nullif(cc.vici_user_raw, '')) as closer_user,
           t.sale_disposition, t.match_status
      from transfers t
      join companies co on co.id = t.company_id
      join dialer_servers d on d.id = t.dialer_server_id
      left join calls fc on fc.id = t.fronter_call_id
      left join vici_agents fa on fa.id = fc.vici_agent_id
      left join calls cc on cc.id = t.closer_call_id
      left join vici_agents ca on ca.id = cc.vici_agent_id
      left join calls sc on sc.id = t.sale_call_id
      left join vici_agents sa on sa.id = sc.vici_agent_id
      left join agent_dispositions ad on ad.dialer_server_id = t.dialer_server_id and ad.agent_log_id = t.agent_log_id
     where not t.is_mock and ${where}
     order by ${order}
     limit ${limit}`);
  return (r.rows as Array<Record<string, unknown>>).map((x) => ({
    id: String(x.id),
    company: String(x.company),
    kind: String(x.kind),
    queue_status: String(x.queue_status),
    xfer_time: iso(x.xfer_time),
    closed_at: iso(x.closed_at),
    updated_at: iso(x.updated_at),
    dialer: String(x.dialer),
    ...(opts.pii ? { phone: (x.phone_number as string | null) ?? null } : {}),
    vici_lead_id: num(x.vici_lead_id),
    fronter_user: (x.fronter_user as string | null) ?? null,
    closer_user: (x.closer_user as string | null) ?? null,
    sale_disposition: (x.sale_disposition as string | null) ?? null,
    match_status: String(x.match_status),
    _cursor: String(x.cursor_at),
  }));
}

export interface EvaluationRecord {
  id: string;
  company: string;
  transfer_id: string | null;
  agent: string | null;
  agent_name: string | null;
  dialer: string | null;
  form: string;
  form_target: string;
  score: number | null;
  max_score: number | null;
  percent: number | null;
  passed: boolean | null;
  auto_failed: boolean;
  completed_at: string | null;
  updated_at: string | null;
  reviewer: string;
}

/**
 * Completed evaluations matching `where` (SQL over `evaluations`). The agent
 * is the one the evaluation is about, by the QA performance report's rule
 * (services/evaluationFilters.ts).
 */
export async function selectEvaluations(where: SQL, order: SQL, limit: number): Promise<Array<EvaluationRecord & { _cursor: string }>> {
  const a = evaluationAliases();
  const r = await db.execute(sql`
    select evaluations.id, co.slug as company, evaluations.transfer_id,
           ea.vici_user as agent, ea.full_name as agent_name, ed.name as dialer,
           qa_forms.name as form, qa_forms.target as form_target,
           evaluations.score, evaluations.max_score, evaluations.percent, evaluations.passed, evaluations.auto_failed,
           evaluations.completed_at, evaluations.updated_at,
           ${cursorText(sql`evaluations.completed_at`)} as cursor_at,
           u.name as reviewer
      from evaluations
      join companies co on co.id = evaluations.company_id
      join users u on u.id = evaluations.reviewer_id
      join qa_form_versions v on v.id = evaluations.form_version_id
      join qa_forms on qa_forms.id = v.form_id
      left join transfers t on t.id = evaluations.transfer_id
      left join calls fc on fc.id = t.fronter_call_id
      left join calls cc on cc.id = t.closer_call_id
      left join vici_agents ea on ea.id = ${evaluatedAgentId(a)}
      left join dialer_servers ed on ed.id = ea.dialer_server_id
     where evaluations.status = 'completed' and evaluations.completed_at is not null and ${where}
     order by ${order}
     limit ${limit}`);
  return (r.rows as Array<Record<string, unknown>>).map((x) => ({
    id: String(x.id),
    company: String(x.company),
    transfer_id: (x.transfer_id as string | null) ?? null,
    agent: (x.agent as string | null) ?? null,
    agent_name: (x.agent_name as string | null) ?? null,
    dialer: (x.dialer as string | null) ?? null,
    form: String(x.form),
    form_target: String(x.form_target),
    score: num(x.score),
    max_score: num(x.max_score),
    percent: num(x.percent),
    passed: (x.passed as boolean | null) ?? null,
    auto_failed: !!x.auto_failed,
    completed_at: iso(x.completed_at),
    updated_at: iso(x.updated_at),
    reviewer: String(x.reviewer),
    _cursor: String(x.cursor_at),
  }));
}

/** Drops the internal cursor field before a record leaves the platform. */
export function publicRecord<T extends { _cursor: string }>(r: T): Omit<T, '_cursor'> {
  const { _cursor, ...rest } = r;
  void _cursor;
  return rest;
}
