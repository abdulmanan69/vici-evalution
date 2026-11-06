/**
 * The last result of each outgoing job (HRMS and CRM pushes, the webhook
 * dispatcher), kept in integration_cursors as 'job:<name>' so the
 * Connections page can show it. Writing it never fails the job itself.
 */
import { like, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { integrationCursors } from '../../db/schema.js';

export interface JobState {
  ok: boolean;
  startedAt: string;
  finishedAt: string;
  ms: number;
  result?: unknown;
  error?: string;
  /** last successful run, kept across failures */
  lastOkAt?: string | null;
}

async function save(name: string, state: JobState): Promise<void> {
  try {
    await db
      .insert(integrationCursors)
      .values({ name: `job:${name}`, lastAt: new Date(state.finishedAt), state })
      .onConflictDoUpdate({
        target: integrationCursors.name,
        set: {
          lastAt: new Date(state.finishedAt),
          // keep when it last worked across failures
          state: state.ok
            ? sql`${JSON.stringify(state)}::jsonb`
            : sql`${JSON.stringify(state)}::jsonb || jsonb_build_object('lastOkAt', ${integrationCursors.state}->'lastOkAt')`,
          updatedAt: new Date(),
        },
      });
  } catch (err) {
    console.error(`[worker] could not record ${name} result:`, (err as Error).message);
  }
}

/** Runs a job and records how it went; errors are recorded and rethrown. */
export async function trackJob<T>(name: string, run: () => Promise<T>): Promise<T> {
  const started = new Date();
  try {
    const result = await run();
    const finished = new Date();
    await save(name, { ok: true, startedAt: started.toISOString(), finishedAt: finished.toISOString(), ms: finished.getTime() - started.getTime(), result, lastOkAt: finished.toISOString() });
    return result;
  } catch (err) {
    const finished = new Date();
    await save(name, {
      ok: false,
      startedAt: started.toISOString(),
      finishedAt: finished.toISOString(),
      ms: finished.getTime() - started.getTime(),
      error: (err as Error).message?.slice(0, 500) ?? String(err),
    });
    throw err;
  }
}

export async function jobStates(): Promise<Record<string, JobState>> {
  const rows = await db.select().from(integrationCursors).where(like(integrationCursors.name, 'job:%'));
  return Object.fromEntries(rows.map((r) => [r.name.slice(4), r.state as JobState]));
}
