import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { dialerServers, reviewerAgentAssignments, roles, users, viciAgents } from '../db/schema.js';
import { companyScope, requirePermission } from '../auth/plugin.js';
import { hasPermission } from '../auth/permissions.js';
import { audit } from '../lib/audit.js';
import { NotFoundError, ValidationError } from '../lib/errors.js';

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

export async function qaTeamRoutes(app: FastifyInstance): Promise<void> {
  app.get('/', { preHandler: [requirePermission('qa.assign')] }, async (req) => {
    const q = req.query as { companyId?: string };
    const scope = companyScope(req, q.companyId);
    const rows = await db
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
      .where(scope ? eq(users.companyId, scope) : undefined)
      .orderBy(users.name);
    const reviewers = rows.filter((r) => r.companyId && isReviewerRole(r.permissions));

    const ids = reviewers.map((r) => r.id);
    const assignments = ids.length
      ? await db
          .select({ reviewerUserId: reviewerAgentAssignments.reviewerUserId, methods: reviewerAgentAssignments.methods })
          .from(reviewerAgentAssignments)
          .where(inArray(reviewerAgentAssignments.reviewerUserId, ids))
      : [];

    return {
      reviewers: reviewers.map((r) => {
        const mine = assignments.filter((a) => a.reviewerUserId === r.id);
        const methodCounts = { transfer: 0, unclosed: 0, closed: 0 };
        for (const a of mine) for (const m of a.methods) methodCounts[m] += 1;
        return {
          id: r.id,
          name: r.name,
          email: r.email,
          status: r.status,
          roleName: r.roleName,
          allowedFormIds: r.allowedFormIds,
          agentCount: mine.length,
          methodCounts,
        };
      }),
    };
  });

  app.get('/:userId/assignments', { preHandler: [requirePermission('qa.assign')] }, async (req) => {
    const { userId } = req.params as { userId: string };
    const [reviewer] = await db.select().from(users).where(eq(users.id, userId));
    if (!reviewer || !reviewer.companyId) throw new NotFoundError('Reviewer not found');
    companyScope(req, reviewer.companyId);
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
      .where(eq(reviewerAgentAssignments.reviewerUserId, userId))
      .orderBy(viciAgents.fullName);
    return { assignments: rows };
  });

  /** Replaces the reviewer's full assignment list (the UI edits it as a whole). */
  app.put('/:userId/assignments', { preHandler: [requirePermission('qa.assign')] }, async (req) => {
    const { userId } = req.params as { userId: string };
    const body = assignmentsBody.parse(req.body);
    const [reviewer] = await db
      .select({ user: users, permissions: roles.permissions })
      .from(users)
      .innerJoin(roles, eq(users.roleId, roles.id))
      .where(eq(users.id, userId));
    if (!reviewer || !reviewer.user.companyId) throw new NotFoundError('Reviewer not found');
    const companyId = reviewer.user.companyId;
    companyScope(req, companyId);
    if (!isReviewerRole(reviewer.permissions)) {
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
      await tx.delete(reviewerAgentAssignments).where(eq(reviewerAgentAssignments.reviewerUserId, userId));
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
