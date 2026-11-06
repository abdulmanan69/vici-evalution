import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  decodeCursor,
  encodeCursor,
  eventMatches,
  hashApiKey,
  isInternalHost,
  isValidEventPattern,
  looksLikeApiKey,
  newApiKey,
  retryDelaySec,
  RETRY_DELAYS_SEC,
  signWebhook,
  verifyWebhook,
} from './catalog.js';

describe('webhook signature', () => {
  it('is hex HMAC-SHA256 of "<timestamp>.<raw body>"', () => {
    const body = '{"event":"ping","data":{"a":1}}';
    const expected = createHmac('sha256', 'whsec_test').update(`1700000000.${body}`).digest('hex');
    expect(signWebhook('whsec_test', 1700000000, body)).toBe(expected);
    expect(signWebhook('whsec_test', '1700000000', body)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('verifies, and rejects a changed body, another secret or an old timestamp', () => {
    const body = '{"x":1}';
    const now = 1700000000_000;
    const ts = '1700000000';
    const sig = signWebhook('s1', ts, body);
    expect(verifyWebhook('s1', ts, body, sig, 300, now)).toBe(true);
    expect(verifyWebhook('s1', ts, '{"x":2}', sig, 300, now)).toBe(false);
    expect(verifyWebhook('s2', ts, body, sig, 300, now)).toBe(false);
    expect(verifyWebhook('s1', ts, body, sig, 300, now + 301_000)).toBe(false);
    expect(verifyWebhook('s1', ts, body, '', 300, now)).toBe(false);
  });
});

describe('event matching', () => {
  it('matches exact names, "*" and "prefix.*"', () => {
    expect(eventMatches(['evaluation.completed'], 'evaluation.completed')).toBe(true);
    expect(eventMatches(['evaluation.completed'], 'transfer.closed')).toBe(false);
    expect(eventMatches(['*'], 'transfer.reopened')).toBe(true);
    expect(eventMatches(['transfer.*'], 'transfer.closed')).toBe(true);
    expect(eventMatches(['transfer.*'], 'transfer.reopened')).toBe(true);
    expect(eventMatches(['transfer.*'], 'evaluation.completed')).toBe(false);
    // a prefix must end at the dot: "transfer.*" is not "transfers.x"
    expect(eventMatches(['transfer.*'], 'transfers.closed')).toBe(false);
    expect(eventMatches([], 'ping')).toBe(false);
  });

  it('accepts only known events and patterns that match one', () => {
    expect(isValidEventPattern('*')).toBe(true);
    expect(isValidEventPattern('transfer.*')).toBe(true);
    expect(isValidEventPattern('transfer.closed')).toBe(true);
    expect(isValidEventPattern('agent.*')).toBe(false);
    expect(isValidEventPattern('transfer.deleted')).toBe(false);
    expect(isValidEventPattern('transfer*')).toBe(false);
  });
});

describe('API keys', () => {
  it('are qa_ + 43 base64url characters, stored as SHA-256', () => {
    const k = newApiKey();
    expect(k.key).toMatch(/^qa_[A-Za-z0-9_-]{43}$/);
    expect(looksLikeApiKey(k.key)).toBe(true);
    expect(k.prefix).toBe(k.key.slice(0, 11));
    expect(k.hash).toBe(hashApiKey(k.key));
    expect(k.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(newApiKey().key).not.toBe(k.key);
    expect(looksLikeApiKey('qa_short')).toBe(false);
    expect(looksLikeApiKey('a'.repeat(64))).toBe(false);
  });
});

describe('retries', () => {
  it('back off to about 24 hours, then stop', () => {
    const total = RETRY_DELAYS_SEC.reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThan(22 * 3600);
    expect(total).toBeLessThanOrEqual(24 * 3600);
    expect(retryDelaySec(1)).toBe(30);
    expect(retryDelaySec(RETRY_DELAYS_SEC.length)).toBe(28800);
    expect(retryDelaySec(RETRY_DELAYS_SEC.length + 1)).toBeNull();
  });
});

describe('cursors', () => {
  it('round-trip and reject junk', () => {
    const c = encodeCursor('2026-11-06T10:00:00.123456Z', '7d3c2a3e-1111-4222-8333-944455556666');
    expect(decodeCursor(c)).toEqual({ at: '2026-11-06T10:00:00.123456Z', id: '7d3c2a3e-1111-4222-8333-944455556666' });
    expect(decodeCursor('bm9wZQ')).toBeNull();
    expect(decodeCursor(undefined)).toBeNull();
  });
});

describe('internal hosts', () => {
  it('flags this server’s own network', () => {
    for (const h of ['localhost', 'postgres', 'redis', '127.0.0.1', '10.0.0.5', '172.20.1.1', '192.168.1.10', '169.254.169.254', '[::1]', 'api.internal']) {
      expect(isInternalHost(h)).toBe(true);
    }
    for (const h of ['crm.vertexpakistan.com', 'hooks.example.com', '8.8.8.8', '172.32.0.1']) {
      expect(isInternalHost(h)).toBe(false);
    }
  });
});
