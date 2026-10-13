import { and, desc, eq, gte, inArray, isNull, lte, sql } from 'drizzle-orm';
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
import { localToUtc, utcToLocalString } from './timezone.js';
import { decideMatch, DEFAULT_MATCH_OPTIONS, normalizePhone, type CloserCandidate } from './matcher.js';
import { resolveMeaning, transition, type MappingRow } from './queueLogic.js';
import type { DialerConnection, ViciCallRow } from './types.js';
import {
  assignLegSources,
  normalizeRecordingRow,
  phoneFromFilename,
  syntheticUniqueId,
  type ApiRecordingRow,
} from './apiDerive.js';

export interface SyncStats {
  [key: string]: number | string[] | undefined;
  notes?: string[];
}

const BATCH_LIMIT = 5000;
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

/** Connectivity check used by the admin "test connection" button. */
export async function testDialerConnection(dialerServerId: string): Promise<{
  api: { ok: boolean; detail: string };
  db: { ok: boolean; detail: string };
}> {
  const [dialer] = await db.select().from(dialerServers).where(eq(dialerServers.id, dialerServerId));
  if (!dialer) throw new Error('Dialer not found');
  const conn = toConnection(dialer);

  const result = {
    api: { ok: false, detail: 'No API credentials configured' },
    db: { ok: false, detail: 'No DB credentials configured' },
  };
  if (conn.apiUser) {
    try {
      const version = await new ViciApiClient(conn).version();
      result.api = { ok: true, detail: version };
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
  const days = full ? config.SYNC_HISTORICAL_DAYS : 1;
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

  for (;;) {
    const sinceLocal = utcToLocalString(sinceUtc, conn.timezone);
    const untilLocal = utcToLocalString(untilUtc, conn.timezone);
    const rows =
      source === 'vicidial_log'
        ? await viciDb.fetchOutboundCalls(sinceLocal, untilLocal, BATCH_LIMIT)
        : await viciDb.fetchCloserCalls(sinceLocal, untilLocal, BATCH_LIMIT);
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
    sinceUtc = localToUtc(last.call_date, conn.timezone);
  }

  if (maxSeen) await setCursor(conn.id, source, maxSeen);
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

  for (;;) {
    const rows = await viciDb.fetchRecordings(
      utcToLocalString(sinceUtc, conn.timezone),
      utcToLocalString(untilUtc, conn.timezone),
      BATCH_LIMIT,
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
      const now = new Date();
      await db
        .insert(recordings)
        .values({
          companyId: conn.companyId,
          dialerServerId: conn.id,
          callId,
          viciRecordingId: r.recording_id,
          viciLeadId: r.lead_id,
          filename: r.filename,
          locationUrl: r.location,
          startTime: startUtc,
          lengthSec: r.length_in_sec,
          status: r.location ? 'available' : 'pending',
          raw: r,
        })
        .onConflictDoUpdate({
          target: [recordings.dialerServerId, recordings.filename],
          set: {
            callId: callId ?? undefined,
            locationUrl: r.location,
            lengthSec: r.length_in_sec,
            status: r.location ? 'available' : 'pending',
            raw: r,
            updatedAt: now,
          },
        });
      imported += 1;
    }

    if (rows.length < BATCH_LIMIT) break;
    const last = rows[rows.length - 1];
    if (!last.start_time) break;
    sinceUtc = localToUtc(last.start_time, conn.timezone);
  }

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
  const lookback = new Date(Date.now() - config.SYNC_LOOKBACK_MINUTES * 4 * 60 * 1000);

  const candidates = await db
    .select({ leadId: calls.viciLeadId })
    .from(calls)
    .leftJoin(recordings, eq(recordings.callId, calls.id))
    .where(
      and(
        eq(calls.dialerServerId, conn.id),
        gte(calls.callDate, lookback),
        isNull(recordings.id),
        sql`${calls.viciLeadId} is not null`,
      ),
    )
    .groupBy(calls.viciLeadId)
    .limit(200);

  let found = 0;
  for (const c of candidates) {
    if (c.leadId == null) continue;
    let rows: Array<Record<string, string>>;
    try {
      rows = await api.recordingLookup({ leadId: c.leadId });
    } catch {
      continue; // transient API failure — retried next cycle
    }
    for (const r of rows) {
      const location = r.location ?? r.url ?? '';
      const filename = r.filename ?? (location ? location.split('/').pop()! : '');
      if (!filename) continue;
      const startLocal = r.start_time ?? r.start ?? null;
      await db
        .insert(recordings)
        .values({
          companyId: conn.companyId,
          dialerServerId: conn.id,
          viciRecordingId: r.recording_id ? Number(r.recording_id) : null,
          viciLeadId: c.leadId,
          filename,
          locationUrl: location || null,
          startTime: startLocal ? localToUtc(startLocal, conn.timezone) : null,
          lengthSec: r.length_in_sec ? Number(r.length_in_sec) : null,
          status: location ? 'available' : 'pending',
          raw: r,
        })
        .onConflictDoUpdate({
          target: [recordings.dialerServerId, recordings.filename],
          set: {
            locationUrl: location || null,
            status: location ? 'available' : 'pending',
            raw: r,
            updatedAt: new Date(),
          },
        });
      found += 1;
    }
  }
  stats.recordings_api_found = found;
}

// ---------------------------------------------------------------------------
// API-only ingestion (no MySQL access)
// ---------------------------------------------------------------------------
const API_AGENT_CAP = 300;
const API_LEAD_LOOKUP_CAP = 800;
const API_FULL_BACKFILL_DAYS = 14;

function localDateMinus(todayLocal: string, minusDays: number): string {
  const [y, m, d] = todayLocal.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d - minusDays)).toISOString().slice(0, 10);
}

