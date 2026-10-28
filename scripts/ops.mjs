#!/usr/bin/env node
// Remote diagnostics client for a deployed VICIdial QA instance.
// Reads the read-only /api/v1/ops endpoints (server/src/routes/ops.ts).
//
//   node scripts/ops.mjs init --url https://qa.example.com   create .ops.local with a new token
//   node scripts/ops.mjs status                               health, problems, dialers
//   node scripts/ops.mjs help                                 every command
//
// Connection: OPS_URL + OPS_TOKEN from the environment, --url/--token, or the
// .ops.local file in the repository root (git ignores *.local).

import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const HELP = `Remote diagnostics for a deployed VICIdial QA instance

  node scripts/ops.mjs <command> [options]

Commands
  init [--url URL] [--force]   create .ops.local with a new random token
  status                       health, problems, dialers, top errors (default)
  errors [--since 24h] [--src api|worker] [--list] [--limit N]
                               warnings/errors, grouped by message (--list: one per line)
  logs [--since 1h] [--src worker] [--grep TEXT] [--limit N]
                               everything the worker reported, plus API warnings
  requests [--minutes 15]      API timing: per minute, per route, slow requests
  dialers                      every dialer: last sync, 7-day import, counts, cursors
  sync [--dialer NAME] [--status failed] [--limit N]
                               recent sync runs with errors and slowest stages
  companies                    companies with users, dialers, transfers, evaluations
  queues                       background job queues, schedules, running jobs
  db                           database size, connections, slow queries, tables
  sql "SELECT …" [--max N]     read-only query (no secrets, 20 s limit)
  probe <dialer name|id>       connect to a dialer's API + database now
  raw <path>                   GET any diagnostics path, print the JSON

Options
  --json                       print the raw JSON answer
  --url URL --token TOKEN      override OPS_URL / OPS_TOKEN
  --config FILE                read another config file instead of .ops.local
`;

// ---------------------------------------------------------------------------
// arguments and config
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=', 2);
      if (v !== undefined) out[k] = v;
      else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) out[k] = argv[++i];
      else out[k] = true;
    } else out._.push(a);
  }
  return out;
}

function readConfigFile(file) {
  if (!existsSync(file)) return {};
  const out = {};
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

function connection(args) {
  const file = args.config ? String(args.config) : join(ROOT, '.ops.local');
  const fromFile = readConfigFile(file);
  const url = String(args.url || process.env.OPS_URL || fromFile.OPS_URL || '').replace(/\/+$/, '');
  const token = String(args.token || process.env.OPS_TOKEN || fromFile.OPS_TOKEN || '');
  if (!url || !token || url.includes('your-domain')) {
    fail(`No connection set. Run "node scripts/ops.mjs init --url https://your-site" (writes ${file}),\nor set OPS_URL and OPS_TOKEN.`);
  }
  return { url, token };
}

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

async function call(conn, path, { method = 'GET', body } = {}) {
  let res;
  try {
    res = await fetch(`${conn.url}/api/v1/ops${path}`, {
      method,
      headers: {
        authorization: `Bearer ${conn.token}`,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(90_000),
    });
  } catch (err) {
    fail(`Could not reach ${conn.url}: ${err.cause?.message ?? err.message}`);
  }
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text.slice(0, 500) };
  }
  if (res.status === 401) fail('The server rejected the token — OPS_TOKEN here must equal OPS_TOKEN on the server.');
  // the route itself missing (not "no such dialer") means diagnostics are off
  if (res.status === 404 && /^Route \S+ not found/.test(data.message ?? '')) {
    fail('Diagnostics are off on the server: OPS_TOKEN is not set there (32+ characters), or this version is not deployed yet.');
  }
  if (!res.ok) fail(`HTTP ${res.status}: ${data.message ?? data.error ?? text.slice(0, 300)}`);
  return data;
}

// ---------------------------------------------------------------------------
// formatting
// ---------------------------------------------------------------------------

