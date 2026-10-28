import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { config } from './config.js';
import { runMigrations } from './db/migrate.js';
import { db, relaxCommitDurabilityForSync } from './db/client.js';
import { calls, dialerServers, recordings } from './db/schema.js';
import { runDialerSync } from './vicidial/sync.js';
import { toConnection } from './vicidial/credentials.js';
import { refreshRecording } from './vicidial/recordingUrl.js';
import { isCallInProgress } from './services/callRecordings.js';
import { pendingPurges, purgeCompany, purgeDialer } from './services/purge.js';
import { ensureDefaultMappingsEverywhere } from './services/defaultMappings.js';
import { enqueueCompanyPurge, enqueueDialerPurge, MAINTENANCE_QUEUE, SYNC_QUEUE } from './lib/queue.js';
import { captureConsole, captureCrashes, flushOpsLog, recordBoot, setOpsSource, startHeartbeat } from './lib/opsLog.js';
import { buildInfo, processStats } from './lib/runtime.js';

/**
 * Background worker: schedules and runs per-dialer synchronization and
 * recording availability checks. BullMQ job ids are derived from the dialer id
 * so a dialer can never be synced by two jobs at once (idempotent + deduped).
 * Housekeeping that can run for minutes (deleting a dialer or company, the
 * daily retention) has its own queue, so it never holds up a sync.
 */

const connection = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });

export const syncQueue = new Queue(SYNC_QUEUE, { connection });
const maintenanceQueue = new Queue(MAINTENANCE_QUEUE, { connection });

