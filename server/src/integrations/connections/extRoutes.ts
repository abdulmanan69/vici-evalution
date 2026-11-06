/**
 * Machine API for other apps: /api/v1/ext/… with an API key
 * (Authorization: Bearer qa_…). Read-only. See docs/CONNECTIONS.md.
 *
 *   GET /me            the key: name, company, scopes
 *   GET /agents        agents.read
 *   GET /transfers     transfers.read (+ transfers.read_pii for phone numbers)
 *   GET /evaluations   evaluations.read
 *   GET /scores        scores.read      ?period=YYYY-MM
 *   GET /activity      calls.read       agent activity per shift day
 *
 * Lists are cursor-paginated: pass back `next` as ?cursor= until it is null.
 */
import type { FastifyInstance } from 'fastify';
import { and, asc, eq, gt, inArray, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db/client.js';
import { companies, dialerServers, viciAgents } from '../../db/schema.js';
import { config } from '../../config.js';
import { ValidationError } from '../../lib/errors.js';
import { agentScores, periodRange } from '../../services/agentScores.js';
import { addDays, buildAttendanceItems, parseDayStart, shiftDayStart, type CallRow } from '../hrms/attendance.js';
import { decodeCursor, encodeCursor } from './catalog.js';
import { authenticateKey, hasScope, keyCompanies, requireScope } from './keyAuth.js';
import { publicRecord, selectEvaluations, selectTransfers } from './records.js';

const limitSchema = z.coerce.number().int().min(1).max(1000).default(100);
/** 'YYYY-MM-DD' (start of that UTC day) or a full ISO time */
const when = z
  .string()
  .max(40)
  .refine((v) => !Number.isNaN(Date.parse(v)), 'expected YYYY-MM-DD or an ISO time')
  .optional();

const ids = (list: Array<{ id: string }>) => sql.join(list.map((c) => sql`${c.id}::uuid`), sql`, `);

function cursorOf(q: { cursor?: string }) {
  if (!q.cursor) return null;
  const c = decodeCursor(q.cursor);
  if (!c) throw new ValidationError('cursor is not valid');
  return c;
}

/** to: a plain date includes that whole day */
const toBound = (v: string) => (/^\d{4}-\d{2}-\d{2}$/.test(v) ? addDays(v, 1) : v);

export async function extRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authenticateKey);

  app.get('/me', async (req) => {
    const k = req.extKey!;
    return { key: { name: k.name, prefix: k.prefix, company: k.companySlug ?? '*', scopes: k.scopes } };
  });

  app.get('/agents', { preHandler: requireScope('agents.read') }, async (req) => {
    const q = z
      .object({ company: z.string().max(64).optional(), active: z.enum(['true', 'false']).optional(), limit: limitSchema, cursor: z.string().max(200).optional() })
      .parse(req.query);
    const list = await keyCompanies(req, q.company);
    if (!list.length) return { data: [], next: null };
    const c = q.cursor ? cursorOf(q) : null;
    const where: SQL[] = [inArray(viciAgents.companyId, list.map((x) => x.id)), sql`${dialerServers.deletingAt} is null`];
    if (q.active) where.push(eq(viciAgents.active, q.active === 'true'));
    if (c) where.push(gt(viciAgents.id, c.id));
    const rows = await db
      .select({
        id: viciAgents.id,
        vici_user: viciAgents.viciUser,
        full_name: viciAgents.fullName,
        user_group: viciAgents.userGroup,
        agent_role: viciAgents.agentRole,
        active: viciAgents.active,
        dialer: dialerServers.name,
        company: companies.slug,
      })
      .from(viciAgents)
      .innerJoin(dialerServers, eq(viciAgents.dialerServerId, dialerServers.id))
      .innerJoin(companies, eq(viciAgents.companyId, companies.id))
      .where(and(...where))
      .orderBy(asc(viciAgents.id))
      .limit(q.limit);
    const last = rows[rows.length - 1];
    return { data: rows, next: rows.length === q.limit && last ? encodeCursor(new Date(0).toISOString(), last.id) : null };
  });

  app.get('/transfers', { preHandler: requireScope('transfers.read') }, async (req) => {
    const q = z
      .object({
        company: z.string().max(64).optional(),
        status: z.enum(['transfer', 'unclosed', 'closed']).optional(),
        from: when,
        to: when,
        updated_since: when,
        limit: limitSchema,
        cursor: z.string().max(200).optional(),
      })
      .parse(req.query);
    const list = await keyCompanies(req, q.company);
    if (!list.length) return { data: [], next: null };
    const where: SQL[] = [sql`t.company_id in (${ids(list)})`];
    if (q.status) where.push(sql`t.queue_status = ${q.status}`);
    if (q.from) where.push(sql`t.xfer_time >= ${q.from}::timestamptz`);
    if (q.to) where.push(sql`t.xfer_time < ${toBound(q.to)}::timestamptz`);
    if (q.updated_since) where.push(sql`t.updated_at >= ${q.updated_since}::timestamptz`);
    const c = cursorOf(q);
    if (c) where.push(sql`(t.updated_at, t.id) > (${c.at}::timestamptz, ${c.id}::uuid)`);
    const rows = await selectTransfers(sql.join(where, sql` and `), sql`t.updated_at, t.id`, q.limit, { pii: hasScope(req, 'transfers.read_pii') });
    const last = rows[rows.length - 1];
    return { data: rows.map(publicRecord), next: rows.length === q.limit && last ? encodeCursor(last._cursor, last.id) : null };
  });

  app.get('/evaluations', { preHandler: requireScope('evaluations.read') }, async (req) => {
    const q = z
      .object({
        company: z.string().max(64).optional(),
        from: when,
        to: when,
        agent: z.string().max(50).optional(),
        limit: limitSchema,
        cursor: z.string().max(200).optional(),
      })
      .parse(req.query);
    const list = await keyCompanies(req, q.company);
    if (!list.length) return { data: [], next: null };
    const where: SQL[] = [sql`evaluations.company_id in (${ids(list)})`];
    if (q.from) where.push(sql`evaluations.completed_at >= ${q.from}::timestamptz`);
    if (q.to) where.push(sql`evaluations.completed_at < ${toBound(q.to)}::timestamptz`);
    if (q.agent) where.push(sql`upper(ea.vici_user) = ${q.agent.trim().toUpperCase()}`);
    const c = cursorOf(q);
    if (c) where.push(sql`(evaluations.completed_at, evaluations.id) > (${c.at}::timestamptz, ${c.id}::uuid)`);
    const rows = await selectEvaluations(sql.join(where, sql` and `), sql`evaluations.completed_at, evaluations.id`, q.limit);
    const last = rows[rows.length - 1];
    return { data: rows.map(publicRecord), next: rows.length === q.limit && last ? encodeCursor(last._cursor, last.id) : null };
  });

  app.get('/scores', { preHandler: requireScope('scores.read') }, async (req) => {
    const q = z
      .object({ company: z.string().max(64).optional(), period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'period must be YYYY-MM') })
      .parse(req.query);
    const list = await keyCompanies(req, q.company);
    const { from, to } = periodRange(q.period);
    const data = [];
    for (const c of list) {
      for (const r of await agentScores(c.id, from, to)) {
        data.push({
          company: c.slug,
          vici_user: r.viciUser,
          full_name: r.fullName,
          dialer: r.dialer,
          period: q.period,
          count: r.n,
          avg_percent: Math.round(r.avg * 10) / 10,
          min_percent: r.min,
          max_percent: r.max,
          pass_rate: Math.round((r.passed / r.n) * 1000) / 10,
        });
      }
    }
    data.sort((a, b) => (a.company === b.company ? a.vici_user.localeCompare(b.vici_user) : a.company.localeCompare(b.company)));
    return { data };
  });

  /**
   * Activity per agent and shift day, the same figures the HRMS attendance
   * push sends. Days are cut like HRMS does (?tz=Asia/Karachi&day_starts=12:00
   * by default). Only days inside the call retention window are complete.
   */
  app.get('/activity', { preHandler: requireScope('calls.read') }, async (req) => {
    const q = z
      .object({
        company: z.string().max(64).optional(),
        from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        tz: z.string().max(64).default(process.env.HRMS_TZ || 'Asia/Karachi'),
        day_starts: z.string().regex(/^\d{1,2}:\d{2}$/).default('12:00'),
      })
      .parse(req.query);
    if (q.to < q.from || addDays(q.from, 62) <= q.to) throw new ValidationError('from..to must be 1 to 62 days');
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: q.tz });
    } catch {
      throw new ValidationError('tz is not a known time zone');
    }
    const startMin = parseDayStart(q.day_starts);
    const list = await keyCompanies(req, q.company);
    const fromAt = shiftDayStart(q.from, q.tz, startMin);
    const toAt = shiftDayStart(addDays(q.to, 1), q.tz, startMin);
    const data = [];
    for (const c of list) {
      const r = await db.execute(sql`
        select coalesce(a.vici_user, nullif(trim(c.vici_user_raw), '')) as account, c.call_date, c.length_sec
          from calls c left join vici_agents a on a.id = c.vici_agent_id
         where c.company_id = ${c.id} and not c.is_mock
           and c.source in ('vicidial_log', 'vicidial_closer_log')
           and c.call_date >= ${fromAt} and c.call_date < ${toAt}`);
      const rows: CallRow[] = (r.rows as Array<{ account: string | null; call_date: Date | string; length_sec: number | null }>).map((x) => ({
        account: x.account,
        callDate: x.call_date instanceof Date ? x.call_date : new Date(x.call_date),
        lengthSec: x.length_sec,
      }));
      for (const item of buildAttendanceItems(rows, q.tz, startMin, { from: q.from, to: q.to })) data.push({ company: c.slug, ...item });
    }
    return { data, retentionDays: config.RETENTION_DAYS };
  });
}
