/**
 * Managing connections from the QA console (signed in, permission
 * admin.users: company admins for their company, super admins for any or
 * all companies). Mounted at /api/v1/connections.
 *
 *   GET    /catalog                    scopes and events
 *   GET    /keys                       API keys (never the key itself)
 *   POST   /keys                       new key — the key is in the answer, once
 *   DELETE /keys/:id                   revoke
 *   GET    /webhooks                   webhooks
 *   POST   /webhooks                   new webhook — the secret is in the answer, once
 *   PATCH  /webhooks/:id               name, url, events, active
 *   POST   /webhooks/:id/rotate        new secret, shown once
 *   POST   /webhooks/:id/ping          send a test delivery now
 *   GET    /webhooks/:id/deliveries    the latest deliveries
 *   POST   /deliveries/:id/retry       try a failed delivery again now
 *   DELETE /webhooks/:id
 *   GET    /links                      HRMS and CRM links: set up or not, last run of each job
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { and, desc, eq, isNull, or, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db/client.js';
import { companies, integrationDeliveries, integrationKeys, integrationWebhooks, users } from '../../db/schema.js';
import { companyScope, isSuperAdmin, requirePermission } from '../../auth/plugin.js';
import { audit } from '../../lib/audit.js';
import { encryptSecret } from '../../lib/crypto.js';
import { ForbiddenError, NotFoundError, ValidationError } from '../../lib/errors.js';
import { hrmsFor } from '../hrms/client.js';
import { EVENTS, SCOPES, SCOPE_IDS, isInternalHost, isValidEventPattern, newApiKey, newWebhookSecret } from './catalog.js';
import { sendPing } from './dispatcher.js';
import { forgetKeyCache } from './keyAuth.js';
import { jobStates } from './jobStatus.js';

/**
 * The company a new key or webhook belongs to. Company admins: their own.
 * Super admins: the one chosen, or none (= every company) when allCompanies.
 */
function ownerCompany(req: FastifyRequest, body: { companyId?: string | null; allCompanies?: boolean }): string | null {
  if (isSuperAdmin(req.auth)) {
    if (body.allCompanies) return null;
    const id = body.companyId ?? req.auth.companyId ?? undefined;
    if (!id) throw new ValidationError('Choose a company, or all companies');
    return id;
  }
  const scope = companyScope(req, body.companyId ?? undefined);
  if (!scope) throw new ForbiddenError('Not attached to a company');
  return scope;
}

/** Rows a user may see: super admins all (or one company), others their company's only. */
function visible(req: FastifyRequest, col: typeof integrationKeys.companyId | typeof integrationWebhooks.companyId, companyId?: string): SQL | undefined {
  const scope = companyScope(req, companyId);
  if (!scope) return undefined;
  return isSuperAdmin(req.auth) ? or(eq(col, scope), isNull(col)) : eq(col, scope);
}

function assertMine(req: FastifyRequest, rowCompanyId: string | null) {
  if (isSuperAdmin(req.auth)) return;
  if (!rowCompanyId || rowCompanyId !== req.auth.companyId) throw new NotFoundError();
}

