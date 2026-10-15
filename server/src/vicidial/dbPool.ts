import { ViciDbClient } from './dbClient.js';
import type { DialerConnection } from './types.js';

/**
 * Per-dialer cached MySQL client for request-time lookups (lead details on
 * the call page). Reusing the pool keeps those lookups at a few milliseconds
 * instead of paying a fresh TCP+auth handshake per page view.
 */
const cache = new Map<string, { key: string; client: ViciDbClient }>();

export function getPooledDbClient(conn: DialerConnection): ViciDbClient | null {
  if (!conn.db) return null;
  const key = `${conn.db.host}:${conn.db.port}/${conn.db.database}/${conn.db.user}`;
  const hit = cache.get(conn.id);
  if (hit && hit.key === key) return hit.client;
  if (hit) void hit.client.close().catch(() => {});
  const client = new ViciDbClient(conn);
  cache.set(conn.id, { key, client });
  return client;
}
