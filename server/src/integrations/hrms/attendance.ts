/**
 * Dialer attendance → HRMS: per agent and shift day, when they first and last
 * worked on the dialer, how many calls and how much talk time.
 *
 *   pushAttendance()   hourly job `hrms-attendance` (worker.ts)
 *
 * A shift day runs from HRMS's `dayStartsAt` (local time in its `timeZone`)
 * to the same time the next day, and is dated the day it began: with
 * dayStartsAt 12:00, a 20:00 → 05:00 night shift is one shift day.
 *
 * HRMS replaces this source's dialer rows for the whole window it is sent,
 * so every request carries every agent's days of its window. The window is
 * the last few shift days only, never older than RETENTION_DAYS, because
 * older un-reviewed calls are deleted here and would look like absences.
 *
 * Read-only on the QA side.
 */
import { and, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import { config } from '../../config.js';
import { db } from '../../db/client.js';
import { calls, dialerServers, viciAgents } from '../../db/schema.js';
import { localToUtc } from '../../vicidial/timezone.js';
import { type AttendanceItem, type AttendanceResult, type HrmsClient } from './client.js';
import { forEachHrmsCompany, type PushScope } from './sync.js';

/** VICIdial's own users, never a person: auto-dial and drop placeholders. */
const SYSTEM_USERS = new Set(['', 'VDAD', 'VDCL', 'VDAC']);

export function isSystemUser(user: string | null | undefined): boolean {
  return SYSTEM_USERS.has((user ?? '').trim().toUpperCase());
}

/** 'HH:MM' → minutes after midnight (defaults to 12:00 on anything odd). */
export function parseDayStart(v: string | undefined): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec((v ?? '').trim());
  if (!m) return 12 * 60;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 23 || mi > 59) return 12 * 60;
  return h * 60 + mi;
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function localParts(at: Date, timeZone: string) {
  let f = fmtCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });
    fmtCache.set(timeZone, f);
  }
  const p: Record<string, string> = {};
  for (const x of f.formatToParts(at)) p[x.type] = x.value;
  return { y: Number(p.year), mo: Number(p.month), d: Number(p.day), h: Number(p.hour) % 24, mi: Number(p.minute), s: Number(p.second) };
}

export const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** The shift day (YYYY-MM-DD) an instant belongs to. */
export function shiftDay(at: Date, timeZone: string, dayStartMin: number): string {
  const p = localParts(at, timeZone);
  const wall = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - dayStartMin * 60_000;
  return new Date(wall).toISOString().slice(0, 10);
}

/** The instant a shift day begins. */
export function shiftDayStart(day: string, timeZone: string, dayStartMin: number): Date {
  const hh = String(Math.floor(dayStartMin / 60)).padStart(2, '0');
  const mm = String(dayStartMin % 60).padStart(2, '0');
  return localToUtc(`${day} ${hh}:${mm}:00`, timeZone);
}

/**
 * The shift days to send: the current one and the completed ones before it,
 * at most 8 in all and never reaching back past RETENTION_DAYS (0 = keep
 * forever, so 8).
 */
export function attendanceWindow(now: Date, timeZone: string, dayStartMin: number, retentionDays: number): { from: string; to: string; days: number } {
  const days = retentionDays > 0 ? Math.max(1, Math.min(8, retentionDays - 1)) : 8;
  const to = shiftDay(now, timeZone, dayStartMin);
  return { from: addDays(to, -(days - 1)), to, days };
}

export interface CallRow {
  account: string | null;
  callDate: Date;
  lengthSec: number | null;
  context?: string;
}

/**
 * Per account and shift day inside [from, to]: first call start, last call
 * end (start + length), number of calls and talk seconds. System users and
 * calls outside the window are left out. Sorted by day, then account.
 */
export function buildAttendanceItems(rows: CallRow[], timeZone: string, dayStartMin: number, window: { from: string; to: string }): AttendanceItem[] {
  const acc = new Map<string, { account: string; day: string; first: number; last: number; calls: number; talk: number }>();
  for (const r of rows) {
    const account = (r.account ?? '').trim();
    if (isSystemUser(account)) continue;
    const day = shiftDay(r.callDate, timeZone, dayStartMin);
    if (day < window.from || day > window.to) continue;
    const start = r.callDate.getTime();
    const len = Math.max(0, Number(r.lengthSec ?? 0) || 0);
    const end = start + len * 1000;
    const key = `${day}\u0000${account}`;
    const cur = acc.get(key);
    if (!cur) acc.set(key, { account, day, first: start, last: end, calls: 1, talk: len });
    else {
      cur.first = Math.min(cur.first, start);
      cur.last = Math.max(cur.last, end);
      cur.calls += 1;
      cur.talk += len;
    }
  }
  return [...acc.values()]
    .sort((a, b) => (a.day === b.day ? (a.account < b.account ? -1 : a.account > b.account ? 1 : 0) : a.day < b.day ? -1 : 1))
    .map((v) => ({
      account: v.account,
      day: v.day,
      firstAt: new Date(v.first).toISOString(),
      lastAt: new Date(v.last).toISOString(),
      calls: v.calls,
      talkSec: Math.round(v.talk),
    }));
}

