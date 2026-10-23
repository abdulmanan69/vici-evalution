import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requiredCompanyScope, requirePermission } from '../auth/plugin.js';
import { audit } from '../lib/audit.js';
import { getQaSettings, updateQaSettings } from '../services/qaSettings.js';

/** Manager-set QA behaviour for a company (the evaluation edit window, for now). */
export async function qaSettingsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/', { preHandler: [requirePermission('qa.forms.manage')] }, async (req) => {
    const q = z.object({ companyId: z.string().uuid().optional() }).parse(req.query);
    const companyId = requiredCompanyScope(req, q.companyId);
    return { settings: await getQaSettings(companyId) };
  });

  app.patch('/', { preHandler: [requirePermission('qa.forms.manage')] }, async (req) => {
    const body = z
      .object({
        companyId: z.string().uuid().optional(),
        // up to 30 days; 0 locks an evaluation as soon as it is completed
        evaluationEditWindowMinutes: z.number().int().min(0).max(30 * 24 * 60),
      })
      .parse(req.body);
    const companyId = requiredCompanyScope(req, body.companyId);
    const settings = await updateQaSettings(companyId, { evaluationEditWindowMinutes: body.evaluationEditWindowMinutes });
    await audit(req, { action: 'qa_settings.update', entityType: 'company', entityId: companyId, after: settings, companyId });
    return { settings };
  });
}
