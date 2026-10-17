import { useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Plus, RotateCcw } from 'lucide-react';
import { api } from '../api/client';
import type { QaForm } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { useCompanyScope } from '../components/Layout';
import { Chip, EmptyState, ErrorState, Field, Loading, Modal, PageHeader, fmtDateTime } from '../components/ui';

export function FormsPage() {
  const { companyId } = useCompanyScope();
  const { hasPerm, isSuperAdmin } = useAuth();
  const navigate = useNavigate();
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState('');
  const [target, setTarget] = useState<'fronter' | 'closer' | 'any'>('closer');
  const [queue, setQueue] = useState<'' | 'transfer' | 'unclosed' | 'closed'>('');
  const [description, setDescription] = useState('');

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['forms', companyId],
    queryFn: () => api<{ forms: QaForm[] }>('/qa/forms', { query: { companyId: companyId || undefined } }),
  });

  const create = useMutation({
    mutationFn: () =>
      api<{ form: QaForm }>('/qa/forms', {
        method: 'POST',
        body: {
          name,
          target,
          queue: queue || null,
          description: description || undefined,
          companyId: companyId || undefined,
        },
      }),
    onSuccess: (res) => navigate(`/qa/forms/${res.form.id}`),
  });

  const createBlocked = isSuperAdmin && !companyId;

  // the built-in TRA / Unclosed / Closed scorecards — brings back any that
  // were archived, never touches the ones already here
  const loadDefaults = useMutation({
    mutationFn: () =>
      api<{ created: string[]; existing: string[] }>('/qa/forms/load-defaults', {
        method: 'POST',
        body: { companyId: companyId || undefined },
      }),
    onSuccess: () => void refetch(),
  });
  const defaultsNote = loadDefaults.isError
    ? 'The default forms could not be loaded.'
    : loadDefaults.isSuccess
      ? loadDefaults.data.created.length > 0
        ? `Loaded: ${loadDefaults.data.created.join(', ')}.`
        : 'All default forms are already here.'
      : null;

  // the builder is a manager tool; reviewers reach forms through evaluations
  if (!hasPerm('qa.forms.manage')) return <Navigate to="/" replace />;

  return (
    <div>
      <PageHeader
        title="QA forms"
        subtitle="Scorecards your reviewers fill in — versioned on every publish"
        actions={
          hasPerm('qa.forms.manage') && (
            <>
              <button
                className="btn-secondary"
                onClick={() => loadDefaults.mutate()}
                disabled={createBlocked || loadDefaults.isPending}
                title="Bring back the built-in TRA / Unclosed / Closed scorecards if any is missing"
              >
                <RotateCcw size={14} className={loadDefaults.isPending ? 'animate-spin' : ''} />{' '}
                {loadDefaults.isPending ? 'Loading…' : 'Load default forms'}
              </button>
              <button className="btn-primary" onClick={() => setCreateOpen(true)}>
                <Plus size={14} /> New form
              </button>
            </>
          )
        }
      />
      {defaultsNote && <div className="mb-3 rounded-md bg-brand-soft px-3 py-2 text-sm text-brand">{defaultsNote}</div>}

      {isLoading ? (
        <Loading />
      ) : isError || !data ? (
        <ErrorState message="Forms could not load." onRetry={() => void refetch()} />
      ) : data.forms.length === 0 ? (
        <EmptyState
          title="No QA forms yet"
          hint="Press “Load default forms” for the built-in TRA / Unclosed / Closed scorecards, or create your own."
        />
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b border-ink/10">
              <tr>
                <th className="th">Form</th>
                <th className="th">Target</th>
                <th className="th">State</th>
                <th className="th">Version</th>
                <th className="th">Updated</th>
                <th className="th"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink/5">
              {data.forms.map((f) => (
                <tr key={f.id} className="hover:bg-bg/60">
                  <td className="td">
                    <div className="font-medium">{f.name}</div>
                    {f.description && <div className="text-2xs text-ink-3">{f.description}</div>}
                  </td>
                  <td className="td">
                    <Chip value={f.target} />
                  </td>
                  <td className="td">
                    <Chip value={f.state} />
                  </td>
                  <td className="td font-mono">v{f.currentVersion}</td>
                  <td className="td font-mono text-2xs">{fmtDateTime(f.updatedAt)}</td>
                  <td className="td">
                    <Link to={`/qa/forms/${f.id}`} className="font-medium text-brand hover:underline">
                      {hasPerm('qa.forms.manage') ? 'Edit' : 'View'}
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Modal title="New QA form" open={createOpen} onClose={() => setCreateOpen(false)}>
        {createBlocked ? (
          <p className="text-sm text-ink-2">Pick a company in the scope selector above before creating a form.</p>
        ) : (
          <div className="space-y-3">
            <Field label="Name">
              <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Closer QA scorecard" />
            </Field>
            <Field label="Target agents">
              <select className="input" value={target} onChange={(e) => setTarget(e.target.value as typeof target)}>
                <option value="closer">Closers</option>
                <option value="fronter">Fronters</option>
                <option value="any">Any agent</option>
              </select>
            </Field>
            <Field label="Queue" hint="Reviewers limited to this form only see this queue.">
              <select className="input" value={queue} onChange={(e) => setQueue(e.target.value as typeof queue)}>
                <option value="">Any queue</option>
                <option value="transfer">Transfers</option>
                <option value="unclosed">Unclosed</option>
                <option value="closed">Closed</option>
              </select>
            </Field>
            <Field label="Description (optional)">
              <input className="input" value={description} onChange={(e) => setDescription(e.target.value)} />
            </Field>
            <button
              className="btn-primary w-full justify-center"
              disabled={name.trim().length < 2 || create.isPending}
              onClick={() => create.mutate()}
            >
              Create and open builder
            </button>
          </div>
        )}
      </Modal>
    </div>
  );
}
