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
export class ViciDbClient {
  private pool: mysql.Pool;

  constructor(conn: DialerConnection) {
    if (!conn.db) throw new Error(`Dialer ${conn.name} has no database credentials`);
    this.pool = mysql.createPool({
      host: conn.db.host,
      port: conn.db.port,
      database: conn.db.database,
      user: conn.db.user,
      password: conn.db.password,
      connectionLimit: 3,
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
    const [rows] = await this.pool.query(
      `SELECT recording_id, start_time, length_in_sec, filename, location,
              lead_id, user, vicidial_id
         FROM ${table}
        WHERE start_time > ? AND start_time <= ?
        ORDER BY start_time ASC
        LIMIT ?`,
      [since, until, limit],
    );
    return rows as ViciRecordingRow[];
  }

  /** One lead's details for the call page — primary-key lookup, milliseconds. */
  async fetchLead(leadId: number): Promise<Record<string, unknown> | null> {
    const [rows] = await this.pool.query(
      `SELECT lead_id, status, list_id, phone_number, alt_phone, title, first_name,
              middle_initial, last_name, address1, address2, address3, city, state,
              postal_code, country_code, email, vendor_lead_code, source_id,
              security_phrase, comments, called_count, last_local_call_time, entry_date
         FROM vicidial_list
        WHERE lead_id = ?
        LIMIT 1`,
      [leadId],
    );
    return (rows as Record<string, unknown>[])[0] ?? null;
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
