import mysql from 'mysql2/promise';
import type {
  AgentLogRow,
  DialerConnection,
  ViciCallRow,
  ViciCampaignRow,
  ViciIngroupRow,
  ViciRecordingRow,
  ViciUserRow,
} from './types.js';

/**
 * Read-only MySQL adapter for a VICIdial cluster database. This is the
 * recommended source for call logs: the Non-Agent API has no full call-log
 * export. Only SELECT statements are issued; grant the configured MySQL user
 * SELECT-only privileges.
 */
export interface LeadInfo {
  lead: Record<string, unknown>;
  list: Record<string, unknown> | null;
  custom: Record<string, unknown> | null;
}

/** VICIdial stores line breaks in free text as "!N" (carriage returns as "!R"). */
export function decodeViciText<T extends Record<string, unknown>>(row: T): T {
  const out: Record<string, unknown> = { ...row };
  for (const [k, v] of Object.entries(out)) {
    if (typeof v === 'string' && v.includes('!')) out[k] = v.replace(/!R/g, '').replace(/!N/g, '\n');
  }
  return out as T;
}

export interface ViciDbPoolOptions {
  /** parallel connections to the dialer (default 3 — syncs are sequential) */
  connectionLimit?: number;
  /** keep idle connections this long, so the next lookup skips the handshake */
  idleTimeoutMs?: number;
}

const NO_SUCH_TABLE = 1146;

export class ViciDbClient {
  private pool: mysql.Pool;
  /** whether custom_<list_id> exists — fields rarely change, so remembered */
  private customTables = new Map<number, { exists: boolean; at: number }>();

  constructor(conn: DialerConnection, opts: ViciDbPoolOptions = {}) {
    if (!conn.db) throw new Error(`Dialer ${conn.name} has no database credentials`);
    this.pool = mysql.createPool({
      host: conn.db.host,
      port: conn.db.port,
      database: conn.db.database,
      user: conn.db.user,
      password: conn.db.password,
      connectionLimit: opts.connectionLimit ?? 3,
      maxIdle: opts.connectionLimit ?? 3,
      idleTimeout: opts.idleTimeoutMs ?? 60_000,
      enableKeepAlive: true,
      connectTimeout: 10_000,
      // VICIdial stores local time; we read strings and convert explicitly.
      dateStrings: true,
    });
  }

  async ping(): Promise<void> {
    const c = await this.pool.getConnection();
    try {
      await c.ping();
    } finally {
      c.release();
    }
  }

  /**
   * Outbound call legs. `since`/`until` are dialer-local 'YYYY-MM-DD HH:MM:SS'.
   * `archive` reads the *_archive table — dialers with a nightly archive job
   * keep only the current day in the live tables.
   */
  async fetchOutboundCalls(since: string, until: string, limit = 5000, archive = false): Promise<ViciCallRow[]> {
    const table = archive ? 'vicidial_log_archive' : 'vicidial_log';
    const [rows] = await this.pool.query(
      `SELECT uniqueid, lead_id, list_id, campaign_id, call_date, length_in_sec,
              status, phone_number, user, term_reason
         FROM ${table}
        WHERE call_date > ? AND call_date <= ?
        ORDER BY call_date ASC
        LIMIT ?`,
      [since, until, limit],
    );
    return rows as ViciCallRow[];
  }

  /**
   * Outbound legs in a window whose disposition is one of `statuses` — the
   * realtime refresh: a row first read mid-call (INCALL) becomes XFER/SALE
   * only when the agent dispositions, after the cursor has moved on.
   */
  async fetchOutboundCallsByStatus(
    since: string,
    until: string,
    statuses: string[],
    limit = 5000,
  ): Promise<ViciCallRow[]> {
    if (statuses.length === 0) return [];
    const [rows] = await this.pool.query(
      `SELECT uniqueid, lead_id, list_id, campaign_id, call_date, length_in_sec,
              status, phone_number, user, term_reason
         FROM vicidial_log
        WHERE call_date > ? AND call_date <= ? AND UPPER(status) IN (?)
        ORDER BY call_date ASC
        LIMIT ?`,
      [since, until, statuses.map((s) => s.toUpperCase()), limit],
    );
    return rows as ViciCallRow[];
  }

  /**
   * Exact rows by uniqueid from the live AND archived table — heals calls we
   * first saw mid-call (INCALL) whose final disposition was written later,
   * whichever table the dialer has moved them to since.
   */
  async fetchCallsByUniqueIds(
    source: 'vicidial_log' | 'vicidial_closer_log',
    uniqueIds: string[],
  ): Promise<ViciCallRow[]> {
    if (uniqueIds.length === 0) return [];
    const cols = `uniqueid, lead_id, list_id, campaign_id, call_date, length_in_sec,
                  status, phone_number, user, term_reason`;
    const out: ViciCallRow[] = [];
    for (const table of [source, `${source}_archive`]) {
      try {
        const [rows] = await this.pool.query(`SELECT ${cols} FROM ${table} WHERE uniqueid IN (?)`, [uniqueIds]);
        out.push(...(rows as ViciCallRow[]));
      } catch {
        // archive table may not exist on every dialer
      }
    }
    return out;
  }

