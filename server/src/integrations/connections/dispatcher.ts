/**
 * Outbound webhooks. The worker runs dispatchWebhooks() every 30 seconds:
 *
 * 1. collect  read new events from their source tables, in order, from where
 *             the last run stopped (integration_cursors), and add one outbox
 *             row per matching webhook (integration_deliveries). The cursor
 *             moves in the same transaction, and (webhook, event) is unique,
 *             so nothing is missed or sent twice. A stream with no cursor
 *             yet starts from now. Events younger than LAG_SEC wait a run so
 *             rows still being committed are never skipped.
 *               evaluation.completed  evaluations.completed_at
 *               transfer.closed       transfer_events to 'closed'
 *               transfer.reopened     transfer_events from 'closed' to another queue
 * 2. deliver  POST due outbox rows: signed, 10 s timeout, retried with
 *             backoff for about 24 hours (catalog.ts RETRY_DELAYS_SEC).
 * 3. prune    delivered or given-up rows older than 14 days.
 */
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { companies, integrationCursors, integrationDeliveries, integrationWebhooks } from '../../db/schema.js';
import { decryptSecret } from '../../lib/crypto.js';
import { eventMatches, retryDelaySec, signWebhook, type EventName } from './catalog.js';
import { publicRecord, selectEvaluations, selectTransfers } from './records.js';

const LAG_SEC = 60;
const BATCH = 500;
const TIMEOUT_MS = 10_000;
const MAX_UUID = 'ffffffff-ffff-ffff-ffff-ffffffffffff';

interface Hook {
  id: string;
  companyId: string | null;
  events: string[];
}

interface PendingEvent {
  key: string;
  event: EventName;
  companyId: string;
  payload: Record<string, unknown>;
}

async function activeHooks(): Promise<Hook[]> {
  return db
    .select({ id: integrationWebhooks.id, companyId: integrationWebhooks.companyId, events: integrationWebhooks.events })
    .from(integrationWebhooks)
    .where(eq(integrationWebhooks.active, true));
}

