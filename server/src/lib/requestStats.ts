/**
 * In-memory request timing for remote diagnostics: per-minute totals for
 * the last hour, per-route counts and percentiles since start, and the
 * latest slow requests. Recorded by an onResponse hook in app.ts.
 */

export const SLOW_MS = 1000;
const MINUTES = 60;
const SAMPLES = 200;
const SLOW_KEPT = 50;

interface Bucket {
  minute: number;
  count: number;
  s4xx: number;
  s429: number;
  s5xx: number;
  slow: number;
  sumMs: number;
  maxMs: number;
  /** requests counted in sumMs/maxMs (all but audio streams) */
  timed: number;
}

interface RouteStat {
  count: number;
  s4xx: number;
  s5xx: number;
  sumMs: number;
  maxMs: number;
  samples: number[];
  next: number;
}

export interface SlowRequest {
  t: string;
  method: string;
  route: string;
  path: string;
  status: number;
  ms: number;
}

const buckets: Bucket[] = [];
const routes = new Map<string, RouteStat>();
const slow: SlowRequest[] = [];
const since = new Date().toISOString();

/**
 * Audio streams last as long as the audio takes to send — a second or more
 * is normal, not a slow page — so they stay out of the latency totals and
 * the slow list (their own route row still shows their timings).
 */
export function isStreamingRoute(route: string): boolean {
  return /\/stream$/.test(route);
}

export function recordRequest(r: { method: string; route: string; path: string; status: number; ms: number; at?: number }): void {
  const at = r.at ?? Date.now();
  const minute = Math.floor(at / 60_000);
  const streaming = isStreamingRoute(r.route);
  let b = buckets[buckets.length - 1];
  if (!b || b.minute !== minute) {
    b = { minute, count: 0, s4xx: 0, s429: 0, s5xx: 0, slow: 0, sumMs: 0, maxMs: 0, timed: 0 };
    buckets.push(b);
    while (buckets.length > 0 && buckets[0].minute <= minute - MINUTES) buckets.shift();
  }
  b.count += 1;
  if (r.status >= 500) b.s5xx += 1;
  else if (r.status >= 400) b.s4xx += 1;
  if (r.status === 429) b.s429 += 1;
  if (!streaming) {
    if (r.ms >= SLOW_MS) b.slow += 1;
    b.timed += 1;
    b.sumMs += r.ms;
    b.maxMs = Math.max(b.maxMs, r.ms);
  }

  const key = `${r.method} ${r.route}`;
  let s = routes.get(key);
  if (!s) {
    s = { count: 0, s4xx: 0, s5xx: 0, sumMs: 0, maxMs: 0, samples: [], next: 0 };
    routes.set(key, s);
  }
  s.count += 1;
  if (r.status >= 500) s.s5xx += 1;
  else if (r.status >= 400) s.s4xx += 1;
  s.sumMs += r.ms;
  s.maxMs = Math.max(s.maxMs, r.ms);
  if (s.samples.length < SAMPLES) s.samples.push(r.ms);
  else s.samples[s.next] = r.ms;
  s.next = (s.next + 1) % SAMPLES;

  if (r.ms >= SLOW_MS && !streaming) {
    slow.push({ t: new Date(at).toISOString(), method: r.method, route: r.route, path: r.path, status: r.status, ms: Math.round(r.ms) });
    if (slow.length > SLOW_KEPT) slow.shift();
  }
}

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Math.round(sorted[i] * 10) / 10;
}

const round = (n: number) => Math.round(n * 10) / 10;

export function requestSnapshot(minutes = 15, now = Date.now()) {
  const from = Math.floor(now / 60_000) - minutes + 1;
  const inWindow = buckets.filter((b) => b.minute >= from);
  const totals = inWindow.reduce(
    (a, b) => ({
      count: a.count + b.count,
      s4xx: a.s4xx + b.s4xx,
      s429: a.s429 + b.s429,
      s5xx: a.s5xx + b.s5xx,
      slow: a.slow + b.slow,
      sumMs: a.sumMs + b.sumMs,
      maxMs: Math.max(a.maxMs, b.maxMs),
      timed: a.timed + b.timed,
    }),
    { count: 0, s4xx: 0, s429: 0, s5xx: 0, slow: 0, sumMs: 0, maxMs: 0, timed: 0 },
  );
  return {
    since,
    windowMinutes: minutes,
    totals: {
      requests: totals.count,
      perMinute: round(totals.count / minutes),
      // page/API timing — audio streams excluded (see isStreamingRoute)
      avgMs: totals.timed ? round(totals.sumMs / totals.timed) : 0,
      maxMs: round(totals.maxMs),
      slow: totals.slow,
      clientErrors: totals.s4xx,
      rateLimited: totals.s429,
      serverErrors: totals.s5xx,
    },
    perMinute: inWindow.map((b) => ({
      minute: new Date(b.minute * 60_000).toISOString(),
      requests: b.count,
      avgMs: b.timed ? round(b.sumMs / b.timed) : 0,
      maxMs: round(b.maxMs),
      serverErrors: b.s5xx,
      rateLimited: b.s429,
    })),
    routes: [...routes.entries()]
      .map(([route, s]) => ({
        route,
        count: s.count,
        avgMs: round(s.sumMs / s.count),
        p50Ms: percentile(s.samples, 50),
        p95Ms: percentile(s.samples, 95),
        maxMs: round(s.maxMs),
        clientErrors: s.s4xx,
        serverErrors: s.s5xx,
      }))
      .sort((a, b) => b.avgMs * b.count - a.avgMs * a.count)
      .slice(0, 40),
    slow: [...slow].reverse(),
  };
}
