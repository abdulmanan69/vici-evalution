import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { api, ApiError } from '../../api/client';
import type { Company } from '../../api/types';
import { Chip, EmptyState, ErrorState, Field, Loading, Modal, PageHeader, fmtDateTime } from '../../components/ui';
import { DeleteConfirmModal, DeletingChip } from '../../components/DeleteConfirm';

export function CompaniesPage() {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<Company | null>(null);

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['companies'],
    queryFn: () => api<{ companies: Company[] }>('/companies'),
    // while a company is being removed, follow it until it is gone
    refetchInterval: (q) => (q.state.data?.companies.some((c) => c.status === 'deleting') ? 5_000 : false),
  });

  const create = useMutation({
    mutationFn: () => api('/companies', { method: 'POST', body: { name, slug } }),
    onSuccess: () => {
      setOpen(false);
      setName('');
      setSlug('');
      setError(null);
      void queryClient.invalidateQueries({ queryKey: ['companies'] });
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Create failed.'),
  });

  return (
    <div>
      <PageHeader
        title="Companies"
        subtitle="Each company gets isolated dialers, data, roles and users"
        actions={
          <button className="btn-primary" onClick={() => setOpen(true)}>
            <Plus size={14} /> New company
          </button>
        }
      />
      {isLoading ? (
        <Loading />
      ) : isError || !data ? (
        <ErrorState message="Companies could not load." onRetry={() => void refetch()} />
      ) : data.companies.length === 0 ? (
        <EmptyState title="No companies yet" hint="Create the first company to start connecting dialers." />
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b border-ink/10">
              <tr>
                <th className="th">Company</th>
                <th className="th">Slug</th>
                <th className="th">Status</th>
                <th className="th">Created</th>
                <th className="th text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink/5">
              {data.companies.map((c) => {
                const isDeleting = c.status === 'deleting';
                return (
                  <tr key={c.id} className={isDeleting ? 'opacity-70' : 'hover:bg-bg/60'}>
                    <td className="td font-medium">{c.name}</td>
                    <td className="td font-mono text-2xs">{isDeleting ? '—' : c.slug}</td>
                    <td className="td">{isDeleting ? <DeletingChip /> : <Chip value={c.status} />}</td>
                    <td className="td font-mono text-2xs">{fmtDateTime(c.createdAt)}</td>
                    <td className="td text-right">
                      {!isDeleting && (
                        <button
                          className="btn-secondary px-2 py-1 text-2xs text-bad hover:bg-bad-soft"
                          onClick={() => setDeleting(c)}
                          aria-label={`Delete ${c.name}`}
                        >
                          <Trash2 size={13} /> Delete
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <Modal title="New company" open={open} onClose={() => setOpen(false)}>
        <div className="space-y-3">
          <Field label="Name">
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Slug" hint="Lowercase letters, numbers and dashes — used in URLs and exports.">
            <input
              className="input font-mono"
              value={slug}
              onChange={(e) => setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-'))}
            />
          </Field>
          {error && <div className="rounded-md bg-bad-soft px-3 py-2 text-sm text-bad">{error}</div>}
          <button
            className="btn-primary w-full justify-center"
            onClick={() => create.mutate()}
            disabled={name.length < 2 || slug.length < 2 || create.isPending}
          >
            Create company
          </button>
        </div>
      </Modal>

      {deleting && (
        <DeleteConfirmModal
          open={!!deleting}
          onClose={() => setDeleting(null)}
          kind="company"
          name={deleting.name}
          usagePath={`/companies/${deleting.id}/usage`}
          deletePath={`/companies/${deleting.id}`}
          consequences="Its users are signed out and disabled right away and its dialers stop syncing. The data is then removed in the background — the company disappears from this list when that is done."
          onDeleted={() => {
            void queryClient.invalidateQueries({ queryKey: ['companies'] });
            void queryClient.invalidateQueries({ queryKey: ['dialers'] });
          }}
        />
      )}
    </div>
  );
}
