import { format } from 'node:util';
import { Redis } from 'ioredis';
import { config } from '../config.js';

/**
 * Diagnostics log shared by the API and the worker, kept in Redis so it
 * survives restarts and can be read remotely (routes/ops.ts). Two capped
 * lists: every warning and error from both processes, and everything the
 * worker reports (its info lines say what each sync and repair run did).
 * Writes are batched once a second and never block or throw — while Redis
 * is down, entries wait in a small buffer and the oldest are dropped.
 */

export type OpsSource = 'api' | 'worker';
export type OpsLevel = 'info' | 'warn' | 'error' | 'fatal';

export interface OpsEntry {
  t: string;
  src: OpsSource;
  lvl: OpsLevel;
  msg: string;
  ctx?: Record<string, unknown>;
}

export const OPS_ERRORS_KEY = 'ops:log:errors';
export const OPS_ALL_KEY = 'ops:log:all';
export const OPS_BOOTS_KEY = 'ops:boots';
export const opsHeartbeatKey = (src: OpsSource) => `ops:hb:${src}`;

const ERRORS_CAP = 2000;
const ALL_CAP = 5000;
const BOOTS_CAP = 100;
const BUFFER_CAP = 1000;
const MAX_MSG = 2000;
const MAX_CTX = 4000;

