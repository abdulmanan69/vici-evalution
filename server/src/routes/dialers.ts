import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, desc, eq, type SQL } from 'drizzle-orm';
import { db } from '../db/client.js';
import { dialerServers, syncJobs } from '../db/schema.js';
import { companyScope, requiredCompanyScope, requirePermission } from '../auth/plugin.js';
import { audit } from '../lib/audit.js';
import { NotFoundError } from '../lib/errors.js';
import { encryptSecret } from '../lib/crypto.js';
import { testDialerConnection } from '../vicidial/sync.js';
import { enqueueDialerSync } from '../lib/queue.js';

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
    const q = req.query as { companyId?: string };
    const scope = companyScope(req, q.companyId);
    const where: SQL[] = [];
    if (scope) where.push(eq(dialerServers.companyId, scope));
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
    return reply.status(201).send({ dialer: publicDialer(row) });
  });

  app.patch('/:id', { preHandler: [requirePermission('admin.dialers')] }, async (req) => {
    const { id } = req.params as { id: string };
    const body = dialerSchema.partial().parse(req.body);
    const [before] = await db.select().from(dialerServers).where(eq(dialerServers.id, id));
    if (!before) throw new NotFoundError('Dialer not found');
    companyScope(req, before.companyId); // throws on cross-company access

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

    const [row] = await db.update(dialerServers).set(set).where(eq(dialerServers.id, id)).returning();
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
    const [row] = await db.select().from(dialerServers).where(eq(dialerServers.id, id));
    if (!row) throw new NotFoundError('Dialer not found');
    companyScope(req, row.companyId);
    const result = await testDialerConnection(id);
    await audit(req, { action: 'dialer.test', entityType: 'dialer', entityId: id, after: result, companyId: row.companyId });
    return result;
  });

  app.post('/:id/sync', { preHandler: [requirePermission('admin.sync')] }, async (req) => {
    const { id } = req.params as { id: string };
    const q = req.query as { full?: string };
    const [row] = await db.select().from(dialerServers).where(eq(dialerServers.id, id));
    if (!row) throw new NotFoundError('Dialer not found');
    companyScope(req, row.companyId);
    await enqueueDialerSync(id, q.full === 'true');
    await audit(req, { action: 'dialer.sync_trigger', entityType: 'dialer', entityId: id, companyId: row.companyId });
    return { queued: true };
  });

  app.get('/:id/jobs', { preHandler: [requirePermission('admin.sync')] }, async (req) => {
    const { id } = req.params as { id: string };
    const [row] = await db.select().from(dialerServers).where(eq(dialerServers.id, id));
    if (!row) throw new NotFoundError('Dialer not found');
    companyScope(req, row.companyId);
    const jobs = await db
      .select()
      .from(syncJobs)
      .where(eq(syncJobs.dialerServerId, id))
      .orderBy(desc(syncJobs.createdAt))
      .limit(50);
    return { jobs };
  });
}
