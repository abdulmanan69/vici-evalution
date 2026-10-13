import mysql from 'mysql2/promise';
import type {
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

  /** Outbound call legs. `since`/`until` are dialer-local 'YYYY-MM-DD HH:MM:SS'. */
  async fetchOutboundCalls(since: string, until: string, limit = 5000): Promise<ViciCallRow[]> {
    const [rows] = await this.pool.query(
      `SELECT uniqueid, lead_id, list_id, campaign_id, call_date, length_in_sec,
              status, phone_number, user, term_reason
         FROM vicidial_log
        WHERE call_date > ? AND call_date <= ?
        ORDER BY call_date ASC
        LIMIT ?`,
      [since, until, limit],
    );
    return rows as ViciCallRow[];
  }

  /** Closer/inbound call legs (vicidial_closer_log.campaign_id = in-group). */
  async fetchCloserCalls(since: string, until: string, limit = 5000): Promise<ViciCallRow[]> {
    const [rows] = await this.pool.query(
      `SELECT uniqueid, lead_id, list_id, campaign_id, call_date, length_in_sec,
              status, phone_number, user, term_reason
         FROM vicidial_closer_log
        WHERE call_date > ? AND call_date <= ?
        ORDER BY call_date ASC
        LIMIT ?`,
      [since, until, limit],
    );
    return rows as ViciCallRow[];
  }

  /** recording_log rows; vicidial_id is the uniqueid of the recorded leg. */
  async fetchRecordings(since: string, until: string, limit = 5000): Promise<ViciRecordingRow[]> {
    const [rows] = await this.pool.query(
      `SELECT recording_id, start_time, length_in_sec, filename, location,
              lead_id, user, vicidial_id
         FROM recording_log
        WHERE start_time > ? AND start_time <= ?
        ORDER BY start_time ASC
        LIMIT ?`,
      [since, until, limit],
    );
    return rows as ViciRecordingRow[];
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
