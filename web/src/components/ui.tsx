import type { ReactNode } from 'react';
import { AlertTriangle, Inbox, Loader2 } from 'lucide-react';
import type { PageMeta } from '../api/types';

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="font-display text-xl font-bold tracking-tight">{title}</h1>
        {subtitle && <p className="mt-0.5 text-sm text-ink-2">{subtitle}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}

const CHIP_STYLES: Record<string, string> = {
  transfer: 'bg-info-soft text-info',
  unclosed: 'bg-amber-soft text-amber-line',
  closed: 'bg-good-soft text-good',
  pending_match: 'bg-bg text-ink-2',
  matched: 'bg-good-soft text-good',
  flagged: 'bg-amber-soft text-amber-line',
  unmatched: 'bg-bad-soft text-bad',
  available: 'bg-good-soft text-good',
  pending: 'bg-bg text-ink-2',
  missing: 'bg-bad-soft text-bad',
  error: 'bg-bad-soft text-bad',
  draft: 'bg-bg text-ink-2',
  published: 'bg-good-soft text-good',
  archived: 'bg-bg text-ink-3',
  completed: 'bg-good-soft text-good',
  success: 'bg-good-soft text-good',
  failed: 'bg-bad-soft text-bad',
  running: 'bg-info-soft text-info',
  queued: 'bg-bg text-ink-2',
  active: 'bg-good-soft text-good',
  disabled: 'bg-bg text-ink-3',
  sale: 'bg-good-soft text-good',
  no_sale: 'bg-bad-soft text-bad',
  callback: 'bg-info-soft text-info',
  dnc: 'bg-bad-soft text-bad',
  other: 'bg-bg text-ink-2',
  fronter: 'bg-info-soft text-info',
  closer: 'bg-brand-soft text-brand',
  blended: 'bg-amber-soft text-amber-line',
  unknown: 'bg-bg text-ink-3',
};

export function Chip({ value, label }: { value: string; label?: string }) {
  return (
    <span className={`chip ${CHIP_STYLES[value] ?? 'bg-bg text-ink-2'}`}>
      {(label ?? value).replace(/_/g, ' ')}
    </span>
  );
}

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="card flex items-center justify-center gap-2 p-10 text-ink-2">
      <Loader2 size={16} className="animate-spin" /> {label}
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="card flex flex-col items-center gap-2 p-10 text-center">
      <AlertTriangle size={20} className="text-bad" />
      <p className="text-sm text-ink-2">{message}</p>
      {onRetry && (
        <button onClick={onRetry} className="btn-secondary mt-1">
          Try again
        </button>
      )}
    </div>
  );
}

export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="card flex flex-col items-center gap-1.5 p-10 text-center">
      <Inbox size={20} className="text-ink-3" />
      <p className="font-medium">{title}</p>
      {hint && <p className="text-sm text-ink-2">{hint}</p>}
    </div>
  );
}

export function Pagination({ meta, onPage }: { meta: PageMeta; onPage: (page: number) => void }) {
  if (meta.total === 0) return null;
  const from = (meta.page - 1) * meta.pageSize + 1;
  const to = Math.min(meta.page * meta.pageSize, meta.total);
  return (
    <div className="flex items-center justify-between border-t border-ink/10 px-3 py-2 text-sm text-ink-2">
      <span className="font-mono text-2xs">
        {from}–{to} of {meta.total.toLocaleString()}
      </span>
      <div className="flex gap-1">
        <button
          className="btn-secondary px-2 py-1"
          disabled={meta.page <= 1}
          onClick={() => onPage(meta.page - 1)}
        >
          Previous
        </button>
        <button
          className="btn-secondary px-2 py-1"
          disabled={meta.page >= meta.totalPages}
          onClick={() => onPage(meta.page + 1)}
        >
          Next
        </button>
      </div>
    </div>
  );
}

export function Modal({
  title,
  open,
  onClose,
  children,
  wide,
}: {
  title: string;
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-ink/40 p-6 overflow-y-auto"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className={`card mt-10 w-full ${wide ? 'max-w-3xl' : 'max-w-lg'} p-5`} role="dialog" aria-label={title}>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="font-display text-base font-bold">{title}</h2>
          <button onClick={onClose} className="text-ink-3 hover:text-ink" aria-label="Close">
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <div>
      <label className="label">{label}</label>
      {children}
      {hint && <p className="mt-1 text-2xs text-ink-3">{hint}</p>}
    </div>
  );
}

export function StatTile({
  label,
  value,
  accent,
  sub,
}: {
  label: string;
  value: string | number;
  accent?: 'brand' | 'amber' | 'good' | 'bad';
  sub?: string;
}) {
  const accentCls =
    accent === 'amber'
      ? 'text-amber-line'
      : accent === 'good'
        ? 'text-good'
        : accent === 'bad'
          ? 'text-bad'
          : 'text-ink';
  return (
    <div className="card p-4">
      <div className="text-2xs font-semibold uppercase tracking-wider text-ink-2">{label}</div>
      <div className={`mt-1 font-display text-2xl font-bold tabular-nums ${accentCls}`}>{value}</div>
      {sub && <div className="mt-0.5 text-2xs text-ink-3">{sub}</div>}
    </div>
  );
}

export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function fmtDuration(sec: number | null | undefined): string {
  if (sec == null) return '—';
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}
