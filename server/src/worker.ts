import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { and, eq, lt, sql } from 'drizzle-orm';
import { request } from 'undici';
import { config } from './config.js';
import { runMigrations } from './db/migrate.js';
import { db } from './db/client.js';
import { dialerServers, recordings } from './db/schema.js';
import { runDialerSync } from './vicidial/sync.js';
import { toConnection } from './vicidial/credentials.js';

/**
 * Background worker: schedules and runs per-dialer synchronization and
 * recording availability checks. BullMQ job ids are derived from the dialer id
 * so a dialer can never be synced by two jobs at once (idempotent + deduped).
 */

const connection = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });

export const syncQueue = new Queue('vici-sync', { connection });

async function enqueueActiveDialers(): Promise<void> {
  const rows = await db
    .select({ id: dialerServers.id, name: dialerServers.name })
    .from(dialerServers)
    .where(eq(dialerServers.active, true));
  for (const d of rows) {
    await syncQueue.add(
      'sync-dialer',
      { dialerServerId: d.id },
      {
        // ':' is forbidden in custom ids; remove on completion so the id
        // dedupes only while a sync is queued/running, never afterwards.
        jobId: `sync-${d.id}`,
        removeOnComplete: true,
        removeOnFail: true,
        attempts: 3,
        backoff: { type: 'exponential', delay: 10_000 },
      },
    );
  }
}

/** Re-check recordings that have no URL yet or recently went missing. */
async function checkPendingRecordings(): Promise<void> {
  const cutoff = new Date(Date.now() - config.RECORDING_RETRY_MINUTES * 60 * 1000);
  // never-checked rows, plus previously failed ones (checkAttempts > 0) due a retry
  const rows = await db
    .select()
    .from(recordings)
    .where(
      and(
        eq(recordings.status, 'available'),
        eq(recordings.isMock, false),
        lt(recordings.checkAttempts, 5),
        sql`(${recordings.lastCheckedAt} is null or (${recordings.checkAttempts} > 0 and ${recordings.lastCheckedAt} < ${cutoff}))`,
      ),
    )
    .limit(100);

  for (const rec of rows) {
    if (!rec.locationUrl) continue;
    const [dialer] = await db.select().from(dialerServers).where(eq(dialerServers.id, rec.dialerServerId));
    if (!dialer) continue;
    const conn = toConnection(dialer);
    let ok = false;
    try {
      const headers: Record<string, string> = {};
      if (conn.recordingAuth) {
        headers.authorization =
          'Basic ' + Buffer.from(`${conn.recordingAuth.user}:${conn.recordingAuth.pass}`).toString('base64');
      }
      const res = await request(rec.locationUrl, {
        method: 'HEAD',
        headers,
        headersTimeout: 10_000,
      });
      ok = res.statusCode >= 200 && res.statusCode < 400;
    } catch {
      ok = false;
    }
    await db
      .update(recordings)
      .set({
        status: ok ? 'available' : rec.checkAttempts + 1 >= 5 ? 'missing' : 'available',
        // success resets the counter so verified rows are not re-polled
        checkAttempts: ok ? 0 : rec.checkAttempts + 1,
        lastCheckedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(recordings.id, rec.id));
  }
  // retry 'missing' ones occasionally — recordings can appear late
  await db
    .update(recordings)
    .set({ lastCheckedAt: null, checkAttempts: 0 })
    .where(and(eq(recordings.status, 'missing'), lt(recordings.lastCheckedAt, cutoff), lt(recordings.checkAttempts, 20)));
}

async function main(): Promise<void> {
  await runMigrations();

  const worker = new Worker(
    'vici-sync',
    async (job) => {
      if (job.name === 'sync-dialer') {
        return runDialerSync(job.data.dialerServerId as string, { full: !!job.data.full });
      }
      if (job.name === 'check-recordings') {
        await checkPendingRecordings();
        return { ok: true };
      }
      if (job.name === 'tick') {
        await enqueueActiveDialers();
        return { ok: true };
      }
      throw new Error(`Unknown job: ${job.name}`);
    },
    {
      connection: new Redis(config.REDIS_URL, { maxRetriesPerRequest: null }),
      concurrency: 2, // modest parallelism — keeps CPU/RAM low and dialers safe
    },
  );

  worker.on('failed', (job, err) => {
    console.error(`[worker] job ${job?.name}:${job?.id} failed:`, err.message);
  });
  worker.on('completed', (job) => {
    if (job.name === 'sync-dialer') {
      console.log(`[worker] sync completed for dialer ${job.data.dialerServerId}`);
    }
  });

  // repeatable schedulers
  await syncQueue.upsertJobScheduler('tick', { every: config.SYNC_POLL_SECONDS * 1000 }, { name: 'tick' });
  await syncQueue.upsertJobScheduler(
    'check-recordings',
    { every: config.RECORDING_RETRY_MINUTES * 60 * 1000 },
    { name: 'check-recordings' },
  );

  console.log(
    `[worker] started — polling every ${config.SYNC_POLL_SECONDS}s, recording checks every ${config.RECORDING_RETRY_MINUTES}m`,
  );

  const shutdown = async () => {
    await worker.close();
    await syncQueue.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

main().catch((err) => {
  console.error('Worker fatal error:', err);
  process.exit(1);
});
