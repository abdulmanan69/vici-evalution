import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { alias } from 'drizzle-orm/pg-core';
import { and, count, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { db } from '../db/client.js';
import { calls, dialerServers, evaluations, qaFormVersions, qaForms, recordings, transfers, users, viciAgents } from '../db/schema.js';
import { localToUtc } from '../vicidial/timezone.js';
import { companyScope, requirePermission } from '../auth/plugin.js';
import { audit } from '../lib/audit.js';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../lib/errors.js';
import { hasPermission } from '../auth/permissions.js';
import { offsetOf, pageMeta, paginationSchema } from '../lib/pagination.js';
import { answersSchema, formDefinitionSchema } from '../services/formSchema.js';
import { scoreEvaluation } from '../services/scoring.js';

const createSchema = z.object({
  transferId: z.string().uuid(),
  formId: z.string().uuid(),
  targetAgentId: z.string().uuid().optional(),
  callId: z.string().uuid().optional(),
});

const listQuery = paginationSchema.extend({
  companyId: z.string().uuid().optional(),
  status: z.enum(['draft', 'completed']).optional(),
  reviewerId: z.string().uuid().optional(),
  transferId: z.string().uuid().optional(),
  formId: z.string().uuid().optional(),
  result: z.enum(['pass', 'fail', 'auto_fail']).optional(),
  /** matches the evaluated agent's name or user id */
  agent: z.string().max(60).optional(),
  /** YYYY-MM-DD = dialer-local day */
  dateFrom: z.string().max(40).optional(),
  dateTo: z.string().max(40).optional(),
  /** reviewers: only my own evaluations */
  mine: z.coerce.boolean().optional(),
});

export async function evaluationRoutes(app: FastifyInstance): Promise<void> {
  app.get('/', { preHandler: [requirePermission('qa.view')] }, async (req) => {
    const q = listQuery.parse(req.query);
    const scope = companyScope(req, q.companyId);
    const fc = alias(calls, 'fc');
    const cc = alias(calls, 'cc');
    const fa = alias(viciAgents, 'fa');
    const ca = alias(viciAgents, 'ca');

    const where: SQL[] = [];
    if (scope) where.push(eq(evaluations.companyId, scope));
    if (q.status) where.push(eq(evaluations.status, q.status));
    if (q.mine) where.push(eq(evaluations.reviewerId, req.auth.userId));
    else if (q.reviewerId) where.push(eq(evaluations.reviewerId, q.reviewerId));
    if (q.transferId) where.push(eq(evaluations.transferId, q.transferId));
    if (q.formId) where.push(eq(qaForms.id, q.formId));
    if (q.result === 'pass') where.push(eq(evaluations.passed, true));
    if (q.result === 'fail') where.push(and(eq(evaluations.passed, false), eq(evaluations.autoFailed, false))!);
    if (q.result === 'auto_fail') where.push(eq(evaluations.autoFailed, true));
    // a restricted reviewer only ever sees their assigned methods
    if (req.auth.allowedFormIds && !hasPermission(req.auth.permissions, 'qa.forms.manage')) {
      where.push(inArray(qaForms.id, req.auth.allowedFormIds));
    }
    if (q.agent) {
      const pat = `%${q.agent}%`;
      where.push(
        sql`(${fa.fullName} ilike ${pat} or ${fa.viciUser} ilike ${pat} or ${ca.fullName} ilike ${pat} or ${ca.viciUser} ilike ${pat})`,
      );
    }
    if (q.dateFrom || q.dateTo) {
      // plain dates mean the dialer's day, like everywhere else
      const [dialerRow] = await db
        .select()
        .from(dialerServers)
        .where(scope ? eq(dialerServers.companyId, scope) : eq(dialerServers.active, true))
        .limit(1);
      const tz = dialerRow?.timezone ?? 'UTC';
      const evDate = sql`coalesce(${evaluations.completedAt}, ${evaluations.createdAt})`;
      const parseDay = (v: string, end: boolean): Date =>
        /^\d{4}-\d{2}-\d{2}$/.test(v) ? localToUtc(`${v} ${end ? '23:59:59' : '00:00:00'}`, tz) : new Date(v);
      if (q.dateFrom) where.push(sql`${evDate} >= ${parseDay(q.dateFrom, false)}`);
      if (q.dateTo) where.push(sql`${evDate} <= ${parseDay(q.dateTo, true)}`);
    }
    const whereAll = where.length ? and(...where) : undefined;

    const [total] = await db
      .select({ n: count() })
      .from(evaluations)
      .innerJoin(users, eq(evaluations.reviewerId, users.id))
      .innerJoin(qaFormVersions, eq(evaluations.formVersionId, qaFormVersions.id))
      .innerJoin(qaForms, eq(qaFormVersions.formId, qaForms.id))
      .leftJoin(transfers, eq(evaluations.transferId, transfers.id))
      .leftJoin(fc, eq(transfers.fronterCallId, fc.id))
      .leftJoin(fa, eq(fc.viciAgentId, fa.id))
      .leftJoin(cc, eq(transfers.closerCallId, cc.id))
      .leftJoin(ca, eq(cc.viciAgentId, ca.id))
      .where(whereAll);

    const rows = await db
      .select({
        evaluation: evaluations,
        reviewerName: users.name,
        formName: qaForms.name,
        formTarget: qaForms.target,
        formId: qaForms.id,
        formVersion: qaFormVersions.version,
        formVersionId: qaFormVersions.id,
        phone: transfers.phoneNumber,
        callTime: transfers.xferTime,
        queueStatus: transfers.queueStatus,
        fronterAgent: fa.fullName,
        fronterUser: fa.viciUser,
        closerAgent: ca.fullName,
        closerUser: ca.viciUser,
        hasRecording: sql<boolean>`exists(select 1 from recordings r where r.call_id in (${fc.id}, ${cc.id}) and r.status = 'available')`,
      })
      .from(evaluations)
      .innerJoin(users, eq(evaluations.reviewerId, users.id))
      .innerJoin(qaFormVersions, eq(evaluations.formVersionId, qaFormVersions.id))
      .innerJoin(qaForms, eq(qaFormVersions.formId, qaForms.id))
      .leftJoin(transfers, eq(evaluations.transferId, transfers.id))
      .leftJoin(fc, eq(transfers.fronterCallId, fc.id))
      .leftJoin(fa, eq(fc.viciAgentId, fa.id))
      .leftJoin(cc, eq(transfers.closerCallId, cc.id))
      .leftJoin(ca, eq(cc.viciAgentId, ca.id))
      .where(whereAll)
      .orderBy(desc(sql`coalesce(${evaluations.completedAt}, ${evaluations.createdAt})`))
      .limit(q.pageSize)
      .offset(offsetOf(q));

    // ship the question definitions of the versions on this page so the UI
    // can render one column per scored question
    const versionIds = [...new Set(rows.map((r) => r.formVersionId))];
    const forms: Record<string, unknown> = {};
    if (versionIds.length > 0) {
      for (const v of await db
        .select()
        .from(qaFormVersions)
        .where(inArray(qaFormVersions.id, versionIds))) {
        forms[v.id] = { version: v.version, schema: v.schema };
      }
    }
    return { evaluations: rows, forms, meta: pageMeta(q, total.n) };
  });

  app.get('/:id', { preHandler: [requirePermission('qa.view')] }, async (req) => {
    const { id } = req.params as { id: string };
    const [row] = await db
      .select({
        evaluation: evaluations,
        reviewerName: users.name,
        formName: qaForms.name,
        formIdOfEval: qaForms.id,
        formVersion: qaFormVersions.version,
        formSchema: qaFormVersions.schema,
        maxScore: qaFormVersions.maxScore,
        passThreshold: qaFormVersions.passThreshold,
      })
      .from(evaluations)
      .innerJoin(users, eq(evaluations.reviewerId, users.id))
      .innerJoin(qaFormVersions, eq(evaluations.formVersionId, qaFormVersions.id))
      .innerJoin(qaForms, eq(qaFormVersions.formId, qaForms.id))
      .where(eq(evaluations.id, id));
    if (!row) throw new NotFoundError('Evaluation not found');
    companyScope(req, row.evaluation.companyId);
    if (
      req.auth.allowedFormIds &&
      !req.auth.allowedFormIds.includes(row.formIdOfEval) &&
      !hasPermission(req.auth.permissions, 'qa.forms.manage')
    ) {
      throw new ForbiddenError('This evaluation method is not assigned to you');
    }

    // the reviewer scores while listening — ship the call's recordings and
    // context so the player lives on the evaluation page itself
    let callRecordings: Array<Record<string, unknown>> = [];
    let callContext: Record<string, unknown> | null = null;
    if (row.evaluation.transferId) {
      const fronterCall = alias(calls, 'fc');
      const closerCall = alias(calls, 'cc');
      const fronterAgent = alias(viciAgents, 'fa');
      const closerAgent = alias(viciAgents, 'ca');
      const [t] = await db
        .select({
          transfer: transfers,
          fronterCallId: fronterCall.id,
          closerCallId: closerCall.id,
          fronterAgent: fronterAgent.fullName,
          fronterUser: fronterAgent.viciUser,
          closerAgent: closerAgent.fullName,
          closerUser: closerAgent.viciUser,
          closerStatus: closerCall.status,
        })
        .from(transfers)
        .innerJoin(fronterCall, eq(transfers.fronterCallId, fronterCall.id))
        .leftJoin(fronterAgent, eq(fronterCall.viciAgentId, fronterAgent.id))
        .leftJoin(closerCall, eq(transfers.closerCallId, closerCall.id))
        .leftJoin(closerAgent, eq(closerCall.viciAgentId, closerAgent.id))
        .where(eq(transfers.id, row.evaluation.transferId));
      if (t) {
        callContext = {
          phoneNumber: t.transfer.phoneNumber,
          xferTime: t.transfer.xferTime,
          queueStatus: t.transfer.queueStatus,
          fronterAgent: t.fronterAgent ?? t.fronterUser,
          closerAgent: t.closerAgent ?? t.closerUser,
          closerStatus: t.closerStatus,
          transferId: t.transfer.id,
        };
        const legIds = [t.fronterCallId, t.closerCallId].filter((x): x is string => !!x);
        if (legIds.length > 0) {
          const recs = await db
            .select()
            .from(recordings)
            .where(inArray(recordings.callId, legIds));
          callRecordings = recs.map((r) => ({
            id: r.id,
            filename: r.filename,
            status: r.status,
            lengthSec: r.lengthSec,
            leg: r.callId === t.fronterCallId ? 'fronter' : 'closer',
          }));
        }
      }
    }
    return { ...row, call: callContext, recordings: callRecordings };
  });

  app.post('/', { preHandler: [requirePermission('qa.evaluate')] }, async (req, reply) => {
    const body = createSchema.parse(req.body);
    const [transfer] = await db.select().from(transfers).where(eq(transfers.id, body.transferId));
    if (!transfer) throw new NotFoundError('Transfer not found');
    const companyId = companyScope(req, transfer.companyId);
    if (!companyId) throw new ValidationError('Evaluation requires a company context');

    const [form] = await db.select().from(qaForms).where(eq(qaForms.id, body.formId));
    if (!form || form.companyId !== transfer.companyId) throw new NotFoundError('Form not found');
    if (
      req.auth.allowedFormIds &&
      !req.auth.allowedFormIds.includes(form.id) &&
      !hasPermission(req.auth.permissions, 'qa.forms.manage')
    ) {
      throw new ForbiddenError('This evaluation method is not assigned to you');
    }
    if (form.state !== 'published' || form.currentVersion === 0) {
      throw new ValidationError('Form has no published version');
    }
    const [version] = await db
      .select()
      .from(qaFormVersions)
      .where(and(eq(qaFormVersions.formId, form.id), eq(qaFormVersions.version, form.currentVersion)));
    if (!version) throw new ValidationError('Published version missing');

    const [row] = await db
      .insert(evaluations)
      .values({
        companyId: transfer.companyId,
        transferId: transfer.id,
        callId: body.callId ?? transfer.closerCallId ?? transfer.fronterCallId,
        formVersionId: version.id,
        targetAgentId: body.targetAgentId ?? null,
        reviewerId: req.auth.userId,
        status: 'draft',
        answers: {},
      })
      .returning();
    await audit(req, { action: 'evaluation.create', entityType: 'evaluation', entityId: row.id, companyId: transfer.companyId });
    return reply.status(201).send({ evaluation: row });
  });

  app.patch('/:id', { preHandler: [requirePermission('qa.evaluate')] }, async (req) => {
    const { id } = req.params as { id: string };
    const body = z
      .object({
        answers: answersSchema.optional(),
        comments: z.string().max(5000).optional(),
        coachingNotes: z.string().max(5000).optional(),
      })
      .parse(req.body);
    const [before] = await db.select().from(evaluations).where(eq(evaluations.id, id));
    if (!before) throw new NotFoundError('Evaluation not found');
    companyScope(req, before.companyId);
    if (before.status === 'completed') {
      throw new ConflictError('Completed evaluations are immutable');
    }
    const [row] = await db
      .update(evaluations)
      .set({
        answers: body.answers ?? before.answers,
        comments: body.comments ?? before.comments,
        coachingNotes: body.coachingNotes ?? before.coachingNotes,
        updatedAt: new Date(),
      })
      .where(eq(evaluations.id, id))
      .returning();
    return { evaluation: row };
  });

  /** Completion scores server-side against the frozen form version. */
  app.post('/:id/complete', { preHandler: [requirePermission('qa.evaluate')] }, async (req) => {
    const { id } = req.params as { id: string };
    const [evalRow] = await db.select().from(evaluations).where(eq(evaluations.id, id));
    if (!evalRow) throw new NotFoundError('Evaluation not found');
    companyScope(req, evalRow.companyId);
    if (evalRow.status === 'completed') throw new ConflictError('Already completed');

    const [version] = await db
      .select()
      .from(qaFormVersions)
      .where(eq(qaFormVersions.id, evalRow.formVersionId));
    if (!version) throw new NotFoundError('Form version missing');
    const form = formDefinitionSchema.parse(version.schema);
    const answers = answersSchema.parse(evalRow.answers ?? {});

    const result = scoreEvaluation(form, answers, Number(version.passThreshold));
    if (result.missingRequired.length > 0) {
      throw new ValidationError(`Required questions unanswered: ${result.missingRequired.join(', ')}`);
    }

    const [row] = await db
      .update(evaluations)
      .set({
        status: 'completed',
        score: String(result.score),
        maxScore: String(result.maxScore),
        percent: String(result.percent),
        passed: result.passed,
        autoFailed: result.autoFailed,
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(evaluations.id, id))
      .returning();
    await audit(req, {
      action: 'evaluation.complete',
      entityType: 'evaluation',
      entityId: id,
      after: { score: result.score, percent: result.percent, passed: result.passed, autoFailed: result.autoFailed },
      companyId: evalRow.companyId,
    });
    return { evaluation: row, result };
  });
}
