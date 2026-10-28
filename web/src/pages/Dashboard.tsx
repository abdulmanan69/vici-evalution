import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import {
  ArrowLeftRight,
  ArrowUpRight,
  BadgeCheck,
  CheckCircle2,
  ClipboardCheck,
  Flag,
  MicOff,
  PhoneForwarded,
  Star,
  Table2,
  Target,
} from 'lucide-react';
import { api } from '../api/client';
import type { DashboardStats } from '../api/types';
import { useCompanyScope } from '../components/Layout';
import { ErrorState, Loading, PageHeader, dialerDayIso } from '../components/ui';

// Where a transfer is now. Validated pair (blue/orange, CVD ΔE 29.5 on white)
// plus a neutral for transfers still waiting for a closer — the remainder.
const OUTCOME = {
  closed: { color: '#3B4A9F', label: 'Closed', hint: 'sold' },
  unclosed: { color: '#C97A10', label: 'Unclosed', hint: 'closer reached, no sale' },
  open: { color: '#C7CCD6', label: 'No closer yet', hint: 'still in Transfers' },
} as const;
type OutcomeKey = keyof typeof OUTCOME;

const PRESETS = [
  { id: '1', label: 'Today' },
  { id: '7', label: '7 days' },
  { id: '15', label: '15 days' },
  { id: '30', label: '30 days' },
  { id: 'custom', label: 'Custom' },
] as const;
type Preset = (typeof PRESETS)[number]['id'];

const pct = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : 0);
const fmt = (n: number) => n.toLocaleString();

