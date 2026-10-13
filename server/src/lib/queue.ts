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
      jobId: `sync:${dialerServerId}`,
      removeOnComplete: 100,
      removeOnFail: 100,
      attempts: 3,
      backoff: { type: 'exponential', delay: 10_000 },
    },
  );
}
