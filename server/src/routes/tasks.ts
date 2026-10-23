import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { alias } from 'drizzle-orm/pg-core';
import { and, count, desc, eq, gte, inArray, lte, sql, type SQL } from 'drizzle-orm';
import { db } from '../db/client.js';
import { calls, dialerServers, qaAssignments, transfers, users, viciAgents } from '../db/schema.js';
import { companyScope, requiredCompanyScope, requirePermission } from '../auth/plugin.js';
import { hasPermission } from '../auth/permissions.js';
import { authContextForUser, type AuthContext } from '../auth/session.js';
import { audit } from '../lib/audit.js';
import { NotFoundError, ValidationError } from '../lib/errors.js';
import { offsetOf, pageMeta, paginationSchema } from '../lib/pagination.js';
import { agentScopeCondition, isAgentScoped } from '../lib/reviewScope.js';
import { localToUtc } from '../vicidial/timezone.js';

type QueueName = 'transfer' | 'unclosed' | 'closed';
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const assignBody = z.object({
  companyId: z.string().uuid().optional(),
  reviewerId: z.string().uuid(),
  date: day,
  queue: z.enum(['transfer', 'unclosed', 'closed']),
  /** null/omitted = every matching call */
  limit: z.number().int().min(1).max(2000).nullable().optional(),
  order: z.enum(['random', 'oldest']).default('random'),
  skipEvaluated: z.boolean().default(true),
  dueDate: day.nullable().optional(),
});

async function companyTimezone(companyId: string): Promise<string> {
  const [d] = await db
    .select({ timezone: dialerServers.timezone })
    .from(dialerServers)
    .where(eq(dialerServers.companyId, companyId))
    .limit(1);
  return d?.timezone ?? 'UTC';
}

interface CandidateOpts {
  companyId: string;
  reviewer: AuthContext;
  queue: QueueName;
  start: Date;
  end: Date;
  skipEvaluated: boolean;
}

/**
 * The method's calls for one dialer day:
 *  - Transfer: every fronter XFER (sale-only entries have no fronter);
 *  - Unclosed: every XFER that is not a sale — reached a closer without a
 *    sale, or no closer leg was found. Only calls whose closer may still be
 *    on the line right now are left out;
 *  - Closed: every sale (transfer, callback and inbound).
 */
function methodPool(opts: CandidateOpts): SQL {
  const parts: SQL[] = [
    sql`transfers.company_id = ${opts.companyId}`,
    sql`transfers.is_mock = false`,
    sql`coalesce(transfers.counted_at, transfers.xfer_time) >= ${opts.start}`,
    sql`coalesce(transfers.counted_at, transfers.xfer_time) <= ${opts.end}`,
  ];
  if (opts.queue === 'transfer') parts.push(sql`transfers.kind = 'transfer'`);
  else if (opts.queue === 'unclosed') {
    parts.push(sql`transfers.kind = 'transfer'`);
    parts.push(sql`transfers.queue_status <> 'closed'`);
    parts.push(sql`not (transfers.queue_status = 'transfer' and transfers.match_status = 'pending_match')`);
  } else parts.push(sql`transfers.queue_status = 'closed'`);
  return sql.join(parts, sql` and `);
}

/** already in an unfinished task of the same method (another method's task does not count) */
const inActiveTask = (queue: QueueName) => sql`exists (select 1 from qa_assignments x
   where x.transfer_id = transfers.id and x.status in ('open', 'in_progress')
     and (x.queue = ${queue} or x.queue is null))`;

const evaluatedWith = (queue: QueueName) => sql`exists (
  select 1 from evaluations e
    join qa_form_versions v on v.id = e.form_version_id
    join qa_forms f on f.id = v.form_id
   where e.transfer_id = transfers.id and e.status = 'completed'
     and (f.queue = ${queue} or f.queue is null))`;

/**
 * Calls a reviewer could be given for one dialer day and method: the
 * method's pool, inside the reviewer's agent coverage, not already in a task
 * of this method, and — by default — not already evaluated with it.
 */
function candidateWhere(opts: CandidateOpts): SQL {
  const parts: SQL[] = [methodPool(opts), sql`not ${inActiveTask(opts.queue)}`];
  if (isAgentScoped(opts.reviewer)) parts.push(agentScopeCondition(opts.reviewer, opts.queue));
  if (opts.skipEvaluated) parts.push(sql`not ${evaluatedWith(opts.queue)}`);
  return sql.join(parts, sql` and `);
}

