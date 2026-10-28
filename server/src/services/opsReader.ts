import { createHmac } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import pg from 'pg';
import { config } from '../config.js';
import { pool } from '../db/client.js';

/**
 * Read-only SQL for remote diagnostics (POST /api/v1/ops/sql). Queries run
 * as a separate Postgres login, never as the app's own user, so nothing a
 * query says can write or reach secrets:
 *  - it may only SELECT, and every transaction is read-only;
 *  - sessions, password hashes, tokens and the encrypted dialer credentials
 *    are not granted at all;
 *  - one statement per request, 20 s timeout, rows capped.
 * Its password is derived from OPS_TOKEN and set at every API start; with
 * no token the login is switched off.
 */

export const OPS_READER_ROLE = 'vici_ops_reader';
const HIDDEN_TABLES = new Set(['sessions']);
const SENSITIVE_COLUMN = /(password|passwd|token|secret|_enc$)/i;

export function isSensitiveColumn(name: string): boolean {
  return SENSITIVE_COLUMN.test(name);
}

export function readerPassword(token: string): string {
  return createHmac('sha256', token).update('vici-ops-reader').digest('hex');
}

const ident = (s: string) => `"${s.replace(/"/g, '""')}"`;

let readerPool: pg.Pool | null = null;
let unavailable = 'OPS_TOKEN is not set';

export function opsSqlStatus(): { available: boolean; reason: string | null } {
  return { available: !!readerPool, reason: readerPool ? null : unavailable };
}

/** Creates/refreshes the read-only login and its grants (API start-up). */
export async function setupOpsReader(token: string | null): Promise<void> {
  const c = await pool.connect();
  try {
    if (!token) {
      await c.query(`do $$ begin
        if exists (select 1 from pg_roles where rolname = '${OPS_READER_ROLE}') then alter role ${OPS_READER_ROLE} nologin; end if;
      end $$`);
      return;
    }
    // the password is in the statement text; keep it out of pg_stat_statements
    await c.query(`set pg_stat_statements.track_utility = off`).catch(() => undefined);
    await c.query('begin');
    await c.query(`do $$ begin
      if not exists (select 1 from pg_roles where rolname = '${OPS_READER_ROLE}') then create role ${OPS_READER_ROLE}; end if;
    end $$`);
    await c.query(
      `alter role ${OPS_READER_ROLE} with login nosuperuser nocreatedb nocreaterole noreplication nobypassrls ` +
        `connection limit 4 password '${readerPassword(token)}'`,
    );
    await c.query(`alter role ${OPS_READER_ROLE} set default_transaction_read_only = on`);
    await c.query(`alter role ${OPS_READER_ROLE} set statement_timeout = '20s'`);
    await c.query(`alter role ${OPS_READER_ROLE} set idle_in_transaction_session_timeout = '60s'`);
    await c.query(`do $$ begin execute format('grant connect on database %I to ${OPS_READER_ROLE}', current_database()); end $$`);
    await c.query(`grant usage on schema public to ${OPS_READER_ROLE}`);
    // start clean (this also drops earlier column grants), then grant table by table
    await c.query(`revoke all on all tables in schema public from ${OPS_READER_ROLE}`);
    const cols = await c.query<{ table_name: string; column_name: string }>(
      `select c.relname as table_name, a.attname as column_name
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
         join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
        where n.nspname = 'public' and c.relkind in ('r', 'v', 'm', 'p')
        order by c.relname, a.attnum`,
    );
    const byTable = new Map<string, string[]>();
    for (const r of cols.rows) {
      if (!byTable.has(r.table_name)) byTable.set(r.table_name, []);
      byTable.get(r.table_name)!.push(r.column_name);
    }
    for (const [table, columns] of byTable) {
      if (HIDDEN_TABLES.has(table)) continue;
      const allowed = columns.filter((col) => !isSensitiveColumn(col));
      if (allowed.length === 0) continue;
      if (allowed.length === columns.length) {
        await c.query(`grant select on table ${ident(table)} to ${OPS_READER_ROLE}`);
      } else {
        await c.query(`grant select (${allowed.map(ident).join(', ')}) on table ${ident(table)} to ${OPS_READER_ROLE}`);
      }
    }
    // pg_stat_activity / pg_stat_statements for every session, not just its own
    await c.query(`grant pg_read_all_stats to ${OPS_READER_ROLE}`);
    await c.query('commit');
  } catch (err) {
    await c.query('rollback').catch(() => undefined);
    unavailable = `read-only SQL is off: ${err instanceof Error ? err.message : String(err)}`;
    return;
  } finally {
    await c.query('reset pg_stat_statements.track_utility').catch(() => undefined);
    c.release();
  }

  if (!token) return;
  const url = new URL(config.DATABASE_URL);
  url.username = OPS_READER_ROLE;
  url.password = readerPassword(token);
  await readerPool?.end().catch(() => undefined);
  readerPool = new pg.Pool({ connectionString: url.toString(), max: 2, idleTimeoutMillis: 60_000 });
  readerPool.on('error', () => undefined);
}

export interface PreparedSql {
  text: string;
  wrapped: boolean;
}

/**
 * One statement, trailing semicolons dropped. Row-returning queries are
 * wrapped so the database stops after the cap instead of sending everything.
 */
export function prepareSql(input: string, maxRows: number): PreparedSql {
  const q = input.trim().replace(/[;\s]+$/, '');
  if (!q) throw new Error('The query is empty');
  if (q.length > 20_000) throw new Error('The query is too long');
  const wrapped = /^(select|with|values|table)\b/i.test(q) && !/\bfor\s+(update|share|no\s+key\s+update|key\s+share)\b/i.test(q);
  return { text: wrapped ? `select * from (\n${q}\n) as ops_q limit ${maxRows + 1}` : q, wrapped };
}

function cell(v: unknown): unknown {
  if (v instanceof Date) return v.toISOString();
  if (Buffer.isBuffer(v)) return `\\x${v.subarray(0, 64).toString('hex')}${v.length > 64 ? '…' : ''}`;
  if (typeof v === 'string' && v.length > 4000) return `${v.slice(0, 4000)}… (+${v.length - 4000} chars)`;
  return v;
}

export interface OpsSqlResult {
  columns: string[];
  rows: unknown[][];
  rowCount: number;
  truncated: boolean;
  ms: number;
}

export async function runOpsSql(input: string, maxRows = 200): Promise<OpsSqlResult> {
  if (!readerPool) throw new Error(unavailable);
  const cap = Math.min(Math.max(1, maxRows), 2000);
  const { text } = prepareSql(input, cap);
  const c = await readerPool.connect();
  const t0 = performance.now();
  try {
    await c.query('begin read only');
    // the extended protocol refuses more than one statement
    const res = await c.query({ text, rowMode: 'array', queryMode: 'extended' } as pg.QueryConfig & { queryMode: 'extended' });
    const rows = (res.rows as unknown[][]) ?? [];
    return {
      columns: (res.fields ?? []).map((f) => f.name),
      rows: rows.slice(0, cap).map((r) => r.map(cell)),
      rowCount: rows.length > cap ? cap : (res.rowCount ?? rows.length),
      truncated: rows.length > cap,
      ms: Math.round(performance.now() - t0),
    };
  } finally {
    await c.query('rollback').catch(() => undefined);
    c.release();
  }
}
