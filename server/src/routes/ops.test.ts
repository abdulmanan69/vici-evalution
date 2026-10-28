import { describe, expect, it } from 'vitest';
import { allowList, ipAllowed, parseSince, tokenMatches } from './ops.js';
import { isSensitiveColumn, prepareSql, readerPassword } from '../services/opsReader.js';
import { percentile, recordRequest, requestSnapshot } from '../lib/requestStats.js';

describe('diagnostics token', () => {
  const secret = 'x'.repeat(40);
  it('accepts only the exact token', () => {
    expect(tokenMatches(secret, secret)).toBe(true);
    expect(tokenMatches(`${secret}y`, secret)).toBe(false);
    expect(tokenMatches('', secret)).toBe(false);
    expect(tokenMatches(undefined, secret)).toBe(false);
  });
});

describe('address allow list', () => {
  it('lets everyone through when empty', () => {
    expect(ipAllowed('203.0.113.9', allowList(''))).toBe(true);
  });
  it('matches single addresses, ranges and IPv4-mapped IPv6', () => {
    const list = allowList('203.0.113.9, 10.0.0.0/8, 2001:db8::1, not-an-ip');
    expect(ipAllowed('203.0.113.9', list)).toBe(true);
    expect(ipAllowed('::ffff:203.0.113.9', list)).toBe(true);
    expect(ipAllowed('10.20.30.40', list)).toBe(true);
    expect(ipAllowed('2001:db8::1', list)).toBe(true);
    expect(ipAllowed('203.0.113.10', list)).toBe(false);
    expect(ipAllowed('garbage', list)).toBe(false);
  });
});

describe('parseSince', () => {
  const now = Date.parse('2026-10-28T12:00:00.000Z');
  it('reads relative times and ISO times', () => {
    expect(parseSince('2h', now)).toBe('2026-10-28T10:00:00.000Z');
    expect(parseSince('30m', now)).toBe('2026-10-28T11:30:00.000Z');
    expect(parseSince('1d', now)).toBe('2026-10-27T12:00:00.000Z');
    expect(parseSince('2026-10-28T09:00:00Z', now)).toBe('2026-10-28T09:00:00.000Z');
    expect(parseSince(undefined, now)).toBeUndefined();
    expect(() => parseSince('yesterday', now)).toThrow(/Cannot read the time/);
  });
});

describe('read-only SQL', () => {
  it('caps row-returning queries and drops trailing semicolons', () => {
    const p = prepareSql('select id from calls order by call_date desc; ', 50);
    expect(p.wrapped).toBe(true);
    expect(p.text).toBe('select * from (\nselect id from calls order by call_date desc\n) as ops_q limit 51');
    expect(prepareSql('with x as (select 1) select * from x -- note', 10).text).toContain('-- note\n) as ops_q limit 11');
  });
  it('runs other statements as they are', () => {
    expect(prepareSql('explain select 1', 10)).toEqual({ text: 'explain select 1', wrapped: false });
    expect(prepareSql('show work_mem', 10).wrapped).toBe(false);
    expect(prepareSql('select * from calls for update', 10).wrapped).toBe(false);
  });
  it('refuses empty queries', () => {
    expect(() => prepareSql(' ; ', 10)).toThrow(/empty/);
  });
  it('never grants secret columns', () => {
    for (const c of ['password_hash', 'token_hash', 'api_pass_enc', 'db_user_enc', 'recording_auth_pass_enc', 'client_secret']) {
      expect(isSensitiveColumn(c)).toBe(true);
    }
    for (const c of ['id', 'name', 'email', 'db_host', 'base_url', 'last_login_at', 'status']) {
      expect(isSensitiveColumn(c)).toBe(false);
    }
  });
  it('derives a stable login password from the token', () => {
    expect(readerPassword('a'.repeat(40))).toBe(readerPassword('a'.repeat(40)));
    expect(readerPassword('a'.repeat(40))).not.toBe(readerPassword('b'.repeat(40)));
    expect(readerPassword('a'.repeat(40))).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('request timing', () => {
  it('computes percentiles', () => {
    expect(percentile([5, 1, 3, 2, 4], 50)).toBe(3);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 100], 95)).toBe(100);
    expect(percentile([], 95)).toBe(0);
  });
  it('totals the window and keeps slow requests', () => {
    const at = Date.parse('2026-10-28T12:00:30.000Z');
    recordRequest({ method: 'GET', route: '/api/v1/queues', path: '/api/v1/queues', status: 200, ms: 20, at });
    recordRequest({ method: 'GET', route: '/api/v1/queues', path: '/api/v1/queues', status: 500, ms: 1500, at });
    recordRequest({ method: 'POST', route: '/api/v1/auth/login', path: '/api/v1/auth/login', status: 429, ms: 2, at });
    const s = requestSnapshot(15, at);
    expect(s.totals).toMatchObject({ requests: 3, serverErrors: 1, rateLimited: 1, clientErrors: 1, slow: 1, maxMs: 1500 });
    expect(s.slow[0]).toMatchObject({ route: '/api/v1/queues', status: 500, ms: 1500 });
    expect(s.routes.find((r) => r.route === 'GET /api/v1/queues')).toMatchObject({ count: 2, serverErrors: 1 });
    // an hour later the minute buckets are gone, the per-route totals stay
    expect(requestSnapshot(15, at + 3600_000).totals.requests).toBe(0);
  });
  it('does not call audio streams slow pages', () => {
    const at = Date.parse('2026-10-28T14:00:30.000Z');
    recordRequest({ method: 'GET', route: '/api/v1/recordings/:id/stream', path: '/api/v1/recordings/x/stream', status: 206, ms: 1800, at });
    recordRequest({ method: 'GET', route: '/api/v1/qa/tasks', path: '/api/v1/qa/tasks', status: 200, ms: 40, at });
    const s = requestSnapshot(15, at);
    expect(s.totals).toMatchObject({ requests: 2, slow: 0, avgMs: 40, maxMs: 40 });
    expect(s.slow.some((x) => x.route.endsWith('/stream'))).toBe(false);
    expect(s.routes.find((r) => r.route === 'GET /api/v1/recordings/:id/stream')?.maxMs).toBe(1800);
  });
});
