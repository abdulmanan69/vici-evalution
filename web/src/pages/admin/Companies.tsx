import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { api, ApiError } from '../../api/client';
import type { Company } from '../../api/types';
import { Chip, EmptyState, ErrorState, Field, Loading, Modal, PageHeader, fmtDateTime } from '../../components/ui';

export function CompaniesPage() {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [error, setError] = useState<string | null>(null);

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['companies'],
    queryFn: () => api<{ companies: Company[] }>('/companies'),
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
              </tr>
            </thead>
            <tbody className="divide-y divide-ink/5">
              {data.companies.map((c) => (
                <tr key={c.id} className="hover:bg-bg/60">
                  <td className="td font-medium">{c.name}</td>
                  <td className="td font-mono text-2xs">{c.slug}</td>
                  <td className="td">
                    <Chip value={c.status} />
                  </td>
                  <td className="td font-mono text-2xs">{fmtDateTime(c.createdAt)}</td>
                </tr>
              ))}
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
    </div>
  );
}
