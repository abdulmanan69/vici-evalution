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
  searchArchived: boolean,
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
  // only set for archived dates: with the flag on, dialers that have NOT yet
  // archived a date return an empty table for it
  if (searchArchived) u.searchParams.set('search_archived_data', 'checked');
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
  const rawLines = html.split('\n');
  const lines = rawLines.map((l) => l.replace(/<[^>]+>/g, ''));

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
      // the TEXT table truncates IDs to 8 chars; the link carries the full one
      user: linkedUser(rawLines[i]) ?? cells[1],
      calls,
      statusCounts,
    });
  }
  if (rows.length === 0) {
    throw new Error('Agent table parsed but contained no data rows');
  }
  return { statuses, rows };
}

function linkedUser(rawLine: string): string | null {
  const m = /user_stats\.php\?[^"'>]*?\buser=([^&"'>]+)/i.exec(rawLine);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1].replace(/\+/g, ' ')).trim() || null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// user_stats.php per-call exports — the exact call log, no DB access needed.
// Verified live: file_download=5 (outbound), 6 (inbound closer), 9 (manual):
//   "","#","DATE/TIME","LENGTH","STATUS","PHONE","CAMPAIGN","GROUP","LIST","LEAD","HANGUP REASON"
//   "","#","DATE/TIME","LENGTH","STATUS","PHONE","IN-GROUP","WAIT(S)","AGENT(S)","LIST","LEAD","HANGUP REASON"
// ---------------------------------------------------------------------------

export type UserStatsKind = 'outbound' | 'closer' | 'manual';

export interface UserStatsCall {
  kind: UserStatsKind;
  dateTimeLocal: string; // 'YYYY-MM-DD HH:MM:SS' dialer-local
  lengthSec: number | null;
  status: string | null;
  phone: string | null;
  /** outbound/manual: campaign id; closer: in-group id */
  campaignOrGroup: string | null;
  listId: number | null;
  leadId: number | null;
  hangupReason: string | null;
}

const USER_STATS_DOWNLOADS: Array<{ n: number; kind: UserStatsKind }> = [
  { n: 5, kind: 'outbound' },
  { n: 6, kind: 'closer' },
  { n: 9, kind: 'manual' },
];

/** Exact per-call rows for one agent over a dialer-local date range. */
export async function fetchUserStatsCalls(
  conn: DialerConnection,
  agentUser: string,
  dateFrom: string,
  dateTo: string,
  searchArchived: boolean,
): Promise<UserStatsCall[]> {
  if (!conn.apiUser || !conn.apiPass) throw new Error('No API credentials configured');
  const all: UserStatsCall[] = [];
  for (const { n, kind } of USER_STATS_DOWNLOADS) {
    const u = new URL(`${conn.baseUrl}/vicidial/user_stats.php`);
    u.searchParams.set('DB', '0');
    u.searchParams.set('user', agentUser);
    u.searchParams.set('begin_date', dateFrom);
    u.searchParams.set('end_date', dateTo);
    if (searchArchived) u.searchParams.set('search_archived_data', 'checked');
    u.searchParams.set('file_download', String(n));
    const res = await request(u.toString(), {
      headers: {
        authorization: 'Basic ' + Buffer.from(`${conn.apiUser}:${conn.apiPass}`).toString('base64'),
      },
      headersTimeout: 20_000,
      bodyTimeout: 90_000,
    });
    const body = await res.body.text();
    if (res.statusCode !== 200) throw new Error(`user_stats export HTTP ${res.statusCode}`);
    all.push(...parseUserStatsCsv(body, kind));
  }
  return all;
}

/** Pure CSV parser for the user_stats export format. Unit-tested. */
export function parseUserStatsCsv(csv: string, kind: UserStatsKind): UserStatsCall[] {
  const lines = csv.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
  const headerIdx = lines.findIndex((l) => /"DATE\/TIME"/i.test(l));
  if (headerIdx === -1) return [];
  const header = splitCsv(lines[headerIdx]).map((h) => h.toUpperCase());
  const col = (name: string) => header.findIndex((h) => h === name);
  const iDate = col('DATE/TIME');
  const iLen = col('LENGTH');
  const iStatus = col('STATUS');
  const iPhone = col('PHONE');
  const iCamp = header.findIndex((h) => h === 'CAMPAIGN' || h === 'IN-GROUP');
  const iList = col('LIST');
  const iLead = col('LEAD');
  const iHang = col('HANGUP REASON');

  const rows: UserStatsCall[] = [];
  for (const line of lines.slice(headerIdx + 1)) {
    const cells = splitCsv(line);
    const dt = cells[iDate];
    if (!dt || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(dt)) continue;
    const num = (v: string | undefined) => (v !== undefined && /^\d+$/.test(v.trim()) ? Number(v) : null);
    rows.push({
      kind,
      dateTimeLocal: dt,
      lengthSec: num(cells[iLen]),
      status: cells[iStatus]?.trim().toUpperCase() || null,
      phone: cells[iPhone]?.trim() || null,
      campaignOrGroup: iCamp >= 0 ? cells[iCamp]?.trim() || null : null,
      listId: num(cells[iList]),
      leadId: num(cells[iLead]),
      hangupReason: iHang >= 0 ? cells[iHang]?.trim() || null : null,
    });
  }
  return rows;
}

function splitCsv(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else if (ch === '"') {
        inQ = false;
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQ = true;
    } else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
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
