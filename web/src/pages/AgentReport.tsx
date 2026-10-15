import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import type { Dialer } from '../api/types';
import { useCompanyScope } from '../components/Layout';
import { EmptyState, ErrorState, Loading, PageHeader, dialerDayIso } from '../components/ui';

interface ActivityRow {
  user: string;
  fullName: string | null;
  userGroup: string | null;
  viciCalls: number | null;
  viciXfers: number | null;
  viciSales: number | null;
  talkSec: number | null;
  waitSec: number | null;
  pauseSec: number | null;
  loginSec: number | null;
  recordedCalls: number;
  recordedSec: number;
  transfersStarted: number;
  salesClosed: number;
}

interface ActivityResponse {
  dialer: { id: string; name: string; timezone: string };
  dateFrom: string;
  dateTo: string;
  source: 'live_api' | 'archived_report' | 'platform_only';
  viciError: string | null;
  rows: ActivityRow[];
  totals: {
    viciCalls: number;
    viciXfers: number;
    viciSales: number;
    talkSec: number;
    recordedCalls: number;
    transfersStarted: number;
    salesClosed: number;
  };
}

const SOURCE_LABEL: Record<ActivityResponse['source'], string> = {
  live_api: "live from the dialer's agent statistics",
  archived_report: "from the dialer's archived Agent Status Detail report",
  platform_only: 'platform-synced data only (dialer unreachable)',
};

function hms(sec: number | null): string {
  if (sec == null) return '—';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}



export function AgentReportPage() {
  const { companyId } = useCompanyScope();
  const [dialerId, setDialerId] = useState('');
  const [dateFrom, setDateFrom] = useState(() => dialerDayIso());
  const [dateTo, setDateTo] = useState(() => dialerDayIso());

  const { data: dialers } = useQuery({
    queryKey: ['dialers', companyId],
    queryFn: () => api<{ dialers: Dialer[] }>('/dialers', { query: { companyId: companyId || undefined } }),
  });
  const effectiveDialer = dialerId || dialers?.dialers.find((d) => d.active)?.id || '';

  const { data, isLoading, isError, refetch, isFetching } = useQuery({
    queryKey: ['agent-activity', effectiveDialer, dateFrom, dateTo],
    queryFn: () =>
      api<ActivityResponse>('/reports/agent-activity', {
        query: { dialerServerId: effectiveDialer, dateFrom, dateTo },
      }),
    enabled: !!effectiveDialer && !!dateFrom && !!dateTo && dateFrom <= dateTo,
  });

  return (
    <div>
      <PageHeader
        title="Agent report"
        subtitle={
          data
            ? `${data.dialer.name} · ${data.dateFrom} to ${data.dateTo} (dialer time, ${data.dialer.timezone}) · ${SOURCE_LABEL[data.source]}`
            : 'Per-agent activity for a date range, matched against the dialer'
        }
      />

      <div className="card mb-3 flex flex-wrap items-end gap-3 p-3">
        <div>
          <label className="label">Dialer</label>
          <select
            className="input w-56"
            value={effectiveDialer}
            onChange={(e) => setDialerId(e.target.value)}
            aria-label="Dialer"
          >
            {dialers?.dialers.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="label">From (dialer date)</label>
          <input type="date" className="input w-40" value={dateFrom} max={dateTo} onChange={(e) => setDateFrom(e.target.value)} />
        </div>
        <div>
          <label className="label">To</label>
          <input type="date" className="input w-40" value={dateTo} min={dateFrom} onChange={(e) => setDateTo(e.target.value)} />
        </div>
        {isFetching && <span className="pb-2 text-2xs text-ink-3">Loading from the dialer…</span>}
      </div>

      <p className="mb-3 text-2xs text-ink-3">
        <strong>Calls / talk / wait / pause / login</strong> are fetched live from VICIdial's own agent
        statistics for this range — the same numbers as its Agent Status Detail report.{' '}
        <strong>Recorded calls, transfers and sales</strong> are this platform's synced view: in API-only
        mode a call is only visible once it has a recording, so recorded counts can trail the live totals.
      </p>

      {data?.viciError && (
        <div className="mb-3 rounded-md bg-amber-soft px-3 py-2 text-sm text-amber-line">
          Live dialer stats unavailable: {data.viciError}. Showing platform-synced columns only.
        </div>
      )}

      {isLoading ? (
        <Loading label="Querying the dialer…" />
      ) : isError ? (
        <ErrorState message="Report could not load." onRetry={() => void refetch()} />
      ) : !data || data.rows.length === 0 ? (
        <EmptyState title="No agent activity in this range" hint="Pick a different date range or dialer." />
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b border-ink/10">
              <tr>
                <th className="th">Agent</th>
                <th className="th">Name</th>
                <th className="th text-right">Calls</th>
                <th className="th text-right">XFER</th>
                <th className="th text-right">SALE</th>
                <th className="th text-right">Talk</th>
                <th className="th text-right">Wait</th>
                <th className="th text-right">Pause</th>
                <th className="th text-right">Login</th>
                <th className="th text-right">Recorded</th>
                <th className="th text-right">Transfers</th>
                <th className="th text-right">Sales</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink/5">
              {data.rows.map((r) => (
                <tr key={r.user} className="hover:bg-bg/60">
                  <td className="td font-mono">{r.user}</td>
                  <td className="td">
                    <div className="font-medium">{r.fullName ?? '—'}</div>
                    {r.userGroup && <div className="text-2xs text-ink-3">{r.userGroup}</div>}
                  </td>
                  <td className="td text-right font-mono tabular-nums">{r.viciCalls ?? '—'}</td>
                  <td className="td text-right font-mono tabular-nums">{r.viciXfers ?? '—'}</td>
                  <td className="td text-right font-mono tabular-nums">{r.viciSales ?? '—'}</td>
                  <td className="td text-right font-mono tabular-nums">{hms(r.talkSec)}</td>
                  <td className="td text-right font-mono tabular-nums">{hms(r.waitSec)}</td>
                  <td className="td text-right font-mono tabular-nums">{hms(r.pauseSec)}</td>
                  <td className="td text-right font-mono tabular-nums">{hms(r.loginSec)}</td>
                  <td className="td text-right font-mono tabular-nums">{r.recordedCalls}</td>
                  <td className="td text-right font-mono tabular-nums">{r.transfersStarted}</td>
                  <td className="td text-right font-mono tabular-nums">{r.salesClosed}</td>
                </tr>
              ))}
            </tbody>
            <tfoot className="border-t border-ink/10 bg-bg/50">
              <tr>
                <td className="td font-semibold" colSpan={2}>
                  Totals · {data.rows.length} agents
                </td>
                <td className="td text-right font-mono font-semibold tabular-nums">{data.totals.viciCalls}</td>
                <td className="td text-right font-mono font-semibold tabular-nums">{data.totals.viciXfers}</td>
                <td className="td text-right font-mono font-semibold tabular-nums">{data.totals.viciSales}</td>
                <td className="td text-right font-mono font-semibold tabular-nums">{hms(data.totals.talkSec)}</td>
                <td className="td" colSpan={3}></td>
                <td className="td text-right font-mono font-semibold tabular-nums">{data.totals.recordedCalls}</td>
                <td className="td text-right font-mono font-semibold tabular-nums">{data.totals.transfersStarted}</td>
                <td className="td text-right font-mono font-semibold tabular-nums">{data.totals.salesClosed}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  );
}
