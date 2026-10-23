import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarCheck, Play } from 'lucide-react';
import { api, ApiError } from '../api/client';
import type { PageMeta, QaForm } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { useCompanyScope } from '../components/Layout';
import { Chip, EmptyState, ErrorState, Field, Loading, PageHeader, Pagination, dialerDayIso, fmtDateTime } from '../components/ui';

type Method = 'transfer' | 'unclosed' | 'closed';
const METHOD_LABEL: Record<Method, string> = { transfer: 'Transfer', unclosed: 'Unclosed', closed: 'Closed' };

interface TaskRow {
  task: {
    id: string;
    transferId: string;
    assignedTo: string;
    status: 'open' | 'in_progress' | 'done' | 'cancelled';
    taskDate: string | null;
    queue: Method | null;
    dueAt: string | null;
  };
  reviewerName: string;
  phone: string | null;
  xferTime: string;
  queueStatus: string;
  fronterAgent: string | null;
  fronterUser: string | null;
  closerAgent: string | null;
  closerUser: string | null;
  closerStatus: string | null;
  evaluationId: string | null;
  evaluationPercent: string | null;
  evaluationPassed: boolean | null;
}

interface TaskList {
  tasks: TaskRow[];
  progress: { total: number; done: number; inProgress: number; open: number };
  meta: PageMeta;
}

interface SummaryRow {
  reviewerId: string;
  reviewerName: string;
  taskDate: string;
  queue: Method | null;
  total: number;
  done: number;
  inProgress: number;
}

interface Reviewer {
  id: string;
  name: string;
  status: string;
}

// dates are dialer days (New York), not the reviewer's own calendar
const todayIso = () => dialerDayIso();
const daysAgoIso = (n: number) => dialerDayIso(-n);

