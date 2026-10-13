import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { api, ApiError } from '../../api/client';
import type { Dialer, DispoMapping } from '../../api/types';
import { useAuth } from '../../auth/AuthContext';
import { useCompanyScope } from '../../components/Layout';
import { Chip, EmptyState, ErrorState, Field, Loading, Modal, PageHeader } from '../../components/ui';

const MEANINGS: { value: DispoMapping['meaning']; label: string; hint: string }[] = [
  { value: 'transfer', label: 'Transfer', hint: 'Fronter handed the call to a closer (e.g. XFER)' },
  { value: 'sale', label: 'Sale', hint: 'Closer completed a sale — moves the call to Closed' },
  { value: 'no_sale', label: 'No sale', hint: 'Closer finished without a sale' },
  { value: 'callback', label: 'Callback', hint: 'Scheduled follow-up' },
  { value: 'dnc', label: 'Do not call', hint: 'DNC request' },
  { value: 'other', label: 'Other', hint: 'Tracked but neutral' },
];

export function DispositionsPage() {
  const { companyId } = useCompanyScope();
  const { isSuperAdmin } = useAuth();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState('');
  const [meaning, setMeaning] = useState<DispoMapping['meaning']>('sale');
  const [dialerId, setDialerId] = useState('');
  const [error, setError] = useState<string | null>(null);

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['dispositions', companyId],
    queryFn: () => api<{ mappings: DispoMapping[] }>('/dispositions', { query: { companyId: companyId || undefined } }),
  });
  const { data: dialers } = useQuery({
    queryKey: ['dialers', companyId],
    queryFn: () => api<{ dialers: Dialer[] }>('/dialers', { query: { companyId: companyId || undefined } }),
  });

  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ['dispositions'] });

  const create = useMutation({
    mutationFn: () =>
      api('/dispositions', {
        method: 'POST',
        body: {
          companyId: companyId || undefined,
          dispositionCode: code,
          meaning,
          dialerServerId: dialerId || null,
        },
      }),
    onSuccess: () => {
      setOpen(false);
      setCode('');
      setError(null);
      invalidate();
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Create failed.'),
  });

  const toggle = useMutation({
    mutationFn: (m: DispoMapping) => api(`/dispositions/${m.id}`, { method: 'PATCH', body: { active: !m.active } }),
    onSuccess: invalidate,
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/dispositions/${id}`, { method: 'DELETE' }),
    onSuccess: invalidate,
  });

  const dialerName = (id: string | null) => (id ? (dialers?.dialers.find((d) => d.id === id)?.name ?? id) : 'All dialers');

  return (
    <div>
      <PageHeader
        title="Disposition mappings"
        subtitle="Explicit semantics only — a call is never counted as a sale or transfer by name alone"
        actions={
          <button className="btn-primary" onClick={() => setOpen(true)} disabled={isSuperAdmin && !companyId}>
            <Plus size={14} /> Add mapping
          </button>
        }
      />

      {isLoading ? (
        <Loading />
      ) : isError || !data ? (
        <ErrorState message="Mappings could not load." onRetry={() => void refetch()} />
      ) : data.mappings.length === 0 ? (
        <EmptyState
          title="No mappings configured"
          hint="Without mappings the sync cannot detect transfers or sales. Start with XFER → Transfer and your sale codes → Sale."
        />
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b border-ink/10">
              <tr>
                <th className="th">Disposition code</th>
                <th className="th">Meaning</th>
                <th className="th">Scope</th>
                <th className="th">Active</th>
                <th className="th"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink/5">
              {data.mappings.map((m) => (
                <tr key={m.id} className="hover:bg-bg/60">
                  <td className="td font-mono font-semibold">{m.dispositionCode}</td>
                  <td className="td">
                    <Chip value={m.meaning} />
                  </td>
                  <td className="td text-ink-2">{dialerName(m.dialerServerId)}</td>
                  <td className="td">
                    <button
                      className={`chip ${m.active ? 'bg-good-soft text-good' : 'bg-bg text-ink-3'}`}
                      onClick={() => toggle.mutate(m)}
                    >
                      {m.active ? 'active' : 'inactive'}
                    </button>
                  </td>
                  <td className="td">
                    <button
                      className="text-ink-3 hover:text-bad"
                      onClick={() => {
                        if (window.confirm(`Delete the mapping ${m.dispositionCode} → ${m.meaning}?`)) {
                          remove.mutate(m.id);
                        }
                      }}
                      aria-label="Delete mapping"
                    >
                      <Trash2 size={14} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Modal title="Add disposition mapping" open={open} onClose={() => setOpen(false)}>
        <div className="space-y-3">
          <Field label="Disposition code" hint="Exactly as VICIdial logs it (case-insensitive), e.g. XFER, SALE, NI.">
            <input className="input font-mono uppercase" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} />
          </Field>
          <Field label="Meaning">
            <select className="input" value={meaning} onChange={(e) => setMeaning(e.target.value as DispoMapping['meaning'])}>
              {MEANINGS.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label} — {m.hint}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Scope">
            <select className="input" value={dialerId} onChange={(e) => setDialerId(e.target.value)}>
              <option value="">All dialers in the company</option>
              {dialers?.dialers.map((d) => (
                <option key={d.id} value={d.id}>
                  Only {d.name}
                </option>
              ))}
            </select>
          </Field>
          {error && <div className="rounded-md bg-bad-soft px-3 py-2 text-sm text-bad">{error}</div>}
          <button className="btn-primary w-full justify-center" onClick={() => create.mutate()} disabled={!code.trim() || create.isPending}>
            Add mapping
          </button>
        </div>
      </Modal>
    </div>
  );
}
