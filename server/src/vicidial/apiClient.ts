import { request } from 'undici';
import type { DialerConnection } from './types.js';

/**
 * Thin client for the VICIdial Non-Agent API (/vicidial/non_agent_api.php).
 *
 * The Non-Agent API does NOT expose a full call-log export; call records come
 * from the read-only MySQL adapter (dbClient). The API is used for:
 *  - connectivity checks (`version`)
 *  - recording metadata (`recording_lookup`) in 'api'/'hybrid' source modes
 * Column layouts are resolved from the API's own header row (header=YES), not
 * hard-coded, because layouts differ between VICIdial builds.
 */
export class ViciApiError extends Error {
  constructor(
    message: string,
    public readonly body?: string,
  ) {
    super(message);
  }
}

export class ViciApiClient {
  constructor(private readonly conn: DialerConnection) {}

  private async call(params: Record<string, string>): Promise<string> {
    if (!this.conn.apiUser || !this.conn.apiPass) {
      throw new ViciApiError('Dialer has no API credentials configured');
    }
    const url = new URL(`${this.conn.baseUrl}/vicidial/non_agent_api.php`);
    url.searchParams.set('source', 'viciqa');
    url.searchParams.set('user', this.conn.apiUser);
    url.searchParams.set('pass', this.conn.apiPass);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

    const res = await request(url.toString(), {
      method: 'GET',
      headersTimeout: 15_000,
      bodyTimeout: 30_000,
    });
    const body = await res.body.text();
    if (res.statusCode !== 200) {
      throw new ViciApiError(`VICIdial API HTTP ${res.statusCode}`, body.slice(0, 500));
    }
    if (/^ERROR/m.test(body)) {
      throw new ViciApiError(`VICIdial API error: ${body.split('\n')[0]}`, body.slice(0, 500));
    }
    return body;
  }

  /** Connectivity + credential check. Returns the VERSION line. */
  async version(): Promise<string> {
    const body = await this.call({ function: 'version' });
    return body.trim().split('\n')[0];
  }

  /**
   * The dialer's own clock, from the version line
   * (DATE: local datetime, EPOCH: unix seconds, TZNOW: current UTC offset
   * in hours including DST). Used to auto-check timezone config and drift.
   */
  async serverTime(): Promise<{
    localTime: string | null;
    epoch: number | null;
    tzNowHours: number | null;
    raw: string;
  }> {
    const line = await this.version();
    const date = line.match(/DATE:\s*(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/)?.[1] ?? null;
    const epoch = line.match(/EPOCH:\s*(\d+)/)?.[1];
    const tznow = line.match(/TZNOW:\s*(-?\d+(?:\.\d+)?)/)?.[1];
    return {
      localTime: date,
      epoch: epoch ? Number(epoch) : null,
      tzNowHours: tznow ? Number(tznow) : null,
      raw: line,
    };
  }

  /**
   * recording_lookup for one lead or one agent+date. Returns rows keyed by the
   * header names the server itself reports.
   *
   * Verified on a live 2.14-189 build: with duration=Y the data rows carry one
   * MORE cell than the header (seconds inserted before the URL) — the remap in
   * fixRecordingRow recovers `location` and `length_in_sec` in that case.
   */
  async recordingLookup(opts: {
    leadId?: number;
    agentUser?: string;
    date?: string; // YYYY-MM-DD (dialer-local)
  }): Promise<Array<Record<string, string>>> {
    const params: Record<string, string> = {
      function: 'recording_lookup',
      stage: 'pipe',
      header: 'YES',
      duration: 'Y',
    };
    if (opts.leadId != null) params.lead_id = String(opts.leadId);
    if (opts.agentUser) params.agent_user = opts.agentUser;
    if (opts.date) params.date = opts.date;

    const body = await this.call(params);
    return parsePipeWithHeader(body).map(fixRecordingRow);
  }

  /** campaigns_list has no header row; columns verified: id|name|active|… */
  async campaignsList(): Promise<Array<{ campaign_id: string; campaign_name: string; active: string }>> {
    const body = await this.call({ function: 'campaigns_list' });
    return body
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith('ERROR'))
      .map((l) => {
        const c = l.split('|');
        return { campaign_id: (c[0] ?? '').trim(), campaign_name: (c[1] ?? '').trim(), active: (c[2] ?? '').trim() };
      })
      .filter((r) => r.campaign_id.length > 0);
  }

  /** Per-agent stats for a dialer-local datetime range; used as the agent roster. */
  async agentStatsExport(startLocal: string, endLocal: string): Promise<Array<Record<string, string>>> {
    const body = await this.call({
      function: 'agent_stats_export',
      datetime_start: startLocal,
      datetime_end: endLocal,
      stage: 'pipe',
      header: 'YES',
    });
    return parsePipeWithHeader(body);
  }

  /** Currently logged-in agents (live roster supplement). */
  async loggedInAgents(): Promise<Array<Record<string, string>>> {
    const body = await this.call({ function: 'logged_in_agents', stage: 'pipe', header: 'YES' });
    return parsePipeWithHeader(body);
  }

  /** Full lead record — provides status (latest disposition) and phone_number. */
  async leadAllInfo(leadId: number): Promise<Record<string, string> | null> {
    let body: string;
    try {
      body = await this.call({ function: 'lead_all_info', lead_id: String(leadId), stage: 'pipe', header: 'YES' });
    } catch (err) {
      if (err instanceof ViciApiError) return null; // unknown lead etc.
      throw err;
    }
    const rows = parsePipeWithHeader(body);
    return rows[0] ?? null;
  }
}

/**
 * Repairs recording_lookup rows where duration=Y added an unlisted seconds
 * column: the URL lands one past the 'location' slot and 'location' holds the
 * seconds. Pure; unit-tested.
 */
export function fixRecordingRow(row: Record<string, string>): Record<string, string> {
  const extra = row.__extra0;
  if (extra !== undefined && /^https?:\/\//i.test(extra) && row.location && !/^https?:\/\//i.test(row.location)) {
    const fixed: Record<string, string> = { ...row, length_in_sec: row.location, location: extra };
    delete fixed.__extra0;
    return fixed;
  }
  // still recording: the row carries the seconds so far and no URL yet, so
  // the seconds land in the 'location' slot — never treat them as a path
  if (extra === undefined && row.location !== undefined && /^\d+$/.test(row.location)) {
    return { ...row, length_in_sec: row.location, location: '' };
  }
  return row;
}

export function parsePipeWithHeader(body: string): Array<Record<string, string>> {
  const lines = body
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('ERROR'));
  if (lines.length < 2) return [];
  const header = lines[0].split('|').map((h) => h.trim().toLowerCase());
  const rows: Array<Record<string, string>> = [];
  for (const line of lines.slice(1)) {
    const cells = line.split('|');
    const row: Record<string, string> = {};
    header.forEach((h, i) => {
      row[h] = (cells[i] ?? '').trim();
    });
    // keep cells beyond the header so callers can repair shifted layouts
    for (let i = header.length; i < cells.length; i += 1) {
      row[`__extra${i - header.length}`] = (cells[i] ?? '').trim();
    }
    rows.push(row);
  }
  return rows;
}
