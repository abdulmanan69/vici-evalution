import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { and, eq, sql } from 'drizzle-orm';
import { config } from './config.js';
import { runMigrations } from './db/migrate.js';
import { db } from './db/client.js';
import { calls, dialerServers, recordings } from './db/schema.js';
import { runDialerSync } from './vicidial/sync.js';
import { toConnection } from './vicidial/credentials.js';
import { refreshRecording } from './vicidial/recordingUrl.js';
import { isCallInProgress } from './services/callRecordings.js';

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
 * Recording repair, every RECORDING_CHECK_SECONDS. First re-links recent
 * recordings to the right call (a closer's call row can land a cycle after
 * its recording), then probes every recording in the retention window that
 * is not verified on its final MP3 — no URL yet, a temporary .wav, a broken
 * URL, or marked missing. Transfer legs and calls still up are probed every
 * run; the rest back off exponentially (1, 2, 4 … 60 min) until the
 * retention window ends, so a file that shows up late is never lost.
 */
async function checkPendingRecordings(): Promise<void> {
  if (recordingCheckRunning) return;
  recordingCheckRunning = true;
  try {
    await relinkRecentRecordings();

    const windowDays = config.RETENTION_DAYS > 0 ? config.RETENTION_DAYS : 7;
    const isLeg = sql`exists (select 1 from transfers t where t.fronter_call_id = ${recordings.callId}
      or t.closer_call_id = ${recordings.callId} or t.sale_call_id = ${recordings.callId})`;
    const rows = await db
      .select({ rec: recordings, callLength: calls.lengthSec, callStatus: calls.status })
      .from(recordings)
      .leftJoin(calls, eq(recordings.callId, calls.id))
      .where(
        and(
          eq(recordings.isMock, false),
          sql`coalesce(${recordings.startTime}, ${recordings.createdAt}) > now() - make_interval(days => ${windowDays})`,
          // a 0-second entry the dialer gave up on never gets a file
          sql`not (${recordings.status} = 'missing' and ${recordings.lengthSec} = 0)`,
          sql`(${recordings.status} <> 'available'
               or ${recordings.locationUrl} is null
               or ${recordings.locationUrl} not like '%/RECORDINGS/MP3/%'
               or ${recordings.lastCheckedAt} is null
               or ${recordings.checkAttempts} > 0)`,
          sql`(${recordings.lastCheckedAt} is null or ${recordings.lastCheckedAt} < now() - make_interval(secs =>
               case when ${isLeg} or (${recordings.callId} is not null and ${calls.lengthSec} is null)
                    then least(power(2, ${recordings.checkAttempts}) * 60,
                               case when coalesce(${recordings.startTime}, ${recordings.createdAt}) > now() - interval '30 minutes'
                                    then 50 else 300 end)
                    else least(power(2, ${recordings.checkAttempts}) * 60, 3600) end))`,
        ),
      )
      .orderBy(sql`(${isLeg}) desc`, sql`${recordings.startTime} desc nulls last`)
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
      for (let r = queue.shift(); r; r = queue.shift()) {
        const conn = await connFor(r.rec.dialerServerId);
        if (!conn) continue;
        const before = r.rec;
        const after = await refreshRecording(before, conn, {
          inProgress: before.callId != null && isCallInProgress({ lengthSec: r.callLength, status: r.callStatus }),
        });
        if (after.status === 'available') {
          if (after.locationUrl !== before.locationUrl || before.status !== 'available') fixed += 1;
        } else {
          failed += 1;
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
 * A recording is linked to its call by start/end time (recordingUrl.ts). The
 * closer's call row can arrive a cycle after the recording did, so links from
 * the last two hours are re-evaluated with the same rule, and recordings that
 * found no call at all get a second chance for two days.
 */
async function relinkRecentRecordings(): Promise<void> {
  await db.execute(sql`
    with best as (
      select r.id rid,
        (select c.id from calls c
          where c.dialer_server_id = r.dialer_server_id and c.vici_lead_id = r.vici_lead_id and not c.is_mock
            and abs(extract(epoch from c.call_date - r.start_time)) <= 900
          order by abs(extract(epoch from c.call_date - r.start_time))
            + 0.5 * least(coalesce(abs(extract(epoch from c.call_date - r.start_time) + c.length_sec - r.length_sec), 0), 60)
          limit 1) cid
      from recordings r
      where not r.is_mock and r.vici_lead_id is not null and r.start_time is not null
        and (r.start_time > now() - interval '2 hours'
             or (r.call_id is null and r.start_time > now() - interval '48 hours'))
    )
    update recordings r set call_id = best.cid, updated_at = now()
      from best where r.id = best.rid and best.cid is not null and best.cid is distinct from r.call_id`);
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

  // a restart mid-sync leaves job rows stuck at 'running'; this worker is the
  // only thing that runs syncs, so every such row is stale — close them out
  await db.execute(sql`
    update sync_jobs set status = 'failed', error = 'interrupted by worker restart', finished_at = now()
     where status = 'running'`);

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
