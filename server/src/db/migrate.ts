import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { sql } from 'drizzle-orm';
import { db, pool } from './client.js';

const MIGRATION_LOCK = 719_355_001;

/**
 * Runs pending migrations under a Postgres advisory lock so that api and
 * worker containers can both call this at boot without racing.
 */
export async function runMigrations(): Promise<void> {
  await db.execute(sql`select pg_advisory_lock(${MIGRATION_LOCK})`);
  try {
    await migrate(db, { migrationsFolder: 'drizzle' });
  } finally {
    await db.execute(sql`select pg_advisory_unlock(${MIGRATION_LOCK})`);
  }
}

// Allow running directly: `npm run migrate`
if (process.argv[1] && /migrate\.(ts|js)$/.test(process.argv[1])) {
  runMigrations()
    .then(() => {
      console.log('Migrations applied.');
      return pool.end();
    })
    .catch((err) => {
      console.error('Migration failed:', err);
      process.exit(1);
    });
}
