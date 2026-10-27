import { eq, sql, type SQL } from 'drizzle-orm';
import { db } from '../db/client.js';
import { companies, dialerServers } from '../db/schema.js';

/**
 * Deleting a dialer or a company. A dialer can hold hundreds of thousands of
 * calls, and every deleted call fires several foreign-key checks, so one big
 * DELETE ran for minutes while holding locks the sync needs. Instead the API
 * only marks the row (it stops syncing and disappears from pickers at once)
 * and the worker removes the data here in short batches, then the row.
 * Every step is idempotent, so an interrupted purge simply runs again.
 */

const BATCH = 5_000;

export interface DialerUsage {
  calls: number;
  recordings: number;
  transfers: number;
  evaluations: number;
  agents: number;
}

export interface CompanyUsage extends DialerUsage {
  dialers: number;
  users: number;
  forms: number;
}

const n = (v: unknown): number => Number(v ?? 0);

/** Evaluations that belong to a dialer: its calls, transfers or agents. */
function dialerEvaluations(dialerId: string): SQL {
  return sql`(e.transfer_id in (select id from transfers where dialer_server_id = ${dialerId})
           or e.target_agent_id in (select id from vici_agents where dialer_server_id = ${dialerId})
           or e.call_id in (select id from calls where dialer_server_id = ${dialerId}))`;
}

/** What deleting a dialer removes — shown in the confirmation dialog. */
export async function dialerUsage(dialerId: string): Promise<DialerUsage> {
  const r = await db.execute(sql`
    select (select count(*) from calls where dialer_server_id = ${dialerId}) as calls,
           (select count(*) from recordings where dialer_server_id = ${dialerId}) as recordings,
           (select count(*) from transfers where dialer_server_id = ${dialerId}) as transfers,
           (select count(*) from evaluations e where ${dialerEvaluations(dialerId)}) as evaluations,
           (select count(*) from vici_agents where dialer_server_id = ${dialerId}) as agents`);
  const row = (r.rows[0] ?? {}) as Record<string, unknown>;
  return {
    calls: n(row.calls),
    recordings: n(row.recordings),
    transfers: n(row.transfers),
    evaluations: n(row.evaluations),
    agents: n(row.agents),
  };
}

/** What deleting a company removes — shown in the confirmation dialog. */
export async function companyUsage(companyId: string): Promise<CompanyUsage> {
  const r = await db.execute(sql`
    select (select count(*) from dialer_servers where company_id = ${companyId}) as dialers,
           (select count(*) from users where company_id = ${companyId}) as users,
           (select count(*) from qa_forms where company_id = ${companyId}) as forms,
           (select count(*) from calls where company_id = ${companyId}) as calls,
           (select count(*) from recordings where company_id = ${companyId}) as recordings,
           (select count(*) from transfers where company_id = ${companyId}) as transfers,
           (select count(*) from evaluations where company_id = ${companyId}) as evaluations,
           (select count(*) from vici_agents where company_id = ${companyId}) as agents`);
  const row = (r.rows[0] ?? {}) as Record<string, unknown>;
  return {
    dialers: n(row.dialers),
    users: n(row.users),
    forms: n(row.forms),
    calls: n(row.calls),
    recordings: n(row.recordings),
    transfers: n(row.transfers),
    evaluations: n(row.evaluations),
    agents: n(row.agents),
  };
}

/** Repeats a `... limit BATCH` delete until a short batch says it is done. */
async function deleteInBatches(statement: () => SQL): Promise<number> {
  let total = 0;
  for (;;) {
    const r = await db.execute(statement());
    const deleted = r.rowCount ?? 0;
    total += deleted;
    if (deleted < BATCH) return total;
  }
}

export interface PurgeLog {
  (message: string): void;
}

/**
 * Removes everything a dialer brought in, then the dialer. Refuses a dialer
 * that is not marked for deletion — a purge can never hit a live dialer.
 * Returns false when the dialer is already gone.
 */
export async function purgeDialer(dialerId: string, log: PurgeLog = () => {}): Promise<boolean> {
  const [d] = await db
    .select({ id: dialerServers.id, name: dialerServers.name, deletingAt: dialerServers.deletingAt })
    .from(dialerServers)
    .where(eq(dialerServers.id, dialerId));
  if (!d) return false;
  if (!d.deletingAt) throw new Error(`Dialer ${d.name} is not marked for deletion`);
  const started = Date.now();

  // QA history of this dialer goes with it (its calls and agents are gone)
  const evals = await db.execute(sql`delete from evaluations e where ${dialerEvaluations(dialerId)}`);
  // forms tied to one of its campaigns stay, no longer tied to a campaign
  await db.execute(sql`
    update qa_forms set campaign_id = null, updated_at = now()
     where campaign_id in (select id from campaigns where dialer_server_id = ${dialerId})`);

  const recs = await deleteInBatches(
    () => sql`delete from recordings where id in
                (select id from recordings where dialer_server_id = ${dialerId} limit ${BATCH})`,
  );
  const transfers = await deleteInBatches(
    () => sql`delete from transfers where id in
                (select id from transfers where dialer_server_id = ${dialerId} limit ${BATCH})`,
  );
  await deleteInBatches(
    () => sql`delete from agent_dispositions where id in
                (select id from agent_dispositions where dialer_server_id = ${dialerId} limit ${BATCH})`,
  );
  const calls = await deleteInBatches(
    () => sql`delete from calls where id in
                (select id from calls where dialer_server_id = ${dialerId} limit ${BATCH})`,
  );
  // the rest is small: agents, campaigns, in-groups, mappings, sync history
  await db.delete(dialerServers).where(eq(dialerServers.id, dialerId));

  log(
    `dialer ${d.name} deleted: ${calls} calls, ${recs} recordings, ${transfers} transfers, ` +
      `${evals.rowCount ?? 0} evaluations in ${Math.round((Date.now() - started) / 1000)}s`,
  );
  return true;
}

