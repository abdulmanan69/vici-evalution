import { and, desc, eq, gte, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { db } from '../db/client.js';
import {
  calls,
  campaigns,
  dialerServers,
  dispositionMappings,
  ingroups,
  recordings,
  syncCursors,
  syncJobs,
  transferEvents,
  transfers,
  viciAgents,
} from '../db/schema.js';
import { config } from '../config.js';
import { toConnection } from './credentials.js';
import { ViciApiClient } from './apiClient.js';
import { ViciDbClient } from './dbClient.js';
import {
  currentOffsetMin,
  localToUtc,
  offsetLocalToUtc,
  utcToLocalString,
  utcToOffsetLocalString,
} from './timezone.js';
import { decideMatch, DEFAULT_MATCH_OPTIONS, normalizePhone, type CloserCandidate } from './matcher.js';
import { resolveMeaning, transition, type MappingRow } from './queueLogic.js';
import type { DialerConnection, ViciCallRow } from './types.js';
import { normalizeRecordingRow } from './apiDerive.js';
import { fetchUserStatsCalls, type UserStatsCall } from './webReport.js';
import { sha256 } from '../lib/crypto.js';

export interface SyncStats {
  [key: string]: number | string[] | undefined;
  notes?: string[];
}

const BATCH_LIMIT = 5000;
/** how far back each cycle re-reads calls whose disposition may still change */
const REFRESH_HOURS = 12;
const RECORDING_LOOKUP_BUDGET_MS = 20_000;
const CURSOR_OVERLAP_MS = 2 * 60 * 1000; // re-read a small overlap to catch late rows
const MATCH_WINDOW_BEFORE_MS = 2 * 60 * 1000;
const MATCH_WINDOW_AFTER_MS = 10 * 60 * 1000;
const PENDING_GRACE_MS = 2 * 60 * 60 * 1000; // keep pending this long before 'unmatched'

/** Full sync pass for one dialer. Idempotent — safe to re-run at any time. */
export async function runDialerSync(
  dialerServerId: string,
  opts: { full?: boolean } = {},
): Promise<SyncStats> {
  const [dialer] = await db.select().from(dialerServers).where(eq(dialerServers.id, dialerServerId));
  if (!dialer) throw new Error(`Dialer ${dialerServerId} not found`);
  if (!dialer.active) throw new Error(`Dialer ${dialer.name} is not active`);

  const conn = toConnection(dialer);
  const stats: SyncStats = { notes: [] };
  const notes = stats.notes as string[];

  // Auto time check: read the dialer's own clock every sync, record offset
  // and drift, and prefer the measured offset when the configured timezone
  // disagrees — call timestamps stay correct even with a wrong zone setting.
  if (conn.apiUser) {
    try {
      const t = await new ViciApiClient(conn).serverTime();
      const nowMs = Date.now();
      const driftSec = t.epoch != null ? Math.round(t.epoch - nowMs / 1000) : null;
      let measuredOffsetMin: number | null = null;
      if (t.localTime) {
        const asUtcMs = Date.parse(`${t.localTime.replace(' ', 'T')}Z`);
        // snap to 15 min to shed request latency and sub-minute drift
        measuredOffsetMin = Math.round((asUtcMs - nowMs) / 60_000 / 15) * 15;
      }
      await db
        .update(dialerServers)
        .set({ tzOffsetMin: measuredOffsetMin, clockDriftSec: driftSec, timeCheckedAt: new Date() })
        .where(eq(dialerServers.id, conn.id));
      if (measuredOffsetMin != null) {
        const cfgOffset = currentOffsetMin(conn.timezone);
        if (Math.abs(cfgOffset - measuredOffsetMin) > 5) {
          conn.measuredOffsetMin = measuredOffsetMin;
          notes.push(
            `timezone mismatch: dialer clock is UTC${fmtOffset(measuredOffsetMin)} but configured zone '${conn.timezone}' is UTC${fmtOffset(cfgOffset)} — using the dialer's measured offset for this sync`,
          );
        }
      }
      if (driftSec != null && Math.abs(driftSec) > 90) {
        notes.push(`dialer clock drifts ${driftSec}s from platform time — fix NTP on the dialer`);
      }
    } catch (err) {
      notes.push(`dialer time check failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const [job] = await db
    .insert(syncJobs)
    .values({ dialerServerId, jobType: opts.full ? 'full' : 'incremental', status: 'running', startedAt: new Date() })
    .returning();

  let viciDb: ViciDbClient | null = null;
  try {
    if ((conn.sourceMode === 'db' || conn.sourceMode === 'hybrid') && conn.db) {
      viciDb = new ViciDbClient(conn);
      await syncRoster(conn, viciDb, stats);
      await syncCallStream(conn, viciDb, 'vicidial_log', stats, opts.full);
      await syncCallStream(conn, viciDb, 'vicidial_closer_log', stats, opts.full);
      await syncRecordingsFromDb(conn, viciDb, stats, opts.full);
    } else if (conn.sourceMode === 'api') {
      // No DB access: synthesize call records from recording_lookup +
      // lead_all_info (verified shapes on this build — see docs).
      await syncApiOnly(conn, stats, opts.full);
    } else {
      notes.push('No usable data source configured (db credentials missing).');
    }

    if (conn.sourceMode === 'hybrid') {
      await syncRecordingsFromApi(conn, stats);
    }

    await buildTransfers(conn, stats);
    await matchPendingTransfers(conn.companyId, stats);
    await attributeSales(conn.companyId, stats);
    await updateQueueStatuses(conn.companyId, stats);

    await db
      .update(dialerServers)
      .set({ lastSeenAt: new Date(), updatedAt: new Date() })
      .where(eq(dialerServers.id, dialerServerId));
    await db
      .update(syncJobs)
      .set({ status: 'success', stats, finishedAt: new Date() })
      .where(eq(syncJobs.id, job.id));
    return stats;
  } catch (err) {
    await db
      .update(syncJobs)
      .set({
        status: 'failed',
        stats,
        error: err instanceof Error ? err.message : String(err),
        finishedAt: new Date(),
      })
      .where(eq(syncJobs.id, job.id));
    throw err;
  } finally {
    await viciDb?.close();
  }
}

function fmtOffset(min: number): string {
  const sign = min < 0 ? '-' : '+';
  const abs = Math.abs(min);
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  return `${sign}${h}${m ? `:${String(m).padStart(2, '0')}` : ''}`;
}

/** Connectivity check used by the admin "test connection" button. */
export async function testDialerConnection(dialerServerId: string): Promise<{
  api: { ok: boolean; detail: string };
  db: { ok: boolean; detail: string };
}> {
  const [dialer] = await db.select().from(dialerServers).where(eq(dialerServers.id, dialerServerId));
  if (!dialer) throw new Error('Dialer not found');
  const conn = toConnection(dialer);

  const result: {
    api: { ok: boolean; detail: string };
    db: { ok: boolean; detail: string };
    time: null | {
      dialerLocalTime: string | null;
      platformUtc: string;
      measuredOffsetMin: number | null;
      configuredOffsetMin: number;
      driftSec: number | null;
      timezoneMatches: boolean;
    };
  } = {
    api: { ok: false, detail: 'No API credentials configured' },
    db: { ok: false, detail: 'No DB credentials configured' },
    time: null,
  };
  if (conn.apiUser) {
    try {
      const t = await new ViciApiClient(conn).serverTime();
      result.api = { ok: true, detail: t.raw };
      const nowMs = Date.now();
      const measuredOffsetMin = t.localTime
        ? Math.round((Date.parse(`${t.localTime.replace(' ', 'T')}Z`) - nowMs) / 60_000 / 15) * 15
        : null;
      const configuredOffsetMin = currentOffsetMin(conn.timezone);
      result.time = {
        dialerLocalTime: t.localTime,
        platformUtc: new Date().toISOString(),
        measuredOffsetMin,
        configuredOffsetMin,
        driftSec: t.epoch != null ? Math.round(t.epoch - nowMs / 1000) : null,
        timezoneMatches: measuredOffsetMin == null || Math.abs(configuredOffsetMin - measuredOffsetMin) <= 5,
      };
    } catch (err) {
      result.api = { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }
  if (conn.db) {
    const client = new ViciDbClient(conn);
    try {
      await client.ping();
      result.db = { ok: true, detail: 'MySQL connection OK' };
    } catch (err) {
      result.db = { ok: false, detail: err instanceof Error ? err.message : String(err) };
    } finally {
      await client.close();
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Roster
// ---------------------------------------------------------------------------
async function syncRoster(conn: DialerConnection, viciDb: ViciDbClient, stats: SyncStats): Promise<void> {
  const [userRows, campRows, groupRows] = await Promise.all([
    viciDb.fetchUsers(),
    viciDb.fetchCampaigns(),
    viciDb.fetchIngroups(),
  ]);

  for (const u of userRows) {
    await db
      .insert(viciAgents)
      .values({
        companyId: conn.companyId,
        dialerServerId: conn.id,
        viciUser: u.user,
        fullName: u.full_name,
        userGroup: u.user_group,
        active: u.active === 'Y',
        raw: u,
        syncedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [viciAgents.dialerServerId, viciAgents.viciUser],
        set: {
          fullName: u.full_name,
          userGroup: u.user_group,
          active: u.active === 'Y',
          raw: u,
          syncedAt: new Date(),
        },
      });
  }
  for (const c of campRows) {
    await db
      .insert(campaigns)
      .values({
        companyId: conn.companyId,
        dialerServerId: conn.id,
        viciCampaignId: c.campaign_id,
        name: c.campaign_name,
        active: c.active === 'Y',
        raw: c,
        syncedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [campaigns.dialerServerId, campaigns.viciCampaignId],
        set: { name: c.campaign_name, active: c.active === 'Y', raw: c, syncedAt: new Date() },
      });
  }
  for (const g of groupRows) {
    await db
      .insert(ingroups)
      .values({
        companyId: conn.companyId,
        dialerServerId: conn.id,
        viciGroupId: g.group_id,
        name: g.group_name,
        raw: g,
        syncedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [ingroups.dialerServerId, ingroups.viciGroupId],
        set: { name: g.group_name, raw: g, syncedAt: new Date() },
      });
  }
  stats.agents = userRows.length;
  stats.campaigns = campRows.length;
  stats.ingroups = groupRows.length;
}

// ---------------------------------------------------------------------------
// Call streams
// ---------------------------------------------------------------------------
async function getCursor(dialerServerId: string, stream: string): Promise<Date | null> {
  const [row] = await db
    .select()
    .from(syncCursors)
    .where(and(eq(syncCursors.dialerServerId, dialerServerId), eq(syncCursors.stream, stream)));
  return row?.lastTimestamp ?? null;
}

async function setCursor(dialerServerId: string, stream: string, ts: Date): Promise<void> {
  await db
    .insert(syncCursors)
    .values({ dialerServerId, stream, lastTimestamp: ts, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: [syncCursors.dialerServerId, syncCursors.stream],
      set: { lastTimestamp: ts, updatedAt: new Date() },
    });
}

function initialWindowStart(full?: boolean): Date {
  // no point importing past the retention window — it would be deleted again
  const cap = config.RETENTION_DAYS > 0 ? config.RETENTION_DAYS : config.SYNC_HISTORICAL_DAYS;
  const days = full ? Math.min(config.SYNC_HISTORICAL_DAYS, cap) : 1;
  return new Date(Date.now() - days * 24 * 3600 * 1000);
}

async function syncCallStream(
  conn: DialerConnection,
  viciDb: ViciDbClient,
  source: 'vicidial_log' | 'vicidial_closer_log',
  stats: SyncStats,
  full?: boolean,
): Promise<void> {
  const cursor = await getCursor(conn.id, source);
  let sinceUtc = cursor ? new Date(cursor.getTime() - CURSOR_OVERLAP_MS) : initialWindowStart(full);
  const untilUtc = new Date();

  // FK lookup maps for this dialer
  const agentMap = new Map<string, string>();
  for (const a of await db
    .select({ id: viciAgents.id, viciUser: viciAgents.viciUser })
    .from(viciAgents)
    .where(eq(viciAgents.dialerServerId, conn.id))) {
    agentMap.set(a.viciUser, a.id);
  }
  const campMap = new Map<string, string>();
  for (const c of await db
    .select({ id: campaigns.id, cid: campaigns.viciCampaignId })
    .from(campaigns)
    .where(eq(campaigns.dialerServerId, conn.id))) {
    campMap.set(c.cid, c.id);
  }
  const groupMap = new Map<string, string>();
  for (const g of await db
    .select({ id: ingroups.id, gid: ingroups.viciGroupId })
    .from(ingroups)
    .where(eq(ingroups.dialerServerId, conn.id))) {
    groupMap.set(g.gid, g.id);
  }

  let imported = 0;
  let skippedNoUid = 0;
  let maxSeen: Date | null = null;

  const runPass = async (archive: boolean, passSinceUtc: Date): Promise<void> => {
    let cursorUtc = passSinceUtc;
    for (;;) {
      const sinceLocal = utcToLocalString(cursorUtc, conn.timezone);
      const untilLocal = utcToLocalString(untilUtc, conn.timezone);
      const rows =
        source === 'vicidial_log'
          ? await viciDb.fetchOutboundCalls(sinceLocal, untilLocal, BATCH_LIMIT, archive)
          : await viciDb.fetchCloserCalls(sinceLocal, untilLocal, BATCH_LIMIT, archive);
      if (rows.length === 0) break;

      for (const row of rows) {
        const callDateUtc = localToUtc(row.call_date, conn.timezone);
        if (!maxSeen || callDateUtc > maxSeen) maxSeen = callDateUtc;
        if (!row.uniqueid) {
          skippedNoUid += 1;
          continue;
        }
        await upsertCall(conn, source, row, callDateUtc, agentMap, campMap, groupMap);
        imported += 1;
      }

      if (rows.length < BATCH_LIMIT) break;
      // advance window past the last processed row (equal timestamps re-read via overlap)
      const last = rows[rows.length - 1];
      cursorUtc = localToUtc(last.call_date, conn.timezone);
    }
  };

  // Full syncs read the *_archive table first: dialers with a nightly archive
  // job keep little or nothing in the live tables beyond the current day.
  if (full) {
    try {
      await runPass(true, initialWindowStart(full));
    } catch (err) {
      (stats.notes as string[]).push(
        `${source}_archive not readable: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  await runPass(false, sinceUtc);
  const cursorAfter = maxSeen;

  // Realtime refresh. A call is written when it starts (status INCALL) and
  // rewritten when the agent dispositions minutes later — after the cursor
  // has moved past it. Re-read the recent window so XFER/SALE land within a
  // cycle: every closer leg (a small table), and outbound legs only when
  // their disposition is now one this company maps (the huge table stays cheap).
  if (!full) {
    const refreshSince = utcToLocalString(new Date(Date.now() - REFRESH_HOURS * 3600 * 1000), conn.timezone);
    const refreshUntil = utcToLocalString(untilUtc, conn.timezone);
    let refreshRows: ViciCallRow[] = [];
    if (source === 'vicidial_closer_log') {
      refreshRows = await viciDb.fetchCloserCalls(refreshSince, refreshUntil, BATCH_LIMIT);
    } else {
      const mapped = await companyMappings(conn.companyId);
      const codes = [
        ...new Set(
          mapped
            .filter((m) => m.meaning === 'transfer' || m.meaning === 'sale')
            .map((m) => m.dispositionCode.trim().toUpperCase()),
        ),
      ];
      refreshRows = await viciDb.fetchOutboundCallsByStatus(refreshSince, refreshUntil, codes, BATCH_LIMIT);
    }
    let refreshed = 0;
    for (const row of refreshRows) {
      if (!row.uniqueid) continue;
      await upsertCall(conn, source, row, localToUtc(row.call_date, conn.timezone), agentMap, campMap, groupMap);
      refreshed += 1;
    }
    stats[`${source}_refreshed`] = refreshed;

    // Self-heal: any call we still hold at a mid-call status (from before
    // this window, or a missed cycle) is re-read by its exact uniqueid from
    // the live and archived tables until it carries its final disposition.
    const stuck = await db
      .select({ uid: calls.viciUniqueId })
      .from(calls)
      .where(
        and(
          eq(calls.dialerServerId, conn.id),
          eq(calls.source, source),
          eq(calls.isMock, false),
          sql`upper(${calls.status}) in ('INCALL', 'QUEUE', 'DISPO', 'DONEM')`,
          sql`${calls.callDate} < now() - interval '30 minutes'`,
        ),
      )
      .limit(500);
    const stuckIds = stuck.map((s) => s.uid).filter((u): u is string => !!u);
    if (stuckIds.length > 0) {
      let healed = 0;
      for (const row of await viciDb.fetchCallsByUniqueIds(source, stuckIds)) {
        if (!row.uniqueid || !row.status || ['INCALL', 'QUEUE', 'DISPO', 'DONEM'].includes(row.status.toUpperCase())) {
          continue;
        }
        await upsertCall(conn, source, row, localToUtc(row.call_date, conn.timezone), agentMap, campMap, groupMap);
        healed += 1;
      }
      stats[`${source}_healed`] = healed;
    }
  }

  if (cursorAfter) await setCursor(conn.id, source, cursorAfter);
  stats[`${source}_imported`] = imported;
  if (skippedNoUid > 0) stats[`${source}_skipped_no_uniqueid`] = skippedNoUid;
}

async function upsertCall(
  conn: DialerConnection,
  source: 'vicidial_log' | 'vicidial_closer_log',
  row: ViciCallRow,
  callDateUtc: Date,
  agentMap: Map<string, string>,
  campMap: Map<string, string>,
  groupMap: Map<string, string>,
): Promise<void> {
  // vicidial_closer_log reuses campaign_id for the in-group id
  const campaignId = source === 'vicidial_log' ? (campMap.get(row.campaign_id ?? '') ?? null) : null;
  const ingroupId = source === 'vicidial_closer_log' ? (groupMap.get(row.campaign_id ?? '') ?? null) : null;
  const now = new Date();

  await db
    .insert(calls)
    .values({
      companyId: conn.companyId,
      dialerServerId: conn.id,
      source,
      viciLeadId: row.lead_id,
      viciUniqueId: row.uniqueid,
      campaignId,
      ingroupId,
      viciAgentId: row.user ? (agentMap.get(row.user) ?? null) : null,
      viciUserRaw: row.user,
      phoneNumber: row.phone_number,
      callDate: callDateUtc,
      lengthSec: row.length_in_sec,
      status: row.status,
      termReason: row.term_reason,
      listId: row.list_id,
      raw: row,
      firstSyncedAt: now,
      lastSyncedAt: now,
    })
    .onConflictDoUpdate({
      target: [calls.dialerServerId, calls.source, calls.viciUniqueId],
      targetWhere: sql`vici_uniqueid is not null`,
      // dispositions and lengths arrive late/corrected — refresh them
      set: {
        status: row.status,
        lengthSec: row.length_in_sec,
        termReason: row.term_reason,
        phoneNumber: row.phone_number,
        raw: row,
        lastSyncedAt: now,
      },
    });
}

// ---------------------------------------------------------------------------
// Recordings
// ---------------------------------------------------------------------------
async function syncRecordingsFromDb(
  conn: DialerConnection,
  viciDb: ViciDbClient,
  stats: SyncStats,
  full?: boolean,
): Promise<void> {
  const cursor = await getCursor(conn.id, 'recording_log');
  let sinceUtc = cursor ? new Date(cursor.getTime() - CURSOR_OVERLAP_MS) : initialWindowStart(full);
  const untilUtc = new Date();

  let imported = 0;
  let unlinked = 0;
  let maxSeen: Date | null = null;

  const runPass = async (archive: boolean, passSinceUtc: Date): Promise<void> => {
  let cursorUtc = passSinceUtc;
  for (;;) {
    const rows = await viciDb.fetchRecordings(
      utcToLocalString(cursorUtc, conn.timezone),
      utcToLocalString(untilUtc, conn.timezone),
      BATCH_LIMIT,
      archive,
    );
    if (rows.length === 0) break;

    // resolve recording -> call via vicidial_id (= call uniqueid on this dialer)
    const uids = rows.map((r) => r.vicidial_id).filter((u): u is string => !!u);
    const callByUid = new Map<string, string>();
    if (uids.length > 0) {
      for (const c of await db
        .select({ id: calls.id, uid: calls.viciUniqueId })
        .from(calls)
        .where(and(eq(calls.dialerServerId, conn.id), inArray(calls.viciUniqueId, uids)))) {
        if (c.uid) callByUid.set(c.uid, c.id);
      }
    }

    for (const r of rows) {
      if (!r.filename) continue;
      const startUtc = r.start_time ? localToUtc(r.start_time, conn.timezone) : null;
      if (startUtc && (!maxSeen || startUtc > maxSeen)) maxSeen = startUtc;
      const callId = r.vicidial_id ? (callByUid.get(r.vicidial_id) ?? null) : null;
      if (!callId) unlinked += 1;
      // either-key upsert: a recording can already exist under the same
      // recording_id with a different filename (or vice versa) from the
      // API-era import — a single-key conflict target would abort the job
      await upsertRecordingByEitherKey(
        conn,
        {
          recordingId: r.recording_id,
          leadId: r.lead_id,
          filename: r.filename,
          locationUrl: r.location,
          startTime: startUtc,
          lengthSec: r.length_in_sec,
        },
        callId,
      );
      imported += 1;
    }

    if (rows.length < BATCH_LIMIT) break;
    const last = rows[rows.length - 1];
    if (!last.start_time) break;
    cursorUtc = localToUtc(last.start_time, conn.timezone);
  }
  };

  if (full) {
    try {
      await runPass(true, initialWindowStart(full));
    } catch (err) {
      (stats.notes as string[]).push(
        `recording_log_archive not readable: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  await runPass(false, sinceUtc);

  if (maxSeen) await setCursor(conn.id, 'recording_log', maxSeen);
  stats.recordings_imported = imported;
  if (unlinked > 0) stats.recordings_unlinked = unlinked;
}

/** API fallback: recording_lookup per lead for recent calls missing recordings. */
async function syncRecordingsFromApi(conn: DialerConnection, stats: SyncStats): Promise<void> {
  if (!conn.apiUser) {
    (stats.notes as string[]).push('API recording lookup skipped: no API credentials.');
    return;
  }
  const api = new ViciApiClient(conn);
  // cover the whole retention window — recording_log can be empty on hosted
  // dialers, so this lookup is the recording source and must reach past days.
  // Transfer legs come first (those are the calls QA actually reviews); the
  // 300-lead cap drains the backlog across cycles without stalling a sync.
  const lookbackDays = config.RETENTION_DAYS > 0 ? config.RETENTION_DAYS : 7;
  const lookback = new Date(Date.now() - lookbackDays * 24 * 3600 * 1000);

  const candidates = await db
    .select({ leadId: calls.viciLeadId })
    .from(calls)
    .leftJoin(recordings, eq(recordings.callId, calls.id))
    .where(
      and(
        eq(calls.dialerServerId, conn.id),
        eq(calls.isMock, false),
        gte(calls.callDate, lookback),
        isNull(recordings.id),
        sql`${calls.viciLeadId} is not null`,
      ),
    )
    .groupBy(calls.viciLeadId)
    .orderBy(
      sql`max((exists(select 1 from transfers t where t.fronter_call_id = ${calls.id} or t.closer_call_id = ${calls.id}))::int) desc`,
      sql`max(${calls.callDate}) desc`,
    )
    .limit(300);

  let found = 0;
  // a time budget keeps each sync cycle short so new calls and dispositions
  // land within a minute; the backlog drains over the following cycles
  const deadline = Date.now() + RECORDING_LOOKUP_BUDGET_MS;
  for (const c of candidates) {
    if (Date.now() > deadline) {
      (stats.notes as string[]).push('recording lookup time budget reached — continuing next cycle');
      break;
    }
    if (c.leadId == null) continue;
    let rows: Array<Record<string, string>>;
    try {
      rows = await api.recordingLookup({ leadId: c.leadId });
    } catch {
      continue; // transient API failure — retried next cycle
    }
    // the lead's call legs, so each recording links to the right one
    const leadCalls = await db
      .select({ id: calls.id, callDate: calls.callDate })
      .from(calls)
      .where(
        and(eq(calls.dialerServerId, conn.id), eq(calls.viciLeadId, c.leadId), eq(calls.isMock, false)),
      )
      .limit(50);
    for (const r of rows) {
      const location = r.location ?? r.url ?? '';
      const filename = r.filename ?? (location ? location.split('/').pop()! : '');
      if (!filename) continue;
      const startLocal = r.start_time ?? r.start ?? null;
      const startTime = startLocal ? localToUtc(startLocal, conn.timezone) : null;
      // the lookup returns the lead's FULL history — months-old recordings
      // are already purged on the dialer and outside our retention window
      if (startTime && startTime < lookback) continue;
      // link to the lead's nearest call leg within 15 minutes
      let bestId: string | null = null;
      if (startTime) {
        let bestDelta = 15 * 60_000;
        for (const lc of leadCalls) {
          const delta = Math.abs(lc.callDate.getTime() - startTime.getTime());
          if (delta <= bestDelta) {
            bestDelta = delta;
            bestId = lc.id;
          }
        }
      }
      // either-key upsert — recording_lookup filenames can differ from the
      // recording_log ones for the same recording_id (format variants)
      await upsertRecordingByEitherKey(
        conn,
        {
          recordingId: r.recording_id ? Number(r.recording_id) : null,
          leadId: c.leadId,
          filename,
          locationUrl: location || null,
          startTime,
          lengthSec: r.length_in_sec ? Number(r.length_in_sec) : null,
        },
        bestId,
      );
      found += 1;
    }
  }
  stats.recordings_api_found = found;
}

// ---------------------------------------------------------------------------
// API-only ingestion (no MySQL access)
// ---------------------------------------------------------------------------
const API_AGENT_CAP = 300;
const API_FULL_BACKFILL_DAYS = 14;

function userStatsKey(r: UserStatsCall): string {
  return `${r.kind}|${r.dateTimeLocal}|${r.phone ?? ''}|${r.leadId ?? ''}`;
}

function localDateMinus(todayLocal: string, minusDays: number): string {
  const [y, m, d] = todayLocal.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d - minusDays)).toISOString().slice(0, 10);
}

/**
 * 'api' source mode: call records come from the dialer's own per-agent call
 * exports (user_stats.php file_download 5/6/9 — verified live), which carry
 * the EXACT per-call disposition, phone, campaign/in-group, list and lead id
 * for outbound, inbound-closer and manual calls. Recordings come from
 * recording_lookup and are linked to those calls by lead + start time.
 * Everything is idempotent via deterministic synthetic uniqueids.
 */
async function syncApiOnly(conn: DialerConnection, stats: SyncStats, full?: boolean): Promise<void> {
  const api = new ViciApiClient(conn);
  const notes = stats.notes as string[];
  const now = new Date();

  // local<->UTC through the dialer's measured clock offset when the
  // configured zone was detected as wrong (set by the time check above)
  const toLocalStr = (d: Date): string =>
    conn.measuredOffsetMin != null
      ? utcToOffsetLocalString(d, conn.measuredOffsetMin)
      : utcToLocalString(d, conn.timezone);
  const toUtcDate = (s: string): Date =>
    conn.measuredOffsetMin != null
      ? offsetLocalToUtc(s, conn.measuredOffsetMin)
      : localToUtc(s, conn.timezone);

  // --- campaigns ---
  try {
    const camps = await api.campaignsList();
    for (const c of camps) {
      await db
        .insert(campaigns)
        .values({
          companyId: conn.companyId,
          dialerServerId: conn.id,
          viciCampaignId: c.campaign_id,
          name: c.campaign_name,
          active: c.active === 'Y',
          raw: c,
          syncedAt: now,
        })
        .onConflictDoUpdate({
          target: [campaigns.dialerServerId, campaigns.viciCampaignId],
          set: { name: c.campaign_name, active: c.active === 'Y', raw: c, syncedAt: now },
        });
    }
    stats.campaigns = camps.length;
  } catch (err) {
    notes.push(`campaigns_list failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // --- agent roster: stats export over a window + currently logged-in agents ---
  const rosterRows: Array<Record<string, string>> = [];
  try {
    const rosterStart = new Date(now.getTime() - (full ? 7 : 1) * 24 * 3600 * 1000);
    rosterRows.push(...(await api.agentStatsExport(toLocalStr(rosterStart), toLocalStr(now))));
  } catch (err) {
    notes.push(`agent_stats_export failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    rosterRows.push(...(await api.loggedInAgents()));
  } catch {
    // live roster is a best-effort supplement
  }
  let rosterCount = 0;
  const seenUsers = new Set<string>();
  for (const r of rosterRows) {
    const user = (r.user ?? '').trim();
    if (!user || seenUsers.has(user)) continue;
    seenUsers.add(user);
    rosterCount += 1;
    await db
      .insert(viciAgents)
      .values({
        companyId: conn.companyId,
        dialerServerId: conn.id,
        viciUser: user,
        fullName: r.full_name ?? null,
        userGroup: r.user_group ?? null,
        raw: r,
        syncedAt: now,
      })
      .onConflictDoUpdate({
        target: [viciAgents.dialerServerId, viciAgents.viciUser],
        // never touch agentRole here — that is the admin's classification
        set: { fullName: r.full_name ?? null, userGroup: r.user_group ?? null, raw: r, syncedAt: now },
      });
  }
  stats.agents = rosterCount;

  const agentRows = await db.select().from(viciAgents).where(eq(viciAgents.dialerServerId, conn.id));
  const idByUser = new Map(agentRows.map((a) => [a.viciUser, a.id] as const));
  let scanUsers = agentRows.filter((a) => a.active).map((a) => a.viciUser);
  if (scanUsers.length > API_AGENT_CAP) {
    notes.push(`agent cap: scanning ${API_AGENT_CAP} of ${scanUsers.length} agents per cycle`);
    scanUsers = scanUsers.slice(0, API_AGENT_CAP);
  }

  // --- exact per-call log: user_stats exports, chunked to stay under the
  // 10k-row export cap; incremental = today+yesterday, full = backfill window ---
  const todayLocal = toLocalStr(now).slice(0, 10);
  // no point backfilling past the retention window — it would be deleted again
  const retentionCap = config.RETENTION_DAYS > 0 ? config.RETENTION_DAYS : Number.MAX_SAFE_INTEGER;
  const dayCount = full ? Math.min(config.SYNC_HISTORICAL_DAYS, API_FULL_BACKFILL_DAYS, retentionCap) : 2;
  const chunks: Array<{ from: string; to: string }> = [];
  for (let i = dayCount - 1; i >= 0; i -= 2) {
    chunks.push({ from: localDateMinus(todayLocal, i), to: localDateMinus(todayLocal, Math.max(i - 1, 0)) });
  }

  const campMap = new Map<string, string>();
  for (const c of await db
    .select({ id: campaigns.id, cid: campaigns.viciCampaignId })
    .from(campaigns)
    .where(eq(campaigns.dialerServerId, conn.id))) {
    campMap.set(c.cid, c.id);
  }
  const groupMap = new Map<string, string>();
  for (const g of await db
    .select({ id: ingroups.id, gid: ingroups.viciGroupId })
    .from(ingroups)
    .where(eq(ingroups.dialerServerId, conn.id))) {
    groupMap.set(g.gid, g.id);
  }
  const ensureIngroup = async (gid: string | null): Promise<string | null> => {
    if (!gid) return null;
    const hit = groupMap.get(gid);
    if (hit) return hit;
    const [row] = await db
      .insert(ingroups)
      .values({ companyId: conn.companyId, dialerServerId: conn.id, viciGroupId: gid, name: gid, syncedAt: new Date() })
      .onConflictDoUpdate({
        target: [ingroups.dialerServerId, ingroups.viciGroupId],
        set: { syncedAt: new Date() },
      })
      .returning({ id: ingroups.id });
    groupMap.set(gid, row.id);
    return row.id;
  };

  let callsImported = 0;
  let callsRefreshed = 0;
  let recsImported = 0;
  let recsLinked = 0;
  let exportErrors = 0;

  for (const chunk of chunks) {
    for (const user of scanUsers) {
      let callRows: UserStatsCall[];
      try {
        callRows = await fetchUserStatsCalls(conn, user, chunk.from, chunk.to, false);
        if (chunk.from < todayLocal) {
          // Archived days MUST also be fetched with the archive flag and
          // merged: the live export still returns some sections (manual
          // calls) for archived days, so "empty means archived" is wrong —
          // outbound and closer legs only appear in the archive search.
          try {
            const archivedRows = await fetchUserStatsCalls(conn, user, chunk.from, chunk.to, true);
            const seen = new Set(callRows.map(userStatsKey));
            for (const r of archivedRows) {
              if (!seen.has(userStatsKey(r))) callRows.push(r);
            }
          } catch {
            exportErrors += 1; // archived half missing — next cycle retries
          }
        }
      } catch {
        exportErrors += 1;
        continue; // transient — retried next cycle
      }

      // deterministic uid per call row — repeated imports stay idempotent
      const prepared = callRows.map((r) => ({
        r,
        uid: `us-${sha256(`${conn.id}|${user}|${r.kind}|${r.dateTimeLocal}|${r.phone ?? ''}|${r.leadId ?? ''}`).slice(0, 29)}`,
      }));
      const existingByUid = new Map<string, string>();
      if (prepared.length > 0) {
        for (const c of await db
          .select({ id: calls.id, uid: calls.viciUniqueId })
          .from(calls)
          .where(and(eq(calls.dialerServerId, conn.id), inArray(calls.viciUniqueId, prepared.map((p) => p.uid))))) {
          if (c.uid) existingByUid.set(c.uid, c.id);
        }
      }

      const imported: Array<{ id: string; callDate: Date; leadId: number | null }> = [];
      for (const { r, uid } of prepared) {
        const callDate = toUtcDate(r.dateTimeLocal);
        const source = r.kind === 'closer' ? ('vicidial_closer_log' as const) : ('vicidial_log' as const);
        const campaignId = r.kind !== 'closer' ? (campMap.get(r.campaignOrGroup ?? '') ?? null) : null;
        const ingroupId = r.kind === 'closer' ? await ensureIngroup(r.campaignOrGroup) : null;
        const rawPayload = { derivedFrom: 'user_stats_export', kind: r.kind, hangupReason: r.hangupReason };

        const existingId = existingByUid.get(uid);
        let callId: string;
        if (existingId) {
          // dispositions get corrected after the fact — refresh them
          await db
            .update(calls)
            .set({
              status: r.status,
              lengthSec: r.lengthSec,
              phoneNumber: r.phone,
              campaignId,
              ingroupId,
              listId: r.listId,
              raw: rawPayload,
              lastSyncedAt: new Date(),
            })
            .where(eq(calls.id, existingId));
          callId = existingId;
          callsRefreshed += 1;
        } else {
          const inserted = await db
            .insert(calls)
            .values({
              companyId: conn.companyId,
              dialerServerId: conn.id,
              source,
              viciLeadId: r.leadId,
              viciUniqueId: uid,
              campaignId,
              ingroupId,
              viciAgentId: idByUser.get(user) ?? null,
              viciUserRaw: user,
              phoneNumber: r.phone,
              callDate,
              lengthSec: r.lengthSec,
              status: r.status,
              listId: r.listId,
              raw: rawPayload,
            })
            .onConflictDoNothing()
            .returning({ id: calls.id });
          if (inserted.length === 0) continue; // raced — next cycle refreshes it
          callId = inserted[0].id;
          callsImported += 1;
        }
        imported.push({ id: callId, callDate, leadId: r.leadId });
      }

      // recordings for this agent over the chunk's days, linked to those calls
      const chunkDays = chunk.from === chunk.to ? [chunk.from] : [chunk.from, chunk.to];
      for (const day of chunkDays) {
        let recRaw: Array<Record<string, string>>;
        try {
          recRaw = await api.recordingLookup({ agentUser: user, date: day });
        } catch {
          continue;
        }
        for (const rr of recRaw) {
          const n = normalizeRecordingRow(rr);
          if (!n.startTimeLocal || !n.filename) continue;
          const startTime = toUtcDate(n.startTimeLocal);
          // best call: same lead within 15 min beats nearest start within 2 min
          let bestId: string | null = null;
          let bestScore = Infinity;
          for (const c of imported) {
            const delta = Math.abs(c.callDate.getTime() - startTime.getTime());
            const sameLead = n.leadId != null && c.leadId === n.leadId;
            if (delta > (sameLead ? 15 * 60_000 : 2 * 60_000)) continue;
            const score = sameLead ? delta : delta + 10 * 60_000;
            if (score < bestScore) {
              bestScore = score;
              bestId = c.id;
            }
          }
          if (bestId) recsLinked += 1;
          await upsertRecordingByEitherKey(
            conn,
            { recordingId: n.recordingId, leadId: n.leadId, filename: n.filename, locationUrl: n.locationUrl, startTime, lengthSec: n.lengthSec },
            bestId,
          );
          recsImported += 1;
        }
      }
    }
  }

  stats.api_calls_imported = callsImported;
  stats.api_calls_refreshed = callsRefreshed;
  stats.api_recordings = recsImported;
  stats.api_recordings_linked = recsLinked;
  if (exportErrors > 0) stats.api_export_errors = exportErrors;
  notes.push(
    "API mode: per-call dispositions come from the dialer's own per-agent call exports (exact log — outbound, inbound closer and manual legs).",
  );
}

/**
 * A recording can resurface under the same recording_id with a changed
 * filename (re-encodes, archive moves) — match on EITHER unique key so
 * neither constraint can fail a sync job. callId null leaves any existing
 * link untouched.
 */
type RecordingInput = {
  recordingId: number | null;
  leadId: number | null;
  filename: string;
  locationUrl: string | null;
  startTime: Date | null;
  lengthSec: number | null;
};

async function upsertRecordingByEitherKey(
  conn: DialerConnection,
  row: RecordingInput,
  callId: string | null,
): Promise<void> {
  try {
    await upsertRecordingUnchecked(conn, row, callId);
  } catch (err) {
    // The dialer can hold two recording entries that collide on our keys
    // (same file under two recording ids, or a parallel sync importing the
    // same row). Skipping that one row beats aborting the whole sync.
    if ((err as { code?: string }).code === '23505') return;
    throw err;
  }
}

async function upsertRecordingUnchecked(
  conn: DialerConnection,
  row: RecordingInput,
  callId: string | null,
): Promise<void> {
  const [existingRec] = await db
    .select({ id: recordings.id })
    .from(recordings)
    .where(
      and(
        eq(recordings.dialerServerId, conn.id),
        or(
          eq(recordings.filename, row.filename),
          row.recordingId != null ? eq(recordings.viciRecordingId, row.recordingId) : sql`false`,
        ),
      ),
    )
    .limit(1);
  if (existingRec) {
    await db
      .update(recordings)
      .set({
        ...(callId ? { callId } : {}),
        viciRecordingId: row.recordingId,
        viciLeadId: row.leadId,
        filename: row.filename,
        locationUrl: row.locationUrl,
        lengthSec: row.lengthSec,
        status: row.locationUrl ? 'available' : 'pending',
        updatedAt: new Date(),
      })
      .where(eq(recordings.id, existingRec.id));
  } else {
    await db
      .insert(recordings)
      .values({
        companyId: conn.companyId,
        dialerServerId: conn.id,
        callId,
        viciRecordingId: row.recordingId,
        viciLeadId: row.leadId,
        filename: row.filename,
        locationUrl: row.locationUrl,
        startTime: row.startTime,
        lengthSec: row.lengthSec,
        status: row.locationUrl ? 'available' : 'pending',
        raw: { source: 'recording_lookup' },
      })
      .onConflictDoNothing();
  }
}

// ---------------------------------------------------------------------------
// Transfers: create -> match -> queue transitions
// ---------------------------------------------------------------------------
async function companyMappings(companyId: string): Promise<MappingRow[]> {
  const rows = await db
    .select()
    .from(dispositionMappings)
    .where(and(eq(dispositionMappings.companyId, companyId), eq(dispositionMappings.active, true)));
  return rows.map((r) => ({
    dialerServerId: r.dialerServerId,
    campaignId: r.campaignId,
    dispositionCode: r.dispositionCode,
    meaning: r.meaning,
    active: r.active,
  }));
}

async function buildTransfers(conn: DialerConnection, stats: SyncStats): Promise<void> {
  const mappings = await companyMappings(conn.companyId);
  const recent = new Date(Date.now() - config.SYNC_HISTORICAL_DAYS * 24 * 3600 * 1000);
  let created = 0;

  if (mappings.length > 0) {
    created += await buildTransfersFromMappings(conn, mappings, recent);
  } else {
    (stats.notes as string[]).push(
      'No disposition mappings configured — only structural transfer detection (API mode) can run.',
    );
  }
  if (conn.sourceMode === 'api') {
    created += await buildTransfersStructurally(conn, recent);
  }
  stats.transfers_created = created;
}

/**
 * One handoff = one transfer: a redial that shows up as both a manual and an
 * outbound leg (or a quick re-dial) must not create a second transfer row
 * for the same lead within the handoff window.
 */
async function transferExistsNearby(
  dialerServerId: string,
  viciLeadId: number | null,
  xferTime: Date,
): Promise<boolean> {
  if (viciLeadId == null) return false;
  const [t] = await db
    .select({ id: transfers.id })
    .from(transfers)
    .where(
      and(
        eq(transfers.dialerServerId, dialerServerId),
        eq(transfers.viciLeadId, viciLeadId),
        // sale-only entries must never block a real fronter transfer
        eq(transfers.kind, 'transfer'),
        gte(transfers.xferTime, new Date(xferTime.getTime() - 10 * 60_000)),
        lte(transfers.xferTime, new Date(xferTime.getTime() + 10 * 60_000)),
      ),
    )
    .limit(1);
  return !!t;
}

async function buildTransfersFromMappings(
  conn: DialerConnection,
  mappings: MappingRow[],
  recent: Date,
): Promise<number> {
  // prefilter by the mapped transfer codes in SQL — without this the row cap
  // truncates the scan long before it reaches the XFER calls in a backfill
  const xferCodes = [
    ...new Set(
      mappings
        .filter((m) => m.active && m.meaning === 'transfer')
        .map((m) => m.dispositionCode.trim().toUpperCase()),
    ),
  ];
  if (xferCodes.length === 0) return 0;

  const fronterCalls = await db
    .select({
      id: calls.id,
      viciLeadId: calls.viciLeadId,
      phoneNumber: calls.phoneNumber,
      callDate: calls.callDate,
      lengthSec: calls.lengthSec,
      status: calls.status,
      campaignId: calls.campaignId,
    })
    .from(calls)
    .leftJoin(transfers, eq(transfers.fronterCallId, calls.id))
    .where(
      and(
        eq(calls.dialerServerId, conn.id),
        eq(calls.source, 'vicidial_log'),
        eq(calls.isMock, false),
        gte(calls.callDate, recent),
        inArray(calls.status, xferCodes),
        isNull(transfers.id),
      ),
    )
    .limit(20_000);

  let created = 0;
  for (const c of fronterCalls) {
    const meaning = resolveMeaning(mappings, {
      dialerServerId: conn.id,
      campaignId: c.campaignId,
      dispositionCode: c.status,
    });
    if (meaning !== 'transfer') continue;
    // xfer moment ≈ end of fronter leg
    const xferTime = new Date(c.callDate.getTime() + (c.lengthSec ?? 0) * 1000);
    if (await transferExistsNearby(conn.id, c.viciLeadId, xferTime)) continue;
    const inserted = await db
      .insert(transfers)
      .values({
        companyId: conn.companyId,
        dialerServerId: conn.id,
        fronterCallId: c.id,
        xferTime,
        phoneNumber: c.phoneNumber,
        viciLeadId: c.viciLeadId,
        matchStatus: 'pending_match',
        queueStatus: 'transfer',
      })
      .onConflictDoNothing({ target: [transfers.fronterCallId] })
      .returning({ id: transfers.id });
    if (inserted.length > 0) {
      await db.insert(transferEvents).values({
        transferId: inserted[0].id,
        toStatus: 'transfer',
        reason: `fronter disposition '${c.status}' mapped to transfer`,
      });
      created += 1;
    }
  }
  return created;
}

/**
 * API mode has no per-call XFER disposition (the closer's final dispo
 * overwrites the lead status), so transfers are also detected structurally:
 * a fronter-leg call whose lead has a closer-leg call starting within two
 * hours IS a transfer, and the pair is linked directly (same dialer + same
 * lead = strong evidence).
 */
async function buildTransfersStructurally(conn: DialerConnection, recent: Date): Promise<number> {
  const closerLeg = alias(calls, 'closer_leg');
  const pairs = await db
    .select({
      fronterId: calls.id,
      leadId: calls.viciLeadId,
      phoneNumber: calls.phoneNumber,
      callDate: calls.callDate,
      lengthSec: calls.lengthSec,
      closerId: closerLeg.id,
      closerDate: closerLeg.callDate,
    })
    .from(calls)
    .innerJoin(
      closerLeg,
      and(
        eq(closerLeg.dialerServerId, calls.dialerServerId),
        eq(closerLeg.source, 'vicidial_closer_log'),
        eq(closerLeg.viciLeadId, calls.viciLeadId),
        gte(closerLeg.callDate, calls.callDate),
        lte(closerLeg.callDate, sql`${calls.callDate} + interval '2 hours'`),
      ),
    )
    .leftJoin(transfers, eq(transfers.fronterCallId, calls.id))
    .where(
      and(
        eq(calls.dialerServerId, conn.id),
        eq(calls.source, 'vicidial_log'),
        eq(calls.isMock, false),
        gte(calls.callDate, recent),
        isNull(transfers.id),
        sql`${calls.viciLeadId} is not null`,
      ),
    )
    .limit(20_000);

  // keep the earliest closer leg per fronter call
  const byFronter = new Map<string, (typeof pairs)[number]>();
  for (const p of pairs) {
    const prev = byFronter.get(p.fronterId);
    if (!prev || p.closerDate < prev.closerDate) byFronter.set(p.fronterId, p);
  }

  let created = 0;
  for (const p of byFronter.values()) {
    const xferTime = new Date(p.callDate.getTime() + (p.lengthSec ?? 0) * 1000);
    if (await transferExistsNearby(conn.id, p.leadId, xferTime)) continue;
    const inserted = await db
      .insert(transfers)
      .values({
        companyId: conn.companyId,
        dialerServerId: conn.id,
        fronterCallId: p.fronterId,
        closerCallId: p.closerId,
        xferTime,
        phoneNumber: p.phoneNumber,
        viciLeadId: p.leadId,
        closerLeadId: p.leadId,
        matchStatus: 'matched',
        matchConfidence: 85,
        matchMethod: 'structural-lead',
        matchNotes: 'same-dialer lead with a closer leg inside the transfer window',
        queueStatus: 'unclosed',
      })
      .onConflictDoNothing({ target: [transfers.fronterCallId] })
      .returning({ id: transfers.id });
    if (inserted.length > 0) {
      await db.insert(transferEvents).values({
        transferId: inserted[0].id,
        toStatus: 'unclosed',
        reason: 'structural detection: closer leg found for the same lead on this dialer',
      });
      created += 1;
    }
  }
  return created;
}

async function matchPendingTransfers(companyId: string, stats: SyncStats): Promise<void> {
  const recent = new Date(Date.now() - 7 * 24 * 3600 * 1000);
  const pending = await db
    .select()
    .from(transfers)
    .where(
      and(
        eq(transfers.companyId, companyId),
        eq(transfers.matchStatus, 'pending_match'),
        eq(transfers.isMock, false),
        gte(transfers.xferTime, recent),
      ),
    )
    .limit(2000);

  let matched = 0;
  let flagged = 0;
  let unmatched = 0;

  for (const t of pending) {
    const winStart = new Date(t.xferTime.getTime() - MATCH_WINDOW_BEFORE_MS);
    const winEnd = new Date(t.xferTime.getTime() + MATCH_WINDOW_AFTER_MS);
    // candidates across ALL of the company's dialers (same- and cross-dialer)
    const rows = await db
      .select({
        id: calls.id,
        dialerServerId: calls.dialerServerId,
        viciLeadId: calls.viciLeadId,
        phoneNumber: calls.phoneNumber,
        callDate: calls.callDate,
      })
      .from(calls)
      .where(
        and(
          eq(calls.companyId, companyId),
          eq(calls.source, 'vicidial_closer_log'),
          eq(calls.isMock, false),
          gte(calls.callDate, winStart),
          lte(calls.callDate, winEnd),
        ),
      )
      .limit(500);

    const candidates: CloserCandidate[] = rows.map((r) => ({
      callId: r.id,
      dialerServerId: r.dialerServerId,
      viciLeadId: r.viciLeadId,
      phoneNumber: r.phoneNumber,
      callDate: r.callDate,
    }));

    const opts = {
      ...DEFAULT_MATCH_OPTIONS,
      autoThreshold: config.MATCH_AUTO_THRESHOLD,
      flagThreshold: config.MATCH_FLAG_THRESHOLD,
      // warm handoffs: the closer leg often starts while the fronter is still
      // on the line, well before the fronter leg's end timestamp
      maxEarlySec: 600,
    };
    const decision = decideMatch(
      {
        dialerServerId: t.dialerServerId,
        viciLeadId: t.viciLeadId,
        phoneNumber: t.phoneNumber,
        xferTime: t.xferTime,
      },
      candidates,
      opts,
    );

    if (decision.outcome === 'matched' && decision.best) {
      const closerRow = rows.find((r) => r.id === decision.best!.callId);
      await db
        .update(transfers)
        .set({
          closerCallId: decision.best.callId,
          closerLeadId: closerRow?.viciLeadId ?? null,
          matchStatus: 'matched',
          matchConfidence: decision.best.score,
          matchMethod: 'auto',
          matchNotes: decision.notes,
          updatedAt: new Date(),
        })
        .where(eq(transfers.id, t.id));
      await db.insert(transferEvents).values({
        transferId: t.id,
        fromStatus: 'pending_match',
        toStatus: 'matched',
        reason: decision.notes,
        meta: { score: decision.best.score },
      });
      matched += 1;
    } else if (decision.outcome === 'flagged') {
      await db
        .update(transfers)
        .set({
          matchStatus: 'flagged',
          matchConfidence: decision.best?.score ?? null,
          matchNotes: decision.notes,
          updatedAt: new Date(),
        })
        .where(eq(transfers.id, t.id));
      await db.insert(transferEvents).values({
        transferId: t.id,
        fromStatus: 'pending_match',
        toStatus: 'flagged',
        reason: decision.notes,
      });
      flagged += 1;
    } else {
      // closer legs can arrive late — only give up after the grace period
      const age = Date.now() - t.xferTime.getTime();
      if (age > PENDING_GRACE_MS) {
        await db
          .update(transfers)
          .set({ matchStatus: 'unmatched', matchNotes: decision.notes, updatedAt: new Date() })
          .where(eq(transfers.id, t.id));
        await db.insert(transferEvents).values({
          transferId: t.id,
          fromStatus: 'pending_match',
          toStatus: 'unmatched',
          reason: decision.notes,
        });
        unmatched += 1;
      }
    }
  }
  stats.match_matched = matched;
  stats.match_flagged = flagged;
  stats.match_unmatched = unmatched;
}

/**
 * Every sale call ends up counted exactly once, so the Closed queue matches
 * the dialer's SALE column:
 *  1. a sale on a transfer's own closer leg — handled by the queue status;
 *  2. a sale on a LATER call of a transferred lead (closer callback) closes
 *     that lead's most recent transfer before it (one sale → one transfer);
 *  3. a sale with no transfer behind it becomes its own Closed entry: an
 *     inbound sale (call came straight into the closer group) or a callback
 *     sale (closer's own follow-up call).
 */
async function attributeSales(companyId: string, stats: SyncStats): Promise<void> {
  const mappings = await companyMappings(companyId);
  const codes = [
    ...new Set(
      mappings.filter((m) => m.active && m.meaning === 'sale').map((m) => m.dispositionCode.trim().toUpperCase()),
    ),
  ];
  if (codes.length === 0) return;
  const codeList = sql.join(
    codes.map((c) => sql`${c}`),
    sql`, `,
  );
  const windowDays = config.RETENTION_DAYS > 0 ? config.RETENTION_DAYS : 7;
  const since = new Date(Date.now() - windowDays * 24 * 3600 * 1000);

  // links whose sale call stopped being a sale (disposition corrected)
  await db.execute(sql`
    update transfers set sale_call_id = null, updated_at = now()
     where company_id = ${companyId} and sale_call_id is not null
       and not exists (select 1 from calls c where c.id = transfers.sale_call_id and upper(c.status) in (${codeList}))`);
  const removed = await db.execute(sql`
    delete from transfers
     where company_id = ${companyId} and kind <> 'transfer' and is_mock = false
       and not exists (select 1 from calls c where c.id = transfers.closer_call_id and upper(c.status) in (${codeList}))
       and not exists (select 1 from evaluations e where e.transfer_id = transfers.id)`);

  const pending = await db.execute(sql`
    select c.id, c.dialer_server_id, c.campaign_id, c.vici_lead_id, c.status, c.call_date, c.source, c.phone_number
      from calls c
     where c.company_id = ${companyId} and c.is_mock = false and c.call_date >= ${since}
       and upper(c.status) in (${codeList})
       and not exists (select 1 from transfers t where t.closer_call_id = c.id or t.sale_call_id = c.id)
     order by c.call_date
     limit 5000`);

  let linkedAsCloser = 0;
  let linkedAsCallback = 0;
  let saleOnly = 0;
  for (const raw of pending.rows as Array<Record<string, unknown>>) {
    const call = {
      id: raw.id as string,
      dialerServerId: raw.dialer_server_id as string,
      campaignId: (raw.campaign_id as string | null) ?? null,
      leadId: raw.vici_lead_id === null ? null : Number(raw.vici_lead_id),
      status: raw.status as string,
      callDate: new Date(raw.call_date as string),
      source: raw.source as string,
      phone: (raw.phone_number as string | null) ?? null,
    };
    const meaning = resolveMeaning(mappings, {
      dialerServerId: call.dialerServerId,
      campaignId: call.campaignId,
      dispositionCode: call.status,
    });
    if (meaning !== 'sale') continue;

    if (call.leadId !== null) {
      const [t] = await db
        .select()
        .from(transfers)
        .where(
          and(
            eq(transfers.companyId, companyId),
            eq(transfers.kind, 'transfer'),
            eq(transfers.dialerServerId, call.dialerServerId),
            eq(transfers.viciLeadId, call.leadId),
            lte(transfers.xferTime, new Date(call.callDate.getTime() + 10 * 60_000)),
            gte(transfers.xferTime, new Date(call.callDate.getTime() - windowDays * 24 * 3600 * 1000)),
            isNull(transfers.saleCallId),
            sql`${transfers.queueStatus} <> 'closed'`,
            eq(transfers.isMock, false),
          ),
        )
        .orderBy(desc(transfers.xferTime))
        .limit(1);
      if (t) {
        if (!t.closerCallId && call.source === 'vicidial_closer_log') {
          // the matcher never found this transfer's closer leg — the sale IS it
          await db
            .update(transfers)
            .set({
              closerCallId: call.id,
              closerLeadId: call.leadId,
              matchStatus: 'matched',
              matchMethod: 'sale-lead',
              matchConfidence: 85,
              matchNotes: 'closer leg identified by its sale on the same lead',
              updatedAt: new Date(),
            })
            .where(eq(transfers.id, t.id));
          linkedAsCloser += 1;
        } else if (t.closerCallId) {
          // closed by updateQueueStatuses, which reads the sale call's status
          await db
            .update(transfers)
            .set({ saleCallId: call.id, updatedAt: new Date() })
            .where(eq(transfers.id, t.id));
          linkedAsCallback += 1;
        } else {
          // no closer leg was ever found, so nothing else will close it
          await db
            .update(transfers)
            .set({
              saleCallId: call.id,
              queueStatus: 'closed',
              saleDisposition: call.status,
              closedAt: call.callDate,
              updatedAt: new Date(),
            })
            .where(eq(transfers.id, t.id));
          await db.insert(transferEvents).values({
            transferId: t.id,
            fromStatus: t.queueStatus,
            toStatus: 'closed',
            reason: `sold on a later call of this lead ('${call.status}')`,
          });
          linkedAsCallback += 1;
        }
        continue;
      }
    }

    const inserted = await db
      .insert(transfers)
      .values({
        companyId,
        dialerServerId: call.dialerServerId,
        kind: call.source === 'vicidial_closer_log' ? 'inbound_sale' : 'callback_sale',
        fronterCallId: null,
        closerCallId: call.id,
        xferTime: call.callDate,
        phoneNumber: call.phone,
        viciLeadId: call.leadId,
        closerLeadId: call.leadId,
        matchStatus: 'matched',
        matchMethod: 'sale-only',
        matchConfidence: 100,
        matchNotes:
          call.source === 'vicidial_closer_log'
            ? 'sale on a call that reached the closer group with no fronter transfer'
            : "sale on the closer's own follow-up call — no transfer for this lead in the window",
        queueStatus: 'closed',
        saleDisposition: call.status,
        closedAt: call.callDate,
      })
      .onConflictDoNothing()
      .returning({ id: transfers.id });
    if (inserted.length > 0) {
      await db.insert(transferEvents).values({
        transferId: inserted[0].id,
        toStatus: 'closed',
        reason:
          call.source === 'vicidial_closer_log'
            ? `inbound sale '${call.status}' — no fronter transfer`
            : `callback sale '${call.status}' — no fronter transfer`,
      });
      saleOnly += 1;
    }
  }
  if (linkedAsCloser) stats.sales_linked_as_closer = linkedAsCloser;
  if (linkedAsCallback) stats.sales_linked_as_callback = linkedAsCallback;
  if (saleOnly) stats.sales_without_transfer = saleOnly;
  if (removed.rowCount) stats.sale_entries_removed = removed.rowCount;
}

async function updateQueueStatuses(companyId: string, stats: SyncStats): Promise<void> {
  const mappings = await companyMappings(companyId);
  const saleCall = alias(calls, 'sale_call');
  const rows = await db
    .select({
      transfer: transfers,
      closerStatus: calls.status,
      closerDialerId: calls.dialerServerId,
      closerIngroupId: calls.ingroupId,
      closerDate: calls.callDate,
      saleStatus: saleCall.status,
      saleDialerId: saleCall.dialerServerId,
      saleCampaignId: saleCall.campaignId,
      saleDate: saleCall.callDate,
    })
    .from(transfers)
    .innerJoin(calls, eq(transfers.closerCallId, calls.id))
    .leftJoin(saleCall, eq(transfers.saleCallId, saleCall.id))
    .where(
      and(
        eq(transfers.companyId, companyId),
        eq(transfers.matchStatus, 'matched'),
        eq(transfers.kind, 'transfer'),
        eq(transfers.isMock, false),
      ),
    )
    .orderBy(desc(transfers.xferTime))
    .limit(10_000);

  let transitions = 0;
  const unmapped = new Map<string, number>();
  for (const row of rows) {
    const closerMeaning = resolveMeaning(mappings, {
      dialerServerId: row.closerDialerId,
      campaignId: null,
      dispositionCode: row.closerStatus,
    });
    if (closerMeaning === null && row.closerStatus) {
      unmapped.set(row.closerStatus, (unmapped.get(row.closerStatus) ?? 0) + 1);
    }
    // a sale on a later call of this lead closes the transfer too
    const laterSale =
      row.saleStatus !== null &&
      resolveMeaning(mappings, {
        dialerServerId: row.saleDialerId ?? row.closerDialerId,
        campaignId: row.saleCampaignId ?? null,
        dispositionCode: row.saleStatus,
      }) === 'sale';
    const viaOwnLeg = closerMeaning === 'sale';
    const result = transition(row.transfer.queueStatus, {
      matched: true,
      closerDisposition: row.closerStatus,
      closerMeaning: viaOwnLeg || laterSale ? 'sale' : closerMeaning,
    });
    if (!result.changed) continue;
    const closed = result.next === 'closed';
    await db
      .update(transfers)
      .set({
        queueStatus: result.next,
        saleDisposition: closed ? (viaOwnLeg ? row.closerStatus : row.saleStatus) : null,
        closedAt: closed ? (viaOwnLeg ? row.closerDate : row.saleDate) : null,
        updatedAt: new Date(),
      })
      .where(eq(transfers.id, row.transfer.id));
    await db.insert(transferEvents).values({
      transferId: row.transfer.id,
      fromStatus: row.transfer.queueStatus,
      toStatus: result.next,
      reason: result.regression
        ? `disposition corrected: no configured sale on this transfer anymore`
        : closed && !viaOwnLeg
          ? `sold on a later call of this lead ('${row.saleStatus}') after the closer leg ended '${row.closerStatus}'`
          : `closer disposition '${row.closerStatus}' -> ${result.next}`,
    });
    transitions += 1;
  }
  stats.queue_transitions = transitions;
  if (unmapped.size > 0) {
    // surfaces the sale/no-sale codes the admin still needs to map
    stats.unmapped_closer_statuses = [...unmapped.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([code, n]) => `${code}(${n})`);
  }
}

/** Normalizes phone once at import time is avoided — matcher normalizes on the fly. */
export { normalizePhone };