async function resolveAssignContext(req: FastifyRequest, body: z.infer<typeof assignBody>) {
  const companyId = requiredCompanyScope(req, body.companyId);
  const [reviewerRow] = await db.select().from(users).where(eq(users.id, body.reviewerId));
  if (!reviewerRow || reviewerRow.companyId !== companyId) throw new NotFoundError('Reviewer not found');
  if (reviewerRow.status !== 'active') throw new ValidationError('This reviewer is disabled');
  const reviewer = await authContextForUser(body.reviewerId);
  if (!reviewer || !hasPermission(reviewer.permissions, 'qa.evaluate')) {
    throw new ValidationError('This user cannot evaluate calls');
  }
  if (reviewer.allowedQueues && !reviewer.allowedQueues.includes(body.queue)) {
    throw new ValidationError(`${reviewerRow.name} is not set up for the ${body.queue} method`);
  }
  const tz = await companyTimezone(companyId);
  const start = localToUtc(`${body.date} 00:00:00`, tz);
  const end = localToUtc(`${body.date} 23:59:59`, tz);
  return { companyId, reviewer, reviewerRow, tz, start, end };
}

export async function taskRoutes(app: FastifyInstance): Promise<void> {
  /**
   * How many calls an assignment would pick up, before committing it — and
   * why the rest of the day's calls in this method are not available.
   */
  app.post('/preview', { preHandler: [requirePermission('qa.assign')] }, async (req) => {
    const body = assignBody.parse(req.body);
    const ctx = await resolveAssignContext(req, body);
    const opts: CandidateOpts = { ...ctx, queue: body.queue, skipEvaluated: body.skipEvaluated, companyId: ctx.companyId };
    const scoped = isAgentScoped(ctx.reviewer);
    const inScope = scoped ? agentScopeCondition(ctx.reviewer, body.queue) : sql`true`;
    const result = await db.execute(sql`
      select count(*)::int as "inMethod",
             count(*) filter (where ${inActiveTask(body.queue)})::int as "inTask",
             count(*) filter (where not ${inActiveTask(body.queue)} and not (${inScope}))::int as "outsideAgents",
             count(*) filter (where not ${inActiveTask(body.queue)} and (${inScope})
                               and ${body.skipEvaluated ? evaluatedWith(body.queue) : sql`false`})::int as "evaluated"
        from transfers where ${methodPool(opts)}`);
    const counts = result.rows[0] as { inMethod: number; inTask: number; outsideAgents: number; evaluated: number };
    const available = Math.max(0, counts.inMethod - counts.inTask - counts.outsideAgents - counts.evaluated);
    return {
      available,
      willAssign: body.limit ? Math.min(body.limit, available) : available,
      breakdown: { ...counts, agentScoped: scoped },
    };
  });

  app.post('/assign', { preHandler: [requirePermission('qa.assign')] }, async (req, reply) => {
    const body = assignBody.parse(req.body);
    const ctx = await resolveAssignContext(req, body);
    const where = candidateWhere({ ...ctx, queue: body.queue, skipEvaluated: body.skipEvaluated, companyId: ctx.companyId });
    const dueAt = body.dueDate ? localToUtc(`${body.dueDate} 23:59:59`, ctx.tz) : null;
    const orderBy = body.order === 'random' ? sql`random()` : sql`transfers.xfer_time asc`;
    const limit = body.limit ? sql`limit ${body.limit}` : sql``;
    const result = await db.execute(sql`
      insert into qa_assignments
        (company_id, transfer_id, assigned_to, assigned_by, due_at, status, task_date, queue)
      select transfers.company_id, transfers.id, ${body.reviewerId}, ${req.auth.userId},
             ${dueAt}, 'open', ${body.date}::date, ${body.queue}
        from transfers
       where ${where}
       order by ${orderBy}
       ${limit}
      on conflict (transfer_id, assigned_to, queue) do update
        set status = 'open', task_date = excluded.task_date,
            due_at = excluded.due_at, assigned_by = excluded.assigned_by,
            completed_at = null, updated_at = now()
      returning id`);
    const assigned = result.rowCount ?? 0;
    await audit(req, {
      action: 'qa_task.assign',
      entityType: 'user',
      entityId: body.reviewerId,
      after: { date: body.date, queue: body.queue, assigned, limit: body.limit ?? null },
      companyId: ctx.companyId,
    });
    return reply.status(201).send({ assigned });
  });

  /** Task list — reviewers always get their own; managers can view anyone's. */
  app.get('/', { preHandler: [requirePermission('qa.evaluate')] }, async (req) => {
    const q = paginationSchema
      .extend({
        companyId: z.string().uuid().optional(),
        reviewerId: z.string().uuid().optional(),
        dateFrom: day.optional(),
        dateTo: day.optional(),
        // an empty filter value means "any"
        status: z.preprocess(
          (v) => (v === '' ? undefined : v),
          z.enum(['open', 'in_progress', 'done', 'cancelled', 'active']).optional(),
        ),
        queue: z.preprocess((v) => (v === '' ? undefined : v), z.enum(['transfer', 'unclosed', 'closed']).optional()),
      })
      .parse(req.query);
    const scope = companyScope(req, q.companyId);
    const isManager = hasPermission(req.auth.permissions, 'qa.assign');

    // A task whose call the reviewer already evaluated with this method is
    // done, however the evaluation came about (before the task existed, or
    // started from the call page) — close it so it never reads "Continue".
    await db.execute(sql`
      update qa_assignments a
         set status = 'done', completed_at = coalesce(a.completed_at, e.completed_at), updated_at = now()
        from evaluations e
        join qa_form_versions v on v.id = e.form_version_id
        join qa_forms f on f.id = v.form_id
       where e.transfer_id = a.transfer_id and e.reviewer_id = a.assigned_to and e.status = 'completed'
         and a.status in ('open', 'in_progress')
         and (a.queue is null or f.queue = a.queue
              or (f.queue is null and ((f.target = 'fronter') = (a.queue = 'transfer'))))
         ${scope ? sql`and a.company_id = ${scope}` : sql``}`);

    // the evaluation that belongs to this task's method (a TRA evaluation is
    // not the Unclosed task's evaluation)
    const methodEval = sql`e.transfer_id = ${qaAssignments.transferId} and e.reviewer_id = ${qaAssignments.assignedTo}
      and exists (select 1 from qa_form_versions v join qa_forms f on f.id = v.form_id
                   where v.id = e.form_version_id
                     and (${qaAssignments.queue} is null or f.queue = ${qaAssignments.queue}
                          or (f.queue is null and ((f.target = 'fronter') = (${qaAssignments.queue} = 'transfer')))))`;
    const fc = alias(calls, 'tfc');
    const cc = alias(calls, 'tcc');
    const fa = alias(viciAgents, 'tfa');
    const ca = alias(viciAgents, 'tca');
    const reviewer = alias(users, 'reviewer');

    const where: SQL[] = [];
    if (scope) where.push(eq(qaAssignments.companyId, scope));
    if (!isManager) where.push(eq(qaAssignments.assignedTo, req.auth.userId));
    else if (q.reviewerId) where.push(eq(qaAssignments.assignedTo, q.reviewerId));
    if (q.dateFrom) where.push(gte(qaAssignments.taskDate, q.dateFrom));
    if (q.dateTo) where.push(lte(qaAssignments.taskDate, q.dateTo));
    if (q.queue) where.push(eq(qaAssignments.queue, q.queue));
    if (q.status === 'active') where.push(inArray(qaAssignments.status, ['open', 'in_progress']));
    else if (q.status) where.push(eq(qaAssignments.status, q.status));
    const whereAll = where.length ? and(...where) : undefined;

    const [total] = await db.select({ n: count() }).from(qaAssignments).where(whereAll);
    const rows = await db
      .select({
        task: qaAssignments,
        reviewerName: reviewer.name,
        phone: transfers.phoneNumber,
        xferTime: transfers.xferTime,
        queueStatus: transfers.queueStatus,
        fronterAgent: fa.fullName,
        fronterUser: fa.viciUser,
        closerAgent: ca.fullName,
        closerUser: ca.viciUser,
        closerStatus: cc.status,
        evaluationId: sql<string | null>`(select e.id from evaluations e where ${methodEval}
            order by (e.status = 'completed') desc, e.created_at desc limit 1)`,
        evaluationPercent: sql<string | null>`(select e.percent from evaluations e where ${methodEval}
              and e.status = 'completed' order by e.completed_at desc limit 1)`,
        evaluationPassed: sql<boolean | null>`(select e.passed from evaluations e where ${methodEval}
              and e.status = 'completed' order by e.completed_at desc limit 1)`,
      })
      .from(qaAssignments)
      .innerJoin(reviewer, eq(qaAssignments.assignedTo, reviewer.id))
      .innerJoin(transfers, eq(qaAssignments.transferId, transfers.id))
      .leftJoin(fc, eq(transfers.fronterCallId, fc.id))
      .leftJoin(fa, eq(fc.viciAgentId, fa.id))
      .leftJoin(cc, eq(transfers.closerCallId, cc.id))
      .leftJoin(ca, eq(cc.viciAgentId, ca.id))
      .where(whereAll)
      .orderBy(
        sql`case ${qaAssignments.status} when 'in_progress' then 0 when 'open' then 1 when 'done' then 2 else 3 end`,
        desc(qaAssignments.taskDate),
        transfers.xferTime,
      )
      .limit(q.pageSize)
      .offset(offsetOf(q));

    // progress across the whole filter, not just this page
    const [progress] = await db
      .select({
        total: count(),
        done: sql<number>`count(*) filter (where ${qaAssignments.status} = 'done')`,
        inProgress: sql<number>`count(*) filter (where ${qaAssignments.status} = 'in_progress')`,
        open: sql<number>`count(*) filter (where ${qaAssignments.status} = 'open')`,
      })
      .from(qaAssignments)
      .where(whereAll);

    return {
      tasks: rows,
      progress: {
        total: Number(progress.total),
        done: Number(progress.done),
        inProgress: Number(progress.inProgress),
        open: Number(progress.open),
      },
      meta: pageMeta(q, total.n),
    };
  });

  /** Per reviewer, per day: the team board managers watch. */
  app.get('/summary', { preHandler: [requirePermission('qa.assign')] }, async (req) => {
    const q = z
      .object({ companyId: z.string().uuid().optional(), dateFrom: day.optional(), dateTo: day.optional() })
      .parse(req.query);
    const scope = companyScope(req, q.companyId);
    const where: SQL[] = [sql`${qaAssignments.status} <> 'cancelled'`];
    if (scope) where.push(eq(qaAssignments.companyId, scope));
    if (q.dateFrom) where.push(gte(qaAssignments.taskDate, q.dateFrom));
    if (q.dateTo) where.push(lte(qaAssignments.taskDate, q.dateTo));
    const rows = await db
      .select({
        reviewerId: qaAssignments.assignedTo,
        reviewerName: users.name,
        taskDate: qaAssignments.taskDate,
        queue: qaAssignments.queue,
        total: count(),
        done: sql<number>`count(*) filter (where ${qaAssignments.status} = 'done')`,
        inProgress: sql<number>`count(*) filter (where ${qaAssignments.status} = 'in_progress')`,
      })
      .from(qaAssignments)
      .innerJoin(users, eq(qaAssignments.assignedTo, users.id))
      .where(and(...where))
      .groupBy(qaAssignments.assignedTo, users.name, qaAssignments.taskDate, qaAssignments.queue)
      .orderBy(desc(qaAssignments.taskDate), users.name);
    return {
      rows: rows.map((r) => ({ ...r, total: Number(r.total), done: Number(r.done), inProgress: Number(r.inProgress) })),
    };
  });

  /** Withdraw unfinished tasks — by ids, or a reviewer's whole day/method. */
  app.post('/cancel', { preHandler: [requirePermission('qa.assign')] }, async (req) => {
    const body = z
      .object({
        companyId: z.string().uuid().optional(),
        ids: z.array(z.string().uuid()).max(2000).optional(),
        reviewerId: z.string().uuid().optional(),
        date: day.optional(),
        queue: z.enum(['transfer', 'unclosed', 'closed']).optional(),
      })
      .parse(req.body);
    const companyId = requiredCompanyScope(req, body.companyId);
    const where: SQL[] = [
      eq(qaAssignments.companyId, companyId),
      inArray(qaAssignments.status, ['open', 'in_progress']),
    ];
    if (body.ids?.length) where.push(inArray(qaAssignments.id, body.ids));
    else if (body.reviewerId && body.date) {
      where.push(eq(qaAssignments.assignedTo, body.reviewerId), eq(qaAssignments.taskDate, body.date));
      if (body.queue) where.push(eq(qaAssignments.queue, body.queue));
    } else {
      throw new ValidationError('Give task ids, or a reviewer and a date');
    }
    const result = await db
      .update(qaAssignments)
      .set({ status: 'cancelled', updatedAt: new Date() })
      .where(and(...where))
      .returning({ id: qaAssignments.id });
    await audit(req, { action: 'qa_task.cancel', after: { cancelled: result.length }, companyId });
    return { cancelled: result.length };
  });
}
