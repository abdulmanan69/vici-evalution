import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { api } from '../api/client';
import type { DashboardStats } from '../api/types';
import { useCompanyScope } from '../components/Layout';
import { ErrorState, Loading, PageHeader, StatTile } from '../components/ui';

// validated 2-series palette (blue/orange, CVD-safe — see docs/ARCHITECTURE.md)
const SERIES = { total: '#3B4A9F', closed: '#C97A10' };

export function DashboardPage() {
  const { companyId } = useCompanyScope();
  const [days, setDays] = useState(30);
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['dashboard', companyId, days, tz],
    queryFn: () =>
      api<DashboardStats>('/dashboard/stats', { query: { companyId: companyId || undefined, days, tz } }),
  });

  if (isLoading) return <Loading />;
  if (isError || !data) return <ErrorState message="Dashboard could not load." onRetry={() => void refetch()} />;

  const t = data.totals;
  return (
    <div>
      <PageHeader
        title="Dashboard"
        subtitle={`Transfer and QA activity over the last ${days} days`}
        actions={
          <select className="input w-32" value={days} onChange={(e) => setDays(Number(e.target.value))} aria-label="Time range">
            <option value={7}>Last 7 days</option>
            <option value={30}>Last 30 days</option>
            <option value={90}>Last 90 days</option>
          </select>
        }
      />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatTile label="Transfers" value={t.transfers.toLocaleString()} sub="fronter XFER calls" />
        <StatTile label="Unclosed" value={t.unclosed.toLocaleString()} accent="amber" sub="awaiting a sale" />
        <StatTile label="Closed" value={t.closed.toLocaleString()} accent="good" sub="mapped sale dispositions" />
        <StatTile label="Close rate" value={`${t.closeRate}%`} sub="closed / all transfers" />
        <StatTile
          label="Flagged matches"
          value={t.flaggedMatches.toLocaleString()}
          accent={t.flaggedMatches > 0 ? 'amber' : undefined}
          sub="need human review"
        />
        <StatTile
          label="Missing recordings"
          value={t.missingRecordings.toLocaleString()}
          accent={t.missingRecordings > 0 ? 'bad' : undefined}
          sub="not found on dialer"
        />
        <StatTile label="Evaluations" value={t.evaluationsCompleted.toLocaleString()} sub="completed in range" />
        <StatTile label="Avg QA score" value={t.avgQaScore != null ? `${t.avgQaScore}%` : '—'} sub="completed evaluations" />
      </div>

      <div className="card mt-4 p-4">
        <h2 className="mb-3 font-display text-sm font-bold">Transfers vs closed, by day</h2>
        {data.trend.length === 0 ? (
          <p className="py-10 text-center text-sm text-ink-2">
            No transfer activity in this range yet. Connect a dialer and run a sync to populate it.
          </p>
        ) : (
          <div className="h-64">
            <ResponsiveContainer>
              <LineChart data={data.trend} margin={{ top: 8, right: 16, bottom: 0, left: -16 }}>
                <CartesianGrid stroke="#E7EAEF" vertical={false} />
                <XAxis dataKey="day" tick={{ fontSize: 11, fill: '#8A93A3' }} tickLine={false} axisLine={false} />
                <YAxis tick={{ fontSize: 11, fill: '#8A93A3' }} tickLine={false} axisLine={false} allowDecimals={false} />
                <Tooltip
                  contentStyle={{ fontSize: 12, borderRadius: 8, border: '1px solid #E7EAEF' }}
                  labelStyle={{ color: '#5A6372' }}
                />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Line type="monotone" dataKey="total" name="Transfers" stroke={SERIES.total} strokeWidth={2} dot={false} activeDot={{ r: 4 }} />
                <Line type="monotone" dataKey="closed" name="Closed" stroke={SERIES.closed} strokeWidth={2} dot={false} activeDot={{ r: 4 }} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>
    </div>
  );
}
