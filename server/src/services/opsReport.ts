import type { Job, Queue } from 'bullmq';
import { pool } from '../db/client.js';
import { getMaintenanceQueue, getSyncQueue } from '../lib/queue.js';
import {
  OPS_ERRORS_KEY,
  errorFingerprint,
  opsHeartbeatKey,
  opsRedis,
  readBoots,
  readOpsLog,
  type OpsEntry,
} from '../lib/opsLog.js';
import { buildInfo, processStats } from '../lib/runtime.js';
import { requestSnapshot } from '../lib/requestStats.js';
import { opsSqlStatus } from './opsReader.js';

/**
 * Read-only reports behind the remote diagnostics endpoints (routes/ops.ts):
 * what runs, how each dialer syncs, queues, database health, and a list of
 * problems worked out from all of it. Nothing here writes, and no stored
 * credential is ever read.
 */

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : v == null ? null : String(v));
const ageSec = (v: unknown) => (v ? Math.round((Date.now() - new Date(v as string).getTime()) / 1000) : null);

function hostOf(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

async function timed<T>(fn: () => Promise<T>): Promise<{ ok: boolean; ms: number; value?: T; error?: string }> {
  const t0 = Date.now();
  try {
    const value = await fn();
    return { ok: true, ms: Date.now() - t0, value };
  } catch (err) {
    return { ok: false, ms: Date.now() - t0, error: err instanceof Error ? err.message : String(err) };
  }
}

// ---------------------------------------------------------------------------
// Dialers and sync
// ---------------------------------------------------------------------------

export async function dialerReport() {
  const [dialers, counts, transfers, recordings, cursors] = await Promise.all([
    pool.query(`
      select d.id, d.name, c.name as company, c.status as company_status, d.source_mode, d.active,
             d.deleting_at, d.last_seen_at, d.backfilled_at, d.timezone, d.tz_offset_min, d.clock_drift_sec,
             d.time_checked_at, d.base_url, d.db_host, d.created_at,
             lj.status as last_status, lj.job_type as last_type, lj.created_at as last_created,
             lj.started_at as last_started, lj.finished_at as last_finished, lj.error as last_error,
             lj.stats->'stageSeconds' as last_stage_seconds,
             rj.id as running_id, rj.job_type as running_type, rj.started_at as running_started,
             rj.progress as running_progress,
             coalesce((rj.progress->>'heartbeatAt')::timestamptz, (rj.progress->>'updatedAt')::timestamptz, rj.started_at) as running_beat,
             (select count(*) from sync_jobs f where f.dialer_server_id = d.id and f.status = 'failed'
                 and f.created_at > now() - interval '24 hours')::int as failed_24h,
             (select count(*) from sync_jobs s where s.dialer_server_id = d.id and s.status = 'success'
                 and s.created_at > now() - interval '24 hours')::int as succeeded_24h
        from dialer_servers d
        join companies c on c.id = d.company_id
        left join lateral (select * from sync_jobs j where j.dialer_server_id = d.id and j.status <> 'running'
                            order by j.created_at desc limit 1) lj on true
        left join lateral (select * from sync_jobs j where j.dialer_server_id = d.id and j.status = 'running'
                            order by (j.job_type = 'full') desc, j.created_at desc limit 1) rj on true
       order by c.name, d.name`),
    pool.query(`select dialer_server_id, count(*)::int as n from calls
                 where call_date > now() - interval '24 hours' and not is_mock group by 1`),
    pool.query(`select dialer_server_id, count(*) filter (where kind = 'transfer')::int as transfers,
                       count(*) filter (where queue_status = 'closed')::int as closed
                  from transfers where xfer_time > now() - interval '24 hours' and not is_mock group by 1`),
    pool.query(`select dialer_server_id, count(*)::int as total, count(*) filter (where status <> 'available')::int as not_ready
                  from recordings where coalesce(start_time, created_at) > now() - interval '24 hours' and not is_mock group by 1`),
    pool.query(`select dialer_server_id, stream, last_timestamp, updated_at from sync_cursors order by stream`),
  ]);
  const by = <T extends { dialer_server_id: string }>(rows: T[]) => new Map(rows.map((r) => [r.dialer_server_id, r]));
  const callsBy = by(counts.rows as { dialer_server_id: string; n: number }[]);
  const xferBy = by(transfers.rows as { dialer_server_id: string; transfers: number; closed: number }[]);
  const recBy = by(recordings.rows as { dialer_server_id: string; total: number; not_ready: number }[]);

  return dialers.rows.map((d) => {
    const running = d.running_id
      ? {
          type: d.running_type as string,
          startedAt: iso(d.running_started),
          heartbeatAgeSec: ageSec(d.running_beat),
          percent: (d.running_progress?.percent as number | undefined) ?? null,
          label: (d.running_progress?.label as string | undefined) ?? null,
          detail: (d.running_progress?.detail as string | undefined) ?? null,
        }
      : null;
    return {
      id: d.id as string,
      name: d.name as string,
      company: d.company as string,
      companyStatus: d.company_status as string,
      sourceMode: d.source_mode as string,
      active: d.active as boolean,
      deleting: !!d.deleting_at,
      apiHost: hostOf(d.base_url),
      dbHost: (d.db_host as string | null) ?? null,
      timezone: d.timezone as string,
      tzOffsetMin: d.tz_offset_min as number | null,
      clockDriftSec: d.clock_drift_sec as number | null,
      lastSeenAt: iso(d.last_seen_at),
      lastSeenAgoSec: ageSec(d.last_seen_at),
      backfilledAt: iso(d.backfilled_at),
      createdAt: iso(d.created_at),
      lastJob: d.last_status
        ? {
            status: d.last_status as string,
            type: d.last_type as string,
            createdAt: iso(d.last_created),
            tookSec:
              d.last_started && d.last_finished
                ? Math.round((new Date(d.last_finished).getTime() - new Date(d.last_started).getTime()) / 1000)
                : null,
            error: d.last_error as string | null,
            stageSeconds: d.last_stage_seconds as Record<string, number> | null,
          }
        : null,
      running,
      last24h: {
        syncsOk: d.succeeded_24h as number,
        syncsFailed: d.failed_24h as number,
        calls: callsBy.get(d.id)?.n ?? 0,
        transfers: xferBy.get(d.id)?.transfers ?? 0,
        closed: xferBy.get(d.id)?.closed ?? 0,
        recordings: recBy.get(d.id)?.total ?? 0,
        recordingsNotReady: recBy.get(d.id)?.not_ready ?? 0,
      },
      cursors: cursors.rows
        .filter((c) => c.dialer_server_id === d.id)
        .map((c) => ({ stream: c.stream as string, lastTimestamp: iso(c.last_timestamp), updatedAt: iso(c.updated_at) })),
    };
  });
}

export async function syncJobsReport(opts: { limit: number; dialer?: string; status?: string }) {
  const params: unknown[] = [];
  const where: string[] = [];
  if (opts.dialer) {
    params.push(opts.dialer);
    where.push(`(d.id::text = $${params.length} or d.name ilike $${params.length} or c.name ilike $${params.length})`);
  }
  if (opts.status) {
    params.push(opts.status);
    where.push(`j.status::text = $${params.length}`);
  }
  params.push(opts.limit);
  const { rows } = await pool.query(
    `select j.id, d.name as dialer, c.name as company, j.job_type, j.status, j.created_at, j.started_at, j.finished_at,
            j.window_start, j.window_end, j.error, j.stats, j.progress
       from sync_jobs j
       join dialer_servers d on d.id = j.dialer_server_id
       join companies c on c.id = d.company_id
      ${where.length ? `where ${where.join(' and ')}` : ''}
      order by j.created_at desc
      limit $${params.length}`,
    params,
  );
  return rows.map((j) => ({
    id: j.id,
    dialer: j.dialer,
    company: j.company,
    type: j.job_type,
    status: j.status,
    createdAt: iso(j.created_at),
    startedAt: iso(j.started_at),
    finishedAt: iso(j.finished_at),
    tookSec:
      j.started_at && j.finished_at
        ? Math.round((new Date(j.finished_at).getTime() - new Date(j.started_at).getTime()) / 1000)
        : null,
    window: j.window_start ? { from: iso(j.window_start), to: iso(j.window_end) } : null,
    error: j.error,
    progress: j.status === 'running' ? j.progress : undefined,
    stats: j.stats,
  }));
}

// ---------------------------------------------------------------------------
// Companies
// ---------------------------------------------------------------------------

export async function companiesReport() {
  const { rows } = await pool.query(`
    select c.id, c.name, c.slug, c.status, c.created_at,
      (select count(*) from users u where u.company_id = c.id and u.status = 'active')::int as users,
      (select count(*) from company_memberships m where m.company_id = c.id)::int as shared_users,
      (select count(*) from dialer_servers d where d.company_id = c.id and d.deleting_at is null)::int as dialers,
      (select count(*) from disposition_mappings dm where dm.company_id = c.id)::int as disposition_mappings,
      (select count(*) from transfers t where t.company_id = c.id and t.kind = 'transfer'
          and t.xfer_time > now() - interval '7 days')::int as transfers_7d,
      (select count(*) from transfers t where t.company_id = c.id and t.queue_status = 'closed'
          and t.xfer_time > now() - interval '7 days')::int as closed_7d,
      (select count(*) from evaluations e where e.company_id = c.id and e.status = 'completed'
          and e.created_at > now() - interval '7 days')::int as evaluations_7d,
      (select count(*) from qa_assignments a where a.company_id = c.id and a.status in ('open', 'in_progress'))::int as open_tasks,
      (select max(u.last_login_at) from users u where u.company_id = c.id) as last_login_at
    from companies c
    order by c.name`);
  return rows.map((r) => ({ ...r, created_at: iso(r.created_at), last_login_at: iso(r.last_login_at) }));
}

// ---------------------------------------------------------------------------
// Queues
// ---------------------------------------------------------------------------

async function dialerNames(): Promise<Map<string, string>> {
  const { rows } = await pool.query(`select id, name from dialer_servers`);
  return new Map(rows.map((r) => [r.id as string, r.name as string]));
}

function jobView(j: Job, names: Map<string, string>) {
  const data = (j.data ?? {}) as Record<string, unknown>;
  const dialerId = data.dialerServerId as string | undefined;
  return {
    id: j.id,
    name: j.name,
    dialer: dialerId ? (names.get(dialerId) ?? dialerId) : undefined,
    data,
    attemptsMade: j.attemptsMade,
    queuedAt: j.timestamp ? new Date(j.timestamp).toISOString() : null,
    startedAt: j.processedOn ? new Date(j.processedOn).toISOString() : null,
    finishedAt: j.finishedOn ? new Date(j.finishedOn).toISOString() : null,
    failedReason: j.failedReason || undefined,
  };
}

async function queueView(q: Queue, names: Map<string, string>) {
  const [counts, schedulers, active, waiting, delayed, failed] = await Promise.all([
    q.getJobCounts('waiting', 'active', 'delayed', 'failed', 'completed', 'paused', 'prioritized'),
    q.getJobSchedulers(0, 50).catch(() => []),
    q.getActive(0, 50),
    q.getWaiting(0, 30),
    q.getDelayed(0, 20),
    q.getFailed(0, 20),
  ]);
  return {
    name: q.name,
    counts,
    schedulers: schedulers.map((s) => ({
      name: s.name,
      every: s.every ?? null,
      pattern: s.pattern ?? null,
      next: s.next ? new Date(s.next).toISOString() : null,
    })),
    active: active.filter(Boolean).map((j) => jobView(j, names)),
    waiting: waiting.filter(Boolean).map((j) => jobView(j, names)),
    delayed: delayed.filter(Boolean).map((j) => jobView(j, names)),
    failed: failed.filter(Boolean).map((j) => jobView(j, names)),
  };
}

export async function queuesReport() {
  const names = await dialerNames();
  const [sync, maintenance] = await Promise.all([queueView(getSyncQueue(), names), queueView(getMaintenanceQueue(), names)]);
  return { sync, maintenance };
}

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

async function section<T>(fn: () => Promise<T>): Promise<T | { error: string }> {
  try {
    return await fn();
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

export async function dbReport() {
  const q = async (text: string) => (await pool.query(text)).rows;
  return {
    database: await section(async () => (await q(`
      select pg_size_pretty(pg_database_size(current_database())) as size,
             current_setting('max_connections')::int as max_connections,
             current_setting('shared_buffers') as shared_buffers,
             current_setting('work_mem') as work_mem,
             (select round(100.0 * sum(blks_hit) / nullif(sum(blks_hit + blks_read), 0), 2)
                from pg_stat_database where datname = current_database()) as cache_hit_pct,
             (select count(*) from pg_locks where not granted)::int as waiting_locks,
             (select deadlocks from pg_stat_database where datname = current_database()) as deadlocks,
             (select stats_reset from pg_stat_database where datname = current_database()) as stats_since,
             version() as version`))[0]),
    connections: await section(() => q(`
      select coalesce(nullif(usename, ''), '-') as "user", coalesce(nullif(application_name, ''), '-') as app,
             coalesce(state, '-') as state, count(*)::int as n,
             max(extract(epoch from now() - coalesce(xact_start, query_start)))::int as oldest_sec
        from pg_stat_activity where datname = current_database()
       group by 1, 2, 3 order by n desc`)),
    running: await section(() => q(`
      select pid, usename as "user", state, wait_event_type, wait_event,
             extract(epoch from now() - query_start)::numeric(10,1) as seconds,
             left(regexp_replace(query, '\\s+', ' ', 'g'), 400) as query
        from pg_stat_activity
       where datname = current_database() and pid <> pg_backend_pid()
         and state <> 'idle' and query_start < now() - interval '1 second'
       order by query_start limit 25`)),
    topByTotalTime: await section(() => q(`
      select calls, round(total_exec_time)::bigint as total_ms, round(mean_exec_time::numeric, 1) as mean_ms,
             round(max_exec_time)::bigint as max_ms, rows,
             left(regexp_replace(query, '\\s+', ' ', 'g'), 300) as query
        from pg_stat_statements
       where dbid = (select oid from pg_database where datname = current_database())
       order by total_exec_time desc limit 15`)),
    topByMeanTime: await section(() => q(`
      select calls, round(mean_exec_time::numeric, 1) as mean_ms, round(max_exec_time)::bigint as max_ms,
             left(regexp_replace(query, '\\s+', ' ', 'g'), 300) as query
        from pg_stat_statements
       where dbid = (select oid from pg_database where datname = current_database()) and calls >= 5
       order by mean_exec_time desc limit 10`)),
    tables: await section(() => q(`
      select relname as "table", n_live_tup as live_rows, n_dead_tup as dead_rows,
             pg_size_pretty(pg_total_relation_size(relid)) as size, seq_scan, idx_scan,
             last_autovacuum, last_autoanalyze
        from pg_stat_user_tables
       order by pg_total_relation_size(relid) desc limit 25`)),
  };
}

// ---------------------------------------------------------------------------
// Logs
// ---------------------------------------------------------------------------

export interface ErrorGroup {
  count: number;
  first: string;
  last: string;
  src: string;
  lvl: string;
  sample: OpsEntry;
}

/** Entries grouped by message shape, most frequent first. */
export function groupEntries(entries: OpsEntry[]): ErrorGroup[] {
  const groups = new Map<string, ErrorGroup>();
  for (const e of entries) {
    const fp = `${e.src}|${errorFingerprint(e.msg)}`;
    const g = groups.get(fp);
    if (!g) groups.set(fp, { count: 1, first: e.t, last: e.t, src: e.src, lvl: e.lvl, sample: e });
    else {
      g.count += 1;
      if (e.t < g.first) g.first = e.t;
      if (e.t > g.last) {
        g.last = e.t;
        g.sample = e;
      }
    }
  }
  return [...groups.values()].sort((a, b) => b.count - a.count || b.last.localeCompare(a.last));
}

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

export interface Problem {
  severity: 'critical' | 'warning';
  message: string;
}

export async function overview() {
  const redisCheck = await timed(async () => {
    const r = opsRedis();
    await r.ping();
    const info = await r.info('memory');
    return { usedMemory: /used_memory_human:(\S+)/.exec(info)?.[1] ?? null };
  });
  const dbCheck = await timed(async () => {
    const { rows } = await pool.query(`
      select (select count(*) from pg_stat_activity where datname = current_database())::int as connections,
             current_setting('max_connections')::int as max_connections,
             (select count(*) from pg_stat_activity where datname = current_database() and state <> 'idle'
                 and query_start < now() - interval '60 seconds' and pid <> pg_backend_pid())::int as long_queries,
             pg_size_pretty(pg_database_size(current_database())) as size`);
    return rows[0] as { connections: number; max_connections: number; long_queries: number; size: string };
  });

  const [workerBeat, dialers, queues, errors, boots] = await Promise.all([
    redisCheck.ok
      ? opsRedis()
          .get(opsHeartbeatKey('worker'))
          .then((v) => (v ? (JSON.parse(v) as Record<string, unknown>) : null))
          .catch(() => null)
      : Promise.resolve(null),
    dbCheck.ok ? dialerReport() : Promise.resolve([]),
    redisCheck.ok
      ? Promise.all([
          getSyncQueue().getJobCounts('waiting', 'active', 'delayed', 'failed'),
          getMaintenanceQueue().getJobCounts('waiting', 'active', 'delayed', 'failed'),
        ]).then(([sync, maintenance]) => ({ sync, maintenance }))
      : Promise.resolve(null),
    redisCheck.ok ? readOpsLog(OPS_ERRORS_KEY, 2000).catch(() => []) : Promise.resolve([] as OpsEntry[]),
    redisCheck.ok ? readBoots(20).catch(() => []) : Promise.resolve([]),
  ]);

  const now = Date.now();
  const hourAgo = new Date(now - 3600_000).toISOString();
  const dayAgo = new Date(now - 24 * 3600_000).toISOString();
  const errorsHour = errors.filter((e) => e.t >= hourAgo);
  const errorsDay = errors.filter((e) => e.t >= dayAgo);
  const requests = requestSnapshot(15);
  const api = processStats();
  const workerAgeSec = workerBeat?.at ? ageSec(workerBeat.at) : null;
  const names = new Map(dialers.map((d) => [d.id, `${d.name} (${d.company})`]));
  const workerBusy = workerBeat?.busy
    ? Object.fromEntries(Object.entries(workerBeat.busy as Record<string, string>).map(([id, mode]) => [names.get(id) ?? id, mode]))
    : undefined;

  const problems: Problem[] = [];
  const crit = (message: string) => problems.push({ severity: 'critical', message });
  const warn = (message: string) => problems.push({ severity: 'warning', message });

  if (!dbCheck.ok) crit(`Database unreachable: ${dbCheck.error}`);
  else {
    if (dbCheck.ms > 500) warn(`Database answered slowly (${dbCheck.ms} ms for a status query)`);
    const v = dbCheck.value!;
    if (v.connections > v.max_connections * 0.8) warn(`Database connections near the limit (${v.connections}/${v.max_connections})`);
    if (v.long_queries > 0) warn(`${v.long_queries} database quer${v.long_queries === 1 ? 'y has' : 'ies have'} run over 60 s (see: ops db)`);
  }
  if (!redisCheck.ok) crit(`Redis unreachable: ${redisCheck.error} — syncs and the diagnostics log stop`);
  else if (!workerBeat) crit('Worker is not running (no heartbeat) — no syncs, recording checks or deletes happen');
  else if (workerAgeSec != null && workerAgeSec > 60) crit(`Worker heartbeat is ${workerAgeSec}s old — it is stuck or gone`);
  if (workerBeat) {
    const lag = (workerBeat.eventLoopDelay as { p99Ms?: number } | undefined)?.p99Ms ?? 0;
    if (lag > 500) warn(`Worker event loop is busy (p99 delay ${lag} ms)`);
  }
  const apiLag = (api.eventLoopDelay as { p99Ms: number }).p99Ms;
  if (apiLag > 200) warn(`API event loop is busy (p99 delay ${apiLag} ms) — pages feel slow`);

  const recentBoots = boots.filter((b) => typeof b.t === 'string' && (b.t as string) >= hourAgo);
  for (const src of ['api', 'worker']) {
    const n = recentBoots.filter((b) => b.src === src).length;
    if (n >= 3) crit(`The ${src} started ${n} times in the last hour — it keeps crashing (see: ops errors)`);
  }

  for (const d of dialers) {
    if (!d.active || d.deleting || d.companyStatus !== 'active') continue;
    const label = `${d.name} (${d.company})`;
    if (d.running && d.running.heartbeatAgeSec != null && d.running.heartbeatAgeSec > 120) {
      warn(`${label}: a running ${d.running.type} sync stopped reporting ${d.running.heartbeatAgeSec}s ago`);
    }
    if (!d.backfilledAt && d.running?.type !== 'full') warn(`${label}: the 7-day import has not finished yet`);
    if (!d.running && d.lastJob?.status === 'failed') warn(`${label}: last sync failed — ${String(d.lastJob.error ?? '').slice(0, 300)}`);
    if (!d.running && (d.lastSeenAgoSec == null || d.lastSeenAgoSec > 600)) {
      warn(`${label}: no successful sync ${d.lastSeenAgoSec == null ? 'ever' : `for ${Math.round(d.lastSeenAgoSec / 60)} min`}`);
    }
    if (d.clockDriftSec != null && Math.abs(d.clockDriftSec) > 90) warn(`${label}: dialer clock is off by ${d.clockDriftSec}s`);
  }

  if (queues) {
    const activeDialers = dialers.filter((d) => d.active && !d.deleting).length;
    if (queues.sync.waiting > Math.max(10, activeDialers * 3)) warn(`Sync queue backlog: ${queues.sync.waiting} jobs waiting`);
    if (queues.maintenance.failed > 0) warn(`${queues.maintenance.failed} maintenance job(s) failed (see: ops queues)`);
  }
  if (errorsHour.length > 0) {
    const top = groupEntries(errorsHour)[0];
    warn(`${errorsHour.length} error/warning line(s) in the last hour — most common (${top.count}×, ${top.src}): ${top.sample.msg.slice(0, 200)}`);
  }
  if (requests.totals.serverErrors > 0) warn(`${requests.totals.serverErrors} request(s) failed with a server error in the last 15 min`);
  if (requests.totals.rateLimited > 0) warn(`${requests.totals.rateLimited} request(s) were rate limited in the last 15 min`);
  if (requests.totals.slow > 0) warn(`${requests.totals.slow} request(s) took over 1 s in the last 15 min (see: ops requests)`);

  problems.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'critical' ? -1 : 1));

  return {
    now: new Date(now).toISOString(),
    build: buildInfo(),
    problems,
    api: { ...api, diagnosticsSql: opsSqlStatus() },
    worker: workerBeat ? { ...workerBeat, heartbeatAgeSec: workerAgeSec, busy: workerBusy } : null,
    database: dbCheck.ok ? { ok: true, pingMs: dbCheck.ms, ...dbCheck.value } : { ok: false, error: dbCheck.error },
    redis: redisCheck.ok ? { ok: true, pingMs: redisCheck.ms, ...redisCheck.value } : { ok: false, error: redisCheck.error },
    queues,
    requests: requests.totals,
    errors: {
      lastHour: errorsHour.length,
      last24h: errorsDay.length,
      top24h: groupEntries(errorsDay)
        .slice(0, 5)
        .map((g) => ({ count: g.count, last: g.last, src: g.src, lvl: g.lvl, msg: g.sample.msg.slice(0, 300) })),
    },
    dialers: dialers.map((d) => ({
      name: d.name,
      company: d.company,
      mode: d.sourceMode,
      active: d.active && !d.deleting,
      lastSeenAgoSec: d.lastSeenAgoSec,
      backfilled: !!d.backfilledAt,
      running: d.running ? `${d.running.type} ${d.running.percent ?? 0}% · ${d.running.label ?? ''}` : null,
      lastJob: d.lastJob ? `${d.lastJob.status} (${d.lastJob.type}, ${d.lastJob.tookSec ?? '?'}s)` : null,
      last24h: d.last24h,
    })),
    boots: boots.slice(0, 6),
  };
}