function ProgressBar({ done, total }: { done: number; total: number }) {
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  return (
    <div className="flex items-center gap-2">
      <div className="h-2 w-28 overflow-hidden rounded-full bg-bg" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
        <div className={`h-full rounded-full ${pct === 100 ? 'bg-good' : 'bg-brand'}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="font-mono text-2xs tabular-nums text-ink-2">
        {done}/{total}
      </span>
    </div>
  );
}

/** Manager panel: pick reviewer, day, method and amount; see a live count first. */
function AssignPanel({ onAssigned }: { onAssigned: () => void }) {
  const { companyId } = useCompanyScope();
  const [reviewerId, setReviewerId] = useState('');
  const [date, setDate] = useState(daysAgoIso(1));
  const [queue, setQueue] = useState<Method>('transfer');
  const [mode, setMode] = useState<'all' | 'sample'>('sample');
  const [limit, setLimit] = useState(20);
  const [order, setOrder] = useState<'random' | 'oldest'>('random');
  const [skipEvaluated, setSkipEvaluated] = useState(true);
  const [dueDate, setDueDate] = useState('');
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const { data: team } = useQuery({
    queryKey: ['qa-team', companyId],
    queryFn: () => api<{ reviewers: Reviewer[] }>('/qa/team', { query: { companyId: companyId || undefined } }),
  });
  const reviewers = (team?.reviewers ?? []).filter((r) => r.status === 'active');
  useEffect(() => {
    if (!reviewerId && reviewers.length > 0) setReviewerId(reviewers[0].id);
  }, [reviewers, reviewerId]);

  const body = {
    companyId: companyId || undefined,
    reviewerId,
    date,
    queue,
    limit: mode === 'sample' ? limit : null,
    order,
    skipEvaluated,
    dueDate: dueDate || null,
  };

  const preview = useQuery({
    queryKey: ['task-preview', body],
    queryFn: () =>
      api<{
        available: number;
        willAssign: number;
        breakdown?: { inMethod: number; inTask: number; outsideAgents: number; evaluated: number; agentScoped: boolean };
      }>('/qa/tasks/preview', { method: 'POST', body }),
    enabled: !!reviewerId && !!date && (mode === 'all' || limit > 0),
    retry: false,
  });

  const assign = useMutation({
    mutationFn: () => api<{ assigned: number }>('/qa/tasks/assign', { method: 'POST', body }),
    onSuccess: (res) => {
      const who = reviewers.find((r) => r.id === reviewerId)?.name ?? 'reviewer';
      setMessage({
        ok: true,
        text: res.assigned > 0 ? `Assigned ${res.assigned} ${METHOD_LABEL[queue]} call${res.assigned === 1 ? '' : 's'} from ${date} to ${who}.` : 'No calls matched — nothing assigned.',
      });
      void preview.refetch();
      onAssigned();
    },
    onError: (err) => setMessage({ ok: false, text: err instanceof ApiError ? err.message : 'Assigning failed.' }),
  });

  if (team && reviewers.length === 0) {
    return (
      <div className="card p-4 text-sm text-ink-2">
        No active QA reviewers yet. Create them under Users & roles with the QA reviewer role.
      </div>
    );
  }

  return (
    <div className="card p-4">
      <h2 className="mb-3 flex items-center gap-2 font-display text-sm font-bold">
        <CalendarCheck size={16} className="text-brand" /> Assign work
      </h2>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        <Field label="Reviewer">
          <select className="input" value={reviewerId} onChange={(e) => setReviewerId(e.target.value)}>
            {reviewers.map((r) => (
              <option key={r.id} value={r.id}>{r.name}</option>
            ))}
          </select>
        </Field>
        <Field label="Calls from (dialer day)">
          <input type="date" className="input" value={date} max={todayIso()} onChange={(e) => setDate(e.target.value)} />
        </Field>
        <Field label="Method">
          <select className="input" value={queue} onChange={(e) => setQueue(e.target.value as Method)}>
            <option value="transfer">Transfer</option>
            <option value="unclosed">Unclosed</option>
            <option value="closed">Closed</option>
          </select>
        </Field>
        <Field label="How many">
          <div className="flex gap-2">
            <select className="input" value={mode} onChange={(e) => setMode(e.target.value as 'all' | 'sample')}>
              <option value="sample">Sample of</option>
              <option value="all">All calls</option>
            </select>
            {mode === 'sample' && (
              <input
                type="number"
                min={1}
                max={2000}
                className="input w-20"
                value={limit}
                onChange={(e) => setLimit(Math.max(1, Number(e.target.value) || 1))}
                aria-label="Number of calls"
              />
            )}
          </div>
        </Field>
        <Field label="Pick">
          <select className="input" value={order} onChange={(e) => setOrder(e.target.value as 'random' | 'oldest')}>
            <option value="random">Random calls</option>
            <option value="oldest">Earliest first</option>
          </select>
        </Field>
        <Field label="Due (optional)">
          <input type="date" className="input" value={dueDate} min={todayIso()} onChange={(e) => setDueDate(e.target.value)} />
        </Field>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-1.5 text-sm text-ink-2">
          <input type="checkbox" checked={skipEvaluated} onChange={(e) => setSkipEvaluated(e.target.checked)} />
          Skip calls already evaluated with this method
        </label>
        <span className="text-sm">
          {preview.isFetching ? (
            <span className="text-ink-3">Counting…</span>
          ) : preview.error ? (
            <span className="text-bad">{preview.error instanceof ApiError ? preview.error.message : 'Preview failed.'}</span>
          ) : preview.data ? (
            <>
              <strong className="tabular-nums">{preview.data.available}</strong> unassigned call
              {preview.data.available === 1 ? '' : 's'} match ·{' '}
              <strong className="tabular-nums">{preview.data.willAssign}</strong> will be assigned
              {preview.data.breakdown && preview.data.breakdown.inMethod > preview.data.available && (
                <span className="ml-2 text-2xs text-ink-3">
                  {preview.data.breakdown.inMethod} {METHOD_LABEL[queue]} calls that day
                  {preview.data.breakdown.inTask > 0 && ` · ${preview.data.breakdown.inTask} already in a ${METHOD_LABEL[queue]} task`}
                  {preview.data.breakdown.outsideAgents > 0 &&
                    ` · ${preview.data.breakdown.outsideAgents} outside this reviewer's agents (QA team)`}
                  {preview.data.breakdown.evaluated > 0 && ` · ${preview.data.breakdown.evaluated} already evaluated`}
                </span>
              )}
            </>
          ) : null}
        </span>
        <button
          className="btn-primary ml-auto"
          disabled={!reviewerId || assign.isPending || !preview.data || preview.data.willAssign === 0}
          onClick={() => assign.mutate()}
        >
          {assign.isPending ? 'Assigning…' : `Assign ${preview.data?.willAssign ?? ''} calls`}
        </button>
      </div>
      {message && (
        <div className={`mt-3 rounded-md px-3 py-2 text-sm ${message.ok ? 'bg-good-soft text-good' : 'bg-bad-soft text-bad'}`}>
          {message.text}
        </div>
      )}
    </div>
  );
}

