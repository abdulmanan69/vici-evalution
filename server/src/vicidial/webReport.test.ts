import { describe, expect, it } from 'vitest';
import { parseAgentStatusDetail, parseUserStatsCsv } from './webReport.js';

// Synthetic fixture mirroring the live AST_agent_status_detail TEXT layout
// (anchor tags in the ID cell, separator lines, TOTALS row).
const SAMPLE = `
<HTML><BODY><PRE><FONT SIZE=2>
Agent Status Detail Report                     2026-10-13 15:23:45 (M)
Time range: 2026-10-12 00:00:00 to 2026-10-12 23:59:59

| USER NAME                 | ID       | CALLS  | CIcalls| DNC/CI%|        A |   CALLBK |       NI |     SALE |     XFER |
+---------------------------+----------+--------+--------+--------+----------+----------+----------+----------+----------+
| Fahad Butt                | <a href="./user_stats.php?user=WTI1002">WTI1002 </a> |     26 |     10 |      0%|        4 |        1 |        3 |        1 |        2 |
| Qasim Suleman T1          | <a href="./user_stats.php?user=WTI1038">WTI1038 </a> |    307 |     80 |      1%|       66 |        0 |        7 |        0 |       12 |
+---------------------------+----------+--------+--------+--------+----------+----------+----------+----------+----------+
|  TOTALS        AGENTS:   2           |    333 |     90 |      0%|       70 |        1 |       10 |        1 |       14 |
+--------------------------------------+--------+--------+--------+----------+----------+----------+----------+----------+
</FONT></PRE></BODY></HTML>
`;

describe('parseAgentStatusDetail', () => {
  it('parses agents, calls and per-status counts from the live layout', () => {
    const parsed = parseAgentStatusDetail(SAMPLE);
    expect(parsed.statuses).toEqual(['A', 'CALLBK', 'NI', 'SALE', 'XFER']);
    expect(parsed.rows).toHaveLength(2);
    const [fahad, qasim] = parsed.rows;
    expect(fahad.user).toBe('WTI1002');
    expect(fahad.name).toBe('Fahad Butt');
    expect(fahad.calls).toBe(26);
    expect(fahad.statusCounts.XFER).toBe(2);
    expect(fahad.statusCounts.SALE).toBe(1);
    expect(qasim.calls).toBe(307);
    expect(qasim.statusCounts.XFER).toBe(12);
    // zero counts are omitted
    expect(qasim.statusCounts.SALE).toBeUndefined();
  });

  it('stops at the TOTALS row (caller recomputes totals)', () => {
    const parsed = parseAgentStatusDetail(SAMPLE);
    expect(parsed.rows.every((r) => !/TOTALS/.test(r.name))).toBe(true);
  });

  it('throws a clear error when the table is absent', () => {
    expect(() => parseAgentStatusDetail('<html>login page</html>')).toThrow(/header not found/);
  });
});

// Synthetic fixtures mirroring the live user_stats file_download exports.
const OUTBOUND_CSV = `"Outbound Calls for this Time Period: (10000 record limit)"
"","#","DATE/TIME","LENGTH","STATUS","PHONE","CAMPAIGN","GROUP","LIST","LEAD","HANGUP REASON"
"","1","2026-10-13 16:50:36","18","N","3475548601","003","wavetechpk","998","8569744","CALLER"
"","2","2026-10-13 16:28:02","248","XFER","3522551285","001","wavetechpk","20261008002","8118915","CALLER"
`;

const CLOSER_CSV = `"Inbound Closer Calls for this Time Period: (10000 record limit)"
"","#","DATE/TIME","LENGTH","STATUS","PHONE","IN-GROUP","WAIT(S)","AGENT(S)","LIST","LEAD","HANGUP REASON"
"","1","2026-10-13 16:57:49","117","SALE","8436819613","Sip_INB","0.00","117","101010","8569770","AGENT"
`;

describe('parseUserStatsCsv', () => {
  it('parses outbound rows with exact per-call statuses', () => {
    const rows = parseUserStatsCsv(OUTBOUND_CSV, 'outbound');
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({
      kind: 'outbound',
      dateTimeLocal: '2026-10-13 16:28:02',
      lengthSec: 248,
      status: 'XFER',
      phone: '3522551285',
      campaignOrGroup: '001',
      listId: 20261008002,
      leadId: 8118915,
    });
  });

  it('parses closer rows (IN-GROUP column, extra WAIT/AGENT columns)', () => {
    const rows = parseUserStatsCsv(CLOSER_CSV, 'closer');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: 'closer',
      status: 'SALE',
      campaignOrGroup: 'Sip_INB',
      leadId: 8569770,
      lengthSec: 117,
    });
  });

  it('returns empty for a page without the table', () => {
    expect(parseUserStatsCsv('nothing here', 'outbound')).toEqual([]);
  });
});