function shortDay(iso: string): string {
  const d = new Date(`${iso}T00:00:00`);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function longDay(iso: string): string {
  const d = new Date(`${iso}T00:00:00`);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
}

export function DashboardPage() {
  const { companyId } = useCompanyScope();
  const [preset, setPreset] = useState<Preset>('7');
  const [customFrom, setCustomFrom] = useState(() => dialerDayIso());
  const [customTo, setCustomTo] = useState(() => dialerDayIso());
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;

  const customReady = preset !== 'custom' || (!!customFrom && !!customTo && customFrom <= customTo);
  const rangeQuery = preset === 'custom' ? { dateFrom: customFrom, dateTo: customTo } : { days: Number(preset) };

  const { data, isLoading, isError, isFetching, refetch } = useQuery({
    queryKey: ['dashboard', companyId, preset, customFrom, customTo, tz],
    queryFn: () =>
      api<DashboardStats>('/dashboard/stats', {
        query: { companyId: companyId || undefined, tz, ...rangeQuery },
      }),
    enabled: customReady,
    // switching the range keeps the page in place instead of blanking it
    placeholderData: keepPreviousData,
  });

  const rangeControl = (
    <div className="flex flex-wrap items-center gap-2">
      <div className="inline-flex rounded-lg bg-surface p-0.5 shadow-card" role="group" aria-label="Time range">
        {PRESETS.map((p) => (
          <button
            key={p.id}
            onClick={() => setPreset(p.id)}
            aria-pressed={preset === p.id}
            className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
              preset === p.id ? 'bg-brand text-white shadow-sm' : 'text-ink-2 hover:bg-bg hover:text-ink'
            }`}
          >
            {p.label}
          </button>
        ))}
      </div>
      {preset === 'custom' && (
        <div className="flex items-center gap-1.5">
          <input
            type="date"
            className="input w-36 py-1.5 text-xs"
            value={customFrom}
            max={customTo}
            onChange={(e) => setCustomFrom(e.target.value)}
            aria-label="From date"
          />
          <span className="text-ink-3">→</span>
          <input
            type="date"
            className="input w-36 py-1.5 text-xs"
            value={customTo}
            min={customFrom}
            onChange={(e) => setCustomTo(e.target.value)}
            aria-label="To date"
          />
        </div>
      )}
    </div>
  );

  if (isLoading) return <Loading />;
  if (isError || !data) return <ErrorState message="Dashboard could not load." onRetry={() => void refetch()} />;

  const t = data.totals;
  const rangeLabel =
    data.dateFrom === data.dateTo ? longDay(data.dateFrom) : `${shortDay(data.dateFrom)} – ${shortDay(data.dateTo)}`;
  const outcomes: Record<OutcomeKey, number> = {
    closed: t.closedFromTransfers,
    unclosed: t.unclosed,
    open: t.transfer,
  };

  return (
    <div className={`transition-opacity ${isFetching ? 'opacity-90' : ''}`}>
      <PageHeader title="Dashboard" subtitle={`${rangeLabel} · dialer days (${data.timezone})`} actions={rangeControl} />

      {/* headline numbers — each opens its queue */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard
          to="/queues/transfer"
          icon={<PhoneForwarded size={16} />}
          tone="ink"
          label="Transfers"
          value={fmt(t.transfers)}
          sub={t.transfer > 0 ? `${fmt(t.transfer)} still waiting for a closer` : 'fronter XFER calls'}
        />
        <KpiCard
          to="/queues/unclosed"
          icon={<ArrowLeftRight size={16} />}
          tone="amber"
          label="Unclosed"
          value={fmt(t.unclosed)}
          sub="closer reached, no sale yet"
        />
        <KpiCard
          to="/queues/closed"
          icon={<BadgeCheck size={16} />}
          tone="brand"
          label="Closed (sales)"
          value={fmt(t.closed)}
          sub={
            t.callbackSales + t.inboundSales > 0
              ? `${fmt(t.closedFromTransfers)} from transfers · ${fmt(t.callbackSales)} callback · ${fmt(t.inboundSales)} inbound`
              : 'all from transfers'
          }
        />
        <KpiCard
          icon={<Target size={16} />}
          tone="brand"
          label="Close rate"
          value={`${t.closeRate}%`}
          sub={`${fmt(t.closedFromTransfers)} of ${fmt(t.transfers)} transfers sold`}
        >
          <Meter value={t.closeRate} color={OUTCOME.closed.color} label="Close rate" />
        </KpiCard>
      </div>

      <div className="mt-3 grid grid-cols-1 gap-3 lg:grid-cols-3">
        <TrendCard trend={data.trend} from={data.dateFrom} to={data.dateTo} />
        <OutcomeCard outcomes={outcomes} total={t.transfers} />
      </div>

      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <SmallCard
          to="/queues/transfer"
          icon={<Flag size={15} />}
          label="Flagged matches"
          value={fmt(t.flaggedMatches)}
          state={t.flaggedMatches > 0 ? 'warn' : 'ok'}
          sub={t.flaggedMatches > 0 ? 'pick the right closer call by hand' : 'every closer leg matched clearly'}
        />
        <SmallCard
          icon={<MicOff size={15} />}
          label="Missing recordings"
          value={fmt(t.missingRecordings)}
          state={t.missingRecordings > 0 ? 'bad' : 'ok'}
          sub={t.missingRecordings > 0 ? 'call legs with no file 10+ min after hangup' : 'every reviewed call has its audio'}
        />
        <SmallCard
          to="/qa/evaluations"
          icon={<ClipboardCheck size={15} />}
          label="Evaluations"
          value={fmt(t.evaluationsCompleted)}
          sub="completed in this range"
        />
        <SmallCard
          icon={<Star size={15} />}
          label="Avg QA score"
          value={t.avgQaScore != null ? `${t.avgQaScore}%` : '—'}
          sub="completed evaluations"
        >
          {t.avgQaScore != null && <Meter value={t.avgQaScore} color="#1F7A4D" label="Average QA score" />}
        </SmallCard>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

const TONES = {
  ink: 'bg-bg text-ink-2',
  amber: 'bg-amber-soft text-amber-line',
  brand: 'bg-brand-soft text-brand',
} as const;

function KpiCard({
  to,
  icon,
  tone,
  label,
  value,
  sub,
  children,
}: {
  to?: string;
  icon: ReactNode;
  tone: keyof typeof TONES;
  label: string;
  value: string;
  sub: string;
  children?: ReactNode;
}) {
  const body = (
    <>
      <div className="flex items-center justify-between">
        <span className="text-2xs font-semibold uppercase tracking-wider text-ink-2">{label}</span>
        <span className={`flex h-8 w-8 items-center justify-center rounded-lg ${TONES[tone]}`}>{icon}</span>
      </div>
      <div className="mt-2 font-display text-3xl font-bold tabular-nums text-ink">{value}</div>
      <div className="mt-1 flex items-center gap-1 text-2xs text-ink-3">
        <span className="truncate">{sub}</span>
        {to && <ArrowUpRight size={12} className="ml-auto shrink-0 text-ink-3 transition-colors group-hover:text-brand" />}
      </div>
      {children && <div className="mt-3">{children}</div>}
    </>
  );
  return to ? (
    <Link to={to} className="card group block p-4 transition-shadow hover:shadow-md hover:ring-1 hover:ring-brand/20">
      {body}
    </Link>
  ) : (
    <div className="card p-4">{body}</div>
  );
}

const STATES = {
  ok: 'bg-good-soft text-good',
  warn: 'bg-amber-soft text-amber-line',
  bad: 'bg-bad-soft text-bad',
  none: 'bg-bg text-ink-2',
} as const;

function SmallCard({
  to,
  icon,
  label,
  value,
  sub,
  state = 'none',
  children,
}: {
  to?: string;
  icon: ReactNode;
  label: string;
  value: string;
  sub: string;
  state?: keyof typeof STATES;
  children?: ReactNode;
}) {
  const body = (
    <div className="flex items-start gap-3">
      <span className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${STATES[state]}`}>
        {state === 'ok' ? <CheckCircle2 size={15} /> : icon}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-xs font-medium text-ink-2">{label}</span>
          <span className="font-display text-xl font-bold tabular-nums text-ink">{value}</span>
        </div>
        <div className="mt-0.5 text-2xs text-ink-3">{sub}</div>
        {children && <div className="mt-2">{children}</div>}
      </div>
    </div>
  );
  return to ? (
    <Link to={to} className="card block p-3.5 transition-shadow hover:shadow-md hover:ring-1 hover:ring-brand/20">
      {body}
    </Link>
  ) : (
    <div className="card p-3.5">{body}</div>
  );
}

function Meter({ value, color, label }: { value: number; color: string; label: string }) {
  const w = Math.max(0, Math.min(100, value));
  return (
    <div
      className="h-1.5 w-full overflow-hidden rounded-full bg-bg"
      role="meter"
      aria-label={label}
      aria-valuenow={value}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div className="h-full rounded-full" style={{ width: `${w}%`, background: color }} />
    </div>
  );
}

// ---------------------------------------------------------------------------

function OutcomeCard({ outcomes, total }: { outcomes: Record<OutcomeKey, number>; total: number }) {
  const keys = Object.keys(OUTCOME) as OutcomeKey[];
  const shown = keys.filter((k) => outcomes[k] > 0);
  return (
    <div className="card p-4">
      <h2 className="font-display text-sm font-bold">Where transfers are now</h2>
      <p className="text-2xs text-ink-3">{fmt(total)} fronter transfers in this range</p>
      {total === 0 ? (
        <p className="py-8 text-center text-sm text-ink-2">No transfers in this range.</p>
      ) : (
        <>
          {/* one 100% bar; a 2px surface gap separates the parts */}
          <div className="mt-4 flex h-3 w-full gap-0.5 overflow-hidden rounded-full" role="img" aria-label="Transfer outcomes">
            {shown.map((k) => (
              <div
                key={k}
                className="h-full first:rounded-l-full last:rounded-r-full"
                style={{ width: `${(outcomes[k] / total) * 100}%`, background: OUTCOME[k].color, minWidth: 4 }}
                title={`${OUTCOME[k].label}: ${fmt(outcomes[k])}`}
              />
            ))}
          </div>
          <ul className="mt-4 space-y-3">
            {keys.map((k) => (
              <li key={k} className="flex items-center gap-3">
                <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: OUTCOME[k].color }} />
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium text-ink">{OUTCOME[k].label}</div>
                  <div className="text-2xs text-ink-3">{OUTCOME[k].hint}</div>
                </div>
                <div className="text-right">
                  <div className="font-display text-sm font-bold tabular-nums text-ink">{fmt(outcomes[k])}</div>
                  <div className="text-2xs tabular-nums text-ink-3">{pct(outcomes[k], total)}%</div>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

type TrendRow = DashboardStats['trend'][number];

/** Every day of the range, quiet days as zero, so the axis shows the whole range. */
function fillDays(rows: TrendRow[], from: string, to: string): TrendRow[] {
  const byDay = new Map(rows.map((r) => [r.day, r]));
  const out: TrendRow[] = [];
  const end = new Date(`${to}T00:00:00Z`).getTime();
  for (let t = new Date(`${from}T00:00:00Z`).getTime(); t <= end && out.length < 400; t += 86_400_000) {
    const day = new Date(t).toISOString().slice(0, 10);
    out.push(byDay.get(day) ?? { day, total: 0, closed: 0, transferClosed: 0, transferUnclosed: 0, transferOpen: 0 });
  }
  return out.length ? out : rows;
}

function TrendCard({ trend: rows, from, to }: { trend: TrendRow[]; from: string; to: string }) {
  const [asTable, setAsTable] = useState(false);
  const trend = fillDays(rows, from, to);
  const activity = trend.reduce((a, r) => a + r.total + r.closed, 0);
  return (
    <div className="card p-4 lg:col-span-2">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="font-display text-sm font-bold">Transfers by day</h2>
          <p className="text-2xs text-ink-3">each day's transfers, by where they are now</p>
        </div>
        <div className="flex items-center gap-3">
          <TrendLegend />
          <button
            className={`flex items-center gap-1 rounded-md px-2 py-1 text-2xs ${asTable ? 'bg-brand-soft text-brand' : 'text-ink-2 hover:bg-bg'}`}
            onClick={() => setAsTable((v) => !v)}
            aria-pressed={asTable}
          >
            <Table2 size={12} /> Table
          </button>
        </div>
      </div>
      {activity === 0 ? (
        <p className="py-16 text-center text-sm text-ink-2">
          No transfer activity in this range yet. Connect a dialer and run a sync to populate it.
        </p>
      ) : asTable ? (
        <div className="mt-3 max-h-64 overflow-auto">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-surface">
              <tr className="border-b border-ink/10">
                <th className="th">Day</th>
                <th className="th text-right">Transfers</th>
                <th className="th text-right">Closed</th>
                <th className="th text-right">Unclosed</th>
                <th className="th text-right">No closer yet</th>
                <th className="th text-right">Close rate</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink/5">
              {trend.map((r) => (
                <tr key={r.day}>
                  <td className="td">{longDay(r.day)}</td>
                  <td className="td text-right tabular-nums">{fmt(r.total)}</td>
                  <td className="td text-right tabular-nums">{fmt(r.transferClosed)}</td>
                  <td className="td text-right tabular-nums">{fmt(r.transferUnclosed)}</td>
                  <td className="td text-right tabular-nums">{fmt(r.transferOpen)}</td>
                  <td className="td text-right tabular-nums">{pct(r.transferClosed, r.total)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="mt-3 h-64">
          <ResponsiveContainer>
            <BarChart data={trend} margin={{ top: 8, right: 4, bottom: 0, left: -16 }} barCategoryGap="22%">
              <CartesianGrid stroke="#EEF0F3" vertical={false} />
              <XAxis
                dataKey="day"
                tickFormatter={shortDay}
                tick={{ fontSize: 11, fill: '#8A93A3' }}
                tickLine={false}
                axisLine={false}
                minTickGap={12}
              />
              <YAxis tick={{ fontSize: 11, fill: '#8A93A3' }} tickLine={false} axisLine={false} allowDecimals={false} />
              <Tooltip cursor={{ fill: 'rgba(59,74,159,0.06)' }} content={<TrendTooltip />} />
              {/* bottom to top; the white stroke is the 2px gap between parts */}
              <Bar dataKey="transferClosed" name="Closed" stackId="t" fill={OUTCOME.closed.color} stroke="#fff" strokeWidth={2} maxBarSize={40} />
              <Bar dataKey="transferUnclosed" name="Unclosed" stackId="t" fill={OUTCOME.unclosed.color} stroke="#fff" strokeWidth={2} maxBarSize={40} />
              <Bar
                dataKey="transferOpen"
                name="No closer yet"
                stackId="t"
                fill={OUTCOME.open.color}
                stroke="#fff"
                strokeWidth={2}
                maxBarSize={40}
                radius={[4, 4, 0, 0]}
              />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}

function TrendLegend() {
  return (
    <ul className="hidden items-center gap-3 sm:flex">
      {(Object.keys(OUTCOME) as OutcomeKey[]).map((k) => (
        <li key={k} className="flex items-center gap-1.5 text-2xs text-ink-2">
          <span className="h-2 w-2 rounded-sm" style={{ background: OUTCOME[k].color }} />
          {OUTCOME[k].label}
        </li>
      ))}
    </ul>
  );
}

function TrendTooltip({ active, payload }: { active?: boolean; payload?: { payload: TrendRow }[] }) {
  if (!active || !payload?.length) return null;
  const r = payload[0].payload;
  const rows: [OutcomeKey, number][] = [
    ['closed', r.transferClosed],
    ['unclosed', r.transferUnclosed],
    ['open', r.transferOpen],
  ];
  const otherSales = r.closed - r.transferClosed;
  return (
    <div className="min-w-48 rounded-lg bg-surface p-3 text-xs shadow-card ring-1 ring-ink/10">
      <div className="font-medium text-ink">{longDay(r.day)}</div>
      <div className="mt-0.5 text-2xs text-ink-3">
        {fmt(r.total)} transfers · {pct(r.transferClosed, r.total)}% closed
      </div>
      <ul className="mt-2 space-y-1">
        {rows.map(([k, v]) => (
          <li key={k} className="flex items-center gap-2">
            <span className="h-2 w-2 rounded-sm" style={{ background: OUTCOME[k].color }} />
            <span className="text-ink-2">{OUTCOME[k].label}</span>
            <span className="ml-auto font-medium tabular-nums text-ink">{fmt(v)}</span>
          </li>
        ))}
      </ul>
      {otherSales > 0 && (
        <div className="mt-2 border-t border-ink/10 pt-1.5 text-2xs text-ink-3">
          + {fmt(otherSales)} callback / inbound sale{otherSales === 1 ? '' : 's'}
        </div>
      )}
    </div>
  );
}