async function readCursor(name: string): Promise<{ at: string; id: string } | null> {
  const r = await db.execute(sql`
    select ${sql.raw(`to_char(last_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`)} as at, last_id as id
      from integration_cursors where name = ${name}`);
  const row = r.rows[0] as { at: string | null; id: string | null } | undefined;
  return row?.at ? { at: row.at, id: row.id ?? MAX_UUID } : null;
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function writeCursor(tx: Tx | typeof db, name: string, at: string, id: string): Promise<void> {
  await tx
    .insert(integrationCursors)
    .values({ name, lastAt: new Date(at), lastId: id })
    .onConflictDoUpdate({ target: integrationCursors.name, set: { lastAt: sql`${at}::timestamptz`, lastId: id, updatedAt: new Date() } });
}

/** Postgres-side "now - lag" as full-precision text, so cursors never lose microseconds. */
async function boundNow(): Promise<string> {
  const r = await db.execute(sql`select to_char((now() - make_interval(secs => ${LAG_SEC})) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as b`);
  return (r.rows[0] as { b: string }).b;
}

const slugs = new Map<string, { slug: string; name: string }>();
async function companyInfo(id: string): Promise<{ id: string; slug: string; name: string }> {
  if (!slugs.has(id)) {
    const [c] = await db.select({ slug: companies.slug, name: companies.name }).from(companies).where(eq(companies.id, id));
    slugs.set(id, c ?? { slug: '', name: '' });
  }
  return { id, ...slugs.get(id)! };
}

function envelope(id: string, event: EventName, occurredAt: string, company: { id: string; slug: string; name: string }, data: unknown) {
  return { id, event, occurredAt, company, data };
}

/** Adds outbox rows for the events and moves the cursor, atomically. */
async function enqueue(stream: string, events: PendingEvent[], hooks: Hook[], cursor: { at: string; id: string }): Promise<number> {
  let added = 0;
  await db.transaction(async (tx) => {
    const rows: Array<typeof integrationDeliveries.$inferInsert> = [];
    for (const e of events) {
      for (const h of hooks) {
        if (h.companyId && h.companyId !== e.companyId) continue;
        if (!eventMatches(h.events, e.event)) continue;
        rows.push({ webhookId: h.id, event: e.event, eventKey: e.key, payload: e.payload });
      }
    }
    for (let i = 0; i < rows.length; i += 500) {
      const r = await tx.insert(integrationDeliveries).values(rows.slice(i, i + 500)).onConflictDoNothing().returning({ id: integrationDeliveries.id });
      added += r.length;
    }
    await writeCursor(tx, stream, cursor.at, cursor.id);
  });
  return added;
}

/** evaluation.completed, from evaluations.completed_at */
async function collectEvaluations(hooks: Hook[], bound: string): Promise<number> {
  const stream = 'evaluations.completed';
  let cursor = await readCursor(stream);
  // first run starts from now; with no webhook to tell, the stream just moves on
  if (!cursor || hooks.length === 0) {
    await writeCursor(db, stream, bound, MAX_UUID);
    return 0;
  }
  let added = 0;
  for (;;) {
    const rows = await selectEvaluations(
      sql`(evaluations.completed_at, evaluations.id) > (${cursor.at}::timestamptz, ${cursor.id}::uuid) and evaluations.completed_at <= ${bound}::timestamptz`,
      sql`evaluations.completed_at, evaluations.id`,
      BATCH,
    );
    const companyIds = new Map<string, string>();
    if (rows.length) {
      const ids = await db.execute(sql`select id, company_id from evaluations where id in (${sql.join(rows.map((r) => sql`${r.id}::uuid`), sql`, `)})`);
      for (const x of ids.rows as Array<{ id: string; company_id: string }>) companyIds.set(x.id, x.company_id);
    }
    const events: PendingEvent[] = [];
    for (const r of rows) {
      const companyId = companyIds.get(r.id)!;
      events.push({
        key: `evaluation:${r.id}`,
        event: 'evaluation.completed',
        companyId,
        payload: envelope(`evaluation:${r.id}`, 'evaluation.completed', r.completed_at!, await companyInfo(companyId), publicRecord(r)),
      });
    }
    const next = rows.length === BATCH ? { at: rows[rows.length - 1]._cursor, id: rows[rows.length - 1].id } : { at: bound, id: MAX_UUID };
    added += await enqueue(stream, events, hooks, next);
    cursor = next;
    if (rows.length < BATCH) return added;
  }
}

/** transfer.closed / transfer.reopened, from transfer_events */
async function collectTransferEvents(hooks: Hook[], bound: string): Promise<number> {
  const stream = 'transfer_events';
  let cursor = await readCursor(stream);
  // first run starts from now; with no webhook to tell, the stream just moves on
  if (!cursor || hooks.length === 0) {
    await writeCursor(db, stream, bound, MAX_UUID);
    return 0;
  }
  let added = 0;
  for (;;) {
    const r = await db.execute(sql`
      select te.id, te.transfer_id, te.from_status, te.to_status, te.reason, t.company_id,
             ${sql.raw(`to_char(te.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`)} as at
        from transfer_events te
        join transfers t on t.id = te.transfer_id
       where (te.created_at, te.id) > (${cursor.at}::timestamptz, ${cursor.id}::uuid)
         and te.created_at <= ${bound}::timestamptz
       order by te.created_at, te.id
       limit ${BATCH}`);
    const rows = r.rows as Array<{ id: string; transfer_id: string; from_status: string | null; to_status: string; reason: string | null; company_id: string; at: string }>;
    const relevant = rows
      .map((x) => ({
        ...x,
        event: (x.to_status === 'closed' && x.from_status !== 'closed'
          ? 'transfer.closed'
          : x.from_status === 'closed' && (x.to_status === 'transfer' || x.to_status === 'unclosed')
            ? 'transfer.reopened'
            : null) as EventName | null,
      }))
      .filter((x) => x.event);
    const records = new Map<string, ReturnType<typeof publicRecord>>();
    if (relevant.length && hooks.length) {
      const ids = [...new Set(relevant.map((x) => x.transfer_id))];
      const recs = await selectTransfers(sql`t.id in (${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)})`, sql`t.id`, ids.length, { pii: false });
      for (const t of recs) records.set(t.id, publicRecord(t));
    }
    const events: PendingEvent[] = [];
    for (const x of relevant) {
      const transfer = records.get(x.transfer_id);
      if (!transfer) continue; // mock data, or no webhook to tell
      events.push({
        key: `transfer_event:${x.id}`,
        event: x.event!,
        companyId: x.company_id,
        payload: envelope(`transfer_event:${x.id}`, x.event!, x.at, await companyInfo(x.company_id), {
          transfer,
          change: { from: x.from_status, to: x.to_status, reason: x.reason },
        }),
      });
    }
    const next = rows.length === BATCH ? { at: rows[rows.length - 1].at, id: rows[rows.length - 1].id } : { at: bound, id: MAX_UUID };
    added += await enqueue(stream, events, hooks, next);
    cursor = next;
    if (rows.length < BATCH) return added;
  }
}

/* ------------------------------------------------------------- deliver */

export interface SendResult {
  ok: boolean;
  status: number | null;
  error: string | null;
  ms: number;
}

/** One signed POST. Never throws. */
export async function sendSigned(url: string, secret: string, event: string, deliveryId: string, payload: unknown): Promise<SendResult> {
  const body = JSON.stringify(payload);
  const ts = String(Math.floor(Date.now() / 1000));
  const started = Date.now();
  try {
    const res = await fetch(url, {
      method: 'POST',
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        'content-type': 'application/json',
        'user-agent': 'vici-qa-webhooks/1',
        'x-qa-event': event,
        'x-qa-delivery': deliveryId,
        'x-qa-timestamp': ts,
        'x-qa-signature': signWebhook(secret, ts, body),
      },
      body,
    });
    // the body is not needed; drain it so the connection is released
    await res.arrayBuffer().catch(() => undefined);
    const ok = res.status >= 200 && res.status < 300;
    return { ok, status: res.status, error: ok ? null : `HTTP ${res.status}`, ms: Date.now() - started };
  } catch (err) {
    const e = err as Error & { cause?: { code?: string } };
    const msg = e.name === 'TimeoutError' ? 'timed out after 10 s' : (e.cause?.code ?? e.message ?? 'request failed');
    return { ok: false, status: null, error: String(msg).slice(0, 300), ms: Date.now() - started };
  }
}

/** Records the outcome on the delivery and its webhook. */
export async function recordAttempt(deliveryId: string, webhookId: string, attemptsBefore: number, r: SendResult): Promise<void> {
  const attempts = attemptsBefore + 1;
  if (r.ok) {
    await db
      .update(integrationDeliveries)
      .set({ attempts, deliveredAt: new Date(), nextAttemptAt: null, lastStatus: r.status, lastError: null })
      .where(eq(integrationDeliveries.id, deliveryId));
    await db
      .update(integrationWebhooks)
      .set({ lastStatus: r.status, lastError: null, lastDeliveryAt: new Date(), failingSince: null })
      .where(eq(integrationWebhooks.id, webhookId));
    return;
  }
  const delay = retryDelaySec(attempts);
  await db
    .update(integrationDeliveries)
    .set({
      attempts,
      nextAttemptAt: delay == null ? null : new Date(Date.now() + delay * 1000),
      lastStatus: r.status,
      lastError: delay == null ? `${r.error} — gave up after ${attempts} attempts` : r.error,
    })
    .where(eq(integrationDeliveries.id, deliveryId));
  await db
    .update(integrationWebhooks)
    .set({ lastStatus: r.status, lastError: r.error, lastDeliveryAt: new Date(), failingSince: sql`coalesce(${integrationWebhooks.failingSince}, now())` })
    .where(eq(integrationWebhooks.id, webhookId));
}

async function deliverDue(): Promise<{ sent: number; failed: number }> {
  // claim due rows: pushing next_attempt_at out keeps a second worker off them
  const claimed = await db.execute(sql`
    update integration_deliveries d
       set next_attempt_at = now() + interval '2 minutes'
      from integration_webhooks w
     where w.id = d.webhook_id
       and d.id in (
         select d2.id from integration_deliveries d2
           join integration_webhooks w2 on w2.id = d2.webhook_id
          where d2.delivered_at is null and d2.next_attempt_at <= now() and w2.active
          order by d2.next_attempt_at
          limit 100
          for update of d2 skip locked)
    returning d.id, d.webhook_id, d.event, d.payload, d.attempts, w.url, w.secret`);
  const rows = claimed.rows as Array<{ id: string; webhook_id: string; event: string; payload: unknown; attempts: number; url: string; secret: string }>;
  let sent = 0;
  let failed = 0;
  // one webhook's deliveries go in order; different webhooks side by side
  const byHook = new Map<string, typeof rows>();
  for (const r of rows) byHook.set(r.webhook_id, [...(byHook.get(r.webhook_id) ?? []), r]);
  const lanes = [...byHook.values()];
  const work = async () => {
    for (let lane = lanes.shift(); lane; lane = lanes.shift()) {
      let secret: string;
      try {
        secret = decryptSecret(lane[0].secret);
      } catch {
        for (const d of lane) await recordAttempt(d.id, d.webhook_id, d.attempts, { ok: false, status: null, error: 'signing secret unreadable — rotate it', ms: 0 });
        failed += lane.length;
        continue;
      }
      for (let i = 0; i < lane.length; i++) {
        const d = lane[i];
        const r = await sendSigned(d.url, secret, d.event, d.id, d.payload);
        await recordAttempt(d.id, d.webhook_id, d.attempts, r);
        if (r.ok) sent += 1;
        else {
          failed += 1;
          // the receiver is down: the rest of its queue waits for the retry
          if (r.status === null || r.status >= 500) {
            const rest = lane.slice(i + 1).map((x) => x.id);
            if (rest.length) {
              await db.execute(sql`update integration_deliveries set next_attempt_at = now() + interval '30 seconds'
                 where id in (${sql.join(rest.map((id) => sql`${id}::uuid`), sql`, `)})`);
            }
            break;
          }
        }
      }
    }
  };
  await Promise.all(Array.from({ length: 4 }, work));
  return { sent, failed };
}

let lastPrune = 0;
async function prune(): Promise<number> {
  if (Date.now() - lastPrune < 3600_000) return 0;
  lastPrune = Date.now();
  const r = await db.execute(sql`
    delete from integration_deliveries
     where (delivered_at is not null and delivered_at < now() - interval '14 days')
        or (delivered_at is null and next_attempt_at is null and created_at < now() - interval '14 days')`);
  return r.rowCount ?? 0;
}

let running = false;

/** One dispatcher pass (worker job `webhooks`, every 30 seconds). */
export async function dispatchWebhooks(): Promise<{ queued: number; sent: number; failed: number; pruned: number } | { skipped: string }> {
  if (running) return { skipped: 'previous run still busy' };
  running = true;
  try {
    const hooks = await activeHooks();
    const bound = await boundNow();
    const queued = (await collectEvaluations(hooks, bound)) + (await collectTransferEvents(hooks, bound));
    const { sent, failed } = hooks.length ? await deliverDue() : { sent: 0, failed: 0 };
    const pruned = await prune();
    return { queued, sent, failed, pruned };
  } finally {
    running = false;
  }
}

/** A ping delivery sent right away (Connections page → Test). */
export async function sendPing(webhookId: string): Promise<SendResult & { deliveryId: string }> {
  const [w] = await db.select().from(integrationWebhooks).where(eq(integrationWebhooks.id, webhookId));
  if (!w) throw new Error('webhook not found');
  const company = w.companyId ? await companyInfo(w.companyId) : null;
  const key = `ping:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
  const payload = envelope(key, 'ping', new Date().toISOString(), company ?? { id: '', slug: '', name: '' }, { message: 'Test delivery from VICIdial QA', webhook: w.name });
  const [d] = await db
    .insert(integrationDeliveries)
    .values({ webhookId: w.id, event: 'ping', eventKey: key, payload, nextAttemptAt: null })
    .returning({ id: integrationDeliveries.id });
  const r = await sendSigned(w.url, decryptSecret(w.secret), 'ping', d.id, payload);
  // a test is not retried; it only shows whether the receiver answers
  await db
    .update(integrationDeliveries)
    .set({ attempts: 1, deliveredAt: r.ok ? new Date() : null, lastStatus: r.status, lastError: r.error })
    .where(and(eq(integrationDeliveries.id, d.id)));
  await db
    .update(integrationWebhooks)
    .set(r.ok ? { lastStatus: r.status, lastError: null, lastDeliveryAt: new Date(), failingSince: null } : { lastStatus: r.status, lastError: r.error, lastDeliveryAt: new Date() })
    .where(eq(integrationWebhooks.id, w.id));
  return { ...r, deliveryId: d.id };
}
