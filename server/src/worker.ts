import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { and, eq, sql } from 'drizzle-orm';
import { config } from './config.js';
import { runMigrations } from './db/migrate.js';
import { db } from './db/client.js';
import { dialerServers, recordings } from './db/schema.js';
import { runDialerSync } from './vicidial/sync.js';
import { toConnection } from './vicidial/credentials.js';
import { isFinalMp3, resolveRecordingUrl } from './vicidial/recordingUrl.js';

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

let recordingCheckRunning = false;

/**
 * Recording repair, every RECORDING_CHECK_SECONDS. Picks every recording in
 * the retention window that is not verified on its final MP3 location —
 * no URL yet, a temporary .wav, a broken URL, or marked missing — and
 * resolves the URL that works now (see recordingUrl.ts). Transfer legs go
 * first, newest first; failures back off exponentially (1, 2, 4 … 60 min)
 * and keep retrying until the retention window ends, so a recording that
 * shows up late is never lost.
 */
async function checkPendingRecordings(): Promise<void> {
  if (recordingCheckRunning) return;
  recordingCheckRunning = true;
  try {
    const windowDays = config.RETENTION_DAYS > 0 ? config.RETENTION_DAYS : 7;
    const rows = await db
      .select()
      .from(recordings)
      .where(
        and(
          eq(recordings.isMock, false),
          sql`coalesce(${recordings.startTime}, ${recordings.createdAt}) > now() - make_interval(days => ${windowDays})`,
          sql`(${recordings.status} <> 'available'
               or ${recordings.locationUrl} is null
               or ${recordings.locationUrl} not like '%/RECORDINGS/MP3/%'
               or ${recordings.lastCheckedAt} is null
               or ${recordings.checkAttempts} > 0)`,
          sql`(${recordings.lastCheckedAt} is null
               or ${recordings.lastCheckedAt} < now() - make_interval(mins => least(power(2, ${recordings.checkAttempts})::int, 60)))`,
        ),
      )
      .orderBy(
        sql`(exists (select 1 from transfers t where t.fronter_call_id = ${recordings.callId}
               or t.closer_call_id = ${recordings.callId} or t.sale_call_id = ${recordings.callId})) desc`,
        sql`${recordings.startTime} desc nulls last`,
      )
      .limit(400);
    if (rows.length === 0) return;

    const conns = new Map<string, ReturnType<typeof toConnection> | null>();
    const connFor = async (dialerServerId: string) => {
      if (!conns.has(dialerServerId)) {
        const [dialer] = await db.select().from(dialerServers).where(eq(dialerServers.id, dialerServerId));
        conns.set(dialerServerId, dialer ? toConnection(dialer) : null);
      }
      return conns.get(dialerServerId) ?? null;
    };

    let fixed = 0;
    let failed = 0;
    const queue = [...rows];
    const work = async () => {
      for (let rec = queue.shift(); rec; rec = queue.shift()) {
        const conn = await connFor(rec.dialerServerId);
        if (!conn) continue;
        const url = await resolveRecordingUrl(rec, conn);
        const attempts = rec.checkAttempts + 1;
        if (url) {
          fixed += url !== rec.locationUrl || rec.status !== 'available' ? 1 : 0;
          await db
            .update(recordings)
            .set({
              locationUrl: url,
              status: 'available',
              // a .wav that still answers is re-checked until its MP3 exists
              checkAttempts: isFinalMp3(url) ? 0 : 1,
              lastCheckedAt: new Date(),
              updatedAt: new Date(),
            })
            .where(eq(recordings.id, rec.id));
        } else {
          failed += 1;
          const ageMin = (Date.now() - (rec.startTime ?? rec.createdAt).getTime()) / 60_000;
          await db
            .update(recordings)
            .set({
              // the dialer needs a few minutes to finish and convert a file
              status: ageMin > 30 && attempts >= 3 ? 'missing' : rec.status === 'missing' ? 'missing' : 'pending',
              checkAttempts: Math.min(attempts, 12),
              lastCheckedAt: new Date(),
              updatedAt: new Date(),
            })
            .where(eq(recordings.id, rec.id));
        }
      }
    };
    await Promise.all(Array.from({ length: 8 }, work));
    console.log(`[worker] recording check: ${rows.length} checked, ${fixed} fixed, ${failed} not found yet`);
  } finally {
    recordingCheckRunning = false;
  }
}

/**
 * Daily retention: delete un-reviewed call data older than RETENTION_DAYS,
 * counted from each row's LAST change, so late disposition corrections are
 * never cut off mid-flight. Evaluated and flagged transfers are kept forever
 * together with their calls and recordings. Mock/demo rows are untouched.
 */
async function applyRetention(): Promise<void> {
  if (config.RETENTION_DAYS <= 0) return;
  const cutoff = new Date(Date.now() - config.RETENTION_DAYS * 24 * 3600 * 1000);
  const t = await db.execute(sql`
    delete from transfers tr
     where tr.is_mock = false
       and tr.updated_at < ${cutoff}
       and tr.match_status <> 'flagged'
       and not exists (select 1 from evaluations e where e.transfer_id = tr.id)`);
  const c = await db.execute(sql`
    delete from calls c
     where c.is_mock = false
       and c.call_date < ${cutoff}
       and not exists (select 1 from transfers tr where tr.fronter_call_id = c.id or tr.closer_call_id = c.id)
       and not exists (select 1 from evaluations e where e.call_id = c.id)`);
  const r = await db.execute(sql`
    delete from recordings r
     where r.is_mock = false
       and r.call_id is null
       and coalesce(r.start_time, r.created_at) < ${cutoff}`);
  console.log(
    `[worker] retention: removed ${t.rowCount ?? 0} transfers, ${c.rowCount ?? 0} calls, ${r.rowCount ?? 0} recordings older than ${config.RETENTION_DAYS}d (evaluated/flagged kept)`,
  );
}

async function main(): Promise<void> {
  await runMigrations();

  // a restart mid-sync leaves job rows stuck at 'running' — close them out
  await db.execute(sql`
    update sync_jobs set status = 'failed', error = 'interrupted by worker restart', finished_at = now()
     where status = 'running' and started_at < now() - interval '30 minutes'`);

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
      if (job.name === 'retention') {
        await applyRetention();
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
    { every: config.RECORDING_CHECK_SECONDS * 1000 },
    { name: 'check-recordings' },
  );
  await syncQueue.upsertJobScheduler('retention', { every: 24 * 3600 * 1000 }, { name: 'retention' });

  console.log(
    `[worker] started — polling every ${config.SYNC_POLL_SECONDS}s, recording checks every ${config.RECORDING_CHECK_SECONDS}s`,
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
