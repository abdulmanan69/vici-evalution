import type { FastifyInstance, FastifyRequest } from 'fastify';
import { createHash, timingSafeEqual } from 'node:crypto';
import { BlockList, isIP } from 'node:net';
import { z } from 'zod';
import { config } from '../config.js';
import { pool } from '../db/client.js';
import { ValidationError } from '../lib/errors.js';
import { OPS_ALL_KEY, OPS_ERRORS_KEY, opsLog, readOpsLog, redactSecrets } from '../lib/opsLog.js';
import { requestSnapshot } from '../lib/requestStats.js';
import { runOpsSql } from '../services/opsReader.js';
import {
  companiesReport,
  dbReport,
  dialerReport,
  groupEntries,
  overview,
  queuesReport,
  syncJobsReport,
} from '../services/opsReport.js';
import { testDialerConnection } from '../vicidial/sync.js';

/**
 * Remote diagnostics: read-only endpoints for looking into a deployed
 * instance from outside (scripts/ops.mjs is the client). Off unless
 * OPS_TOKEN holds a secret of 32+ characters; every request must carry it
 * as `Authorization: Bearer <token>`, and OPS_ALLOWED_IPS can restrict the
 * addresses further. Nothing here changes data — the dialer probe only
 * reads, and SQL runs as a read-only login without access to secrets
 * (services/opsReader.ts).
 */

/** The diagnostics secret, or null when diagnostics are off. */
export function opsToken(): string | null {
  const t = config.OPS_TOKEN.trim();
  return t.length >= 32 ? t : null;
}

