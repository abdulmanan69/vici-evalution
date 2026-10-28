import { useState } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PlayCircle } from 'lucide-react';
import { api } from '../../api/client';
import type { PageMeta, SyncJob } from '../../api/types';
import { useCompanyScope } from '../../components/Layout';
import { Chip, ErrorState, Loading, PageHeader, Pagination, fmtDateTime } from '../../components/ui';
import { SyncProgressView } from '../../components/SyncProgress';

interface DialerStatus {
  dialerServerId: string;
  name: string;
  active: boolean;
  sourceMode: string;
  lastSeenAt: string | null;
  timezone: string;
  tzOffsetMin: number | null;
  clockDriftSec: number | null;
  timeCheckedAt: string | null;
  /** when the last 7 days were last fully imported; null = still importing */
  backfilledAt?: string | null;
  lastJob: SyncJob | null;
  /** the sync in flight right now, with its live progress */
  runningJob: SyncJob | null;
  cursors: { stream: string; lastTimestamp: string | null }[];
}

const STAGE_LABELS: Record<string, string> = {
  roster: 'agents & campaigns',
  calls: 'outbound calls',
  closer_calls: 'closer calls',
  recordings: 'recording log',
  dispositions: 'dispositions',
  api_calls: 'API calls',
  api_recordings: 'recording lookups',
  transfers: 'transfers',
  matching: 'matching',
  sales: 'sales',
  queues: 'queues',
};

/** How long a finished sync took, in seconds. */
function tookSeconds(job: SyncJob): number | null {
  if (!job.startedAt || !job.finishedAt) return null;
  return Math.max(0, Math.round((Date.parse(job.finishedAt) - Date.parse(job.startedAt)) / 1000));
}

/** Where a finished sync spent its time — the three slowest stages. */
function slowestStages(job: SyncJob): string | null {
  const stages = job.stats?.stageSeconds as Record<string, number> | undefined;
  if (!stages) return null;
  const top = Object.entries(stages)
    .filter(([, s]) => s >= 0.5)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([k, s]) => `${STAGE_LABELS[k] ?? k} ${s.toFixed(1)}s`);
  return top.length ? `slowest: ${top.join(' · ')}` : null;
}

/**
 * Whether the dialer's history is in: a new dialer (or one whose disposition
 * meanings changed) first imports the whole retention window, resuming after
 * any interruption, then settles into minute-by-minute syncs.
 */
function BackfillStatus({ s }: { s: DialerStatus }) {
  if (!s.active) return null;
  if (s.backfilledAt) {
    return (
      <div className="mt-2 flex items-center gap-2 text-2xs">
        <span className="chip bg-good-soft text-good">last 7 days imported</span>
        <span className="text-ink-3">{fmtDateTime(s.backfilledAt)}</span>
      </div>
    );
  }
  const resume = s.cursors
    .filter((c) => c.stream.startsWith('backfill:') && c.lastTimestamp)
    .map((c) => c.lastTimestamp as string)
    .sort()
    .pop();
  const importing = s.runningJob?.jobType === 'full';
  const failing = !importing && s.lastJob?.status === 'failed';
  return (
    <div className="mt-2 rounded-md bg-amber-soft px-2 py-1.5 text-2xs text-amber-line">
      <span className="font-semibold">{importing ? 'Importing the last 7 days' : 'Last 7 days not imported yet'}</span>
      {' — '}
      {importing
        ? 'queues fill in as it goes; nothing to click.'
        : failing
          ? 'it keeps retrying on its own and continues where it stopped; the problem is shown below.'
          : 'the import starts on its own within a minute and continues where it stopped.'}
      {resume && <span className="text-ink-3"> Reached {fmtDateTime(resume)}.</span>}
    </div>
  );
}

function fmtOffset(min: number): string {
  const sign = min < 0 ? '-' : '+';
  const abs = Math.abs(min);
  return `UTC${sign}${Math.floor(abs / 60)}${abs % 60 ? `:${String(abs % 60).padStart(2, '0')}` : ''}`;
}

