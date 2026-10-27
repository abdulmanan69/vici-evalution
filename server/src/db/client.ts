import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { config } from '../config.js';
import * as schema from './schema.js';

export const pool = new pg.Pool({
  connectionString: config.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30_000,
});

export const db = drizzle(pool, { schema });

export type Db = typeof db;

/**
 * For the sync worker only: commits stop waiting for the disk flush. The
 * worker writes thousands of small rows a minute, each its own commit, and
 * the flush was most of each write's time — load that slowed the pages too.
 * A database crash can lose at most the last fraction of a second of synced
 * rows, which the next sync cycle reads again from the dialer. It never
 * corrupts data, and the API (evaluations, users …) keeps full durability.
 */
export function relaxCommitDurabilityForSync(): void {
  // passed as a connection start-up option, so no extra query runs and every
  // connection the pool opens from now on carries it
  const opts = (pool as unknown as { options: { options?: string } }).options;
  const flag = '-c synchronous_commit=off';
  if (!opts.options?.includes(flag)) opts.options = opts.options ? `${opts.options} ${flag}` : flag;
}

export async function closeDb(): Promise<void> {
  await pool.end();
}
