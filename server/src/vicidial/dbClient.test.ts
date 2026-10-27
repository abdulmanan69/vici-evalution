import { describe, expect, it } from 'vitest';
import { ViciDbClient, decodeViciText } from './dbClient.js';
import type { DialerConnection } from './types.js';

const conn: DialerConnection = {
  id: 'd1',
  companyId: 'c1',
  name: 'Test dialer',
  baseUrl: 'https://dialer.example.com',
  timezone: 'America/New_York',
  sourceMode: 'db',
  db: { host: '127.0.0.1', port: 3306, database: 'asterisk', user: 'ro', password: 'x' },
};

type Handler = (sql: string, params: unknown[]) => unknown[] | Error;

/** A client whose MySQL pool is replaced by a scripted fake (no network). */
function clientWith(handler: Handler) {
  const client = new ViciDbClient(conn);
  const calls: string[] = [];
  (client as unknown as { pool: unknown }).pool = {
    query: async (sql: string, params: unknown[]) => {
      calls.push(sql.replace(/\s+/g, ' ').trim());
      const out = handler(sql, params);
      if (out instanceof Error) throw out;
      return [out, []];
    },
    end: async () => {},
  };
  return { client, calls };
}

const noSuchTable = () => Object.assign(new Error("Table 'custom_999' doesn't exist"), { errno: 1146 });

const leadRow = {
  lead_id: 42,
  list_id: 1001,
  first_name: 'Ann',
  comments: 'line one!Nline two',
  __ls_list_name: 'Medicare Oct',
  __ls_campaign_id: 'MEDI',
  __ls_active: 'Y',
  __ls_list_description: 'fresh leads',
};

describe('ViciDbClient.fetchLead', () => {
  it('reads the lead and its list in one query and strips the joined columns', async () => {
    const { client, calls } = clientWith((sql) => {
      if (sql.includes('FROM vicidial_list l')) return [leadRow];
      if (sql.includes('custom_1001')) return noSuchTable();
      return [];
    });
    const info = await client.fetchLead(42);
    expect(info?.lead).toEqual({ lead_id: 42, list_id: 1001, first_name: 'Ann', comments: 'line one\nline two' });
    expect(info?.list).toEqual({
      list_id: 1001,
      list_name: 'Medicare Oct',
      campaign_id: 'MEDI',
      active: 'Y',
      list_description: 'fresh leads',
    });
    expect(info?.custom).toBeNull();
    // no separate vicidial_lists query and no SHOW TABLES round trip
    expect(calls.some((q) => q.startsWith('SELECT list_id, list_name'))).toBe(false);
    expect(calls.some((q) => q.startsWith('SHOW TABLES'))).toBe(false);
  });

  it('reads custom fields in parallel when the list is known, and uses them', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const client = new ViciDbClient(conn);
    (client as unknown as { pool: unknown }).pool = {
      query: async (sql: string) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight -= 1;
        if (sql.includes('FROM vicidial_list l')) return [[leadRow], []];
        if (sql.includes('custom_1001')) return [[{ lead_id: 42, callback_date: '2026-11-01', notes: 'a!Nb' }], []];
        return [[], []];
      },
      end: async () => {},
    };
    const info = await client.fetchLead(42, 1001);
    expect(maxInFlight).toBe(2);
    expect(info?.custom).toEqual({ lead_id: 42, callback_date: '2026-11-01', notes: 'a\nb' });
  });

  it('re-reads custom fields from the right list when the lead moved lists', async () => {
    const { client, calls } = clientWith((sql) => {
      if (sql.includes('FROM vicidial_list l')) return [leadRow]; // now on 1001
      if (sql.includes('custom_555')) return [{ lead_id: 42, stale: true }];
      if (sql.includes('custom_1001')) return [{ lead_id: 42, fresh: true }];
      return [];
    });
    const info = await client.fetchLead(42, 555);
    expect(info?.custom).toEqual({ lead_id: 42, fresh: true });
    expect(calls.filter((q) => q.includes('custom_1001'))).toHaveLength(1);
  });

  it('remembers a list without custom fields instead of asking every time', async () => {
    const { client, calls } = clientWith((sql) => {
      if (sql.includes('FROM vicidial_list l')) return [leadRow];
      if (sql.includes('custom_1001')) return noSuchTable();
      return [];
    });
    await client.fetchLead(42);
    await client.fetchLead(42);
    expect(calls.filter((q) => q.includes('custom_1001'))).toHaveLength(1);
  });

  it('falls back to the lead alone when the user cannot read vicidial_lists', async () => {
    const { client } = clientWith((sql) => {
      if (sql.includes('FROM vicidial_list l')) return new Error('SELECT command denied for table vicidial_lists');
      if (sql.startsWith('SELECT * FROM vicidial_list WHERE')) return [{ lead_id: 42, list_id: 1001, first_name: 'Ann' }];
      if (sql.includes('custom_1001')) return noSuchTable();
      return [];
    });
    const info = await client.fetchLead(42);
    expect(info?.lead).toEqual({ lead_id: 42, list_id: 1001, first_name: 'Ann' });
    expect(info?.list).toBeNull();
  });

  it('returns null for a lead the dialer does not have', async () => {
    const { client } = clientWith(() => []);
    expect(await client.fetchLead(7)).toBeNull();
  });
});

describe('ViciDbClient.fetchRecordings', () => {
  /** recording_log with one recording a minute, id 1..100000, newest now */
  const startOf = (id: number) => {
    const base = Date.UTC(2026, 9, 27, 12, 0, 0) - (100_000 - id) * 60_000;
    return new Date(base).toISOString().slice(0, 19).replace('T', ' ');
  };
  function recordingLog() {
    return clientWith((sql, params) => {
      if (sql.startsWith('SELECT MAX(recording_id)')) return [{ mx: 100_000 }];
      if (sql.includes('WHERE recording_id >= ? ORDER BY recording_id')) return [{ start_time: startOf(Number(params[0])) }];
      if (sql.includes('FROM recording_log')) return [];
      return [];
    });
  }

  it('bounds the scan by recording id instead of reading the whole table', async () => {
    const { client, calls } = recordingLog();
    const since = startOf(99_990); // ten minutes ago
    await client.fetchRecordings(since, startOf(100_000));
    const main = calls.find((q) => q.includes('FROM recording_log WHERE recording_id >= ? AND start_time > ?'));
    expect(main).toBeDefined();
    // one MAX, one probe (2000 back already reaches before `since`), one read
    expect(calls).toHaveLength(3);
  });

  it('widens the bound for an older window, and the floor never cuts off a match', async () => {
    const { client } = recordingLog();
    const since = startOf(90_000); // a week back
    const floor = await client.recordingIdFloor(since);
    expect(floor).not.toBeNull();
    expect(floor!).toBeLessThanOrEqual(90_000);
  });

  it('falls back to the plain time filter when the window covers most of the table', async () => {
    const { client, calls } = recordingLog();
    await client.fetchRecordings('2020-01-01 00:00:00', startOf(100_000));
    expect(calls[calls.length - 1]).toContain('FROM recording_log WHERE start_time > ?');
  });

  it('never bounds the archive table', async () => {
    const { client, calls } = recordingLog();
    await client.fetchRecordings(startOf(99_990), startOf(100_000), 5000, true);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('FROM recording_log_archive WHERE start_time > ?');
  });
});

describe('decodeViciText', () => {
  it('turns !N into line breaks and drops !R', () => {
    expect(decodeViciText({ a: 'x!R!Ny', b: 3 })).toEqual({ a: 'x\ny', b: 3 });
  });
});