// Values that must never leave the server, wherever they turn up in a log
// line: dialer API passwords travel in query strings, recording URLs can
// carry basic-auth credentials, and headers carry tokens.
const SECRET_PATTERNS: [RegExp, string][] = [
  [/([?&](?:pass|password|pwd|passwd|token|api_key|apikey|secret|key)=)[^&\s"'#]*/gi, '$1***'],
  [/(\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@"']+:)[^@\s/"']+@/gi, '$1***@'],
  [/(Bearer\s+)[A-Za-z0-9._~+/=-]+/g, '$1***'],
  [/(\b(?:password|passwd|secret|token)\b["']?\s*[:=]\s*["']?)(?!YES\b|NO\b)[^"',\s})]+/gi, '$1***'],
];

export function redactSecrets(text: string): string {
  let out = text;
  for (const [re, to] of SECRET_PATTERNS) out = out.replace(re, to);
  return out;
}

function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}… (+${s.length - n} chars)` : s;
}

function errorJson(err: Error): Record<string, unknown> {
  const e = err as Error & { code?: unknown };
  return {
    type: e.name,
    message: e.message,
    ...(e.code != null ? { code: e.code } : {}),
    stack: e.stack?.split('\n').slice(0, 8).join('\n'),
  };
}

/** Context made safe to store: secrets masked, errors flattened, size capped. */
export function safeContext(ctx: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!ctx || Object.keys(ctx).length === 0) return undefined;
  let text: string;
  try {
    text = JSON.stringify(ctx, (_k, v: unknown) => (v instanceof Error ? errorJson(v) : v));
  } catch {
    return { unserializable: true };
  }
  text = redactSecrets(text);
  if (text.length > MAX_CTX) return { truncated: clip(text, MAX_CTX) };
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { text };
  }
}

let source: OpsSource = 'api';
let redis: Redis | null = null;
const pending: OpsEntry[] = [];
let timer: NodeJS.Timeout | null = null;
let flushing: Promise<void> | null = null;

/** The Redis connection the diagnostics log uses (also read by routes/ops.ts). */
export function opsRedis(): Redis {
  if (!redis) {
    redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: 1 });
    redis.on('error', () => {
      /* diagnostics never take a process down */
    });
  }
  return redis;
}

export function setOpsSource(src: OpsSource): void {
  source = src;
}

export function opsLog(lvl: OpsLevel, msg: string, ctx?: Record<string, unknown>): void {
  pending.push({ t: new Date().toISOString(), src: source, lvl, msg: clip(redactSecrets(msg), MAX_MSG), ctx: safeContext(ctx) });
  if (pending.length > BUFFER_CAP) pending.splice(0, pending.length - BUFFER_CAP);
  if (!timer) {
    timer = setTimeout(() => {
      timer = null;
      void flushOpsLog();
    }, 1000);
    timer.unref();
  }
}

async function writePending(): Promise<void> {
  const batch = pending.splice(0, pending.length);
  if (batch.length === 0) return;
  try {
    const m = opsRedis().multi();
    for (const e of batch) {
      const json = JSON.stringify(e);
      if (e.lvl !== 'info') m.lpush(OPS_ERRORS_KEY, json);
      m.lpush(OPS_ALL_KEY, json);
    }
    m.ltrim(OPS_ERRORS_KEY, 0, ERRORS_CAP - 1).ltrim(OPS_ALL_KEY, 0, ALL_CAP - 1);
    await m.exec();
  } catch {
    // keep them for the next try; when the buffer is full the oldest go
    pending.unshift(...batch);
    if (pending.length > BUFFER_CAP) pending.splice(0, pending.length - BUFFER_CAP);
  }
}

/** Writes what is buffered; waits at most `timeoutMs` (used before exiting). */
export async function flushOpsLog(timeoutMs = 3000): Promise<void> {
  if (!flushing) flushing = writePending().finally(() => (flushing = null));
  await Promise.race([flushing, new Promise((r) => setTimeout(r, timeoutMs).unref())]);
}

/** A process start, kept apart so restarts and crash loops stand out. */
export function recordBoot(src: OpsSource, info: Record<string, unknown>): void {
  const entry = JSON.stringify({ t: new Date().toISOString(), src, ...info });
  opsRedis()
    .multi()
    .lpush(OPS_BOOTS_KEY, entry)
    .ltrim(OPS_BOOTS_KEY, 0, BOOTS_CAP - 1)
    .exec()
    .catch(() => undefined);
  opsLog('info', `${src} started`, info);
}

/** Process health published every 15 s; stale after 90 s means the process is gone. */
export function startHeartbeat(src: OpsSource, describe: () => Record<string, unknown>): NodeJS.Timeout {
  const beat = () => {
    let body: string;
    try {
      body = JSON.stringify({ at: new Date().toISOString(), ...describe() });
    } catch {
      return;
    }
    opsRedis()
      .set(opsHeartbeatKey(src), body, 'EX', 90)
      .catch(() => undefined);
  };
  beat();
  const t = setInterval(beat, 15_000);
  t.unref();
  return t;
}

/**
 * Mirrors console output into the log: warnings and errors always, plain
 * lines only when `info` (the worker's lines describe its runs; the API's
 * request log is far too chatty to keep).
 */
export function captureConsole(opts: { info: boolean }): void {
  const wrap = (name: 'log' | 'info' | 'warn' | 'error', lvl: OpsLevel) => {
    const original = console[name].bind(console);
    console[name] = (...args: unknown[]) => {
      original(...args);
      if (lvl === 'info' && !opts.info) return;
      try {
        const err = args.find((a): a is Error => a instanceof Error);
        opsLog(lvl, format(...args.map((a) => (a instanceof Error ? a.message : a))), err ? { err } : undefined);
      } catch {
        /* never break logging */
      }
    };
  };
  wrap('log', 'info');
  wrap('info', 'info');
  wrap('warn', 'warn');
  wrap('error', 'error');
}

const PINO_LEVELS: Record<number, OpsLevel> = { 40: 'warn', 50: 'error', 60: 'fatal' };

/** A pino log line (JSON) turned into a log entry when it is a warning or worse. */
export function pinoLineToEntry(line: string): { lvl: OpsLevel; msg: string; ctx?: Record<string, unknown> } | null {
  if (!/"level":(?:4|5|6)0[,}]/.test(line)) return null;
  try {
    const obj = JSON.parse(line) as Record<string, unknown>;
    const lvl = PINO_LEVELS[obj.level as number];
    if (!lvl) return null;
    const { level: _l, time: _t, pid: _p, hostname: _h, msg, ...rest } = obj;
    return { lvl, msg: typeof msg === 'string' ? msg : lvl, ctx: rest };
  } catch {
    return null;
  }
}

/** Fastify/pino destination: stdout as before, plus warnings and errors into the log. */
export function opsLogStream(): { write(line: string): void } {
  return {
    write(line: string) {
      process.stdout.write(line);
      const e = pinoLineToEntry(line);
      if (e) opsLog(e.lvl, e.msg, e.ctx);
    },
  };
}

/** Reads one of the lists, newest first. */
export async function readOpsLog(key: string, max: number): Promise<OpsEntry[]> {
  const raw = await opsRedis().lrange(key, 0, Math.max(0, max - 1));
  const out: OpsEntry[] = [];
  for (const r of raw) {
    try {
      out.push(JSON.parse(r) as OpsEntry);
    } catch {
      /* skip a damaged entry */
    }
  }
  return out;
}

/** Last process starts, newest first. */
export async function readBoots(max = 20): Promise<Record<string, unknown>[]> {
  const raw = await opsRedis().lrange(OPS_BOOTS_KEY, 0, max - 1);
  return raw.flatMap((r) => {
    try {
      return [JSON.parse(r) as Record<string, unknown>];
    } catch {
      return [];
    }
  });
}

/** Same message with different ids/numbers counts as one problem. */
export function errorFingerprint(msg: string): string {
  return msg
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<id>')
    .replace(/\d+/g, '#')
    .slice(0, 200);
}

/**
 * Process-level crash capture: the reason lands in the log before the
 * process exits (the container restarts it, as before).
 */
export function captureCrashes(): void {
  const die = (kind: string) => (err: unknown) => {
    opsLog('fatal', `${kind}: ${err instanceof Error ? err.message : String(err)}`, {
      err: err instanceof Error ? err : String(err),
    });
    process.stderr.write(`${kind}: ${err instanceof Error ? err.stack : String(err)}\n`);
    void flushOpsLog(2000).finally(() => process.exit(1));
  };
  process.on('uncaughtException', die('uncaught exception'));
  process.on('unhandledRejection', die('unhandled promise rejection'));
}