function ago(sec) {
  if (sec == null) return 'never';
  if (sec < 90) return `${sec}s`;
  if (sec < 5400) return `${Math.round(sec / 60)}m`;
  if (sec < 172800) return `${Math.round(sec / 3600)}h`;
  return `${Math.round(sec / 86400)}d`;
}
const since = (iso) => (iso ? ago(Math.round((Date.now() - Date.parse(iso)) / 1000)) : 'never');
const short = (iso) => (iso ? String(iso).replace('T', ' ').replace(/\.\d+Z$/, 'Z') : '—');
const clip = (s, n) => {
  const t = String(s ?? '');
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

function table(rows, columns) {
  if (rows.length === 0) return '  (none)';
  // a terminal gets lines that fit; piped output keeps every character
  const width = process.stdout.isTTY && process.stdout.columns ? Math.max(100, process.stdout.columns) : Infinity;
  const cells = rows.map((r) => columns.map((c) => String(c.get(r) ?? '')));
  const w = columns.map((c, i) => Math.min(c.max ?? 60, Math.max(c.title.length, ...cells.map((r) => r[i].length))));
  const line = (vals) =>
    clip(
      '  ' +
        vals
          .map((v, i) => (columns[i].right ? clip(v, w[i]).padStart(w[i]) : clip(v, w[i]).padEnd(w[i])))
          .join('  ')
          .trimEnd(),
      width,
    );
  return [line(columns.map((c) => c.title)), line(w.map((n) => '-'.repeat(n))), ...cells.map(line)].join('\n');
}

function heading(s) {
  console.log(`\n${s}\n${'='.repeat(s.length)}`);
}

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------

function init(args) {
  const file = args.config ? String(args.config) : join(ROOT, '.ops.local');
  const existing = readConfigFile(file);
  if (existing.OPS_TOKEN && !args.force) {
    fail(`${file} already has a token. Use --force to replace it (the server's OPS_TOKEN must then be changed too).`);
  }
  const token = randomBytes(36).toString('base64url');
  const url = String(args.url || existing.OPS_URL || 'https://your-domain');
  writeFileSync(
    file,
    `# Remote diagnostics (scripts/ops.mjs). Private: git ignores *.local.\n` +
      `# Put the same OPS_TOKEN value in the server's environment (Coolify → Environment Variables).\n` +
      `OPS_URL=${url}\n` +
      `OPS_TOKEN=${token}\n`,
  );
  console.log(`Wrote ${file} (URL ${url}).`);
  console.log('Next: copy the OPS_TOKEN line from that file into the server environment, redeploy, then run');
  console.log('  node scripts/ops.mjs status');
}

async function status(conn, args) {
  const o = await call(conn, '/overview');
  if (args.json) return console.log(JSON.stringify(o, null, 2));
  const a = o.api;
  const w = o.worker;
  console.log(`${conn.url}  ·  ${short(o.now)}`);
  console.log(`build   ${o.build.commit ? `commit ${o.build.commit.slice(0, 12)}` : 'commit unknown'} · built ${short(o.build.builtAt)}`);
  console.log(
    `api     up ${ago(a.uptimeSec)} · rss ${a.rssMb} MB · loop p99 ${a.eventLoopDelay.p99Ms} ms · SQL ${a.diagnosticsSql.available ? 'on' : `off (${a.diagnosticsSql.reason})`}`,
  );
  console.log(
    w
      ? `worker  beat ${ago(w.heartbeatAgeSec)} ago · up ${ago(w.uptimeSec)} · rss ${w.rssMb} MB · loop p99 ${w.eventLoopDelay?.p99Ms ?? '?'} ms · busy: ${
          Object.entries(w.busy ?? {})
            .map(([d, m]) => `${d} (${m})`)
            .join(', ') || 'idle'
        }`
      : 'worker  NO HEARTBEAT',
  );
  const d = o.database;
  console.log(d.ok ? `db      ok ${d.pingMs} ms · ${d.connections}/${d.max_connections} connections · ${d.size}` : `db      DOWN: ${d.error}`);
  const r = o.redis;
  console.log(r.ok ? `redis   ok ${r.pingMs} ms · ${r.usedMemory}` : `redis   DOWN: ${r.error}`);
  if (o.queues) {
    const q = (c) => `waiting ${c.waiting} active ${c.active} delayed ${c.delayed} failed ${c.failed}`;
    console.log(`queues  sync: ${q(o.queues.sync)} · maintenance: ${q(o.queues.maintenance)}`);
  }
  const t = o.requests;
  console.log(
    `traffic ${t.requests} requests in 15 min (${t.perMinute}/min) · avg ${t.avgMs} ms · max ${t.maxMs} ms · slow ${t.slow} · 5xx ${t.serverErrors} · 429 ${t.rateLimited}`,
  );
  console.log(`errors  ${o.errors.lastHour} in the last hour · ${o.errors.last24h} in 24 h`);

  heading('Problems');
  if (o.problems.length === 0) console.log('  none found');
  for (const p of o.problems) console.log(`  ${p.severity === 'critical' ? '!!' : '! '} ${p.message}`);

  heading('Dialers');
  console.log(
    table(o.dialers, [
      { title: 'dialer', get: (x) => `${x.name}${x.active ? '' : ' (off)'}`, max: 28 },
      { title: 'company', get: (x) => x.company, max: 22 },
      { title: 'mode', get: (x) => x.mode },
      { title: 'last ok', get: (x) => ago(x.lastSeenAgoSec), right: true },
      { title: '7d', get: (x) => (x.backfilled ? 'yes' : 'NO') },
      { title: 'now', get: (x) => x.running ?? '—', max: 40 },
      { title: 'last run', get: (x) => x.lastJob ?? '—', max: 30 },
      { title: 'calls 24h', get: (x) => x.last24h.calls, right: true },
      { title: 'xfer', get: (x) => x.last24h.transfers, right: true },
      { title: 'closed', get: (x) => x.last24h.closed, right: true },
      { title: 'recs/not ready', get: (x) => `${x.last24h.recordings}/${x.last24h.recordingsNotReady}`, right: true },
    ]),
  );

  if (o.errors.top24h.length) {
    heading('Most frequent errors (24 h)');
    for (const e of o.errors.top24h) console.log(`  ${String(e.count).padStart(5)}×  ${e.src.padEnd(6)} last ${since(e.last)} ago  ${clip(e.msg, 160)}`);
  }
  if (o.boots.length) {
    heading('Recent starts');
    for (const b of o.boots) console.log(`  ${short(b.t)}  ${String(b.src).padEnd(6)} ${b.commit ? `commit ${String(b.commit).slice(0, 12)}` : ''} ${b.builtAt ? `built ${short(b.builtAt)}` : ''}`);
  }
}

async function errors(conn, args) {
  const q = new URLSearchParams({ kind: 'errors', since: String(args.since ?? '24h'), limit: String(args.limit ?? (args.list ? 100 : 30)) });
  if (args.src) q.set('src', String(args.src));
  if (args.grep) q.set('grep', String(args.grep));
  if (!args.list) q.set('group', '1');
  const r = await call(conn, `/logs?${q}`);
  if (args.json) return console.log(JSON.stringify(r, null, 2));
  console.log(`${r.total} warning/error line(s) since ${args.since ?? '24h'} ago`);
  if (args.list) return printEntries(r.entries);
  for (const g of r.groups) {
    console.log(`\n${String(g.count).padStart(5)}×  ${g.lvl.toUpperCase()}  ${g.src}  first ${since(g.first)} ago · last ${since(g.last)} ago`);
    console.log(`       ${clip(g.sample.msg, 400)}`);
    const ctx = g.sample.ctx;
    if (ctx) {
      const stack = ctx.err?.stack;
      const rest = { ...ctx };
      delete rest.err;
      if (Object.keys(rest).length) console.log(`       ${clip(JSON.stringify(rest), 400)}`);
      if (stack) console.log(stack.split('\n').slice(0, 6).map((l) => `       ${l.trim()}`).join('\n'));
      else if (ctx.err) console.log(`       ${clip(JSON.stringify(ctx.err), 400)}`);
    }
  }
}

function printEntries(entries) {
  for (const e of [...entries].reverse()) {
    const ctx = e.ctx ? `  ${clip(JSON.stringify(e.ctx), 300)}` : '';
    console.log(`${short(e.t)}  ${e.src.padEnd(6)} ${e.lvl.padEnd(5)} ${e.msg}${ctx}`);
  }
}

async function logs(conn, args) {
  const q = new URLSearchParams({ kind: args.errors ? 'errors' : 'all', limit: String(args.limit ?? 150) });
  if (args.since) q.set('since', String(args.since));
  if (args.src) q.set('src', String(args.src));
  if (args.grep) q.set('grep', String(args.grep));
  const r = await call(conn, `/logs?${q}`);
  if (args.json) return console.log(JSON.stringify(r, null, 2));
  console.log(`${r.entries.length} of ${r.total} line(s), oldest first`);
  printEntries(r.entries);
}

async function requests(conn, args) {
  const r = await call(conn, `/requests?minutes=${encodeURIComponent(args.minutes ?? 15)}`);
  if (args.json) return console.log(JSON.stringify(r, null, 2));
  const t = r.totals;
  console.log(`API process up since ${short(r.since)} · last ${r.windowMinutes} min:`);
  console.log(`  ${t.requests} requests (${t.perMinute}/min) · avg ${t.avgMs} ms · max ${t.maxMs} ms · slow ${t.slow} · 4xx ${t.clientErrors} · 429 ${t.rateLimited} · 5xx ${t.serverErrors}`);
  heading('Per minute');
  console.log(
    table(r.perMinute, [
      { title: 'minute', get: (x) => short(x.minute).slice(11, 16) },
      { title: 'requests', get: (x) => x.requests, right: true },
      { title: 'avg ms', get: (x) => x.avgMs, right: true },
      { title: 'max ms', get: (x) => x.maxMs, right: true },
      { title: '5xx', get: (x) => x.serverErrors, right: true },
      { title: '429', get: (x) => x.rateLimited, right: true },
    ]),
  );
  heading('Routes since start (by total time)');
  console.log(
    table(r.routes, [
      { title: 'route', get: (x) => x.route, max: 60 },
      { title: 'count', get: (x) => x.count, right: true },
      { title: 'avg', get: (x) => x.avgMs, right: true },
      { title: 'p50', get: (x) => x.p50Ms, right: true },
      { title: 'p95', get: (x) => x.p95Ms, right: true },
      { title: 'max', get: (x) => x.maxMs, right: true },
      { title: '4xx', get: (x) => x.clientErrors, right: true },
      { title: '5xx', get: (x) => x.serverErrors, right: true },
    ]),
  );
  heading('Slow requests (≥ 1 s), newest first');
  console.log(
    table(r.slow, [
      { title: 'when', get: (x) => short(x.t) },
      { title: 'ms', get: (x) => x.ms, right: true },
      { title: 'status', get: (x) => x.status },
      { title: 'request', get: (x) => `${x.method} ${x.path}`, max: 90 },
    ]),
  );
}

async function dialers(conn, args) {
  const r = await call(conn, '/dialers');
  if (args.json) return console.log(JSON.stringify(r, null, 2));
  for (const d of r.dialers) {
    heading(`${d.name} — ${d.company}${d.active ? '' : ' (inactive)'}${d.deleting ? ' (being deleted)' : ''}`);
    console.log(`  id ${d.id} · mode ${d.sourceMode} · api ${d.apiHost ?? '—'} · db ${d.dbHost ?? '—'} · tz ${d.timezone} (offset ${d.tzOffsetMin ?? '?'} min, drift ${d.clockDriftSec ?? '?'}s)`);
    console.log(`  last successful sync ${ago(d.lastSeenAgoSec)} ago · 7-day import ${d.backfilledAt ? `done ${short(d.backfilledAt)}` : 'NOT DONE'} · added ${short(d.createdAt)}`);
    if (d.running) {
      console.log(`  running: ${d.running.type} ${d.running.percent ?? 0}% · ${d.running.label ?? ''}${d.running.detail ? ` · ${d.running.detail}` : ''} · started ${since(d.running.startedAt)} ago · heartbeat ${ago(d.running.heartbeatAgeSec)} ago`);
    }
    if (d.lastJob) {
      console.log(`  last run: ${d.lastJob.status} ${d.lastJob.type} ${since(d.lastJob.createdAt)} ago, took ${d.lastJob.tookSec ?? '?'}s`);
      if (d.lastJob.error) console.log(`  error: ${d.lastJob.error}`);
      const stages = Object.entries(d.lastJob.stageSeconds ?? {})
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([k, s]) => `${k} ${Number(s).toFixed(1)}s`);
      if (stages.length) console.log(`  slowest stages: ${stages.join(' · ')}`);
    }
    const c = d.last24h;
    console.log(`  24 h: syncs ok ${c.syncsOk} / failed ${c.syncsFailed} · calls ${c.calls} · transfers ${c.transfers} · closed ${c.closed} · recordings ${c.recordings} (${c.recordingsNotReady} not ready)`);
    for (const cur of d.cursors) console.log(`  cursor ${cur.stream.padEnd(24)} ${short(cur.lastTimestamp)}  (moved ${since(cur.updatedAt)} ago)`);
  }
}

