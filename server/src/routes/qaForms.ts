import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, desc, eq, inArray, type SQL } from 'drizzle-orm';
import { hasPermission } from '../auth/permissions.js';
import { db } from '../db/client.js';
import { qaForms, qaFormVersions } from '../db/schema.js';
import { companyScope, requiredCompanyScope, requirePermission } from '../auth/plugin.js';
import { audit } from '../lib/audit.js';
import { NotFoundError, ValidationError } from '../lib/errors.js';
import { formDefinitionSchema, formMaxScore } from '../services/formSchema.js';

const formMetaSchema = z.object({
  companyId: z.string().uuid().optional(),
  name: z.string().min(2).max(200),
  description: z.string().max(2000).optional(),
  target: z.enum(['fronter', 'closer', 'any']).default('any'),
  queue: z.enum(['transfer', 'unclosed', 'closed']).nullable().optional(),
  campaignId: z.string().uuid().nullable().optional(),
  passThreshold: z.number().min(0).max(100).default(80),
});

export async function qaFormRoutes(app: FastifyInstance): Promise<void> {
  app.get('/', { preHandler: [requirePermission('qa.view')] }, async (req) => {
    const q = req.query as { companyId?: string; state?: string };
    const scope = companyScope(req, q.companyId);
    const where: SQL[] = [];
    if (scope) where.push(eq(qaForms.companyId, scope));
    if (q.state && ['draft', 'published', 'archived'].includes(q.state)) {
      where.push(eq(qaForms.state, q.state as 'draft' | 'published' | 'archived'));
    }
    // a restricted reviewer only ever sees the methods assigned to them
    if (req.auth.allowedFormIds && !hasPermission(req.auth.permissions, 'qa.forms.manage')) {
      where.push(inArray(qaForms.id, req.auth.allowedFormIds));
    }
    const rows = await db
      .select()
      .from(qaForms)
      .where(where.length ? and(...where) : undefined)
      .orderBy(desc(qaForms.updatedAt));
    return { forms: rows };
  });

  // the builder is a manager tool — reviewers get the form schema through
  // their evaluation, never by browsing forms
  app.get('/:id', { preHandler: [requirePermission('qa.forms.manage')] }, async (req) => {
    const { id } = req.params as { id: string };
    const [form] = await db.select().from(qaForms).where(eq(qaForms.id, id));
    if (!form) throw new NotFoundError('Form not found');
    companyScope(req, form.companyId);
    const versions = await db
      .select({
        id: qaFormVersions.id,
        version: qaFormVersions.version,
        maxScore: qaFormVersions.maxScore,
        passThreshold: qaFormVersions.passThreshold,
        publishedAt: qaFormVersions.publishedAt,
      })
      .from(qaFormVersions)
      .where(eq(qaFormVersions.formId, id))
      .orderBy(desc(qaFormVersions.version));
    return { form, versions };
  });

  app.get('/:id/versions/:version', { preHandler: [requirePermission('qa.forms.manage')] }, async (req) => {
    const { id, version } = req.params as { id: string; version: string };
    const [form] = await db.select().from(qaForms).where(eq(qaForms.id, id));
    if (!form) throw new NotFoundError('Form not found');
    companyScope(req, form.companyId);
    const [v] = await db
      .select()
      .from(qaFormVersions)
      .where(and(eq(qaFormVersions.formId, id), eq(qaFormVersions.version, Number(version))));
    if (!v) throw new NotFoundError('Version not found');
    return { version: v };
  });

  app.post('/', { preHandler: [requirePermission('qa.forms.manage')] }, async (req, reply) => {
    const body = formMetaSchema.parse(req.body);
    const companyId = requiredCompanyScope(req, body.companyId);
    const [row] = await db
      .insert(qaForms)
      .values({
        companyId,
        name: body.name,
        description: body.description ?? null,
        target: body.target,
        queue: body.queue ?? null,
        campaignId: body.campaignId ?? null,
        state: 'draft',
        draftSchema: { sections: [] },
        createdBy: req.auth.userId,
      })
      .returning();
    await audit(req, { action: 'qa_form.create', entityType: 'qa_form', entityId: row.id, after: row, companyId });
    return reply.status(201).send({ form: row });
  });

  app.patch('/:id', { preHandler: [requirePermission('qa.forms.manage')] }, async (req) => {
    const { id } = req.params as { id: string };
    const body = formMetaSchema
      .partial()
      .extend({
        draftSchema: z.unknown().optional(),
        state: z.enum(['draft', 'published', 'archived']).optional(),
      })
      .parse(req.body);
    const [before] = await db.select().from(qaForms).where(eq(qaForms.id, id));
    if (!before) throw new NotFoundError('Form not found');
    companyScope(req, before.companyId);

    // Draft schema edits are validated structurally but stay mutable until publish.
    let draftSchema = before.draftSchema;
    if (body.draftSchema !== undefined) {
      const parsed = formDefinitionSchema.safeParse(body.draftSchema);
      if (!parsed.success && (body.draftSchema as { sections?: unknown[] })?.sections?.length) {
        throw new ValidationError(
          `Invalid form definition: ${parsed.error?.issues.map((i) => i.message).join('; ')}`,
        );
      }
      draftSchema = parsed.success ? parsed.data : (body.draftSchema as object);
    }

    const [row] = await db
      .update(qaForms)
      .set({
        name: body.name ?? before.name,
        description: body.description ?? before.description,
        target: body.target ?? before.target,
        queue: body.queue !== undefined ? body.queue : before.queue,
        campaignId: body.campaignId !== undefined ? body.campaignId : before.campaignId,
        state: body.state ?? before.state,
        draftSchema,
        updatedAt: new Date(),
      })
      .where(eq(qaForms.id, id))
      .returning();
    await audit(req, { action: 'qa_form.update', entityType: 'qa_form', entityId: id, companyId: before.companyId });
    return { form: row };
  });

  /**
   * Publish freezes the draft into an immutable version. Completed evaluations
   * always reference a version row — editing the form later can never change
   * historical scores.
   */
  app.post('/:id/publish', { preHandler: [requirePermission('qa.forms.manage')] }, async (req) => {
    const { id } = req.params as { id: string };
    const body = z.object({ passThreshold: z.number().min(0).max(100).default(80) }).parse(req.body ?? {});
    const [form] = await db.select().from(qaForms).where(eq(qaForms.id, id));
    if (!form) throw new NotFoundError('Form not found');
    companyScope(req, form.companyId);

    const parsed = formDefinitionSchema.safeParse(form.draftSchema);
    if (!parsed.success) {
      throw new ValidationError(
        `Form cannot be published: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
      );
    }
    const maxScore = formMaxScore(parsed.data);
    if (maxScore <= 0) throw new ValidationError('Form has no scorable questions');

    const nextVersion = form.currentVersion + 1;
    const [version] = await db
      .insert(qaFormVersions)
      .values({
        formId: id,
        version: nextVersion,
        schema: parsed.data,
        maxScore: String(maxScore),
        passThreshold: String(body.passThreshold),
        createdBy: req.auth.userId,
      })
      .returning();
    const [row] = await db
      .update(qaForms)
      .set({ state: 'published', currentVersion: nextVersion, updatedAt: new Date() })
      .where(eq(qaForms.id, id))
      .returning();
    await audit(req, {
      action: 'qa_form.publish',
      entityType: 'qa_form',
      entityId: id,
      after: { version: nextVersion, maxScore },
      companyId: form.companyId,
    });
    return { form: row, version };
  });
}
