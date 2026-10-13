import { describe, expect, it } from 'vitest';
import { parseAgentStatusDetail } from './webReport.js';

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
