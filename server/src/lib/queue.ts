import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { config } from '../config.js';

/** Enqueue-only handles used by the API process (worker.ts owns processing). */
let queue: Queue | null = null;
let maintenance: Queue | null = null;

export const SYNC_QUEUE = 'vici-sync';
/** long-running housekeeping (deletes, retention) — never holds up a sync */
export const MAINTENANCE_QUEUE = 'vici-maintenance';

export function getSyncQueue(): Queue {
  if (!queue) {
    queue = new Queue(SYNC_QUEUE, {
      connection: new Redis(config.REDIS_URL, { maxRetriesPerRequest: null }),
    });
  }
  return queue;
}

export function getMaintenanceQueue(): Queue {
  if (!maintenance) {
    maintenance = new Queue(MAINTENANCE_QUEUE, {
      connection: new Redis(config.REDIS_URL, { maxRetriesPerRequest: null }),
    });
  }
  return maintenance;
}

export async function enqueueDialerSync(dialerServerId: string, full = false): Promise<void> {
  await getSyncQueue().add(
    'sync-dialer',
    { dialerServerId, full },
    {
      // BullMQ forbids ':' in custom ids; and the job must be removed on
      // completion or the id would block every future sync of this dialer.
      // Full backfills get their own id so a scheduled incremental cannot
      // swallow a manual full-sync request (all writes are idempotent).
      jobId: full ? `sync-full-${dialerServerId}` : `sync-${dialerServerId}`,
      removeOnComplete: true,
      removeOnFail: true,
      attempts: 3,
      backoff: { type: 'exponential', delay: 10_000 },
    },
  );
}

const PURGE_OPTS = {
  removeOnComplete: true,
  removeOnFail: true,
  attempts: 5,
  backoff: { type: 'exponential' as const, delay: 30_000 },
};

/** Removes a deleted dialer's data in the background (services/purge.ts). */
export async function enqueueDialerPurge(dialerServerId: string, queueHandle: Queue = getMaintenanceQueue()): Promise<void> {
  await queueHandle.add('purge-dialer', { dialerServerId }, { ...PURGE_OPTS, jobId: `purge-dialer-${dialerServerId}` });
}

/** Removes a deleted company and all its data in the background. */
export async function enqueueCompanyPurge(companyId: string, queueHandle: Queue = getMaintenanceQueue()): Promise<void> {
  await queueHandle.add('purge-company', { companyId }, { ...PURGE_OPTS, jobId: `purge-company-${companyId}` });
}

/** Drops queued (not yet running) syncs of a dialer that is being deleted. */
export async function dropQueuedSyncs(dialerServerId: string): Promise<void> {
  const q = getSyncQueue();
  for (const id of [`sync-${dialerServerId}`, `sync-full-${dialerServerId}`]) {
    try {
      const job = await q.getJob(id);
      if (job && (await job.isWaiting())) await job.remove();
    } catch {
      /* a job that started meanwhile ends on its own — the dialer is inactive */
    }
  }
}
