import { describe, expect, it } from 'vitest';
import { localToUtc, utcToLocalString } from './timezone.js';

describe('localToUtc', () => {
  it('converts EST (winter) to UTC', () => {
    const d = localToUtc('2026-01-10 12:00:00', 'America/New_York');
    expect(d.toISOString()).toBe('2026-01-10T17:00:00.000Z');
  });

  it('converts EDT (summer) to UTC', () => {
    const d = localToUtc('2026-07-10 12:00:00', 'America/New_York');
    expect(d.toISOString()).toBe('2026-07-10T16:00:00.000Z');
  });

  it('UTC zone is identity', () => {
    const d = localToUtc('2026-03-01 08:30:15', 'UTC');
    expect(d.toISOString()).toBe('2026-03-01T08:30:15.000Z');
  });

  it('throws on garbage input', () => {
    expect(() => localToUtc('not-a-date', 'UTC')).toThrow();
  });
});

describe('utcToLocalString', () => {
  it('round-trips with localToUtc', () => {
    const original = '2026-01-10 12:34:56';
    const utc = localToUtc(original, 'America/Chicago');
    expect(utcToLocalString(utc, 'America/Chicago')).toBe(original);
  });

  it('renders midnight correctly (no 24:xx)', () => {
    const utc = localToUtc('2026-01-10 00:00:00', 'America/New_York');
    expect(utcToLocalString(utc, 'America/New_York')).toBe('2026-01-10 00:00:00');
  });
});
