import { useEffect, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { AlertTriangle, Trash2 } from 'lucide-react';
import { api, ApiError } from '../api/client';
import { Modal } from './ui';

/** Status of a company or dialer whose data is being removed in the background. */
export function DeletingChip() {
  return (
    <span className="chip inline-flex items-center gap-1.5 bg-bad-soft text-bad" title="Its data is being removed in the background">
      <span className="h-2 w-2 animate-spin rounded-full border border-bad border-t-transparent" aria-hidden />
      Deleting…
    </span>
  );
}

const LABELS: Record<string, string> = {
  dialers: 'Dialers',
  users: 'Users',
  forms: 'QA forms',
  calls: 'Calls',
  recordings: 'Recordings',
  transfers: 'Transfers & sales',
  evaluations: 'Evaluations',
  agents: 'Dialer agents',
};
const ORDER = ['dialers', 'users', 'forms', 'calls', 'recordings', 'transfers', 'evaluations', 'agents'];

/**
 * Confirmation for a permanent delete. It first shows what goes with the
 * item (counted on the server), then asks for the exact name to be typed —
 * a misclick can never delete a company or a dialer.
 */
export function DeleteConfirmModal({
  open,
  onClose,
  kind,
  name,
  usagePath,
  deletePath,
  consequences,
  onDeleted,
}: {
  open: boolean;
  onClose: () => void;
  kind: 'company' | 'dialer';
  name: string;
  usagePath: string;
  deletePath: string;
  /** one or two sentences on what happens straight away */
  consequences: string;
  onDeleted: () => void;
}) {
  const [typed, setTyped] = useState('');
  useEffect(() => {
    if (open) setTyped('');
  }, [open, name]);

  const usage = useQuery({
    queryKey: ['delete-usage', usagePath],
    queryFn: () => api<{ usage: Record<string, number> }>(usagePath),
    enabled: open,
    staleTime: 0,
  });

  const del = useMutation({
    mutationFn: () => api(deletePath, { method: 'DELETE', body: { confirmName: typed } }),
    onSuccess: () => {
      onDeleted();
      onClose();
    },
  });

  const matches = typed.trim() === name.trim();
  const counts = usage.data?.usage;

  return (
    <Modal title={`Delete ${kind}`} open={open} onClose={() => !del.isPending && onClose()}>
      <div className="space-y-4">
        <div className="flex gap-3 rounded-md bg-bad-soft p-3 text-sm text-bad">
          <AlertTriangle size={18} className="mt-0.5 shrink-0" aria-hidden />
          <div>
            <p className="font-semibold">
              This permanently deletes <span className="break-all">“{name}”</span> and everything below. It cannot be undone.
            </p>
            <p className="mt-1 text-ink-2">{consequences}</p>
          </div>
        </div>

        <div>
          <h3 className="mb-2 text-2xs font-semibold uppercase tracking-wide text-ink-3">What will be removed</h3>
          {usage.isLoading ? (
            <p className="text-sm text-ink-3">Counting…</p>
          ) : usage.isError || !counts ? (
            <p className="text-sm text-ink-3">Could not count the data — the delete still removes all of it.</p>
          ) : (
            <dl className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {ORDER.filter((k) => k in counts).map((k) => (
                <div key={k} className="rounded-md border border-ink/10 px-3 py-2">
                  <dt className="text-2xs text-ink-3">{LABELS[k] ?? k}</dt>
                  <dd className="font-mono text-sm font-semibold">{counts[k].toLocaleString()}</dd>
                </div>
              ))}
            </dl>
          )}
        </div>

        <div>
          <label className="label" htmlFor="delete-confirm-name">
            Type <span className="font-mono font-semibold normal-case tracking-normal text-ink">{name}</span> to confirm
            (exactly as shown)
          </label>
          <input
            id="delete-confirm-name"
            className="input font-mono"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && matches && !del.isPending) del.mutate();
            }}
          />
        </div>

        {del.isError && (
          <div className="rounded-md bg-bad-soft px-3 py-2 text-sm text-bad">
            {del.error instanceof ApiError ? del.error.message : 'Delete failed — try again.'}
          </div>
        )}

        <div className="flex justify-end gap-2">
          <button className="btn-secondary" onClick={onClose} disabled={del.isPending}>
            Cancel
          </button>
          <button className="btn-danger" onClick={() => del.mutate()} disabled={!matches || del.isPending}>
            <Trash2 size={14} /> {del.isPending ? 'Deleting…' : `Delete ${kind} permanently`}
          </button>
        </div>
      </div>
    </Modal>
  );
}
