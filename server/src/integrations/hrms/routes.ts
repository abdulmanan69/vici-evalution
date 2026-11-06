/**
 * Routes the VICIdial QA platform adds for the HRMS link.
 *
 *   POST /api/v1/hrms/webhook/:company   HRMS webhooks (signed; no session)
 *   GET  /api/v1/hrms/agents?users=a,b   HRMS details for agents, for QA screens (signed in)
 *   POST /api/v1/hrms/push-qa-scores     send QA scores now (signed in, admin.agents)
 *   POST /api/v1/hrms/push-sales         send closed sales now (signed in, admin.agents)
 *
 * Register in app.ts (two lines, see README):
 *   import { hrmsWebhookRoutes, hrmsRoutes } from './integrations/hrms/routes.js';
 *   await app.register(hrmsWebhookRoutes, { prefix: '/api/v1/hrms' });        // before the authenticated block
 *   await api.register(hrmsRoutes, { prefix: '/hrms' });                       // inside it, next to the others
 */
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db/client.js';
import { companies } from '../../db/schema.js';
import { companyScope, requirePermission } from '../../auth/plugin.js';
import { hrmsWebhookSecret, verifyHrmsWebhook, type HrmsEvent } from './client.js';
import { employeesFor, forgetHrmsCache, pushQaScores, pushSales } from './sync.js';

/** Webhooks from HRMS. Public route; trusted only after the signature checks out. */
export async function hrmsWebhookRoutes(app: FastifyInstance): Promise<void> {
  // keep the raw body: the signature is over the exact bytes sent
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => done(null, body));

  app.post('/webhook/:company', { config: { rateLimit: { max: 300, timeWindow: '1 minute' } } }, async (req, reply) => {
    const { company } = z.object({ company: z.string().min(1).max(64) }).parse(req.params);
    const secret = hrmsWebhookSecret(company);
    const raw = typeof req.body === 'string' ? req.body : '';
    if (!secret || !verifyHrmsWebhook(raw, req.headers as Record<string, unknown>, secret)) {
      return reply.status(401).send({ error: 'bad_signature', message: 'Signature check failed' });
    }
    const event = JSON.parse(raw) as HrmsEvent;
    const [c] = await db.select({ id: companies.id }).from(companies).where(eq(companies.slug, company));
    if (!c) return reply.status(404).send({ error: 'not_found', message: 'Unknown company' });

    // HRMS changed someone: drop cached details so QA screens show the change at once
    forgetHrmsCache(c.id);
    const agents = event.data.links?.vicidial?.map((l) => l.externalId) ?? [];
    req.log.info({ type: event.type, eventId: event.id, agents }, 'HRMS event received');
    // Answer fast; heavier reactions (e.g. reassigning QA tasks of an agent who left) belong in a queued job.
    return reply.status(204).send();
  });
}

/** Signed-in routes inside the QA API. */
export async function hrmsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/agents', async (req) => {
    const q = z.object({ users: z.string().min(1), companyId: z.string().uuid().optional() }).parse(req.query);
    const companyId = companyScope(req, q.companyId);
    if (!companyId) return { data: [] };
    const users = q.users.split(',').map((s) => s.trim()).filter(Boolean).slice(0, 500);
    const people = await employeesFor(companyId, users);
    return { data: users.map((u) => people.get(u) ?? { externalId: u, context: '', found: false }) };
  });

  app.post('/push-qa-scores', { preHandler: requirePermission('admin.agents') }, async () => {
    return { data: await pushQaScores() };
  });

  app.post('/push-sales', { preHandler: requirePermission('admin.agents') }, async () => {
    return { data: await pushSales() };
  });
}