/**
 * 'api' source mode: call records are synthesized from recording_lookup rows
 * (one recording = one call leg) and lead_all_info (status = the lead's
 * latest disposition, phone number). Fronter vs closer leg comes from the
 * agent classification on the Agents page, falling back to time order per
 * lead. Everything is idempotent via synthetic uniqueids (rec-<recording_id>).
 */
async function syncApiOnly(conn: DialerConnection, stats: SyncStats, full?: boolean): Promise<void> {
  const api = new ViciApiClient(conn);
  const notes = stats.notes as string[];
  const now = new Date();

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
    rosterRows.push(
      ...(await api.agentStatsExport(
        utcToLocalString(rosterStart, conn.timezone),
        utcToLocalString(now, conn.timezone),
      )),
    );
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
  const roleByUser = new Map(agentRows.map((a) => [a.viciUser, a.agentRole] as const));
  const idByUser = new Map(agentRows.map((a) => [a.viciUser, a.id] as const));
  let scanUsers = agentRows.filter((a) => a.active).map((a) => a.viciUser);
  if (scanUsers.length > API_AGENT_CAP) {
    notes.push(`agent cap: scanning ${API_AGENT_CAP} of ${scanUsers.length} agents per cycle`);
    scanUsers = scanUsers.slice(0, API_AGENT_CAP);
  }

  // --- recording scan: incremental = today+yesterday, full = backfill window ---
  const todayLocal = utcToLocalString(now, conn.timezone).slice(0, 10);
  const dayCount = full ? Math.min(config.SYNC_HISTORICAL_DAYS, API_FULL_BACKFILL_DAYS) : 2;
  const days: string[] = [];
  for (let i = dayCount - 1; i >= 0; i -= 1) days.push(localDateMinus(todayLocal, i));

  const leadCache = new Map<number, Record<string, string> | null>();
  let lookups = 0;
  let callsImported = 0;
  let recsImported = 0;
  let skipped = 0;

  for (const day of days) {
    const dayRows: ApiRecordingRow[] = [];
    for (const user of scanUsers) {
      let raw: Array<Record<string, string>>;
      try {
        raw = await api.recordingLookup({ agentUser: user, date: day });
      } catch {
        continue; // transient failure or agent with no recordings — next cycle retries
      }
      for (const r of raw) {
        const n = normalizeRecordingRow(r);
        if (!n.startTimeLocal || !n.user || !n.filename) {
          skipped += 1;
          continue;
        }
        dayRows.push({
          startTime: localToUtc(n.startTimeLocal, conn.timezone),
          user: n.user,
          recordingId: n.recordingId,
          leadId: n.leadId,
          lengthSec: n.lengthSec,
          locationUrl: n.locationUrl,
          filename: n.filename,
        });
      }
    }

    // group per lead so transfer legs are classified together
    const byLead = new Map<string, ApiRecordingRow[]>();
    for (const r of dayRows) {
      const key = r.leadId != null ? `l:${r.leadId}` : `f:${r.filename}`;
      const list = byLead.get(key);
      if (list) list.push(r);
      else byLead.set(key, [r]);
    }
    const entries: Array<{ row: ApiRecordingRow; source: 'vicidial_log' | 'vicidial_closer_log'; inferred: boolean }> = [];
    for (const rows of byLead.values()) {
      entries.push(...assignLegSources(rows, (u) => roleByUser.get(u) ?? 'unknown'));
    }

    // pre-select existing synthesized calls so a later reclassification
    // (fronter<->closer) updates the row instead of duplicating it
    const uids = entries.map((e) => syntheticUniqueId(e.row));
    const existingByUid = new Map<string, { id: string }>();
    if (uids.length > 0) {
      for (const c of await db
        .select({ id: calls.id, uid: calls.viciUniqueId })
        .from(calls)
        .where(and(eq(calls.dialerServerId, conn.id), inArray(calls.viciUniqueId, uids)))) {
        if (c.uid) existingByUid.set(c.uid, { id: c.id });
      }
    }

    for (const { row, source, inferred } of entries) {
      let leadInfo: Record<string, string> | null = null;
      if (row.leadId != null) {
        if (leadCache.has(row.leadId)) {
          leadInfo = leadCache.get(row.leadId) ?? null;
        } else if (lookups < API_LEAD_LOOKUP_CAP) {
          lookups += 1;
          try {
            leadInfo = await api.leadAllInfo(row.leadId);
          } catch {
            leadInfo = null;
          }
          leadCache.set(row.leadId, leadInfo);
        }
      }
      const status = leadInfo?.status ? leadInfo.status.trim().toUpperCase() : null;
      const phone = leadInfo?.phone_number?.trim() || phoneFromFilename(row.filename);
      const listId = leadInfo?.list_id && /^\d+$/.test(leadInfo.list_id) ? Number(leadInfo.list_id) : null;
      const uid = syntheticUniqueId(row);
      const rawPayload = {
        derivedFrom: 'api_recording_lookup',
        inferredLeg: inferred,
        recording: { recording_id: row.recordingId, filename: row.filename },
        lead_status: status,
      };

      let callId: string;
      const existing = existingByUid.get(uid);
      if (existing) {
        await db
          .update(calls)
          .set({
            source,
            status,
            phoneNumber: phone,
            lengthSec: row.lengthSec,
            viciAgentId: idByUser.get(row.user) ?? null,
            viciUserRaw: row.user,
            listId,
            raw: rawPayload,
            lastSyncedAt: new Date(),
          })
          .where(eq(calls.id, existing.id));
        callId = existing.id;
      } else {
        const inserted = await db
          .insert(calls)
          .values({
            companyId: conn.companyId,
            dialerServerId: conn.id,
            source,
            viciLeadId: row.leadId,
            viciUniqueId: uid,
            viciAgentId: idByUser.get(row.user) ?? null,
            viciUserRaw: row.user,
            phoneNumber: phone,
            callDate: row.startTime,
            lengthSec: row.lengthSec,
            status,
            listId,
            raw: rawPayload,
          })
          .onConflictDoNothing()
          .returning({ id: calls.id });
        if (inserted.length === 0) continue; // raced — next cycle refreshes it
        callId = inserted[0].id;
        existingByUid.set(uid, { id: callId });
        callsImported += 1;
      }

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
        .onConflictDoUpdate({
          target: [recordings.dialerServerId, recordings.filename],
          set: {
            callId,
            locationUrl: row.locationUrl,
            lengthSec: row.lengthSec,
            status: row.locationUrl ? 'available' : 'pending',
            updatedAt: new Date(),
          },
        });
      recsImported += 1;
    }
  }

  stats.api_calls_imported = callsImported;
  stats.api_recordings = recsImported;
  stats.api_lead_lookups = lookups;
  if (skipped > 0) stats.api_rows_skipped = skipped;
  if (lookups >= API_LEAD_LOOKUP_CAP) {
    notes.push('lead lookup cap reached — remaining dispositions fill in on the next cycles');
  }
  notes.push(
    'API mode: call dispositions come from the lead status (latest dispo per lead); per-call XFER history is not exposed by the Non-Agent API.',
  );
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

async function buildTransfersFromMappings(
  conn: DialerConnection,
  mappings: MappingRow[],
  recent: Date,
): Promise<number> {
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

async function updateQueueStatuses(companyId: string, stats: SyncStats): Promise<void> {
  const mappings = await companyMappings(companyId);
  const rows = await db
    .select({
      transfer: transfers,
      closerStatus: calls.status,
      closerDialerId: calls.dialerServerId,
      closerIngroupId: calls.ingroupId,
    })
    .from(transfers)
    .innerJoin(calls, eq(transfers.closerCallId, calls.id))
    .where(
      and(
        eq(transfers.companyId, companyId),
        eq(transfers.matchStatus, 'matched'),
        eq(transfers.isMock, false),
      ),
    )
    .orderBy(desc(transfers.xferTime))
    .limit(10_000);

  let transitions = 0;
  const unmapped = new Map<string, number>();
  for (const row of rows) {
    const meaning = resolveMeaning(mappings, {
      dialerServerId: row.closerDialerId,
      campaignId: null,
      dispositionCode: row.closerStatus,
    });
    if (meaning === null && row.closerStatus) {
      unmapped.set(row.closerStatus, (unmapped.get(row.closerStatus) ?? 0) + 1);
    }
    const result = transition(row.transfer.queueStatus, {
      matched: true,
      closerDisposition: row.closerStatus,
      closerMeaning: meaning,
    });
    if (!result.changed) continue;
    await db
      .update(transfers)
      .set({
        queueStatus: result.next,
        saleDisposition: result.next === 'closed' ? row.closerStatus : null,
        closedAt: result.next === 'closed' ? new Date() : null,
        updatedAt: new Date(),
      })
      .where(eq(transfers.id, row.transfer.id));
    await db.insert(transferEvents).values({
      transferId: row.transfer.id,
      fromStatus: row.transfer.queueStatus,
      toStatus: result.next,
      reason: result.regression
        ? `disposition corrected: '${row.closerStatus}' is no longer a configured sale`
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