export function SyncMonitorPage() {
  const { companyId } = useCompanyScope();
  const queryClient = useQueryClient();
  const [page, setPage] = useState(1);

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['sync-status', companyId],
    queryFn: () => api<{ statuses: DialerStatus[] }>('/sync/status', { query: { companyId: companyId || undefined } }),
    // every 4 s while a sync is running, otherwise 15 s
    refetchInterval: (q) => (q.state.data?.statuses.some((s) => s.runningJob) ? 4_000 : 15_000),
  });

  const { data: jobs } = useQuery({
    queryKey: ['sync-jobs', companyId, page],
    queryFn: () =>
      api<{ jobs: { job: SyncJob; dialerName: string }[]; meta: PageMeta }>('/sync/jobs', {
        query: { companyId: companyId || undefined, page, pageSize: 25 },
      }),
    placeholderData: keepPreviousData,
    refetchInterval: 15_000,
  });

  const runAll = useMutation({
    mutationFn: () => api('/sync/run', { method: 'POST', body: { companyId: companyId || undefined } }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['sync-jobs'] }),
  });

  return (
    <div>
      <PageHeader
        title="Sync monitor"
        subtitle="Per-dialer synchronization health, cursors and job history — refreshes every 15s"
        actions={
          <button className="btn-primary" onClick={() => runAll.mutate()} disabled={runAll.isPending}>
            <PlayCircle size={14} /> Sync all active dialers
          </button>
        }
      />

      {isLoading ? (
        <Loading />
      ) : isError || !data ? (
        <ErrorState message="Sync status could not load." onRetry={() => void refetch()} />
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {data.statuses.map((s) => (
            <div key={s.dialerServerId} className="card p-4">
              <div className="flex items-center justify-between">
                <span className="font-display font-bold">{s.name}</span>
                <div className="flex gap-1.5">
                  <span className="chip bg-bg text-ink-2">{s.sourceMode}</span>
                  <Chip value={s.active ? 'active' : 'disabled'} label={s.active ? 'active' : 'inactive'} />
                </div>
              </div>
              <div className="mt-2 text-2xs text-ink-2">
                Last successful contact: <span className="font-mono">{fmtDateTime(s.lastSeenAt)}</span>
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-2 text-2xs text-ink-2">
                <span>
                  Dialer clock:{' '}
                  {s.tzOffsetMin != null ? (
                    <span className="font-mono">{fmtOffset(s.tzOffsetMin)}</span>
                  ) : (
                    'not checked yet'
                  )}
                  {s.timeCheckedAt && <span className="text-ink-3"> · checked {fmtDateTime(s.timeCheckedAt)}</span>}
                </span>
                {s.clockDriftSec != null &&
                  (Math.abs(s.clockDriftSec) > 90 ? (
                    <span className="chip bg-amber-soft text-amber-line">drift {s.clockDriftSec}s</span>
                  ) : (
                    <span className="chip bg-good-soft text-good">clock in sync</span>
                  ))}
              </div>
              <BackfillStatus s={s} />
              {s.runningJob && (
                <div className="mt-3">
                  <SyncProgressView job={s.runningJob} />
                </div>
              )}
              {s.lastJob && !s.runningJob && (
                <div className="mt-1 flex items-center gap-2 text-2xs">
                  <Chip value={s.lastJob.status} />
                  <span className="font-mono text-ink-3">
                    {s.lastJob.jobType} · {fmtDateTime(s.lastJob.createdAt)}
                  </span>
                </div>
              )}
              {s.lastJob?.status === 'failed' && s.lastJob.error && !s.runningJob && (
                <div className="mt-2 rounded-md bg-bad-soft px-2 py-1.5 text-2xs text-bad">
                  <div className="font-mono">{s.lastJob.error}</div>
                  <div className="mt-0.5 text-ink-2">
                    It tries again on its own{s.backfilledAt ? ' within a minute' : ' within a few minutes, continuing where it stopped'}.
                  </div>
                </div>
              )}
              {s.cursors.filter((c) => !c.stream.startsWith('backfill:')).length > 0 && (
                <div className="mt-2 space-y-0.5">
                  {s.cursors
                    .filter((c) => !c.stream.startsWith('backfill:'))
                    .map((c) => (
                      <div key={c.stream} className="flex justify-between font-mono text-2xs text-ink-3">
                        <span>{c.stream}</span>
                        <span>{fmtDateTime(c.lastTimestamp)}</span>
                      </div>
                    ))}
                </div>
              )}
            </div>
          ))}
          {data.statuses.length === 0 && (
            <p className="text-sm text-ink-2">No dialers in scope. Add one under Dialer servers.</p>
          )}
        </div>
      )}

      {jobs && (
        <div className="card mt-4 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b border-ink/10">
              <tr>
                <th className="th">Queued</th>
                <th className="th">Dialer</th>
                <th className="th">Type</th>
                <th className="th">Status</th>
                <th className="th">Took</th>
                <th className="th">Result</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink/5">
              {jobs.jobs.map(({ job, dialerName }) => (
                <tr key={job.id} className="hover:bg-bg/60">
                  <td className="td font-mono text-2xs">{fmtDateTime(job.createdAt)}</td>
                  <td className="td">{dialerName}</td>
                  <td className="td font-mono text-2xs">{job.jobType}</td>
                  <td className="td">
                    <Chip value={job.status} />
                  </td>
                  <td className="td font-mono text-2xs text-ink-2">
                    {tookSeconds(job) != null ? `${tookSeconds(job)}s` : '—'}
                  </td>
                  <td
                    className="td max-w-md truncate font-mono text-2xs text-ink-2"
                    title={job.stats ? JSON.stringify(job.stats, null, 1) : undefined}
                  >
                    {job.status === 'running' && job.progress
                      ? `${job.progress.percent.toFixed(0)}% · ${job.progress.label}${job.progress.detail ? ` · ${job.progress.detail}` : ''}`
                      : (job.error ?? slowestStages(job) ?? (job.stats ? JSON.stringify(job.stats) : '—'))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <Pagination meta={jobs.meta} onPage={setPage} />
        </div>
      )}
    </div>
  );
}