function TeamBoard({ refreshKey }: { refreshKey: number }) {
  const { companyId } = useCompanyScope();
  const queryClient = useQueryClient();
  const [from, setFrom] = useState(daysAgoIso(7));
  const [to, setTo] = useState(todayIso());
  const { data, isLoading } = useQuery({
    queryKey: ['task-summary', companyId, from, to, refreshKey],
    queryFn: () =>
      api<{ rows: SummaryRow[] }>('/qa/tasks/summary', {
        query: { companyId: companyId || undefined, dateFrom: from, dateTo: to },
      }),
  });
  const cancel = useMutation({
    mutationFn: (r: SummaryRow) =>
      api('/qa/tasks/cancel', {
        method: 'POST',
        body: { companyId: companyId || undefined, reviewerId: r.reviewerId, date: r.taskDate, queue: r.queue ?? undefined },
      }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['task-summary'] }),
  });

  return (
    <div className="card p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-display text-sm font-bold">Team progress</h2>
        <div className="flex items-center gap-2">
          <input type="date" className="input w-40" value={from} max={to} onChange={(e) => setFrom(e.target.value)} aria-label="From task day" />
          <input type="date" className="input w-40" value={to} min={from} onChange={(e) => setTo(e.target.value)} aria-label="To task day" />
        </div>
      </div>
      {isLoading ? (
        <Loading />
      ) : !data || data.rows.length === 0 ? (
        <p className="py-6 text-center text-sm text-ink-2">No tasks assigned for these days yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b border-ink/10">
              <tr>
                <th className="th">Reviewer</th>
                <th className="th">Calls from</th>
                <th className="th">Method</th>
                <th className="th">Progress</th>
                <th className="th">In progress</th>
                <th className="th"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink/5">
              {data.rows.map((r) => (
                <tr key={`${r.reviewerId}-${r.taskDate}-${r.queue}`}>
                  <td className="td font-medium">{r.reviewerName}</td>
                  <td className="td font-mono text-2xs">{r.taskDate}</td>
                  <td className="td">{r.queue ? <Chip value={r.queue} label={METHOD_LABEL[r.queue]} /> : '—'}</td>
                  <td className="td"><ProgressBar done={r.done} total={r.total} /></td>
                  <td className="td font-mono text-2xs tabular-nums">{r.inProgress}</td>
                  <td className="td text-right">
                    {r.done < r.total && (
                      <button
                        className="text-2xs font-medium text-bad hover:underline"
                        disabled={cancel.isPending}
                        onClick={() => cancel.mutate(r)}
                      >
                        Withdraw unfinished
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function TaskTable({ isManager, refreshKey }: { isManager: boolean; refreshKey: number }) {
  const { companyId } = useCompanyScope();
  const navigate = useNavigate();
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState<string>('active');
  const [queue, setQueue] = useState('');
  const [reviewerId, setReviewerId] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [startError, setStartError] = useState<string | null>(null);

  useEffect(() => setPage(1), [status, queue, reviewerId, from, to, companyId]);

  const { data: team } = useQuery({
    queryKey: ['qa-team', companyId],
    queryFn: () => api<{ reviewers: Reviewer[] }>('/qa/team', { query: { companyId: companyId || undefined } }),
    enabled: isManager,
  });
  const { data: forms } = useQuery({
    queryKey: ['forms-published', companyId],
    queryFn: () => api<{ forms: QaForm[] }>('/qa/forms', { query: { companyId: companyId || undefined, state: 'published' } }),
    staleTime: 60_000,
  });

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['tasks', companyId, page, status, queue, reviewerId, from, to, refreshKey],
    queryFn: () =>
      api<TaskList>('/qa/tasks', {
        query: {
          companyId: companyId || undefined,
          page,
          pageSize: 25,
          status: status || undefined,
          queue: queue || undefined,
          reviewerId: reviewerId || undefined,
          dateFrom: from || undefined,
          dateTo: to || undefined,
        },
      }),
    placeholderData: keepPreviousData,
  });

  const start = useMutation({
    mutationFn: async (row: TaskRow) => {
      const form = forms?.forms.find((f) => f.queue === row.task.queue) ?? forms?.forms.find((f) => !f.queue);
      if (!form) throw new Error('No published form exists for this method yet.');
      return api<{ evaluation: { id: string } }>('/evaluations', {
        method: 'POST',
        body: { transferId: row.task.transferId, formId: form.id },
      });
    },
    onSuccess: (res) => navigate(`/qa/evaluations/${res.evaluation.id}`),
    onError: (err) => setStartError(err instanceof Error ? err.message : 'Could not start the evaluation.'),
  });

  const agentOf = (r: TaskRow) =>
    r.task.queue === 'transfer'
      ? (r.fronterAgent ?? r.fronterUser ?? '—')
      : (r.closerAgent ?? r.closerUser ?? '—');

  return (
    <div className="card overflow-hidden">
      <div className="flex flex-wrap items-end gap-3 border-b border-ink/10 p-3">
        <select className="input w-40" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status">
          <option value="active">To do</option>
          <option value="open">Not started</option>
          <option value="in_progress">In progress</option>
          <option value="done">Done</option>
          <option value="cancelled">Withdrawn</option>
          <option value="">All</option>
        </select>
        <select className="input w-36" value={queue} onChange={(e) => setQueue(e.target.value)} aria-label="Method">
          <option value="">All methods</option>
          <option value="transfer">Transfer</option>
          <option value="unclosed">Unclosed</option>
          <option value="closed">Closed</option>
        </select>
        {isManager && (
          <select className="input w-44" value={reviewerId} onChange={(e) => setReviewerId(e.target.value)} aria-label="Reviewer">
            <option value="">All reviewers</option>
            {team?.reviewers.map((r) => (
              <option key={r.id} value={r.id}>{r.name}</option>
            ))}
          </select>
        )}
        <input type="date" className="input w-40" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} aria-label="Calls from" />
        <input type="date" className="input w-40" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} aria-label="Calls to" />
        {data && (
          <div className="ml-auto flex items-center gap-3 text-2xs text-ink-2">
            <ProgressBar done={data.progress.done} total={data.progress.total} />
            <span>{data.progress.inProgress} in progress · {data.progress.open} not started</span>
          </div>
        )}
      </div>
      {startError && <div className="bg-bad-soft px-3 py-2 text-sm text-bad">{startError}</div>}
      {isLoading ? (
        <Loading />
      ) : isError || !data ? (
        <ErrorState message="Tasks could not load." onRetry={() => void refetch()} />
      ) : data.tasks.length === 0 ? (
        <EmptyState
          title={status === 'active' ? 'Nothing to do right now' : 'No tasks match'}
          hint={isManager ? 'Assign a day of calls above.' : 'Your manager assigns calls here when work is ready.'}
        />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b border-ink/10">
              <tr>
                <th className="th">Number</th>
                <th className="th">Agent</th>
                <th className="th">Method</th>
                <th className="th">Call time</th>
                {isManager && <th className="th">Reviewer</th>}
                <th className="th">Status</th>
                <th className="th">Score</th>
                <th className="th"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink/5">
              {data.tasks.map((r) => {
                const overdue = r.task.dueAt && r.task.status !== 'done' && new Date(r.task.dueAt) < new Date();
                return (
                  <tr key={r.task.id} className="hover:bg-bg/60">
                    <td className="td font-mono">{r.phone ?? '—'}</td>
                    <td className="td font-medium">{agentOf(r)}</td>
                    <td className="td">{r.task.queue ? <Chip value={r.task.queue} label={METHOD_LABEL[r.task.queue]} /> : '—'}</td>
                    <td className="td font-mono text-2xs">{fmtDateTime(r.xferTime)}</td>
                    {isManager && <td className="td">{r.reviewerName}</td>}
                    <td className="td">
                      <span className="flex items-center gap-1.5">
                        <Chip
                          value={r.task.status === 'in_progress' ? 'running' : r.task.status === 'done' ? 'completed' : r.task.status === 'cancelled' ? 'disabled' : 'pending'}
                          label={r.task.status === 'in_progress' ? 'in progress' : r.task.status === 'cancelled' ? 'withdrawn' : r.task.status === 'open' ? 'not started' : 'evaluated'}
                        />
                        {overdue && <span className="chip bg-bad-soft text-bad">overdue</span>}
                      </span>
                    </td>
                    <td className="td font-mono tabular-nums">
                      {r.evaluationPercent !== null ? (
                        <span className={r.evaluationPassed ? 'text-good' : 'text-bad'}>
                          {Math.round(Number(r.evaluationPercent))}%
                        </span>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="td text-right">
                      {r.evaluationId ? (
                        <Link to={`/qa/evaluations/${r.evaluationId}`} className="font-medium text-brand hover:underline">
                          {r.task.status === 'done' ? 'View score' : 'Continue'}
                        </Link>
                      ) : r.task.status === 'open' && !isManager ? (
                        <button className="btn-primary px-2 py-1 text-2xs" onClick={() => start.mutate(r)} disabled={start.isPending}>
                          <Play size={12} /> Start
                        </button>
                      ) : (
                        <Link to={`/transfers/${r.task.transferId}${r.task.queue ? `?from=${r.task.queue}` : ''}`} className="font-medium text-brand hover:underline">
                          Open call
                        </Link>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <Pagination meta={data.meta} onPage={setPage} />
        </div>
      )}
    </div>
  );
}

export function QaTasksPage() {
  const { hasPerm } = useAuth();
  const isManager = hasPerm('qa.assign');
  const [refreshKey, setRefreshKey] = useState(0);
  return (
    <div className="space-y-4">
      <PageHeader
        title={isManager ? 'QA tasks' : 'My tasks'}
        subtitle={
          isManager
            ? 'Hand out a day of calls to each reviewer and follow their progress'
            : 'Calls your manager assigned to you — start each one to score it while you listen'
        }
      />
      {isManager && <AssignPanel onAssigned={() => setRefreshKey((k) => k + 1)} />}
      {isManager && <TeamBoard refreshKey={refreshKey} />}
      <TaskTable isManager={isManager} refreshKey={refreshKey} />
    </div>
  );
}
