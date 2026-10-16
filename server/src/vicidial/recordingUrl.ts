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
    const ordered = origin ? [origin, ...hosts.filter((x) => x !== origin)] : hosts;
    for (const h of ordered) out.push(`${h}/RECORDINGS/MP3/${base}-all.mp3`);
    // the raw file while the dialer is still recording (plays as a partial)
    for (const h of ordered) out.push(`${h}/RECORDINGS/${base}-all.wav`);
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

/**
 * found = the file is there and not empty; absent = the server says it is
 * not; unknown = the server did not answer (slow or down) — nothing learned.
 */
export type Probe = 'found' | 'absent' | 'unknown';

export async function probeUrl(url: string, conn: DialerConnection): Promise<Probe> {
  try {
    const res = await request(url, {
      method: 'HEAD',
      headers: recordingAuthHeader(conn),
      headersTimeout: 8_000,
      bodyTimeout: 8_000,
    });
    res.body.resume();
    if (res.statusCode >= 200 && res.statusCode < 300) {
      const len = Number(res.headers['content-length'] ?? '1');
      return !Number.isFinite(len) || len > 0 ? 'found' : 'absent';
    }
    if (res.statusCode === 404 || res.statusCode === 410 || res.statusCode === 403) return 'absent';
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

export interface Resolved {
  url: string | null;
  /** false when the dialer did not answer for some candidate — a null url then means "unknown", not "gone" */
  certain: boolean;
}

/** The first candidate that answers, with whether a miss is trustworthy. */
export async function resolveRecordingUrl(
  rec: { locationUrl: string | null; filename: string; dialerServerId: string },
  conn: DialerConnection,
): Promise<Resolved> {
  const hosts = await knownRecordingHosts(rec.dialerServerId, conn.recordingBaseUrl);
  let certain = true;
  for (const url of candidateUrls(rec, hosts)) {
    const p = await probeUrl(url, conn);
    if (p === 'found') return { url, certain: true };
    if (p === 'unknown') certain = false;
  }
  return { url: null, certain };
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

export type RecordingRow = typeof recordings.$inferSelect;

/**
 * Probe the dialer for this recording now and store the outcome. While the
 * call is still up (`inProgress`) a file that is not there yet stays
 * 'pending' and does not count toward 'missing'.
 */
export async function refreshRecording(
  rec: RecordingRow,
  conn: DialerConnection,
  opts: { inProgress?: boolean } = {},
): Promise<RecordingRow> {
  const { url, certain } = await resolveRecordingUrl(rec, conn);
  const now = new Date();
  let patch: Partial<RecordingRow>;
  if (!url && !certain) {
    // the dialer did not answer: a slow server must never turn a known
    // recording into 'missing' — leave the state alone, try again later
    patch = { lastCheckedAt: now, updatedAt: now };
  } else if (url && opts.inProgress && !isFinalMp3(url)) {
    // the raw .wav is still being written: its header says 0 seconds and
    // browsers cannot play it — keep the location, stay pending until hangup
    patch = { locationUrl: url, status: 'pending', lastCheckedAt: now, updatedAt: now };
  } else if (url) {
    patch = {
      locationUrl: url,
      status: 'available',
      // a .wav that still answers is re-checked until its MP3 exists
      checkAttempts: isFinalMp3(url) ? 0 : 1,
      lastCheckedAt: now,
      updatedAt: now,
    };
  } else {
    const attempts = opts.inProgress ? rec.checkAttempts : rec.checkAttempts + 1;
    const ageMin = (now.getTime() - (rec.startTime ?? rec.createdAt).getTime()) / 60_000;
    // the dialer needs a few minutes after hangup to mix and convert a file
    const gaveUp = !opts.inProgress && ageMin > 30 && attempts >= 3;
    // a recording the dialer started and dropped at once (0 s, no file ever)
    // — e.g. an unanswered dial; there is nothing to fetch, stop asking
    const ghost = !opts.inProgress && rec.lengthSec === 0 && ageMin > 10;
    patch = {
      status: opts.inProgress ? 'pending' : ghost || gaveUp || rec.status === 'missing' ? 'missing' : 'pending',
      checkAttempts: ghost ? 12 : Math.min(attempts, 12),
      lastCheckedAt: now,
      updatedAt: now,
    };
  }
  await db.update(recordings).set(patch).where(eq(recordings.id, rec.id));
  return { ...rec, ...patch };
}
