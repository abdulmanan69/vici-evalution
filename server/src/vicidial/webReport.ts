import { request } from 'undici';
import type { DialerConnection } from './types.js';

/**
 * Fallback source for per-agent daily counts: VICIdial's own
 * AST_agent_status_detail.php web report in TEXT mode with
 * search_archived_data=checked.
 *
 * Why it exists: agent_stats_export reads the live vicidial_agent_log only —
 * on dialers that archive nightly it returns NO RECORDS for past dates. The
 * web report searches the archive tables, and the API user's credentials are
 * accepted via HTTP Basic auth when the account has report access (verified
 * live against the configured dialer).
 */

export interface AgentStatusDetailRow {
  name: string;
  user: string;
  calls: number;
  statusCounts: Record<string, number>;
}

export interface AgentStatusDetail {
  statuses: string[];
  rows: AgentStatusDetailRow[];
}

export async function fetchAgentStatusDetail(
  conn: DialerConnection,
  dateFrom: string, // YYYY-MM-DD dialer-local
  dateTo: string,
): Promise<string> {
  if (!conn.apiUser || !conn.apiPass) {
    throw new Error('No API credentials configured');
  }
  const u = new URL(`${conn.baseUrl}/vicidial/AST_agent_status_detail.php`);
  u.searchParams.set('DB', '0');
  u.searchParams.set('query_date', dateFrom);
  u.searchParams.set('end_date', dateTo);
  u.searchParams.append('group[]', '--ALL--');
  u.searchParams.append('user_group[]', '--ALL--');
  u.searchParams.set('shift', 'ALL');
  u.searchParams.set('report_display_type', 'TEXT');
  u.searchParams.set('search_archived_data', 'checked');
  u.searchParams.set('SUBMIT', 'SUBMIT');

  const res = await request(u.toString(), {
    headers: {
      authorization: 'Basic ' + Buffer.from(`${conn.apiUser}:${conn.apiPass}`).toString('base64'),
    },
    headersTimeout: 20_000,
    bodyTimeout: 90_000,
  });
  const body = await res.body.text();
  if (res.statusCode !== 200) {
    throw new Error(`Report HTTP ${res.statusCode}`);
  }
  return body;
}

/**
 * Parses the TEXT report's agent table. Pure, unit-tested against the live
 * layout:
 *   | USER NAME | ID | CALLS | CIcalls | DNC/CI% | <one column per status> |
 * Data rows follow until the TOTALS row; the ID cell contains an <a> link.
 */
export function parseAgentStatusDetail(html: string): AgentStatusDetail {
  const text = html.replace(/<[^>]+>/g, '');
  const lines = text.split('\n');

  const headerIdx = lines.findIndex((l) => /^\s*\|\s*USER NAME\s*\|/.test(l) && /\|\s*CALLS\s*\|/.test(l));
  if (headerIdx === -1) {
    throw new Error('Agent table header not found in report (layout changed or no data)');
  }
  const headerCells = splitRow(lines[headerIdx]);
  // [USER NAME, ID, CALLS, CIcalls, DNC/CI%, ...statuses]
  const statuses = headerCells.slice(5).map((s) => s.toUpperCase());

  const rows: AgentStatusDetailRow[] = [];
  for (let i = headerIdx + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^\s*\+[-+]+/.test(line)) continue; // separator
    if (!/^\s*\|/.test(line)) break; // table ended
    const cells = splitRow(line);
    if (cells.length < 3) continue;
    if (/TOTALS/i.test(cells[0])) break; // totals are recomputed by the caller
    const calls = toInt(cells[2]);
    if (calls === null) continue;
    const statusCounts: Record<string, number> = {};
    statuses.forEach((status, idx) => {
      const v = toInt(cells[5 + idx]);
      if (v !== null && v !== 0) statusCounts[status] = v;
    });
    rows.push({
      name: cells[0],
      user: cells[1],
      calls,
      statusCounts,
    });
  }
  if (rows.length === 0) {
    throw new Error('Agent table parsed but contained no data rows');
  }
  return { statuses, rows };
}

function splitRow(line: string): string[] {
  const cells = line.split('|').map((c) => c.trim());
  // leading/trailing pipes produce empty first/last cells
  if (cells.length > 0 && cells[0] === '') cells.shift();
  if (cells.length > 0 && cells[cells.length - 1] === '') cells.pop();
  return cells;
}

function toInt(v: string | undefined): number | null {
  if (v === undefined) return null;
  const t = v.replace(/,/g, '').trim();
  if (!/^\d+$/.test(t)) return null;
  return Number(t);
}