const urlSchema = z
  .string()
  .url()
  .max(2000)
  .refine((u) => /^https?:\/\//i.test(u), 'URL must start with https:// (or http://)');
/**
 * Company admins may only point webhooks at public hosts: not this server's
 * own network (localhost, private ranges, docker service names). Super
 * admins may, e.g. for an app on the same server.
 */
function checkUrl(req: FastifyRequest, url: string | undefined) {
  if (!url || isSuperAdmin(req.auth)) return;
  if (isInternalHost(new URL(url).hostname)) throw new ValidationError('Webhook URL must be a public address');
}

const eventsSchema = z
  .array(z.string().max(64))
  .min(1)
  .max(20)
  .refine((l) => l.every(isValidEventPattern), 'Unknown event; use names from the catalog, "*" or "prefix.*"');

const publicHook = (w: typeof integrationWebhooks.$inferSelect, companyName: string | null) => {
  const { secret, ...rest } = w;
  void secret;
  return { ...rest, companyName };
};

export async function connectionRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requirePermission('admin.users'));

  app.get('/catalog', async () => ({
    scopes: Object.entries(SCOPES).map(([id, description]) => ({ id, description })),
    events: Object.entries(EVENTS).map(([id, description]) => ({ id, description })),
  }));

  /* ---------------------------------------------------------------- keys */

  app.get('/keys', async (req) => {
    const q = z.object({ companyId: z.string().uuid().optional() }).parse(req.query);
    const rows = await db
      .select({ k: integrationKeys, companyName: companies.name, createdByName: users.name })
      .from(integrationKeys)
      .leftJoin(companies, eq(integrationKeys.companyId, companies.id))
      .leftJoin(users, eq(integrationKeys.createdBy, users.id))
      .where(visible(req, integrationKeys.companyId, q.companyId))
      .orderBy(desc(integrationKeys.createdAt));
    return {
      keys: rows.map(({ k, companyName, createdByName }) => {
        const { keyHash, ...rest } = k;
        void keyHash;
        return { ...rest, companyName, createdByName };
      }),
    };
  });

  app.post('/keys', async (req) => {
    const body = z
      .object({
        name: z.string().trim().min(2).max(80),
        scopes: z.array(z.enum(SCOPE_IDS as [string, ...string[]])).min(1),
        companyId: z.string().uuid().nullable().optional(),
        allCompanies: z.boolean().optional(),
      })
      .parse(req.body);
    const companyId = ownerCompany(req, body);
    const scopes = [...new Set(body.scopes)];
    if (scopes.includes('transfers.read_pii') && !scopes.includes('transfers.read')) scopes.push('transfers.read');
    const k = newApiKey();
    const [row] = await db
      .insert(integrationKeys)
      .values({ companyId, name: body.name, keyPrefix: k.prefix, keyHash: k.hash, scopes, createdBy: req.auth.userId })
      .returning();
    await audit(req, { action: 'connections.key_create', entityType: 'integration_key', entityId: row.id, after: { name: row.name, scopes, companyId }, companyId });
    const { keyHash, ...rest } = row;
    void keyHash;
    // the only time the key is shown
    return { key: rest, secret: k.key };
  });

  app.delete('/keys/:id', async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const [row] = await db.select().from(integrationKeys).where(eq(integrationKeys.id, id));
    if (!row) throw new NotFoundError();
    assertMine(req, row.companyId);
    if (!row.revokedAt) await db.update(integrationKeys).set({ revokedAt: new Date() }).where(eq(integrationKeys.id, id));
    forgetKeyCache();
    await audit(req, { action: 'connections.key_revoke', entityType: 'integration_key', entityId: id, before: { name: row.name }, companyId: row.companyId });
    return { ok: true };
  });

  /* ------------------------------------------------------------ webhooks */

  app.get('/webhooks', async (req) => {
    const q = z.object({ companyId: z.string().uuid().optional() }).parse(req.query);
    const rows = await db
      .select({ w: integrationWebhooks, companyName: companies.name })
      .from(integrationWebhooks)
      .leftJoin(companies, eq(integrationWebhooks.companyId, companies.id))
      .where(visible(req, integrationWebhooks.companyId, q.companyId))
      .orderBy(desc(integrationWebhooks.createdAt));
    return { webhooks: rows.map((r) => publicHook(r.w, r.companyName)) };
  });

  app.post('/webhooks', async (req) => {
    const body = z
      .object({
        name: z.string().trim().min(2).max(80),
        url: urlSchema,
        events: eventsSchema,
        companyId: z.string().uuid().nullable().optional(),
        allCompanies: z.boolean().optional(),
      })
      .parse(req.body);
    const companyId = ownerCompany(req, body);
    checkUrl(req, body.url);
    const secret = newWebhookSecret();
    const [row] = await db
      .insert(integrationWebhooks)
      .values({ companyId, name: body.name, url: body.url, events: [...new Set(body.events)], secret: encryptSecret(secret), createdBy: req.auth.userId })
      .returning();
    await audit(req, { action: 'connections.webhook_create', entityType: 'integration_webhook', entityId: row.id, after: { name: row.name, url: row.url, events: row.events }, companyId });
    return { webhook: publicHook(row, null), secret };
  });

  async function loadHook(req: FastifyRequest) {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const [row] = await db.select().from(integrationWebhooks).where(eq(integrationWebhooks.id, id));
    if (!row) throw new NotFoundError('Webhook not found');
    assertMine(req, row.companyId);
    return row;
  }

  app.patch('/webhooks/:id', async (req) => {
    const before = await loadHook(req);
    const body = z
      .object({ name: z.string().trim().min(2).max(80).optional(), url: urlSchema.optional(), events: eventsSchema.optional(), active: z.boolean().optional() })
      .parse(req.body);
    checkUrl(req, body.url);
    const [row] = await db
      .update(integrationWebhooks)
      .set({
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.url !== undefined ? { url: body.url } : {}),
        ...(body.events !== undefined ? { events: [...new Set(body.events)] } : {}),
        ...(body.active !== undefined ? { active: body.active } : {}),
        // switching on again starts healthy
        ...(body.active === true && !before.active ? { failingSince: null, lastError: null } : {}),
      })
      .where(eq(integrationWebhooks.id, before.id))
      .returning();
    await audit(req, {
      action: 'connections.webhook_update',
      entityType: 'integration_webhook',
      entityId: row.id,
      before: { name: before.name, url: before.url, events: before.events, active: before.active },
      after: { name: row.name, url: row.url, events: row.events, active: row.active },
      companyId: row.companyId,
    });
    return { webhook: publicHook(row, null) };
  });

  app.post('/webhooks/:id/rotate', async (req) => {
    const row = await loadHook(req);
    const secret = newWebhookSecret();
    await db.update(integrationWebhooks).set({ secret: encryptSecret(secret) }).where(eq(integrationWebhooks.id, row.id));
    await audit(req, { action: 'connections.webhook_rotate', entityType: 'integration_webhook', entityId: row.id, companyId: row.companyId });
    return { secret };
  });

  app.post('/webhooks/:id/ping', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req) => {
    const row = await loadHook(req);
    return { result: await sendPing(row.id) };
  });

  app.get('/webhooks/:id/deliveries', async (req) => {
    const row = await loadHook(req);
    const list = await db
      .select({
        id: integrationDeliveries.id,
        event: integrationDeliveries.event,
        eventKey: integrationDeliveries.eventKey,
        attempts: integrationDeliveries.attempts,
        nextAttemptAt: integrationDeliveries.nextAttemptAt,
        deliveredAt: integrationDeliveries.deliveredAt,
        lastStatus: integrationDeliveries.lastStatus,
        lastError: integrationDeliveries.lastError,
        createdAt: integrationDeliveries.createdAt,
      })
      .from(integrationDeliveries)
      .where(eq(integrationDeliveries.webhookId, row.id))
      .orderBy(desc(integrationDeliveries.createdAt))
      .limit(50);
    return { deliveries: list };
  });

  app.post('/deliveries/:id/retry', async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const [d] = await db
      .select({ d: integrationDeliveries, companyId: integrationWebhooks.companyId })
      .from(integrationDeliveries)
      .innerJoin(integrationWebhooks, eq(integrationDeliveries.webhookId, integrationWebhooks.id))
      .where(eq(integrationDeliveries.id, id));
    if (!d) throw new NotFoundError();
    assertMine(req, d.companyId);
    if (d.d.deliveredAt) return { ok: true, alreadyDelivered: true };
    if (d.d.event === 'ping') throw new ValidationError('Test deliveries are not retried; send a new test');
    // picked up by the next dispatcher run (within 30 seconds)
    await db.update(integrationDeliveries).set({ nextAttemptAt: new Date() }).where(eq(integrationDeliveries.id, id));
    return { ok: true };
  });

  app.delete('/webhooks/:id', async (req) => {
    const row = await loadHook(req);
    await db.delete(integrationWebhooks).where(eq(integrationWebhooks.id, row.id));
    await audit(req, { action: 'connections.webhook_delete', entityType: 'integration_webhook', entityId: row.id, before: { name: row.name, url: row.url }, companyId: row.companyId });
    return { ok: true };
  });

  /* ---------------------------------------------------- outgoing links */

  app.get('/links', async (req) => {
    const scope = companyScope(req);
    const list = await db
      .select({ id: companies.id, slug: companies.slug, name: companies.name })
      .from(companies)
      .where(scope ? and(eq(companies.id, scope), eq(companies.status, 'active')) : eq(companies.status, 'active'));
    const hrmsUrl = process.env.HRMS_URL?.trim() || null;
    const crmUrl = process.env.CRM_URL?.trim() || null;
    const jobs = await jobStates();
    const pick = (names: string[]) => Object.fromEntries(names.map((n) => [n, jobs[n] ?? null]));
    return {
      hrms: {
        url: hrmsUrl,
        // which companies have an HRMS key (never the key)
        companies: list.map((c) => ({ slug: c.slug, name: c.name, configured: !!hrmsFor(c.slug) })),
        jobs: pick(['hrms-qa-scores', 'hrms-attendance', 'hrms-sales']),
        enabled: {
          'hrms-qa-scores': !!hrmsUrl,
          'hrms-attendance': !!hrmsUrl && process.env.HRMS_PUSH_ATTENDANCE !== 'false',
          'hrms-sales': !!hrmsUrl && process.env.HRMS_PUSH_SALES === 'true',
        },
      },
      crm: {
        url: crmUrl,
        configured: !!crmUrl && !!process.env.CRM_API_KEY?.trim(),
        jobs: pick(['crm-qa-scores']),
        enabled: { 'crm-qa-scores': !!crmUrl && !!process.env.CRM_API_KEY?.trim() },
      },
      webhooks: { jobs: pick(['webhooks']) },
    };
  });
}
