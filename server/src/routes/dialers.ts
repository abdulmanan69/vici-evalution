import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { and, desc, eq, isNull, type SQL } from 'drizzle-orm';
import { db } from '../db/client.js';
import { dialerServers, syncJobs } from '../db/schema.js';
import { companyScope, requiredCompanyScope, requirePermission } from '../auth/plugin.js';
import { audit } from '../lib/audit.js';
import { ConflictError, NotFoundError, ValidationError } from '../lib/errors.js';
import { encryptSecret } from '../lib/crypto.js';
import { testDialerConnection } from '../vicidial/sync.js';
import { dropQueuedSyncs, enqueueDialerPurge, enqueueDialerSync } from '../lib/queue.js';
import { closePooledDbClient } from '../vicidial/dbPool.js';
import { dialerUsage } from '../services/purge.js';
import { ensureDefaultMappings } from '../services/defaultMappings.js';

/** A dialer the caller may manage, or a 404 / 403. */
async function loadDialer(req: FastifyRequest, id: string) {
  const parsed = z.string().uuid().safeParse(id);
  if (!parsed.success) throw new NotFoundError('Dialer not found');
  const [row] = await db.select().from(dialerServers).where(eq(dialerServers.id, id));
  if (!row) throw new NotFoundError('Dialer not found');
  companyScope(req, row.companyId); // throws on cross-company access
  return row;
}

function assertNotDeleting(row: typeof dialerServers.$inferSelect): void {
  if (row.deletingAt) throw new ConflictError('This dialer is being deleted');
}

const dialerSchema = z.object({
  companyId: z.string().uuid().optional(),
  name: z.string().min(2).max(200),
  baseUrl: z.string().url(),
  sourceMode: z.enum(['api', 'db', 'hybrid']).default('hybrid'),
  timezone: z.string().min(1).max(64).default('UTC'),
  active: z.boolean().default(true),
  apiUser: z.string().max(100).optional(),
  apiPass: z.string().max(200).optional(),
  dbHost: z.string().max(255).optional(),
  dbPort: z.number().int().min(1).max(65535).optional(),
  dbName: z.string().max(64).optional(),
  dbUser: z.string().max(64).optional(),
  dbPass: z.string().max(200).optional(),
  recordingBaseUrl: z.string().url().optional(),
  recordingAuthUser: z.string().max(100).optional(),
  recordingAuthPass: z.string().max(200).optional(),
});

/** Strips encrypted secrets before returning a dialer row to the client. */
function publicDialer(row: typeof dialerServers.$inferSelect) {
  const {
    apiUserEnc,
    apiPassEnc,
    dbUserEnc,
    dbPassEnc,
    recordingAuthUserEnc,
    recordingAuthPassEnc,
    ...rest
  } = row;
  return {
    ...rest,
    hasApiCredentials: !!(apiUserEnc && apiPassEnc),
    hasDbCredentials: !!(dbUserEnc && dbPassEnc && row.dbHost),
    hasRecordingAuth: !!(recordingAuthUserEnc && recordingAuthPassEnc),
  };
}