async function sync(conn, args) {
  const q = new URLSearchParams({ limit: String(args.limit ?? 30) });
  if (args.dialer) q.set('dialer', String(args.dialer));
  if (args.status) q.set('status', String(args.status));
  const r = await call(conn, `/sync?${q}`);
  if (args.json) return console.log(JSON.stringify(r, null, 2));
  console.log(
    table(r.jobs, [
      { title: 'queued', get: (x) => short(x.createdAt) },
      { title: 'dialer', get: (x) => x.dialer, max: 24 },
      { title: 'type', get: (x) => x.type },
      { title: 'status', get: (x) => x.status },
      { title: 'took', get: (x) => (x.tookSec != null ? `${x.tookSec}s` : '—'), right: true },
      {
        title: 'result',
        get: (x) =>
          x.status === 'running' && x.progress
            ? `${Math.round(x.progress.percent ?? 0)}% · ${x.progress.label ?? ''} ${x.progress.detail ?? ''}`
            : (x.error ??
              Object.entries(x.stats?.stageSeconds ?? {})
                .sort((a, b) => b[1] - a[1])
                .slice(0, 3)
                .map(([k, s]) => `${k} ${Number(s).toFixed(1)}s`)
                .join(' · ')),
        max: 120,
      },
    ]),
  );
}

