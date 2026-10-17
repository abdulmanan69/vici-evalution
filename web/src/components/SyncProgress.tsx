import type { SyncProgress } from '../api/types';

/** "about 18 min left" from a seconds estimate */
export function fmtEta(sec: number | null | undefined): string {
  if (sec == null) return 'estimating time left…';
  if (sec < 60) return 'under a minute left';
  const m = Math.round(sec / 60);
  if (m < 60) return `about ${m} min left`;
  const h = Math.floor(m / 60);
  return `about ${h} h ${m % 60} min left`;
}

/**
 * A running sync: stage, live detail, percent bar and time left. The server
 * updates sync_jobs.progress every couple of seconds; the pages poll it.
 */
export function SyncProgressView({
  job,
  dialerName,
  compact,
}: {
  job: { jobType: string; progress: SyncProgress | null };
  dialerName?: string;
  compact?: boolean;
}) {
  const p = job.progress;
  const pct = p?.percent ?? 0;
  const title = job.jobType === 'full' ? 'Importing from the dialer' : 'Syncing with the dialer';
  return (
    <div className={compact ? '' : 'rounded-lg border border-brand/30 bg-brand-soft/40 p-3'}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
        <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-brand" />
        <span className="font-medium">
          {title}
          {dialerName ? ` — ${dialerName}` : ''}
        </span>
        <span className="text-ink-2">{p?.label ?? 'Starting…'}</span>
        {p?.detail && <span className="font-mono text-2xs text-ink-3">{p.detail}</span>}
        <span className="ml-auto font-mono text-sm tabular-nums">{pct.toFixed(0)}%</span>
        <span className="text-2xs text-ink-2">{fmtEta(p?.etaSeconds)}</span>
      </div>
      <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-ink/10">
        <div
          className="h-full rounded-full bg-brand transition-all duration-700"
          style={{ width: `${Math.max(2, Math.min(100, pct))}%` }}
        />
      </div>
      {!compact && (
        <p className="mt-1.5 text-2xs text-ink-3">
          Queues and the dashboard fill in as the import progresses — nothing to do until it reaches 100%.
        </p>
      )}
    </div>
  );
}
