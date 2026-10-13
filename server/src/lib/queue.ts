import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { config } from '../config.js';

/** Enqueue-only handle used by the API process (worker.ts owns processing). */
let queue: Queue | null = null;

export function getSyncQueue(): Queue {
  if (!queue) {
    queue = new Queue('vici-sync', {
      connection: new Redis(config.REDIS_URL, { maxRetriesPerRequest: null }),
    });
  }
  return queue;
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