async function companies(conn, args) {
  const r = await call(conn, '/companies');
  if (args.json) return console.log(JSON.stringify(r, null, 2));
  console.log(
    table(r.companies, [
      { title: 'company', get: (x) => x.name, max: 30 },
      { title: 'status', get: (x) => x.status },
      { title: 'users', get: (x) => x.users, right: true },
      { title: 'shared', get: (x) => x.shared_users, right: true },
      { title: 'dialers', get: (x) => x.dialers, right: true },
      { title: 'mappings', get: (x) => x.disposition_mappings, right: true },
      { title: 'xfer 7d', get: (x) => x.transfers_7d, right: true },
      { title: 'closed 7d', get: (x) => x.closed_7d, right: true },
      { title: 'evals 7d', get: (x) => x.evaluations_7d, right: true },
      { title: 'open tasks', get: (x) => x.open_tasks, right: true },
      { title: 'last login', get: (x) => (x.last_login_at ? `${since(x.last_login_at)} ago` : 'never') },
    ]),
  );
}

async function queues(conn, args) {
  const r = await call(conn, '/queues');
  if (args.json) return console.log(JSON.stringify(r, null, 2));
  for (const q of [r.sync, r.maintenance]) {
    heading(`Queue ${q.name}`);
    console.log(`  ${Object.entries(q.counts).map(([k, v]) => `${k} ${v}`).join(' · ')}`);
    for (const s of q.schedulers) console.log(`  schedule ${s.name}: every ${s.every ? `${s.every / 1000}s` : s.pattern} · next ${short(s.next)}`);
    for (const [label, list] of [['active', q.active], ['waiting', q.waiting], ['delayed', q.delayed], ['failed', q.failed]]) {
      for (const j of list) {
        console.log(`  ${label.padEnd(8)} ${j.name}${j.dialer ? ` (${j.dialer})` : ''} · queued ${since(j.queuedAt)} ago${j.startedAt ? ` · started ${since(j.startedAt)} ago` : ''} · attempts ${j.attemptsMade}${j.failedReason ? ` · ${j.failedReason}` : ''}`);
      }
    }
  }
}