export async function dialerRoutes(app: FastifyInstance): Promise<void> {
  app.get('/', { preHandler: [requirePermission('admin.dialers')] }, async (req) => {
    const q = req.query as { companyId?: string; includeDeleting?: string };
    const scope = companyScope(req, q.companyId);
    const where: SQL[] = [];
    if (scope) where.push(eq(dialerServers.companyId, scope));
    // pickers never offer a dialer that is being deleted; the admin page
    // shows it with its progress
    if (q.includeDeleting !== 'true') where.push(isNull(dialerServers.deletingAt));
    const rows = await db
      .select()
      .from(dialerServers)
      .where(where.length ? and(...where) : undefined)
      .orderBy(dialerServers.name);
    return { dialers: rows.map(publicDialer) };
  });

  app.post('/', { preHandler: [requirePermission('admin.dialers')] }, async (req, reply) => {
    const body = dialerSchema.parse(req.body);
    const companyId = requiredCompanyScope(req, body.companyId);
    const [row] = await db
      .insert(dialerServers)
      .values({
        companyId,
        name: body.name,
        baseUrl: body.baseUrl,
        sourceMode: body.sourceMode,
        timezone: body.timezone,
        active: body.active,
        apiUserEnc: body.apiUser ? encryptSecret(body.apiUser) : null,
        apiPassEnc: body.apiPass ? encryptSecret(body.apiPass) : null,
        dbHost: body.dbHost ?? null,
        dbPort: body.dbPort ?? null,
        dbName: body.dbName ?? null,
        dbUserEnc: body.dbUser ? encryptSecret(body.dbUser) : null,
        dbPassEnc: body.dbPass ? encryptSecret(body.dbPass) : null,
        recordingBaseUrl: body.recordingBaseUrl ?? null,
        recordingAuthUserEnc: body.recordingAuthUser ? encryptSecret(body.recordingAuthUser) : null,
        recordingAuthPassEnc: body.recordingAuthPass ? encryptSecret(body.recordingAuthPass) : null,
      })
      .returning();
    await audit(req, {
      action: 'dialer.create',
      entityType: 'dialer',
      entityId: row.id,
      after: publicDialer(row), // never audit-log secrets
      companyId,
    });
    // a new company can recognise transfers and sales straight away, and the
    // dialer starts importing its last 7 days now rather than on the next tick
    await ensureDefaultMappings(companyId, req.auth.userId);
    if (row.active) await enqueueDialerSync(row.id, true);
    return reply.status(201).send({ dialer: publicDialer(row) });
  });

  app.patch('/:id', { preHandler: [requirePermission('admin.dialers')] }, async (req) => {
    const { id } = req.params as { id: string };
    const body = dialerSchema.partial().parse(req.body);
    const before = await loadDialer(req, id);
    assertNotDeleting(before);

    const set: Partial<typeof dialerServers.$inferInsert> = { updatedAt: new Date() };
    if (body.name !== undefined) set.name = body.name;
    if (body.baseUrl !== undefined) set.baseUrl = body.baseUrl;
    if (body.sourceMode !== undefined) set.sourceMode = body.sourceMode;
    if (body.timezone !== undefined) set.timezone = body.timezone;
    if (body.active !== undefined) set.active = body.active;
    if (body.apiUser !== undefined) set.apiUserEnc = body.apiUser ? encryptSecret(body.apiUser) : null;
    if (body.apiPass !== undefined) set.apiPassEnc = body.apiPass ? encryptSecret(body.apiPass) : null;
    if (body.dbHost !== undefined) set.dbHost = body.dbHost || null;
    if (body.dbPort !== undefined) set.dbPort = body.dbPort ?? null;
    if (body.dbName !== undefined) set.dbName = body.dbName || null;
    if (body.dbUser !== undefined) set.dbUserEnc = body.dbUser ? encryptSecret(body.dbUser) : null;
    if (body.dbPass !== undefined) set.dbPassEnc = body.dbPass ? encryptSecret(body.dbPass) : null;
    if (body.recordingBaseUrl !== undefined) set.recordingBaseUrl = body.recordingBaseUrl || null;
    if (body.recordingAuthUser !== undefined)
      set.recordingAuthUserEnc = body.recordingAuthUser ? encryptSecret(body.recordingAuthUser) : null;
    if (body.recordingAuthPass !== undefined)
      set.recordingAuthPassEnc = body.recordingAuthPass ? encryptSecret(body.recordingAuthPass) : null;

    // new connection details or a corrected time zone: re-import the window
    // so nothing missed (or mis-timed) under the old settings stays wrong
    const reconnect = ['baseUrl', 'sourceMode', 'timezone', 'apiUser', 'apiPass', 'dbHost', 'dbPort', 'dbName', 'dbUser', 'dbPass'].some(
      (k) => body[k as keyof typeof body] !== undefined && (k.endsWith('User') || k.endsWith('Pass') || body[k as keyof typeof body] !== before[k as keyof typeof before]),
    );
    if (reconnect) set.backfilledAt = null;
    const [row] = await db.update(dialerServers).set(set).where(eq(dialerServers.id, id)).returning();
    if (reconnect && row.active) await enqueueDialerSync(id, true);
    await audit(req, {
      action: 'dialer.update',
      entityType: 'dialer',
      entityId: id,
      before: publicDialer(before),
      after: publicDialer(row),
      companyId: before.companyId,
    });
    return { dialer: publicDialer(row) };
  });

  app.post('/:id/test', { preHandler: [requirePermission('admin.dialers')] }, async (req) => {
    const { id } = req.params as { id: string };
    const row = await loadDialer(req, id);
    assertNotDeleting(row);
    const result = await testDialerConnection(id);
    await audit(req, { action: 'dialer.test', entityType: 'dialer', entityId: id, after: result, companyId: row.companyId });
    return result;
  });

  app.post('/:id/sync', { preHandler: [requirePermission('admin.sync')] }, async (req) => {
    const { id } = req.params as { id: string };
    const q = req.query as { full?: string };
    const row = await loadDialer(req, id);
    assertNotDeleting(row);
    await enqueueDialerSync(id, q.full === 'true');
    await audit(req, { action: 'dialer.sync_trigger', entityType: 'dialer', entityId: id, companyId: row.companyId });
    return { queued: true };
  });

  app.get('/:id/jobs', { preHandler: [requirePermission('admin.sync')] }, async (req) => {
    const { id } = req.params as { id: string };
    await loadDialer(req, id);
    const jobs = await db
      .select()
      .from(syncJobs)
      .where(eq(syncJobs.dialerServerId, id))
      .orderBy(desc(syncJobs.createdAt))
      .limit(50);
    return { jobs };
  });

  // What a delete would remove — the confirmation dialog shows it first.
  app.get('/:id/usage', { preHandler: [requirePermission('admin.dialers')] }, async (req) => {
    const { id } = req.params as { id: string };
    await loadDialer(req, id);
    return { usage: await dialerUsage(id) };
  });

  // Delete a dialer with all its calls, recordings, transfers and their
  // evaluations. The admin types the dialer's name to confirm. The dialer
  // stops syncing and leaves every picker at once; the worker removes the
  // data in the background (services/purge.ts) and finally the dialer row.
  app.delete('/:id', { preHandler: [requirePermission('admin.dialers')] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z.object({ confirmName: z.string().max(200) }).parse(req.body ?? {});
    const row = await loadDialer(req, id);
    if (row.deletingAt) {
      // already on its way out — make sure the background job exists
      await enqueueDialerPurge(id);
      return reply.status(202).send({ deleting: true });
    }
    if (body.confirmName.trim() !== row.name.trim()) {
      throw new ValidationError('Type the dialer name exactly as shown to confirm');
    }
    const usage = await dialerUsage(id);
    await db
      .update(dialerServers)
      .set({ active: false, deletingAt: new Date(), updatedAt: new Date() })
      .where(eq(dialerServers.id, id));
    await dropQueuedSyncs(id);
    closePooledDbClient(id);
    await enqueueDialerPurge(id);
    await audit(req, {
      action: 'dialer.delete',
      entityType: 'dialer',
      entityId: id,
      before: publicDialer(row),
      after: { usage },
      companyId: row.companyId,
    });
    return reply.status(202).send({ deleting: true, usage });
  });
}
