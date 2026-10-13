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
   * recording_lookup for one lead or one agent+date. Returns rows keyed by the
   * header names the server itself reports.
   */
  async recordingLookup(opts: {
    leadId?: number;
    agentUser?: string;
    date?: string; // YYYY-MM-DD
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
    return parsePipeWithHeader(body);
  }
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
    rows.push(row);
  }
  return rows;
}
