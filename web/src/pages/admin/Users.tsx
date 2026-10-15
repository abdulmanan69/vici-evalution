import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { api, ApiError } from '../../api/client';
import { useCompanyScope } from '../../components/Layout';
import { useAuth } from '../../auth/AuthContext';
import { Chip, EmptyState, ErrorState, Field, Loading, Modal, PageHeader, fmtDateTime } from '../../components/ui';

interface UserRow {
  id: string;
  companyId: string | null;
  email: string;
  name: string;
  status: 'active' | 'disabled';
  lastLoginAt: string | null;
  createdAt: string;
  roleId: string;
  roleName: string;
  allowedFormIds: string[] | null;
}

interface QaFormLite {
  id: string;
  name: string;
}

interface Role {
  id: string;
  companyId: string | null;
  name: string;
  description: string | null;
}

export function UsersPage() {
  const { companyId } = useCompanyScope();
  const { isSuperAdmin, user: me } = useAuth();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ name: '', email: '', password: '', roleId: '' });
  const [error, setError] = useState<string | null>(null);

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['users', companyId],
    queryFn: () => api<{ users: UserRow[] }>('/users', { query: { companyId: companyId || undefined } }),
  });
  const { data: rolesData } = useQuery({
    queryKey: ['roles', companyId],
    queryFn: () => api<{ roles: Role[] }>('/users/roles', { query: { companyId: companyId || undefined } }),
  });

  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ['users'] });

  const create = useMutation({
    mutationFn: () =>
      api('/users', {
        method: 'POST',
        body: { ...form, companyId: companyId || undefined },
      }),
    onSuccess: () => {
      setOpen(false);
      setForm({ name: '', email: '', password: '', roleId: '' });
      setError(null);
      invalidate();
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Create failed.'),
  });

  const setStatus = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) => api(`/users/${id}`, { method: 'PATCH', body: { status } }),
    onSuccess: invalidate,
  });

  const { data: formsData } = useQuery({
    queryKey: ['forms', companyId],
    queryFn: () => api<{ forms: QaFormLite[] }>('/qa/forms', { query: { companyId: companyId || undefined } }),
    staleTime: 60_000,
  });
  const [limitUser, setLimitUser] = useState<UserRow | null>(null);
  const [limitIds, setLimitIds] = useState<string[]>([]);
  const saveLimits = useMutation({
    mutationFn: () =>
      api(`/users/${limitUser!.id}`, {
        method: 'PATCH',
        body: { allowedFormIds: limitIds.length > 0 ? limitIds : null },
      }),
    onSuccess: () => {
      setLimitUser(null);
      invalidate();
    },
  });
  const formName = (id: string) => formsData?.forms.find((f) => f.id === id)?.name.split(' ')[0] ?? '…';

  return (
    <div>
      <PageHeader
        title="Users & roles"
        subtitle="Access is enforced on the server for every request — roles bundle granular permissions"
        actions={
          <button className="btn-primary" onClick={() => setOpen(true)} disabled={isSuperAdmin && !companyId}>
            <Plus size={14} /> New user
          </button>
        }
      />

      {isLoading ? (
        <Loading />
      ) : isError || !data ? (
        <ErrorState message="Users could not load." onRetry={() => void refetch()} />
      ) : data.users.length === 0 ? (
        <EmptyState title="No users in scope" hint="Create QA managers and reviewers for this company." />
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b border-ink/10">
              <tr>
                <th className="th">User</th>
                <th className="th">Role</th>
                <th className="th">QA methods</th>
                <th className="th">Status</th>
                <th className="th">Last sign-in</th>
                <th className="th"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink/5">
              {data.users.map((u) => (
                <tr key={u.id} className="hover:bg-bg/60">
                  <td className="td">
                    <div className="font-medium">{u.name}</div>
                    <div className="font-mono text-2xs text-ink-3">{u.email}</div>
                  </td>
                  <td className="td">
                    <span className="chip bg-brand-soft text-brand">{u.roleName.replace(/_/g, ' ')}</span>
                  </td>
                  <td className="td">
                    <button
                      className="text-left hover:underline"
                      onClick={() => {
                        setLimitUser(u);
                        setLimitIds(u.allowedFormIds ?? []);
                      }}
                      title="Limit which evaluation methods this user can see and use"
                    >
                      {u.allowedFormIds && u.allowedFormIds.length > 0 ? (
                        <span className="chip bg-amber-soft text-amber-line">
                          {u.allowedFormIds.map(formName).join(', ')}
                        </span>
                      ) : (
                        <span className="chip bg-bg text-ink-2">All methods</span>
                      )}
                    </button>
                  </td>
                  <td className="td">
                    <Chip value={u.status} />
                  </td>
                  <td className="td font-mono text-2xs">{fmtDateTime(u.lastLoginAt)}</td>
                  <td className="td">
                    {u.id !== me?.userId && (
                      <button
                        className="btn-secondary px-2 py-1 text-2xs"
                        onClick={() => setStatus.mutate({ id: u.id, status: u.status === 'active' ? 'disabled' : 'active' })}
                      >
                        {u.status === 'active' ? 'Disable' : 'Enable'}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Modal
        title={`QA methods for ${limitUser?.name ?? ''}`}
        open={!!limitUser}
        onClose={() => setLimitUser(null)}
      >
        <p className="mb-3 text-sm text-ink-2">
          Pick the evaluation methods this user may work with. A limited user only sees their
          assigned methods — in the forms list, when starting an evaluation, and in the
          evaluations report. Leave all unchecked for full access.
        </p>
        <div className="space-y-2">
          {formsData?.forms.map((f) => (
            <label key={f.id} className="flex items-center gap-2 rounded-md bg-bg px-3 py-2 text-sm">
              <input
                type="checkbox"
                checked={limitIds.includes(f.id)}
                onChange={(e) =>
                  setLimitIds((prev) => (e.target.checked ? [...prev, f.id] : prev.filter((x) => x !== f.id)))
                }
              />
              {f.name}
            </label>
          ))}
        </div>
        <div className="mt-4 flex gap-2">
          <button className="btn-secondary flex-1 justify-center" onClick={() => setLimitIds([])}>
            Clear (all methods)
          </button>
          <button className="btn-primary flex-1 justify-center" onClick={() => saveLimits.mutate()} disabled={saveLimits.isPending}>
            Save
          </button>
        </div>
        <p className="mt-2 text-2xs text-ink-3">
          Saving signs the user out so the new limits apply immediately.
        </p>
      </Modal>

      <Modal title="New user" open={open} onClose={() => setOpen(false)}>
        <div className="space-y-3">
          <Field label="Full name">
            <input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </Field>
          <Field label="Email">
            <input className="input" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          </Field>
          <Field label="Temporary password" hint="At least 10 characters. The user should change it after first sign-in.">
            <input className="input" type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} autoComplete="new-password" />
          </Field>
          <Field label="Role">
            <select className="input" value={form.roleId} onChange={(e) => setForm({ ...form, roleId: e.target.value })}>
              <option value="">— choose a role —</option>
              {rolesData?.roles
                .filter((r) => isSuperAdmin || r.companyId !== null)
                .map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name.replace(/_/g, ' ')}
                    {r.companyId === null ? ' (platform)' : ''}
                  </option>
                ))}
            </select>
          </Field>
          {error && <div className="rounded-md bg-bad-soft px-3 py-2 text-sm text-bad">{error}</div>}
          <button
            className="btn-primary w-full justify-center"
            onClick={() => create.mutate()}
            disabled={!form.name || !form.email || form.password.length < 10 || !form.roleId || create.isPending}
          >
            Create user
          </button>
        </div>
      </Modal>
    </div>
  );
}