async function db(conn, args) {
  const r = await call(conn, '/db');
  if (args.json) return console.log(JSON.stringify(r, null, 2));
  const d = r.database;
  if (d.error) console.log(`database: ${d.error}`);
  else console.log(`database ${d.size} · cache hit ${d.cache_hit_pct}% · waiting locks ${d.waiting_locks} · deadlocks ${d.deadlocks} · max connections ${d.max_connections} · shared_buffers ${d.shared_buffers} · work_mem ${d.work_mem}\n${d.version}`);
  const show = (title, rows, cols) => {
    heading(title);
    if (rows?.error) console.log(`  ${rows.error}`);
    else console.log(table(rows ?? [], cols));
  };
  show('Connections', r.connections, [
    { title: 'user', get: (x) => x.user },
    { title: 'app', get: (x) => x.app, max: 30 },
    { title: 'state', get: (x) => x.state },
    { title: 'n', get: (x) => x.n, right: true },
    { title: 'oldest', get: (x) => (x.oldest_sec != null ? ago(x.oldest_sec) : '—'), right: true },
  ]);
  show('Running now (> 1 s)', r.running, [
    { title: 'pid', get: (x) => x.pid },
    { title: 'sec', get: (x) => x.seconds, right: true },
    { title: 'state', get: (x) => x.state },
    { title: 'wait', get: (x) => [x.wait_event_type, x.wait_event].filter(Boolean).join(':') },
    { title: 'query', get: (x) => x.query, max: 120 },
  ]);
  show('Heaviest queries (total time)', r.topByTotalTime, [
    { title: 'calls', get: (x) => x.calls, right: true },
    { title: 'total ms', get: (x) => x.total_ms, right: true },
    { title: 'mean', get: (x) => x.mean_ms, right: true },
    { title: 'max', get: (x) => x.max_ms, right: true },
    { title: 'query', get: (x) => x.query, max: 120 },
  ]);
  show('Slowest queries (mean, 5+ calls)', r.topByMeanTime, [
    { title: 'calls', get: (x) => x.calls, right: true },
    { title: 'mean', get: (x) => x.mean_ms, right: true },
    { title: 'max', get: (x) => x.max_ms, right: true },
    { title: 'query', get: (x) => x.query, max: 130 },
  ]);
  show('Largest tables', r.tables, [
    { title: 'table', get: (x) => x.table },
    { title: 'rows', get: (x) => x.live_rows, right: true },
    { title: 'dead', get: (x) => x.dead_rows, right: true },
    { title: 'size', get: (x) => x.size, right: true },
    { title: 'seq scans', get: (x) => x.seq_scan, right: true },
    { title: 'idx scans', get: (x) => x.idx_scan, right: true },
    { title: 'autovacuum', get: (x) => (x.last_autovacuum ? `${since(x.last_autovacuum)} ago` : 'never') },
  ]);
}

