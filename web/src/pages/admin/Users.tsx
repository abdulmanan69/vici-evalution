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