/**
 * Removes a company: each of its dialers through purgeDialer, then the
 * company row, which takes its users, roles, forms and remaining rows with it.
 * Refuses a company that is not marked for deletion.
 */
export async function purgeCompany(companyId: string, log: PurgeLog = () => {}): Promise<boolean> {
  const [c] = await db
    .select({ id: companies.id, name: companies.name, status: companies.status })
    .from(companies)
    .where(eq(companies.id, companyId));
  if (!c) return false;
  if (c.status !== 'deleting') throw new Error(`Company ${c.name} is not marked for deletion`);

  // dialers added after the delete was requested are marked too
  await db
    .update(dialerServers)
    .set({ active: false, deletingAt: new Date(), updatedAt: new Date() })
    .where(sql`${dialerServers.companyId} = ${companyId} and ${dialerServers.deletingAt} is null`);
  const dialers = await db
    .select({ id: dialerServers.id })
    .from(dialerServers)
    .where(eq(dialerServers.companyId, companyId));
  for (const d of dialers) await purgeDialer(d.id, log);

  // evaluations reference users and form versions without cascade — remove
  // them first so the company delete never trips over its own rows
  await deleteInBatches(
    () => sql`delete from evaluations where id in
                (select id from evaluations where company_id = ${companyId} limit ${BATCH})`,
  );
  // people who also work elsewhere, or whose work is on record elsewhere,
  // keep their account in that other company
  const shared = await rehomeSharedPeople(companyId);
  const referenced = await rehomeReferencedUsers(companyId);
  await db.delete(companies).where(eq(companies.id, companyId));
  log(
    `company ${c.name} deleted` +
      (shared + referenced > 0 ? ` (${shared + referenced} account(s) kept in other companies they work in)` : ''),
  );
  return true;
}

/**
 * People whose own company is being deleted but who also work in other
 * companies keep their account: it moves to the first other company they
 * were given access to, with the role they hold there.
 */
export async function rehomeSharedPeople(companyId: string, executor: Pick<typeof db, 'execute'> = db): Promise<number> {
  const r = await executor.execute(sql`
    with pick as (
      select distinct on (m.user_id) m.id as mid, m.user_id, m.company_id, m.role_id, m.allowed_form_ids
        from company_memberships m
        join users u on u.id = m.user_id
        join companies c on c.id = m.company_id
       where u.company_id = ${companyId} and c.status <> 'deleting'
       order by m.user_id, m.created_at
    ), moved as (
      update users u
         set company_id = p.company_id, role_id = p.role_id, allowed_form_ids = p.allowed_form_ids,
             last_company_id = null, updated_at = now()
        from pick p
       where u.id = p.user_id
      returning p.mid
    )
    delete from company_memberships m using moved where m.id = moved.mid`);
  return r.rowCount ?? 0;
}

/**
 * A deleted company's users whose work is on record in another company
 * (evaluations, tasks they assigned, forms they wrote …) cannot be deleted
 * without losing that history. Their account moves to that company,
 * disabled, with its least-privileged role — the history stays intact and
 * that company's admins can switch them back on.
 */
async function rehomeReferencedUsers(companyId: string): Promise<number> {
  const r = await db.execute(sql`
    with refs as (
      select u.id as user_id, coalesce(
        (select e.company_id from evaluations e where e.reviewer_id = u.id and e.company_id <> ${companyId} limit 1),
        (select a.company_id from qa_assignments a where a.assigned_by = u.id and a.company_id <> ${companyId} limit 1),
        (select f.company_id from qa_forms f where f.created_by = u.id and f.company_id <> ${companyId} limit 1),
        (select f.company_id from qa_form_versions v join qa_forms f on f.id = v.form_id
          where v.created_by = u.id and f.company_id <> ${companyId} limit 1),
        (select t.company_id from transfer_events te join transfers t on t.id = te.transfer_id
          where te.actor_user_id = u.id and t.company_id <> ${companyId} limit 1),
        (select d.company_id from disposition_mappings d where d.created_by = u.id and d.company_id <> ${companyId} limit 1),
        (select ra.company_id from reviewer_agent_assignments ra where ra.created_by = u.id and ra.company_id <> ${companyId} limit 1)
      ) as other
        from users u
       where u.company_id = ${companyId}
    )
    update users u
       set company_id = refs.other,
           role_id = (select r.id from roles r where r.company_id = refs.other
                       order by (r.name = 'qa_reviewer') desc, r.name limit 1),
           allowed_form_ids = null, status = 'disabled', last_company_id = null, updated_at = now()
      from refs
     where u.id = refs.user_id and refs.other is not null
       and exists (select 1 from roles r where r.company_id = refs.other)`);
  return r.rowCount ?? 0;
}

/** Dialers and companies whose deletion has not finished (a worker restart). */
export async function pendingPurges(): Promise<{ dialers: string[]; companies: string[] }> {
  const ds = await db.execute(sql`
    select d.id from dialer_servers d
      join companies c on c.id = d.company_id
     where d.deleting_at is not null and c.status <> 'deleting'`);
  const cs = await db.execute(sql`select id from companies where status = 'deleting'`);
  return {
    dialers: (ds.rows as { id: string }[]).map((r) => r.id),
    companies: (cs.rows as { id: string }[]).map((r) => r.id),
  };
}