async function enqueueActiveDialers(): Promise<void> {
  const rows = await db
    .select({ id: dialerServers.id, name: dialerServers.name })
    .from(dialerServers)
    .where(and(eq(dialerServers.active, true), isNull(dialerServers.deletingAt)));
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

/** dialers being synced in this worker, and how */
const busy = new Map<string, 'full' | 'incremental'>();
const sleepMs = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * One sync per dialer at a time. A scheduled sync finds the dialer busy and
 * steps aside; a full import asked for while a short sync runs waits for it.
 * A dialer that has not imported its retention window yet (new, or its
 * disposition meanings changed) gets the full import instead of a short
 * sync — and after a failed attempt, a fresh one at most every 5 minutes;
 * the import resumes where it stopped.
 */
async function runSyncJob(dialerServerId: string, requestedFull: boolean): Promise<unknown> {
  const current = busy.get(dialerServerId);
  if (current) {
    if (!requestedFull || current === 'full') return { skipped: `a ${current} sync is already running` };
    const until = Date.now() + 15 * 60_000;
    while (busy.has(dialerServerId) && Date.now() < until) await sleepMs(2_000);
    if (busy.has(dialerServerId)) return { skipped: 'dialer still busy' };
  }

  let full = requestedFull;
  if (!full) {
    const [d] = await db
      .select({ backfilledAt: dialerServers.backfilledAt })
      .from(dialerServers)
      .where(eq(dialerServers.id, dialerServerId));
    if (d && !d.backfilledAt) {
      // a run cut off by a restart or deploy is not a failure: resume at once
      const recent = await db.execute(sql`
        select 1 from sync_jobs
         where dialer_server_id = ${dialerServerId} and job_type = 'full'
           and finished_at > now() - interval '5 minutes'
           and status = 'failed' and coalesce(error, '') not like 'interrupted by worker restart%'
         limit 1`);
      full = (recent.rowCount ?? 0) === 0;
    }
  }

  busy.set(dialerServerId, full ? 'full' : 'incremental');
  try {
    return await runDialerSync(dialerServerId, { full });
  } finally {
    busy.delete(dialerServerId);
  }
}

/**
 * A delete whose job was lost (worker restart, Redis flush) is picked up
 * again: the database marks are the source of truth, the jobs only carry it.
 */
async function resumePendingPurges(): Promise<void> {
  const pending = await pendingPurges();
  for (const id of pending.companies) await enqueueCompanyPurge(id, maintenanceQueue);
  for (const id of pending.dialers) await enqueueDialerPurge(id, maintenanceQueue);
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
        // a dialer being deleted is not probed any more
        conns.set(dialerServerId, dialer && !dialer.deletingAt ? toConnection(dialer) : null);
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
  // every line the worker prints, and every crash, reaches the diagnostics log
  setOpsSource('worker');
  captureConsole({ info: true });
  captureCrashes();
  relaxCommitDurabilityForSync();
  await runMigrations();
  const commit = await db.execute(sql`select current_setting('synchronous_commit') as v`);
  console.log(`[worker] synchronous_commit for sync writes: ${(commit.rows[0] as { v?: string } | undefined)?.v ?? '?'}`);

  // a restart mid-sync leaves job rows stuck at 'running'; this worker is the
  // only thing that runs syncs, so every such row is stale — close them out
  await db.execute(sql`
    update sync_jobs set status = 'failed', error = 'interrupted by worker restart — it resumes on its own', finished_at = now()
     where status = 'running'`);
  // every company can recognise transfers and sales from the start
  const withDefaults = await ensureDefaultMappingsEverywhere();
  if (withDefaults > 0) console.log(`[worker] default disposition meanings added for ${withDefaults} company(ies)`);

  const worker = new Worker(
    SYNC_QUEUE,
    async (job) => {
      if (job.name === 'sync-dialer') {
        return runSyncJob(job.data.dialerServerId as string, !!job.data.full);
      }
      if (job.name === 'check-recordings') {
        await checkPendingRecordings();
        return { ok: true };
      }
      if (job.name === 'tick') {
        await enqueueActiveDialers();
        await resumePendingPurges();
        return { ok: true };
      }
      if (job.name === 'retention') return { ok: true, movedTo: MAINTENANCE_QUEUE }; // pre-upgrade schedule
      throw new Error(`Unknown job: ${job.name}`);
    },
    {
      connection: new Redis(config.REDIS_URL, { maxRetriesPerRequest: null }),
      // a sync mostly waits on its dialer; several dialers sync side by side
      concurrency: config.SYNC_CONCURRENCY,
    },
  );

  const maintenance = new Worker(
    MAINTENANCE_QUEUE,
    async (job) => {
      const log = (m: string) => console.log(`[worker] ${m}`);
      if (job.name === 'purge-dialer') return { deleted: await purgeDialer(job.data.dialerServerId as string, log) };
      if (job.name === 'purge-company') return { deleted: await purgeCompany(job.data.companyId as string, log) };
      if (job.name === 'retention') {
        await applyRetention();
        return { ok: true };
      }
      throw new Error(`Unknown maintenance job: ${job.name}`);
    },
    {
      connection: new Redis(config.REDIS_URL, { maxRetriesPerRequest: null }),
      concurrency: 1, // one heavy delete at a time
      lockDuration: 5 * 60_000, // batches keep it busy; never hand it to a second run
    },
  );

  for (const w of [worker, maintenance]) {
    w.on('failed', (job, err) => {
      console.error(`[worker] job ${job?.name}:${job?.id} failed:`, err.message);
    });
  }
  worker.on('completed', (job) => {
    if (job.name === 'sync-dialer') {
      console.log(`[worker] sync completed for dialer ${job.data.dialerServerId}`);
    }
  });

  // repeatable schedulers; only the latest finished runs are kept — every
  // run used to stay in Redis (about 2,900 a day)
  const keep = { removeOnComplete: 50, removeOnFail: 50 };
  await syncQueue.upsertJobScheduler('tick', { every: config.SYNC_POLL_SECONDS * 1000 }, { name: 'tick', opts: keep });
  await syncQueue.upsertJobScheduler(
    'check-recordings',
    { every: config.RECORDING_CHECK_SECONDS * 1000 },
    { name: 'check-recordings', opts: keep },
  );
  // retention moved to the maintenance queue — drop the old schedule
  await syncQueue.removeJobScheduler('retention').catch(() => false);
  await maintenanceQueue.upsertJobScheduler('retention', { every: 24 * 3600 * 1000 }, { name: 'retention', opts: keep });
  await resumePendingPurges();

  console.log(
    `[worker] started — polling every ${config.SYNC_POLL_SECONDS}s, recording checks every ${config.RECORDING_CHECK_SECONDS}s, ` +
      `${config.SYNC_CONCURRENCY} dialers at a time`,
  );
  recordBoot('worker', { ...buildInfo(), concurrency: config.SYNC_CONCURRENCY });
  // what the worker is doing right now, for remote diagnostics
  startHeartbeat('worker', () => ({
    ...processStats(),
    ...buildInfo(),
    concurrency: config.SYNC_CONCURRENCY,
    busy: Object.fromEntries(busy),
    recordingCheckRunning,
  }));

  const shutdown = async () => {
    await Promise.all([worker.close(), maintenance.close()]);
    await Promise.all([syncQueue.close(), maintenanceQueue.close()]);
    await flushOpsLog(1000);
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

main().catch(async (err) => {
  console.error('Worker fatal error:', err);
  await flushOpsLog(2000);
  process.exit(1);
});