async function sql(conn, args) {
  const text = args._.slice(1).join(' ');
  if (!text) fail('Usage: node scripts/ops.mjs sql "select …"');
  const r = await call(conn, '/sql', { method: 'POST', body: { sql: text, maxRows: Number(args.max ?? 200) } });
  if (args.json) return console.log(JSON.stringify(r, null, 2));
  const fmt = (v) => (v === null ? 'null' : typeof v === 'object' ? JSON.stringify(v) : String(v));
  console.log(
    table(
      r.rows,
      r.columns.map((c, i) => ({ title: c, get: (row) => fmt(row[i]), max: 80 })),
    ),
  );
  console.log(`\n${r.rowCount} row(s)${r.truncated ? ' (more not shown — raise --max)' : ''} · ${r.ms} ms`);
}

async function probe(conn, args) {
  const name = args._.slice(1).join(' ');
  if (!name) fail('Usage: node scripts/ops.mjs probe <dialer name or id>');
  const r = await call(conn, `/dialers/${encodeURIComponent(name)}/probe`, { method: 'POST' });
  if (args.json) return console.log(JSON.stringify(r, null, 2));
  console.log(`${r.dialer} (${r.company}) — ${r.ms} ms`);
  console.log(`  API:      ${r.api.ok ? 'OK' : 'FAILED'} — ${r.api.detail}`);
  console.log(`  database: ${r.db.ok ? 'OK' : 'FAILED'} — ${r.db.detail}`);
  if (r.time) {
    const t = r.time;
    console.log(`  clock:    dialer ${t.dialerLocalTime ?? '?'} · offset ${t.measuredOffsetMin ?? '?'} min (configured ${t.configuredOffsetMin}) · drift ${t.driftSec ?? '?'}s · time zone ${t.timezoneMatches ? 'matches' : 'DOES NOT MATCH'}`);
  }
}

async function raw(conn, args) {
  const path = args._[1];
  if (!path) fail('Usage: node scripts/ops.mjs raw /overview');
  console.log(JSON.stringify(await call(conn, path.startsWith('/') ? path : `/${path}`), null, 2));
}

// ---------------------------------------------------------------------------

const args = parseArgs(process.argv.slice(2));
const cmd = args._[0] ?? 'status';
const commands = { status, errors, logs, requests, dialers, sync, companies, queues, db, sql, probe, raw };

if (cmd === 'help' || args.help) console.log(HELP);
else if (cmd === 'init') init(args);
else if (!commands[cmd]) fail(`Unknown command "${cmd}".\n\n${HELP}`);
else await commands[cmd](connection(args), args);
