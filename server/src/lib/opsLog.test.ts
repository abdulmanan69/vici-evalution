import { describe, expect, it } from 'vitest';
import { errorFingerprint, pinoLineToEntry, redactSecrets, safeContext } from './opsLog.js';
import { groupEntries } from '../services/opsReport.js';

describe('redactSecrets', () => {
  it('masks dialer API passwords in query strings', () => {
    const s = redactSecrets('GET https://dialer.example/vicidial/non_agent_api.php?source=qa&user=apiuser&pass=S3cret!&function=version');
    expect(s).not.toContain('S3cret');
    expect(s).toContain('pass=***');
    expect(s).toContain('user=apiuser');
  });
  it('masks basic-auth credentials in URLs', () => {
    const s = redactSecrets('fetch failed for https://rec:hunter2@dialer.example/RECORDINGS/MP3/a.mp3');
    expect(s).toBe('fetch failed for https://rec:***@dialer.example/RECORDINGS/MP3/a.mp3');
  });
  it('masks bearer tokens and password fields', () => {
    expect(redactSecrets('Authorization: Bearer abc.def-123')).toBe('Authorization: Bearer ***');
    expect(redactSecrets('{"password":"pw1","name":"x"}')).toBe('{"password":"***","name":"x"}');
  });
  it('keeps MySQL login messages readable', () => {
    const m = "Access denied for user 'ro'@'1.2.3.4' (using password: YES)";
    expect(redactSecrets(m)).toBe(m);
  });
});

describe('pinoLineToEntry', () => {
  it('ignores info lines', () => {
    expect(pinoLineToEntry('{"level":30,"time":1,"msg":"request completed"}\n')).toBeNull();
  });
  it('keeps warnings and errors with their context', () => {
    const e = pinoLineToEntry(
      '{"level":50,"time":1,"pid":7,"hostname":"h","reqId":"req-1","err":{"type":"Error","message":"boom"},"msg":"unhandled error"}\n',
    );
    expect(e).toEqual({ lvl: 'error', msg: 'unhandled error', ctx: { reqId: 'req-1', err: { type: 'Error', message: 'boom' } } });
    expect(pinoLineToEntry('{"level":40,"msg":"slow"}')?.lvl).toBe('warn');
  });
});

describe('safeContext', () => {
  it('flattens errors and masks secrets', () => {
    const ctx = safeContext({ err: new Error('connect failed https://u:pw@h/x'), url: '/x?token=abc' });
    expect(ctx?.err).toMatchObject({ type: 'Error', message: 'connect failed https://u:***@h/x' });
    expect(ctx?.url).toBe('/x?token=***');
  });
  it('caps very large context', () => {
    const ctx = safeContext({ big: 'x'.repeat(10_000) });
    expect(String(ctx?.truncated).length).toBeLessThan(4100);
  });
});

describe('error grouping', () => {
  it('treats messages that differ only in ids and numbers as one problem', () => {
    expect(errorFingerprint('job sync-3f2b8c1a-1111-2222-3333-444455556666 failed after 3 tries')).toBe(
      errorFingerprint('job sync-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee failed after 12 tries'),
    );
    const groups = groupEntries([
      { t: '2026-10-28T10:00:00.000Z', src: 'worker', lvl: 'error', msg: 'timeout after 30 s' },
      { t: '2026-10-28T10:05:00.000Z', src: 'worker', lvl: 'error', msg: 'timeout after 31 s' },
      { t: '2026-10-28T10:01:00.000Z', src: 'api', lvl: 'warn', msg: 'something else' },
    ]);
    expect(groups.map((g) => g.count)).toEqual([2, 1]);
    expect(groups[0]).toMatchObject({ first: '2026-10-28T10:00:00.000Z', last: '2026-10-28T10:05:00.000Z' });
    expect(groups[0].sample.msg).toBe('timeout after 31 s');
  });
});
