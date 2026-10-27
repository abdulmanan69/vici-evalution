import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { dialerServers, reviewerAgentAssignments, roles, users, viciAgents } from '../db/schema.js';
import { companyScope, requirePermission } from '../auth/plugin.js';
import { hasPermission } from '../auth/permissions.js';
import { audit } from '../lib/audit.js';
import { NotFoundError, ValidationError } from '../lib/errors.js';
import { companyPeople, personInCompany, type CompanyPerson } from '../lib/people.js';

const assignmentsBody = z.object({
  assignments: z
    .array(
      z.object({
        viciAgentId: z.string().uuid(),
        methods: z.array(z.enum(['transfer', 'unclosed', 'closed'])).min(1).max(3),
      }),
    )
    .max(2000),
});

/** Reviewers = users who evaluate but don't manage forms (managers are never scoped). */
function isReviewerRole(permissions: string[]): boolean {
  return hasPermission(permissions, 'qa.evaluate') && !hasPermission(permissions, 'qa.forms.manage');
}

/**
 * The company whose reviewer list is being managed and the person as they
 * work there. Managers use their active company; a super admin the company
 * in scope, else the reviewer's own company.
 */
async function reviewerHere(req: FastifyRequest, userId: string): Promise<{ companyId: string; person: CompanyPerson }> {
  const q = req.query as { companyId?: string };
  let companyId = companyScope(req, q.companyId);
  if (!companyId) {
    const [u] = await db.select({ companyId: users.companyId }).from(users).where(eq(users.id, userId));
    companyId = u?.companyId ?? undefined;
  }
  if (!companyId) throw new NotFoundError('Reviewer not found');
  const person = await personInCompany(userId, companyId);
  if (!person) throw new NotFoundError('Reviewer not found');
  return { companyId, person };
}

export async function qaTeamRoutes(app: FastifyInstance): Promise<void> {
  app.get('/', { preHandler: [requirePermission('qa.assign')] }, async (req) => {
    const q = req.query as { companyId?: string };
    const scope = companyScope(req, q.companyId);
    // reviewers of this company, including people shared from other companies
    // who review here; without a company in scope (super admin), everyone's
    // own company
    const rows = scope
      ? (await companyPeople(scope)).map((p) => ({ ...p, companyId: scope }))
      : (
          await db
            .select({
              id: users.id,
              name: users.name,
              email: users.email,
              status: users.status,
              companyId: users.companyId,
              allowedFormIds: users.allowedFormIds,
              permissions: roles.permissions,
              roleName: roles.name,
            })
            .from(users)
            .innerJoin(roles, eq(users.roleId, roles.id))
            .orderBy(users.name)
        ).map((r) => ({ ...r, shared: false }));
    const reviewers = rows.filter((r) => r.companyId && isReviewerRole(r.permissions));

    const ids = reviewers.map((r) => r.id);
    const assignments = ids.length
      ? await db
          .select({
            reviewerUserId: reviewerAgentAssignments.reviewerUserId,
            companyId: reviewerAgentAssignments.companyId,
            methods: reviewerAgentAssignments.methods,
          })
          .from(reviewerAgentAssignments)
          .where(
            and(
              inArray(reviewerAgentAssignments.reviewerUserId, ids),
              scope ? eq(reviewerAgentAssignments.companyId, scope) : undefined,
            ),
          )
      : [];

    return {
      reviewers: reviewers.map((r) => {
        const mine = assignments.filter((a) => a.reviewerUserId === r.id && a.companyId === r.companyId);
        const methodCounts = { transfer: 0, unclosed: 0, closed: 0 };
        for (const a of mine) for (const m of a.methods) methodCounts[m] += 1;
        return {
          id: r.id,
          name: r.name,
          email: r.email,
          status: r.status,
          roleName: r.roleName,
          allowedFormIds: r.allowedFormIds,
          shared: r.shared,
          agentCount: mine.length,
          methodCounts,
        };
      }),
    };
  });

  app.get('/:userId/assignments', { preHandler: [requirePermission('qa.assign')] }, async (req) => {
    const { userId } = req.params as { userId: string };
    const { companyId } = await reviewerHere(req, userId);
    const rows = await db
      .select({
        viciAgentId: reviewerAgentAssignments.viciAgentId,
        methods: reviewerAgentAssignments.methods,
        viciUser: viciAgents.viciUser,
        fullName: viciAgents.fullName,
        agentRole: viciAgents.agentRole,
        dialerName: dialerServers.name,
      })
      .from(reviewerAgentAssignments)
      .innerJoin(viciAgents, eq(reviewerAgentAssignments.viciAgentId, viciAgents.id))
      .innerJoin(dialerServers, eq(viciAgents.dialerServerId, dialerServers.id))
      .where(and(eq(reviewerAgentAssignments.reviewerUserId, userId), eq(reviewerAgentAssignments.companyId, companyId)))
      .orderBy(viciAgents.fullName);
    return { assignments: rows };
  });

  /** Replaces the reviewer's full assignment list (the UI edits it as a whole). */
  app.put('/:userId/assignments', { preHandler: [requirePermission('qa.assign')] }, async (req) => {
    const { userId } = req.params as { userId: string };
    const body = assignmentsBody.parse(req.body);
    const { companyId, person } = await reviewerHere(req, userId);
    if (!isReviewerRole(person.permissions)) {
      throw new ValidationError('Only QA reviewers can be assigned agents — managers already see everything');
    }

    const agentIds = [...new Set(body.assignments.map((a) => a.viciAgentId))];
    if (agentIds.length !== body.assignments.length) {
      throw new ValidationError('Each agent may appear only once');
    }
    if (agentIds.length > 0) {
      const found = await db
        .select({ id: viciAgents.id })
        .from(viciAgents)
        .where(and(inArray(viciAgents.id, agentIds), eq(viciAgents.companyId, companyId)));
      if (found.length !== agentIds.length) {
        throw new ValidationError('One or more agents do not belong to this company');
      }
    }

    await db.transaction(async (tx) => {
      // only this company's list — someone reviewing for several companies
      // keeps their agents everywhere else
      await tx
        .delete(reviewerAgentAssignments)
        .where(and(eq(reviewerAgentAssignments.reviewerUserId, userId), eq(reviewerAgentAssignments.companyId, companyId)));
      if (body.assignments.length > 0) {
        await tx.insert(reviewerAgentAssignments).values(
          body.assignments.map((a) => ({
            companyId,
            reviewerUserId: userId,
            viciAgentId: a.viciAgentId,
            methods: [...new Set(a.methods)],
            createdBy: req.auth.userId,
          })),
        );
      }
    });

    await audit(req, {
      action: 'qa_team.set_assignments',
      entityType: 'user',
      entityId: userId,
      after: { agents: body.assignments.length },
      companyId,
    });
    return { ok: true, agents: body.assignments.length };
  });
}
