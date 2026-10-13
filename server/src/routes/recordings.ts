import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { request } from 'undici';
import { db } from '../db/client.js';
import { dialerServers, recordings } from '../db/schema.js';
import { companyScope, requirePermission } from '../auth/plugin.js';
import { audit } from '../lib/audit.js';
import { NotFoundError } from '../lib/errors.js';
import { toConnection } from '../vicidial/credentials.js';

/**
 * Recordings are never exposed by predictable URLs. The browser only ever
 * talks to this authenticated, company-scoped proxy, which streams from the
 * dialer's recording webserver with Range support (seek/pause/speed work).
 */
export async function recordingRoutes(app: FastifyInstance): Promise<void> {
  app.get('/:id', { preHandler: [requirePermission('recordings.play')] }, async (req) => {
    const { id } = req.params as { id: string };
    const [rec] = await db.select().from(recordings).where(eq(recordings.id, id));
    if (!rec) throw new NotFoundError('Recording not found');
    companyScope(req, rec.companyId);
    const { raw, ...meta } = rec;
    return { recording: meta };
  });

  app.get('/:id/stream', { preHandler: [requirePermission('recordings.play')] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const [rec] = await db.select().from(recordings).where(eq(recordings.id, id));
    if (!rec) throw new NotFoundError('Recording not found');
    companyScope(req, rec.companyId); // strict company isolation

    if (rec.isMock) {
      throw new NotFoundError('Mock recording has no audio');
    }

    const [dialer] = await db.select().from(dialerServers).where(eq(dialerServers.id, rec.dialerServerId));
    if (!dialer) throw new NotFoundError('Dialer not found');
    const conn = toConnection(dialer);

    // Resolve the upstream URL: absolute location from VICIdial, or
    // recordingBaseUrl + filename as fallback.
    let url: string | null = null;
    if (rec.locationUrl && /^https?:\/\//i.test(rec.locationUrl)) {
      url = rec.locationUrl;
    } else if (conn.recordingBaseUrl) {
      url = `${conn.recordingBaseUrl}/${encodeURIComponent(rec.filename)}`;
    }
    if (!url) throw new NotFoundError('No playable location known for this recording');

    const headers: Record<string, string> = {};
    if (req.headers.range) headers.range = req.headers.range;
    if (conn.recordingAuth) {
      headers.authorization =
        'Basic ' + Buffer.from(`${conn.recordingAuth.user}:${conn.recordingAuth.pass}`).toString('base64');
    }

    const upstream = await request(url, { method: 'GET', headers, headersTimeout: 15_000 });
    if (upstream.statusCode === 404) {
      await db
        .update(recordings)
        .set({ status: 'missing', lastCheckedAt: new Date(), updatedAt: new Date() })
        .where(eq(recordings.id, id));
      throw new NotFoundError('Recording file missing on the dialer');
    }
    if (upstream.statusCode >= 400) {
      throw new NotFoundError(`Upstream recording server returned ${upstream.statusCode}`);
    }

    await audit(req, {
      action: 'recording.play',
      entityType: 'recording',
      entityId: id,
      companyId: rec.companyId,
    });

    reply.status(upstream.statusCode);
    const h = upstream.headers;
    reply.header('content-type', (h['content-type'] as string) ?? 'audio/mpeg');
    reply.header('accept-ranges', (h['accept-ranges'] as string) ?? 'bytes');
    if (h['content-length']) reply.header('content-length', h['content-length'] as string);
    if (h['content-range']) reply.header('content-range', h['content-range'] as string);
    reply.header('cache-control', 'private, no-store');
    return reply.send(upstream.body);
  });
}
