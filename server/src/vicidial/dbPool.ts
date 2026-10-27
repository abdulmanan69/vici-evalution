import { ViciDbClient } from './dbClient.js';
import type { DialerConnection } from './types.js';

/**
 * Per-dialer cached MySQL client for request-time lookups (lead details on
 * the call page). Reusing the pool keeps those lookups at one round trip
 * instead of paying a fresh TCP+auth handshake per page view; idle
 * connections are kept for 10 minutes so a reviewer's next call is warm too.
 * Several reviewers open calls at once, so it allows a few parallel
 * connections — lookups are by primary key and cheap for the dialer.
 */
const cache = new Map<string, { key: string; client: ViciDbClient }>();

export function getPooledDbClient(conn: DialerConnection): ViciDbClient | null {
  if (!conn.db) return null;
  const key = `${conn.db.host}:${conn.db.port}/${conn.db.database}/${conn.db.user}`;
  const hit = cache.get(conn.id);
  if (hit && hit.key === key) return hit.client;
  if (hit) void hit.client.close().catch(() => {});
  const client = new ViciDbClient(conn, { connectionLimit: 6, idleTimeoutMs: 10 * 60_000 });
  cache.set(conn.id, { key, client });
  return client;
}

/** Drops a dialer's pooled client (the dialer was deleted or its access changed). */
export function closePooledDbClient(dialerServerId: string): void {
  const hit = cache.get(dialerServerId);
  if (!hit) return;
  cache.delete(dialerServerId);
  void hit.client.close().catch(() => {});
}
