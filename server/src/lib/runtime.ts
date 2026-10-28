import { readFileSync } from 'node:fs';
import { monitorEventLoopDelay } from 'node:perf_hooks';

/**
 * What is running and how it is doing, for remote diagnostics: the build
 * (written into the image by the Dockerfile), memory, and event-loop delay —
 * a busy loop is the first thing users feel as a slow site.
 */

export interface BuildInfo {
  commit: string | null;
  builtAt: string | null;
}

let build: BuildInfo | null = null;

export function buildInfo(): BuildInfo {
  if (!build) {
    try {
      const raw = JSON.parse(readFileSync(new URL('../build-info.json', import.meta.url), 'utf8')) as Partial<BuildInfo>;
      build = { commit: raw.commit || null, builtAt: raw.builtAt || null };
    } catch {
      build = { commit: process.env.SOURCE_COMMIT || null, builtAt: null };
    }
  }
  return build;
}

const startedAt = new Date();
const loop = monitorEventLoopDelay({ resolution: 20 });
loop.enable();
let lastLoop = { p50Ms: 0, p99Ms: 0, maxMs: 0 };
const ms = (ns: number) => Math.round((ns / 1e6) * 10) / 10;
// event-loop delay over the last full minute
setInterval(() => {
  lastLoop = { p50Ms: ms(loop.percentile(50)), p99Ms: ms(loop.percentile(99)), maxMs: ms(loop.max) };
  loop.reset();
}, 60_000).unref();

export function processStats(): Record<string, unknown> {
  const m = process.memoryUsage();
  const mb = (b: number) => Math.round(b / 1048576);
  return {
    pid: process.pid,
    node: process.version,
    startedAt: startedAt.toISOString(),
    uptimeSec: Math.round(process.uptime()),
    rssMb: mb(m.rss),
    heapUsedMb: mb(m.heapUsed),
    heapTotalMb: mb(m.heapTotal),
    eventLoopDelay: lastLoop,
  };
}