  /**
   * Agent dispositions (vicidial_agent_log) with one of `statuses`, by
   * event_time — the source of VICIdial's Agent Status Detail counts.
   */
  async fetchAgentDispositions(
    since: string,
    until: string,
    statuses: string[],
    archive = false,
    limit = 5000,
  ): Promise<AgentLogRow[]> {
    if (statuses.length === 0) return [];
    const table = archive ? 'vicidial_agent_log_archive' : 'vicidial_agent_log';
    const [rows] = await this.pool.query(
      `SELECT agent_log_id, user, event_time, status, lead_id, uniqueid, campaign_id
         FROM ${table}
        WHERE event_time > ? AND event_time <= ? AND UPPER(status) IN (?)
        ORDER BY event_time ASC
        LIMIT ?`,
      [since, until, statuses.map((s) => s.toUpperCase()), limit],
    );
    return rows as AgentLogRow[];
  }

  /** Current status of known agent-log rows (live and archive), to catch edits. */
  async fetchAgentLogByIds(ids: number[]): Promise<AgentLogRow[]> {
    if (ids.length === 0) return [];
    const out: AgentLogRow[] = [];
    for (const table of ['vicidial_agent_log', 'vicidial_agent_log_archive']) {
      try {
        const [rows] = await this.pool.query(
          `SELECT agent_log_id, user, event_time, status, lead_id, uniqueid, campaign_id
             FROM ${table} WHERE agent_log_id IN (?)`,
          [ids],
        );
        out.push(...(rows as AgentLogRow[]));
      } catch {
        // archive table may not exist
      }
    }
    return out;
  }

  /** Closer/inbound call legs (vicidial_closer_log.campaign_id = in-group). */
  async fetchCloserCalls(since: string, until: string, limit = 5000, archive = false): Promise<ViciCallRow[]> {
    const table = archive ? 'vicidial_closer_log_archive' : 'vicidial_closer_log';
    const [rows] = await this.pool.query(
      `SELECT uniqueid, lead_id, list_id, campaign_id, call_date, length_in_sec,
              status, phone_number, user, term_reason
         FROM ${table}
        WHERE call_date > ? AND call_date <= ?
        ORDER BY call_date ASC
        LIMIT ?`,
      [since, until, limit],
    );
    return rows as ViciCallRow[];
  }

  /** recording_log rows; vicidial_id is the uniqueid of the recorded leg. */
  async fetchRecordings(since: string, until: string, limit = 5000, archive = false): Promise<ViciRecordingRow[]> {
    const table = archive ? 'recording_log_archive' : 'recording_log';
    // Stock VICIdial has no index on recording_log.start_time, so a time
    // filter alone scans the whole table — on a busy dialer hundreds of
    // thousands of rows, seconds of load on its database every sync. The
    // primary key grows with start_time, so the scan is bounded to the ids
    // that reach back to `since` (found by a few primary-key lookups).
    const fromId = archive ? null : await this.recordingIdFloor(since).catch(() => null);
    const [rows] = await this.pool.query(
      `SELECT recording_id, start_time, length_in_sec, filename, location,
              lead_id, user, vicidial_id
         FROM ${table}
        WHERE ${fromId != null ? 'recording_id >= ? AND ' : ''}start_time > ? AND start_time <= ?
        ORDER BY start_time ASC
        LIMIT ?`,
      fromId != null ? [fromId, since, until, limit] : [since, until, limit],
    );
    return rows as ViciRecordingRow[];
  }

  /**
   * The lowest recording_id that can hold a recording started after `since`
   * (dialer-local 'YYYY-MM-DD HH:MM:SS'), or null when the bound would cover
   * most of the table anyway. Steps back from the newest id, widening each
   * time, until the row there started at or before `since`.
   */
  async recordingIdFloor(since: string): Promise<number | null> {
    const [maxRows] = await this.pool.query('SELECT MAX(recording_id) AS mx FROM recording_log');
    const max = Number((maxRows as { mx: unknown }[])[0]?.mx);
    if (!Number.isFinite(max) || max <= 0) return null;
    for (let span = 2_000; span <= 1_000_000; span *= 5) {
      const lo = max - span;
      if (lo <= 0) return null;
      const [probe] = await this.pool.query(
        'SELECT start_time FROM recording_log WHERE recording_id >= ? ORDER BY recording_id ASC LIMIT 1',
        [lo],
      );
      const start = (probe as { start_time: string | null }[])[0]?.start_time;
      // ids are handed out at call start, so everything below `lo` started
      // earlier still; a margin covers recordings that began the same second
      if (start && start <= since) return Math.max(0, lo - 200);
    }
    return null;
  }

