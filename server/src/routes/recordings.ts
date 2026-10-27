import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { request, type Dispatcher } from 'undici';
import { db } from '../db/client.js';
import { calls, dialerServers, recordings } from '../db/schema.js';
import { isCallInProgress } from '../services/callRecordings.js';
import { companyScope, requirePermission } from '../auth/plugin.js';
import { audit } from '../lib/audit.js';
import { NotFoundError } from '../lib/errors.js';
import { toConnection } from '../vicidial/credentials.js';
import { isFinalMp3, isHttpUrl, recordingAuthHeader, resolveRecordingUrl } from '../vicidial/recordingUrl.js';

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
    if (isHttpUrl(rec.locationUrl)) {
      url = rec.locationUrl;
    } else if (conn.recordingBaseUrl) {
      url = `${conn.recordingBaseUrl}/${encodeURIComponent(rec.filename)}`;
    }

    const headers: Record<string, string> = { ...recordingAuthHeader(conn) };
    if (req.headers.range) headers.range = req.headers.range;
    // gone = the server said the file is not there; down = it did not answer
    const fetchUpstream = async (u: string): Promise<{ res?: Dispatcher.ResponseData; gone?: boolean; down?: boolean }> => {
      try {
        const res = await request(u, { method: 'GET', headers, headersTimeout: 10_000 });
        if (res.statusCode < 400) return { res };
        res.body.resume();
        return res.statusCode === 404 || res.statusCode === 410 || res.statusCode === 403 ? { gone: true } : { down: true };
      } catch {
        return { down: true };
      }
    };

    let attempt = url ? await fetchUpstream(url) : { gone: true };
    let upstream = attempt.res ?? null;
    if (!upstream && attempt.gone) {
      // the stored URL went stale (a .wav the dialer converted to MP3, or no
      // URL yet) — find where the file lives now and remember it
      const { url: fresh, certain } = await resolveRecordingUrl(rec, conn);
      if (fresh) {
        attempt = await fetchUpstream(fresh);
        upstream = attempt.res ?? null;
        if (upstream) {
          await db
            .update(recordings)
            .set({
              locationUrl: fresh,
              status: 'available',
              checkAttempts: isFinalMp3(fresh) ? 0 : 1,
              lastCheckedAt: new Date(),
              updatedAt: new Date(),
            })
            .where(eq(recordings.id, id));
          url = fresh;
        }
      } else if (!certain) {
        attempt = { down: true };
      }
    }
    if (!upstream && attempt.down) {
      // a slow dialer must not change what we know about the recording
      return reply.code(503).send({
        error: 'dialer_unreachable',
        message: "The dialer's recording server did not answer — try again in a moment",
      });
    }
    if (!upstream || !url) {
      // the repair job keeps retrying it with backoff
      await db
        .update(recordings)
        .set({ status: 'pending', lastCheckedAt: null, updatedAt: new Date() })
        .where(eq(recordings.id, id));
      throw new NotFoundError('Recording is not on the dialer yet — it will appear once the dialer finishes it');
    }
    if (!isFinalMp3(url)) {
      // a raw .wav mid-call has no usable header (browsers see 0 s) — only
      // serve it once the call has ended and the file is closed
      const [call] = rec.callId
        ? await db.select({ lengthSec: calls.lengthSec, status: calls.status }).from(calls).where(eq(calls.id, rec.callId))
        : [];
      if (isCallInProgress(call)) {
        upstream.body.resume();
        throw new NotFoundError('Still recording — the file becomes playable right after the call ends');
      }
    }

    // One audit row per play, not per byte range: the player asks for many
    // ranges while it seeks, and none of them should wait on the insert.
    const range = req.headers.range;
    if (!range || /^bytes=0-/.test(range)) {
      void audit(req, {
        action: 'recording.play',
        entityType: 'recording',
        entityId: id,
        companyId: rec.companyId,
      }).catch((err: unknown) => req.log.warn({ err }, 'recording.play audit failed'));
    }

    reply.status(upstream.statusCode);
    const h = upstream.headers;
    // VICIdial recording webservers often send application/forcedownload,
    // which <audio> refuses — derive a real audio type from the extension.
    const upstreamType = (h['content-type'] as string | undefined)?.toLowerCase();
    const ext = url.toLowerCase().split('?')[0].split('.').pop();
    const extType =
      ext === 'wav' ? 'audio/wav' : ext === 'ogg' ? 'audio/ogg' : ext === 'gsm' ? 'audio/gsm' : 'audio/mpeg';
    reply.header('content-type', upstreamType?.startsWith('audio/') ? upstreamType : extType);
    reply.header('accept-ranges', (h['accept-ranges'] as string) ?? 'bytes');
    if (h['content-length']) reply.header('content-length', h['content-length'] as string);
    if (h['content-range']) reply.header('content-range', h['content-range'] as string);
    reply.header('cache-control', 'private, no-store');
    return reply.send(upstream.body);
  });
}