/**
 * Splits a window's items into requests of whole days, at most `max` items
 * each, whose windows together cover every day (a day with no items still
 * belongs to one request, so HRMS clears it).
 */
export function splitByDays(items: AttendanceItem[], window: { from: string; to: string }, max = 5000): Array<{ window: { from: string; to: string }; items: AttendanceItem[] }> {
  const out: Array<{ window: { from: string; to: string }; items: AttendanceItem[] }> = [];
  let start = window.from;
  let batch: AttendanceItem[] = [];
  let i = 0;
  for (let day = window.from; day <= window.to; day = addDays(day, 1)) {
    const dayItems: AttendanceItem[] = [];
    while (i < items.length && items[i].day === day) dayItems.push(items[i++]);
    if (batch.length && batch.length + dayItems.length > max) {
      out.push({ window: { from: start, to: addDays(day, -1) }, items: batch });
      batch = [];
      start = day;
    }
    // one day alone above the limit cannot be split without losing rows: it is sent whole
    batch.push(...dayItems);
  }
  out.push({ window: { from: start, to: window.to }, items: batch });
  return out;
}

const useDialerContext = () => process.env.HRMS_CONTEXT === 'dialer';

/** Calls of one company in [from, to) with the real agent user. */
async function callRows(companyId: string, from: Date, to: Date): Promise<CallRow[]> {
  const rows = await db
    .select({
      account: sql<string | null>`coalesce(${viciAgents.viciUser}, nullif(trim(${calls.viciUserRaw}), ''))`,
      callDate: calls.callDate,
      lengthSec: calls.lengthSec,
      context: dialerServers.name,
    })
    .from(calls)
    .innerJoin(dialerServers, eq(calls.dialerServerId, dialerServers.id))
    .leftJoin(viciAgents, eq(calls.viciAgentId, viciAgents.id))
    .where(
      and(
        eq(calls.companyId, companyId),
        eq(calls.isMock, false),
        inArray(calls.source, ['vicidial_log', 'vicidial_closer_log']),
        gte(calls.callDate, from),
        lt(calls.callDate, to),
      ),
    );
  return rows;
}

export type AttendanceRun = { company: string; window?: { from: string; to: string }; skipped?: string; error?: string } & Partial<AttendanceResult>;

/**
 * Sends the attendance window of every active company that has an HRMS link
 * (or only the one in `scope`, for "Push now"). A company with no calls at
 * all in the window is skipped rather than sent empty, so a stalled dialer
 * sync cannot wipe days already in HRMS.
 */
export async function pushAttendance(now = new Date(), scope: PushScope = {}): Promise<AttendanceRun[]> {
  const settingsFor = new Map<HrmsClient, { timeZone: string; dayStartsAt: string }>();
  return forEachHrmsCompany(scope, async (c, hrms): Promise<Omit<AttendanceRun, 'company'>> => {
    if (!settingsFor.has(hrms)) settingsFor.set(hrms, await hrms.attendanceSettings());
    const settings = settingsFor.get(hrms)!;
    const tz = settings.timeZone || 'Asia/Karachi';
    const startMin = parseDayStart(settings.dayStartsAt);
    const window = attendanceWindow(now, tz, startMin, config.RETENTION_DAYS);
    const rows = await callRows(c.id, shiftDayStart(window.from, tz, startMin), shiftDayStart(addDays(window.to, 1), tz, startMin));
    if (rows.length === 0) return { window: { from: window.from, to: window.to }, skipped: 'no calls in the window' };

    // one HRMS context per dialer when equal user names exist on several dialers
    const byContext = new Map<string, CallRow[]>();
    for (const r of rows) {
      const ctx = useDialerContext() ? (r.context ?? '') : '';
      const list = byContext.get(ctx) ?? [];
      list.push(r);
      byContext.set(ctx, list);
    }

    const total: AttendanceResult = { received: 0, saved: 0, unchanged: 0, removed: 0, locked: 0, unknown: [] };
    for (const [ctx, ctxRows] of byContext) {
      const items = buildAttendanceItems(ctxRows, tz, startMin, window);
      for (const part of splitByDays(items, window)) {
        const r = await hrms.pushAttendance(part.items, part.window, ctx);
        for (const k of ['received', 'saved', 'unchanged', 'removed', 'locked'] as const) total[k] += Number(r[k] ?? 0);
        total.unknown.push(...(r.unknown ?? []));
      }
    }
    total.unknown = [...new Set(total.unknown)];
    return { window: { from: window.from, to: window.to }, ...total };
  });
}
