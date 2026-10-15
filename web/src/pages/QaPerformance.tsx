import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, Download } from 'lucide-react';
import { api } from '../api/client';
import type { QaForm } from '../api/types';
import { useCompanyScope } from '../components/Layout';
import { EmptyState, ErrorState, Loading, PageHeader, StatTile } from '../components/ui';

type GroupBy = 'agent' | 'reviewer';

interface PerfRow {
  id: string | null;
  name: string;
  user: string | null;
  role: string | null;
  evaluations: number;
  avgPercent: number | null;
  lowest: number | null;
  highest: number | null;
  passed: number;
  failed: number;
  autoFailed: number;
  passRate: number;
  transferEvals: number;
  unclosedEvals: number;
  closedEvals: number;
  tasks?: number;
  tasksDone?: number;
  tasksLate?: number;
  taskCompletion?: number;
}

interface PerfResponse {
  dateFrom: string;
  dateTo: string;
  timezone: string;
  summary: {
    evaluations: number;
    avgPercent: number | null;
    passRate: number;
    autoFailed: number;
    people: number;
    tasks: number;
    tasksDone: number;
  };
  rows: PerfRow[];
}

const today = () => new Date().toISOString().slice(0, 10);
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

type SortKey = 'name' | 'evaluations' | 'avgPercent' | 'passRate' | 'autoFailed' | 'taskCompletion';

function scoreTone(v: number | null): string {
  if (v === null) return 'text-ink-3';
  if (v >= 90) return 'text-good';
  if (v >= 70) return 'text-ink';
  return 'text-bad';
}

