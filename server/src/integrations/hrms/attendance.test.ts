import { describe, expect, it } from 'vitest';
import { attendanceWindow, buildAttendanceItems, isSystemUser, parseDayStart, shiftDay, shiftDayStart, splitByDays } from './attendance.js';

const TZ = 'Asia/Karachi'; // UTC+5, no DST
const NOON = parseDayStart('12:00');
/** Karachi wall time → Date */
const pk = (local: string) => new Date(`${local}+05:00`);

describe('shift days (Asia/Karachi, day starts 12:00)', () => {
  it('keeps a 20:00 → 05:00 night shift on the day it began', () => {
    expect(shiftDay(pk('2026-11-05T20:00:00'), TZ, NOON)).toBe('2026-11-05');
    expect(shiftDay(pk('2026-11-05T23:59:59'), TZ, NOON)).toBe('2026-11-05');
    expect(shiftDay(pk('2026-11-06T00:30:00'), TZ, NOON)).toBe('2026-11-05');
    expect(shiftDay(pk('2026-11-06T05:00:00'), TZ, NOON)).toBe('2026-11-05');
  });

  it('turns over exactly at 12:00 local', () => {
    expect(shiftDay(pk('2026-11-06T11:59:59'), TZ, NOON)).toBe('2026-11-05');
    expect(shiftDay(pk('2026-11-06T12:00:00'), TZ, NOON)).toBe('2026-11-06');
    expect(shiftDayStart('2026-11-06', TZ, NOON).toISOString()).toBe('2026-11-06T07:00:00.000Z');
  });

  it('crosses month and year ends', () => {
    expect(shiftDay(pk('2027-01-01T03:00:00'), TZ, NOON)).toBe('2026-12-31');
    expect(shiftDay(pk('2026-12-01T09:00:00'), TZ, NOON)).toBe('2026-11-30');
  });

  it('reads dayStartsAt, falling back to 12:00', () => {
    expect(parseDayStart('06:30')).toBe(390);
    expect(parseDayStart('0:00')).toBe(0);
    expect(parseDayStart('25:00')).toBe(720);
    expect(parseDayStart(undefined)).toBe(720);
    expect(shiftDay(pk('2026-11-06T06:29:00'), TZ, 390)).toBe('2026-11-05');
    expect(shiftDay(pk('2026-11-06T06:30:00'), TZ, 390)).toBe('2026-11-06');
  });
});

describe('attendance window', () => {
  const now = pk('2026-11-06T15:00:00'); // shift day 2026-11-06

  it('stays inside retention: current day + completed days, at most 8', () => {
    expect(attendanceWindow(now, TZ, NOON, 7)).toEqual({ from: '2026-11-01', to: '2026-11-06', days: 6 });
    expect(attendanceWindow(now, TZ, NOON, 30)).toEqual({ from: '2026-10-30', to: '2026-11-06', days: 8 });
    expect(attendanceWindow(now, TZ, NOON, 0)).toEqual({ from: '2026-10-30', to: '2026-11-06', days: 8 });
    expect(attendanceWindow(now, TZ, NOON, 2)).toEqual({ from: '2026-11-06', to: '2026-11-06', days: 1 });
    expect(attendanceWindow(now, TZ, NOON, 1)).toEqual({ from: '2026-11-06', to: '2026-11-06', days: 1 });
  });

  it('never reaches a call older than RETENTION_DAYS', () => {
    for (const retention of [2, 3, 7, 9]) {
      const w = attendanceWindow(now, TZ, NOON, retention);
      const oldest = shiftDayStart(w.from, TZ, NOON).getTime();
      expect(now.getTime() - oldest).toBeLessThan(retention * 86_400_000);
    }
  });

  it('before noon, the current shift day is still yesterday', () => {
    expect(attendanceWindow(pk('2026-11-06T09:00:00'), TZ, NOON, 7).to).toBe('2026-11-05');
  });
});

describe('attendance items', () => {
  const window = { from: '2026-11-04', to: '2026-11-06' };

  it('one item per agent and shift day: first start, last end, calls, talk time', () => {
    const items = buildAttendanceItems(
      [
        { account: 'agent1043', callDate: pk('2026-11-05T20:00:00'), lengthSec: 60 },
        { account: 'agent1043', callDate: pk('2026-11-06T04:58:00'), lengthSec: 300 }, // ends 05:03, same shift
        { account: 'agent1043', callDate: pk('2026-11-05T22:10:00'), lengthSec: null },
        { account: 'agent1043', callDate: pk('2026-11-06T13:00:00'), lengthSec: 10 }, // next shift day
        { account: ' agent2001 ', callDate: pk('2026-11-05T21:00:00'), lengthSec: 45 },
        { account: 'VDAD', callDate: pk('2026-11-05T21:00:00'), lengthSec: 30 },
        { account: 'vdcl', callDate: pk('2026-11-05T21:00:00'), lengthSec: 30 },
        { account: '', callDate: pk('2026-11-05T21:00:00'), lengthSec: 30 },
        { account: null, callDate: pk('2026-11-05T21:00:00'), lengthSec: 30 },
        { account: 'agent1043', callDate: pk('2026-11-03T20:00:00'), lengthSec: 30 }, // before the window
      ],
      TZ,
      NOON,
      window,
    );
    expect(items).toEqual([
      { account: 'agent1043', day: '2026-11-05', firstAt: '2026-11-05T15:00:00.000Z', lastAt: '2026-11-06T00:03:00.000Z', calls: 3, talkSec: 360 },
      { account: 'agent2001', day: '2026-11-05', firstAt: '2026-11-05T16:00:00.000Z', lastAt: '2026-11-05T16:00:45.000Z', calls: 1, talkSec: 45 },
      { account: 'agent1043', day: '2026-11-06', firstAt: '2026-11-06T08:00:00.000Z', lastAt: '2026-11-06T08:00:10.000Z', calls: 1, talkSec: 10 },
    ]);
  });

  it('recognises system users', () => {
    expect(isSystemUser('VDAD')).toBe(true);
    expect(isSystemUser(' vdcl ')).toBe(true);
    expect(isSystemUser(null)).toBe(true);
    expect(isSystemUser('agent1043')).toBe(false);
  });

  it('splits into whole-day requests whose windows cover every day', () => {
    const mk = (day: string, account: string) => ({ account, day, firstAt: '', lastAt: '', calls: 1, talkSec: 1 });
    const items = [mk('2026-11-04', 'a'), mk('2026-11-04', 'b'), mk('2026-11-05', 'a'), mk('2026-11-06', 'a'), mk('2026-11-06', 'b')];
    const parts = splitByDays(items, window, 3);
    expect(parts.map((p) => [p.window, p.items.length])).toEqual([
      [{ from: '2026-11-04', to: '2026-11-05' }, 3],
      [{ from: '2026-11-06', to: '2026-11-06' }, 2],
    ]);
    // nothing to send still sends the window, so HRMS clears it
    expect(splitByDays([], window)).toEqual([{ window, items: [] }]);
  });
});
