/**
 * Connections: what other apps can read (API key scopes) and be told about
 * (webhook events), and the small pure helpers both sides share. No database
 * access here, so it is unit-tested directly (catalog.test.ts).
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const SCOPES = {
  'agents.read': 'Dialer agents: user, name, group, role, active, dialer, company',
  'transfers.read': 'Transfers, unclosed and closed sales (no phone numbers)',
  'transfers.read_pii': 'Adds the customer phone number to transfers',
  'evaluations.read': 'Completed QA evaluations and their scores',
  'scores.read': 'Monthly QA score per agent',
  'calls.read': 'Agent dialer activity per shift day (first/last call, calls, talk time)',
} as const;

export type Scope = keyof typeof SCOPES;
export const SCOPE_IDS = Object.keys(SCOPES) as Scope[];

export const EVENTS = {
  'evaluation.completed': 'A QA evaluation was completed',
  'transfer.closed': 'A transfer became a closed sale',
  'transfer.reopened': 'A closed sale is no longer closed (disposition corrected)',
  ping: 'Test delivery sent from the Connections page',
} as const;

export type EventName = keyof typeof EVENTS;
export const EVENT_IDS = Object.keys(EVENTS) as EventName[];

/** A webhook's event list may hold exact names, '*' (all) and 'prefix.*'. */
export function eventMatches(patterns: readonly string[], event: string): boolean {
  for (const p of patterns) {
    if (p === '*' || p === event) return true;
    if (p.endsWith('.*') && event.startsWith(p.slice(0, -1))) return true;
  }
  return false;
}

/** True for a pattern a webhook may subscribe to. */
export function isValidEventPattern(p: string): boolean {
  if (p === '*') return true;
  if ((EVENT_IDS as string[]).includes(p)) return true;
  if (p.endsWith('.*')) {
    const prefix = p.slice(0, -1);
    return EVENT_IDS.some((e) => e.startsWith(prefix));
  }
  return false;
}

/* ---------------------------------------------------------------- keys */

export const KEY_PREFIX = 'qa_';
const KEY_RE = /^qa_[A-Za-z0-9_-]{43}$/;

/** A new API key: qa_ + 32 random bytes in base64url (43 characters). */
export function newApiKey(): { key: string; prefix: string; hash: string } {
  const key = `${KEY_PREFIX}${randomBytes(32).toString('base64url')}`;
  return { key, prefix: key.slice(0, 11), hash: hashApiKey(key) };
}

export function looksLikeApiKey(v: string): boolean {
  return KEY_RE.test(v);
}

export function hashApiKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

/* ------------------------------------------------------------ webhooks */

export function newWebhookSecret(): string {
  return `whsec_${randomBytes(32).toString('base64url')}`;
}

/**
 * Hosts on this server's own network: localhost, private, link-local and
 * carrier-grade NAT addresses, and single-label names (docker services like
 * "postgres" or "redis"). Hostname check only; no DNS lookup.
 */
export function isInternalHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!h || h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (!h.includes('.') && !h.includes(':')) return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  if (h.includes(':')) return h === '::1' || h === '::' || h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80') || h.startsWith('::ffff:');
  return false;
}

/** x-qa-signature: hex HMAC-SHA256 of "<timestamp>.<raw body>" with the webhook secret. */
export function signWebhook(secret: string, timestamp: string | number, rawBody: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
}

/** The check a receiver runs (also documented in docs/CONNECTIONS.md). */
export function verifyWebhook(secret: string, timestamp: string, rawBody: string, signature: string, toleranceSec = 300, nowMs = Date.now()): boolean {
  if (!timestamp || !signature || Math.abs(nowMs / 1000 - Number(timestamp)) > toleranceSec) return false;
  const a = Buffer.from(signWebhook(secret, timestamp, rawBody));
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Seconds to wait after the n-th failed attempt (1-based). Ten retries, the
 * last one about 24 hours after the event; after that the delivery is given up.
 */
export const RETRY_DELAYS_SEC = [30, 60, 300, 900, 1800, 3600, 7200, 14400, 28800, 28800];

export function retryDelaySec(failedAttempts: number): number | null {
  return failedAttempts >= 1 && failedAttempts <= RETRY_DELAYS_SEC.length ? RETRY_DELAYS_SEC[failedAttempts - 1] : null;
}

/** Cursor for list endpoints: opaque base64url of "<sort value>|<id>". */
export function encodeCursor(at: string, id: string): string {
  return Buffer.from(`${at}|${id}`).toString('base64url');
}

export function decodeCursor(cursor: string | undefined): { at: string; id: string } | null {
  if (!cursor) return null;
  const raw = Buffer.from(cursor, 'base64url').toString('utf8');
  const i = raw.lastIndexOf('|');
  if (i <= 0) return null;
  const at = raw.slice(0, i);
  const id = raw.slice(i + 1);
  if (!/^[0-9a-f-]{36}$/i.test(id) || Number.isNaN(Date.parse(at))) return null;
  return { at, id };
}