export function tokenMatches(given: string | undefined, expected: string): boolean {
  if (!given) return false;
  // equal-length digests: the comparison takes the same time for any input
  const a = createHash('sha256').update(given).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

/** Parses "1.2.3.4, 10.0.0.0/8, 2001:db8::1" — null when no restriction is set. */
export function allowList(csv: string): BlockList | null {
  const items = csv
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (items.length === 0) return null;
  const list = new BlockList();
  for (const item of items) {
    const [addr, bits] = item.split('/');
    const family = isIP(addr);
    if (!family) continue;
    const type = family === 6 ? 'ipv6' : 'ipv4';
    if (bits !== undefined) list.addSubnet(addr, Number(bits), type);
    else list.addAddress(addr, type);
  }
  return list;
}

export function ipAllowed(ip: string, list: BlockList | null): boolean {
  if (!list) return true;
  const plain = ip.startsWith('::ffff:') && isIP(ip.slice(7)) === 4 ? ip.slice(7) : ip;
  const family = isIP(plain);
  if (!family) return false;
  return list.check(plain, family === 6 ? 'ipv6' : 'ipv4');
}

/** "30m", "2h", "1d" or an ISO time → ISO time; undefined when absent. */
export function parseSince(value: string | undefined, now = Date.now()): string | undefined {
  if (!value) return undefined;
  const rel = /^(\d+)\s*([smhd])$/i.exec(value.trim());
  if (rel) {
    const unit = { s: 1, m: 60, h: 3600, d: 86400 }[rel[2].toLowerCase() as 's' | 'm' | 'h' | 'd'];
    return new Date(now - Number(rel[1]) * unit * 1000).toISOString();
  }
  const t = Date.parse(value);
  if (Number.isNaN(t)) throw new ValidationError(`Cannot read the time "${value}" — use 30m, 2h, 1d or an ISO time`);
  return new Date(t).toISOString();
}

const flag = z
  .enum(['1', '0', 'true', 'false', 'yes', 'no'])
  .optional()
  .transform((v) => v === '1' || v === 'true' || v === 'yes');

export async function opsRoutes(app: FastifyInstance): Promise<void> {
  const token = opsToken();
  if (!token) return; // not configured: the endpoints do not exist
  const allowed = allowList(config.OPS_ALLOWED_IPS);

  // its own budget, apart from the people using the site from the same office
  const limited = {
    config: {
      rateLimit: { max: 300, timeWindow: '1 minute', keyGenerator: (req: FastifyRequest) => `ops:${req.ip}` },
    },
  };

  // rejected callers are noted at most once a minute per address
  const noted = new Map<string, number>();
  // preHandler, so the rate limit (onRequest) has already counted the call
  app.addHook('preHandler', async (req, reply) => {
    const header = req.headers.authorization;
    const given = header?.startsWith('Bearer ') ? header.slice(7).trim() : undefined;
    if (ipAllowed(req.ip, allowed) && tokenMatches(given, token)) return;
    const last = noted.get(req.ip) ?? 0;
    if (Date.now() - last > 60_000) {
      if (noted.size > 1000) noted.clear();
      noted.set(req.ip, Date.now());
      opsLog('warn', 'diagnostics: rejected a request without a valid token', { ip: req.ip, path: req.url.split('?')[0] });
    }
    return reply.code(401).send({ error: 'unauthorized', message: 'Missing or wrong diagnostics token' });
  });

  app.get('/overview', limited, async () => overview());

  app.get('/logs', limited, async (req) => {
    const q = z
      .object({
        kind: z.enum(['errors', 'all']).default('errors'),
        src: z.enum(['api', 'worker']).optional(),
        limit: z.coerce.number().int().min(1).max(5000).default(100),
        since: z.string().optional(),
        grep: z.string().max(200).optional(),
        group: flag,
      })
      .parse(req.query);
    const since = parseSince(q.since);
    const needle = q.grep?.toLowerCase();
    const entries = (await readOpsLog(q.kind === 'errors' ? OPS_ERRORS_KEY : OPS_ALL_KEY, 5000)).filter(
      (e) =>
        (!q.src || e.src === q.src) &&
        (!since || e.t >= since) &&
        (!needle || e.msg.toLowerCase().includes(needle) || JSON.stringify(e.ctx ?? {}).toLowerCase().includes(needle)),
    );
    if (q.group) return { total: entries.length, groups: groupEntries(entries).slice(0, q.limit) };
    return { total: entries.length, entries: entries.slice(0, q.limit) };
  });

  app.get('/requests', limited, async (req) => {
    const q = z.object({ minutes: z.coerce.number().int().min(1).max(60).default(15) }).parse(req.query);
    return requestSnapshot(q.minutes);
  });

  app.get('/dialers', limited, async () => ({ dialers: await dialerReport() }));

  app.get('/sync', limited, async (req) => {
    const q = z
      .object({
        limit: z.coerce.number().int().min(1).max(500).default(30),
        dialer: z.string().max(200).optional(),
        status: z.enum(['queued', 'running', 'success', 'failed']).optional(),
      })
      .parse(req.query);
    return { jobs: await syncJobsReport(q) };
  });

  app.get('/companies', limited, async () => ({ companies: await companiesReport() }));

  app.get('/queues', limited, async () => queuesReport());

  app.get('/db', limited, async () => dbReport());

  app.post('/sql', limited, async (req, reply) => {
    const body = z
      .object({ sql: z.string().min(1).max(20_000), maxRows: z.number().int().min(1).max(2000).default(200) })
      .parse(req.body ?? {});
    opsLog('info', 'diagnostics: SQL query', { ip: req.ip, sql: body.sql.slice(0, 500) });
    try {
      return await runOpsSql(body.sql, body.maxRows);
    } catch (err) {
      const e = err as { message?: string; code?: string; position?: string };
      return reply.code(400).send({ error: 'sql_error', message: e.message ?? String(err), code: e.code, position: e.position });
    }
  });

  /** Connects to one dialer (API + database) and reports what answered — reads only. */
  app.post('/dialers/:dialer/probe', limited, async (req, reply) => {
    const { dialer } = z.object({ dialer: z.string().min(1).max(200) }).parse(req.params);
    const { rows } = await pool.query(
      `select d.id, d.name, c.name as company from dialer_servers d join companies c on c.id = d.company_id
        where d.deleting_at is null and (d.id::text = $1 or d.name ilike $1) limit 5`,
      [dialer],
    );
    if (rows.length === 0) return reply.code(404).send({ error: 'not_found', message: `No dialer called "${dialer}"` });
    if (rows.length > 1) {
      return reply.code(409).send({
        error: 'ambiguous',
        message: 'Several dialers match — use the id',
        matches: rows.map((r) => ({ id: r.id, name: r.name, company: r.company })),
      });
    }
    opsLog('info', 'diagnostics: dialer probe', { ip: req.ip, dialer: rows[0].name });
    const t0 = Date.now();
    const result = await testDialerConnection(rows[0].id as string);
    return JSON.parse(
      redactSecrets(JSON.stringify({ dialer: rows[0].name, company: rows[0].company, ms: Date.now() - t0, ...result })),
    ) as Record<string, unknown>;
  });
}