export function QaPerformancePage() {
  const { companyId } = useCompanyScope();
  const navigate = useNavigate();
  const [groupBy, setGroupBy] = useState<GroupBy>('agent');
  const [preset, setPreset] = useState<'7' | '15' | '30' | 'custom'>('7');
  const [from, setFrom] = useState(daysAgo(6));
  const [to, setTo] = useState(today());
  const [formId, setFormId] = useState('');
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'evaluations', dir: -1 });

  const range =
    preset === 'custom' ? { dateFrom: from, dateTo: to } : { dateFrom: daysAgo(Number(preset) - 1), dateTo: today() };

  const { data: forms } = useQuery({
    queryKey: ['forms', companyId],
    queryFn: () => api<{ forms: QaForm[] }>('/qa/forms', { query: { companyId: companyId || undefined } }),
    staleTime: 60_000,
  });

  const params = {
    companyId: companyId || undefined,
    groupBy,
    formId: formId || undefined,
    ...range,
  };
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['qa-performance', params],
    queryFn: () => api<PerfResponse>('/reports/qa-performance', { query: params }),
    enabled: range.dateFrom <= range.dateTo,
    placeholderData: keepPreviousData,
  });

  const rows = useMemo(() => {
    const list = [...(data?.rows ?? [])];
    list.sort((a, b) => {
      const av = a[sort.key] ?? -1;
      const bv = b[sort.key] ?? -1;
      if (typeof av === 'string' || typeof bv === 'string') return String(av).localeCompare(String(bv)) * sort.dir;
      return ((av as number) - (bv as number)) * sort.dir;
    });
    return list;
  }, [data, sort]);

  const csvHref = `/api/v1/reports/qa-performance?${new URLSearchParams(
    Object.entries({ ...params, format: 'csv' }).filter(([, v]) => v !== undefined) as Array<[string, string]>,
  ).toString()}`;

  const Th = ({ k, children, right }: { k: SortKey; children: React.ReactNode; right?: boolean }) => (
    <th className={`th ${right ? 'text-right' : ''}`}>
      <button
        className="inline-flex items-center gap-1 uppercase hover:text-ink"
        onClick={() => setSort((s) => ({ key: k, dir: s.key === k ? (s.dir === 1 ? -1 : 1) : k === 'name' ? 1 : -1 }))}
      >
        {children}
        {sort.key === k && (sort.dir === 1 ? <ArrowUp size={11} /> : <ArrowDown size={11} />)}
      </button>
    </th>
  );

  const drill = (r: PerfRow) => {
    if (groupBy !== 'agent' || !r.user) return;
    const qs = new URLSearchParams({ agent: r.user, dateFrom: range.dateFrom, dateTo: range.dateTo });
    navigate(`/qa/evaluations?${qs.toString()}`);
  };

  const s = data?.summary;
  return (
    <div>
      <PageHeader
        title="QA performance"
        subtitle={
          data
            ? `${data.dateFrom === data.dateTo ? data.dateFrom : `${data.dateFrom} → ${data.dateTo}`} · dialer time (${data.timezone})`
            : 'Scores and pass rates by agent and by reviewer'
        }
        actions={
          <a href={csvHref} className="btn-secondary" download>
            <Download size={14} /> Export CSV
          </a>
        }
      />

      <div className="card mb-3 flex flex-wrap items-end gap-3 p-3">
        <div className="flex rounded-md bg-bg p-0.5" role="tablist">
          {(['agent', 'reviewer'] as GroupBy[]).map((g) => (
            <button
              key={g}
              role="tab"
              aria-selected={groupBy === g}
              onClick={() => setGroupBy(g)}
              className={`rounded px-3 py-1 text-sm font-medium ${groupBy === g ? 'bg-surface text-brand shadow-card' : 'text-ink-2 hover:text-ink'}`}
            >
              By {g}
            </button>
          ))}
        </div>
        <select className="input w-36" value={preset} onChange={(e) => setPreset(e.target.value as typeof preset)} aria-label="Range">
          <option value="7">Last 7 days</option>
          <option value="15">Last 15 days</option>
          <option value="30">Last 30 days</option>
          <option value="custom">Custom range</option>
        </select>
        {preset === 'custom' && (
          <>
            <input type="date" className="input w-40" value={from} max={to} onChange={(e) => setFrom(e.target.value)} aria-label="From" />
            <input type="date" className="input w-40" value={to} min={from} onChange={(e) => setTo(e.target.value)} aria-label="To" />
          </>
        )}
        <select className="input w-56" value={formId} onChange={(e) => setFormId(e.target.value)} aria-label="Form">
          <option value="">All methods</option>
          {forms?.forms.map((f) => (
            <option key={f.id} value={f.id}>{f.name}</option>
          ))}
        </select>
      </div>

      {s && (
        <div className="mb-3 grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-6">
          <StatTile label="Evaluations" value={s.evaluations.toLocaleString()} sub="completed in range" />
          <StatTile
            label="Average score"
            value={s.avgPercent !== null ? `${s.avgPercent}%` : '—'}
            accent={s.avgPercent !== null && s.avgPercent < 70 ? 'bad' : undefined}
            sub="weighted by evaluations"
          />
          <StatTile label="Pass rate" value={`${s.passRate}%`} accent={s.passRate >= 80 ? 'good' : s.passRate < 50 ? 'bad' : undefined} sub="passed / evaluated" />
          <StatTile label="Auto-fails" value={s.autoFailed} accent={s.autoFailed > 0 ? 'bad' : undefined} sub="critical misses" />
          <StatTile label={groupBy === 'agent' ? 'Agents evaluated' : 'Active reviewers'} value={s.people} />
          {groupBy === 'reviewer' && (
            <StatTile
              label="Tasks done"
              value={s.tasks > 0 ? `${s.tasksDone}/${s.tasks}` : '—'}
              accent={s.tasks > 0 && s.tasksDone === s.tasks ? 'good' : undefined}
              sub="assigned in range"
            />
          )}
        </div>
      )}

      {isLoading ? (
        <Loading />
      ) : isError || !data ? (
        <ErrorState message="The report could not load." onRetry={() => void refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState title="No completed evaluations in this range" hint="Widen the range or pick another method." />
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b border-ink/10">
              <tr>
                <Th k="name">{groupBy === 'agent' ? 'Agent' : 'Reviewer'}</Th>
                <Th k="evaluations" right>Evaluations</Th>
                <Th k="avgPercent" right>Avg score</Th>
                <th className="th text-right">Range</th>
                <Th k="passRate" right>Pass rate</Th>
                <th className="th text-right">Pass / fail</th>
                <Th k="autoFailed" right>Auto-fail</Th>
                <th className="th text-right">Transfer</th>
                <th className="th text-right">Unclosed</th>
                <th className="th text-right">Closed</th>
                {groupBy === 'reviewer' && (
                  <>
                    <Th k="taskCompletion" right>Tasks</Th>
                    <th className="th text-right">Late</th>
                  </>
                )}
              </tr>
            </thead>
            <tbody className="divide-y divide-ink/5">
              {rows.map((r) => (
                <tr
                  key={r.id ?? r.name}
                  className={groupBy === 'agent' && r.user ? 'cursor-pointer hover:bg-bg/60' : ''}
                  onClick={() => drill(r)}
                  title={groupBy === 'agent' && r.user ? 'Open these evaluations' : undefined}
                >
                  <td className="td">
                    <div className="font-medium">{r.name}</div>
                    {r.user && <div className="font-mono text-2xs text-ink-3">{r.user}</div>}
                  </td>
                  <td className="td text-right font-mono tabular-nums">{r.evaluations}</td>
                  <td className={`td text-right font-mono font-semibold tabular-nums ${scoreTone(r.avgPercent)}`}>
                    {r.avgPercent !== null ? `${r.avgPercent}%` : '—'}
                  </td>
                  <td className="td text-right font-mono text-2xs tabular-nums text-ink-3">
                    {r.lowest !== null && r.highest !== null ? `${Math.round(r.lowest)}–${Math.round(r.highest)}%` : '—'}
                  </td>
                  <td className="td text-right">
                    <div className="ml-auto flex w-32 items-center gap-2">
                      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-bg">
                        <div
                          className={`h-full rounded-full ${r.passRate >= 80 ? 'bg-good' : r.passRate < 50 ? 'bg-bad' : 'bg-brand'}`}
                          style={{ width: `${r.passRate}%` }}
                        />
                      </div>
                      <span className="w-12 text-right font-mono text-2xs tabular-nums">{r.passRate}%</span>
                    </div>
                  </td>
                  <td className="td text-right font-mono text-2xs tabular-nums">
                    <span className="text-good">{r.passed}</span> / <span className="text-bad">{r.failed}</span>
                  </td>
                  <td className={`td text-right font-mono tabular-nums ${r.autoFailed > 0 ? 'font-semibold text-bad' : 'text-ink-3'}`}>
                    {r.autoFailed}
                  </td>
                  <td className="td text-right font-mono tabular-nums text-ink-2">{r.transferEvals || '—'}</td>
                  <td className="td text-right font-mono tabular-nums text-ink-2">{r.unclosedEvals || '—'}</td>
                  <td className="td text-right font-mono tabular-nums text-ink-2">{r.closedEvals || '—'}</td>
                  {groupBy === 'reviewer' && (
                    <>
                      <td className="td text-right font-mono text-2xs tabular-nums">
                        {r.tasks ? `${r.tasksDone}/${r.tasks} · ${r.taskCompletion}%` : '—'}
                      </td>
                      <td className={`td text-right font-mono tabular-nums ${r.tasksLate ? 'text-bad' : 'text-ink-3'}`}>
                        {r.tasksLate ?? 0}
                      </td>
                    </>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {groupBy === 'agent' && rows.length > 0 && (
        <p className="mt-2 text-2xs text-ink-3">
          Click an agent to open their evaluations for this range. Transfer methods score the fronter; Unclosed and
          Closed score the closer.
        </p>
      )}
    </div>
  );
}
