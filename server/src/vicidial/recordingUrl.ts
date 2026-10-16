import { and, eq, sql } from 'drizzle-orm';
import { request } from 'undici';
import { db } from '../db/client.js';
import { recordings } from '../db/schema.js';
import type { DialerConnection } from './types.js';

/**
 * VICIdial writes a recording as /RECORDINGS/<name>-all.wav while the call is
 * up, then converts it and moves it to /RECORDINGS/MP3/<name>-all.mp3 — the
 * wav URL dies minutes later. recording_lookup can also return no location
 * yet (still recording) or a shifted column (a number) instead of a URL.
 * These helpers turn whatever we have into the URL that works now.
 */

export function isHttpUrl(v: string | null | undefined): v is string {
  return !!v && /^https?:\/\/[^\s]+$/i.test(v.trim());
}

/** "20261015-174854_2039013302-all.wav" → "20261015-174854_2039013302" */
export function recordingBaseName(filename: string): string {
  const leaf = filename.split('/').pop() ?? filename;
  return leaf.replace(/\.(wav|mp3|gsm|ogg)$/i, '').replace(/-all$/i, '');
}

/** the converted MP3 location for a raw /RECORDINGS/...wav URL, else null */
export function mp3Variant(url: string): string | null {
  const m = /^(https?:\/\/[^/]+)(\/.*?)?\/RECORDINGS\/(?!MP3\/)([^/]+?)(?:-all)?\.wav$/i.exec(url);
  if (!m) return null;
  return `${m[1]}${m[2] ?? ''}/RECORDINGS/MP3/${m[3]}-all.mp3`;
}

export function isFinalMp3(url: string): boolean {
  return /\/RECORDINGS\/MP3\/[^/]+\.mp3$/i.test(url);
}

/** Ordered URLs worth trying for a recording, best first, de-duplicated. */
export function candidateUrls(
  rec: { locationUrl: string | null; filename: string },
  hosts: string[],
): string[] {
  const out: string[] = [];
  const loc = isHttpUrl(rec.locationUrl) ? rec.locationUrl.trim() : null;
  if (loc) {
    const mp3 = mp3Variant(loc);
    if (mp3) out.push(mp3);
    out.push(loc);
  }
  const base = recordingBaseName(rec.filename);
  if (/^\d{8}-\d{6}_/.test(base)) {
    const origin = loc ? new URL(loc).origin : null;
    for (const h of origin ? [origin, ...hosts.filter((x) => x !== origin)] : hosts) {
      out.push(`${h}/RECORDINGS/MP3/${base}-all.mp3`);
    }
  }
  return [...new Set(out)];
}

const hostCache = new Map<string, { at: number; hosts: string[] }>();

/** Recording webservers this dialer uses, learned from working URLs. */
export async function knownRecordingHosts(dialerServerId: string, baseUrl?: string): Promise<string[]> {
  const hit = hostCache.get(dialerServerId);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.hosts;
  const rows = await db
    .select({ origin: sql<string>`substring(${recordings.locationUrl} from '^(https?://[^/]+)')` })
    .from(recordings)
    .where(
      and(
        eq(recordings.dialerServerId, dialerServerId),
        eq(recordings.status, 'available'),
        sql`${recordings.locationUrl} like '%/RECORDINGS/MP3/%'`,
        sql`${recordings.updatedAt} > now() - interval '14 days'`,
      ),
    )
    .groupBy(sql`1`)
    .orderBy(sql`count(*) desc`)
    .limit(6);
  const hosts = rows.map((r) => r.origin).filter(Boolean);
  if (baseUrl) {
    try {
      const o = new URL(baseUrl).origin;
      if (!hosts.includes(o)) hosts.push(o);
    } catch {
      /* not a URL */
    }
  }
  hostCache.set(dialerServerId, { at: Date.now(), hosts });
  return hosts;
}

export function recordingAuthHeader(conn: DialerConnection): Record<string, string> {
  if (!conn.recordingAuth) return {};
  return {
    authorization:
      'Basic ' + Buffer.from(`${conn.recordingAuth.user}:${conn.recordingAuth.pass}`).toString('base64'),
  };
}

/** true when the file is there and not empty */
export async function probeUrl(url: string, conn: DialerConnection): Promise<boolean> {
  try {
    const res = await request(url, {
      method: 'HEAD',
      headers: recordingAuthHeader(conn),
      headersTimeout: 8_000,
      bodyTimeout: 8_000,
    });
    res.body.resume();
    if (res.statusCode < 200 || res.statusCode >= 300) return false;
    const len = Number(res.headers['content-length'] ?? '1');
    return !Number.isFinite(len) || len > 0;
  } catch {
    return false;
  }
}

/** The first candidate that answers, or null. */
export async function resolveRecordingUrl(
  rec: { locationUrl: string | null; filename: string; dialerServerId: string },
  conn: DialerConnection,
): Promise<string | null> {
  const hosts = await knownRecordingHosts(rec.dialerServerId, conn.recordingBaseUrl);
  for (const url of candidateUrls(rec, hosts)) {
    if (await probeUrl(url, conn)) return url;
  }
  return null;
}

/**
 * The lead's call leg a recording belongs to (start within 15 min). Cost =
 * start gap + half the END gap, capped at 60 s. Start time alone mis-links
 * back-to-back calls (a 3 s no-answer 9 s away beat the 253 s XFER call 10 s
 * away); raw length is wrong too, because a closer's recording is often far
 * shorter than the closer call (hold, queue time) — the cap keeps that from
 * pulling it onto the fronter's call, while a fronter recording that ends
 * exactly at the handoff still wins over a 2 s answering-machine call.
 */
export function linkRecordingToCall(
  startTime: Date,
  lengthSec: number | null,
  leadCalls: Array<{ id: string; callDate: Date; lengthSec: number | null }>,
): string | null {
  let bestId: string | null = null;
  let bestCost = Infinity;
  const recStart = startTime.getTime() / 1000;
  for (const lc of leadCalls) {
    const callStart = lc.callDate.getTime() / 1000;
    const startGap = Math.abs(callStart - recStart);
    if (startGap > 15 * 60) continue;
    const endGap =
      lengthSec != null && lc.lengthSec != null ? Math.abs(callStart + lc.lengthSec - (recStart + lengthSec)) : 0;
    const cost = startGap + 0.5 * Math.min(endGap, 60);
    if (cost < bestCost) {
      bestCost = cost;
      bestId = lc.id;
    }
  }
  return bestId;
}