  /** One lead's details for the call page — primary-key lookup, milliseconds. */
  /**
   * Everything the dialer holds on a lead: the full vicidial_list row, its
   * list (name, campaign) and the list's custom fields when the list has a
   * custom_<list_id> table. Free text comes back with VICIdial's "!N" line
   * breaks decoded.
   */
  /**
   * A lead, its list and its custom fields. The dialer is often far away, so
   * round trips are what cost time: the list rides along in the lead query,
   * and when the caller already knows the list (from the synced call) the
   * custom fields are read in parallel — one round trip in the usual case.
   */
  async fetchLead(leadId: number, listIdHint?: number | null): Promise<LeadInfo | null> {
    const hint = listIdHint != null && Number.isFinite(Number(listIdHint)) ? Math.trunc(Number(listIdHint)) : null;
    const [found, guessedCustom] = await Promise.all([
      this.leadWithList(leadId),
      hint != null ? this.customFields(hint, leadId) : Promise.resolve(undefined),
    ]);
    if (!found) return null;
    const { lead, list } = found;
    const listId = Number(lead.list_id);
    let custom: Record<string, unknown> | null = null;
    if (Number.isFinite(listId)) {
      // the lead may have moved lists since the call — then read the right table
      custom = hint === Math.trunc(listId) && guessedCustom !== undefined ? guessedCustom : await this.customFields(listId, leadId);
    }
    return { lead: decodeViciText(lead), list, custom: custom ? decodeViciText(custom) : null };
  }

  private async leadWithList(
    leadId: number,
  ): Promise<{ lead: Record<string, unknown>; list: Record<string, unknown> | null } | null> {
    try {
      const [rows] = await this.pool.query(
        `SELECT l.*, ls.list_name AS __ls_list_name, ls.campaign_id AS __ls_campaign_id,
                ls.active AS __ls_active, ls.list_description AS __ls_list_description
           FROM vicidial_list l
           LEFT JOIN vicidial_lists ls ON ls.list_id = l.list_id
          WHERE l.lead_id = ? LIMIT 1`,
        [leadId],
      );
      const row = (rows as Record<string, unknown>[])[0];
      if (!row) return null;
      const lead: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(row)) if (!k.startsWith('__ls_')) lead[k] = v;
      const list =
        row.__ls_list_name != null || row.__ls_campaign_id != null
          ? {
              list_id: row.list_id,
              list_name: row.__ls_list_name,
              campaign_id: row.__ls_campaign_id,
              active: row.__ls_active,
              list_description: row.__ls_list_description,
            }
          : null;
      return { lead, list };
    } catch {
      // a read-only user without access to vicidial_lists: the lead alone
      const [rows] = await this.pool.query(`SELECT * FROM vicidial_list WHERE lead_id = ? LIMIT 1`, [leadId]);
      const lead = (rows as Record<string, unknown>[])[0];
      return lead ? { lead, list: null } : null;
    }
  }

  private async customFields(listId: number, leadId: number): Promise<Record<string, unknown> | null> {
    const id = Math.trunc(listId);
    const known = this.customTables.get(id);
    if (known && !known.exists && Date.now() - known.at < 10 * 60_000) return null;
    try {
      const [c] = await this.pool.query(`SELECT * FROM \`custom_${id}\` WHERE lead_id = ? LIMIT 1`, [leadId]);
      this.customTables.set(id, { exists: true, at: Date.now() });
      return (c as Record<string, unknown>[])[0] ?? null;
    } catch (err) {
      // no custom fields on this list, or the read-only user cannot see them
      if ((err as { errno?: number }).errno === NO_SUCH_TABLE || (err as { code?: string }).code === 'ER_TABLEACCESS_DENIED_ERROR') {
        this.customTables.set(id, { exists: false, at: Date.now() });
      }
      return null;
    }
  }

  async fetchUsers(): Promise<ViciUserRow[]> {
    const [rows] = await this.pool.query(
      `SELECT user, full_name, user_group, user_level, active FROM vicidial_users`,
    );
    return rows as ViciUserRow[];
  }

  async fetchCampaigns(): Promise<ViciCampaignRow[]> {
    const [rows] = await this.pool.query(
      `SELECT campaign_id, campaign_name, active FROM vicidial_campaigns`,
    );
    return rows as ViciCampaignRow[];
  }

  async fetchIngroups(): Promise<ViciIngroupRow[]> {
    const [rows] = await this.pool.query(
      `SELECT group_id, group_name, active FROM vicidial_inbound_groups`,
    );
    return rows as ViciIngroupRow[];
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
