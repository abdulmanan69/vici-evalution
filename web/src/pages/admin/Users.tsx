import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Building2, Plus, Trash2, UserMinus } from 'lucide-react';
import { api, ApiError } from '../../api/client';
import type { Company } from '../../api/types';
import { useCompanyScope } from '../../components/Layout';
import { useAuth } from '../../auth/AuthContext';
import { Chip, EmptyState, ErrorState, Field, Loading, Modal, PageHeader, fmtDateTime } from '../../components/ui';

interface UserRow {
  id: string;
  /** the person's own company */
  companyId: string | null;
  email: string;
  name: string;
  status: 'active' | 'disabled';
  lastLoginAt: string | null;
  createdAt: string;
  /** role in the company in scope */
  roleId: string;
  roleName: string;
  allowedFormIds: string[] | null;
  /** works here with access from another company */
  shared?: boolean;
  /** super admin, all companies: how many other companies this person works in */
  extraCompanies?: number;
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

interface Membership {
  companyId: string;
  companyName: string;
  roleId: string;
  roleName: string;
}

/** what each role is for, in the words a manager uses */
const ROLE_LABELS: Record<string, string> = {
  super_admin: 'Super admin — every company, dialer and user on the platform',
  company_admin: 'Company admin — users, dialer connection, dispositions and QA team for this company',
  qa_manager: 'QA manager — forms, reviewer assignments, tasks and all reports (can evaluate too)',
  qa_reviewer: 'QA reviewer — evaluates the calls assigned to them',
};
const roleShort = (name: string) => name.replace(/_/g, ' ');

/** A company's own roles — what a person can be given there. */
function useCompanyRoles(companyId: string | null | undefined) {
  return useQuery({
    queryKey: ['roles', companyId],
    queryFn: () => api<{ roles: Role[] }>('/users/roles', { query: { companyId: companyId || undefined } }),
    enabled: !!companyId,
    select: (d) => d.roles.filter((r) => r.companyId === companyId && r.name !== 'super_admin'),
    staleTime: 60_000,
  });
}

function MembershipRow({ userId, m, onChanged }: { userId: string; m: Membership; onChanged: () => void }) {
  const roles = useCompanyRoles(m.companyId);
  const change = useMutation({
    mutationFn: (roleId: string) => api(`/users/${userId}/companies/${m.companyId}`, { method: 'PUT', body: { roleId } }),
    onSuccess: onChanged,
  });
  const remove = useMutation({
    mutationFn: () => api(`/users/${userId}/companies/${m.companyId}`, { method: 'DELETE' }),
    onSuccess: onChanged,
  });
  return (
    <li className="flex flex-wrap items-center gap-2 rounded-md bg-bg px-3 py-2 text-sm">
      <span className="min-w-0 flex-1 truncate font-medium">{m.companyName}</span>
      <select
        className="input w-44"
        value={m.roleId}
        onChange={(e) => change.mutate(e.target.value)}
        disabled={change.isPending || !roles.data}
        aria-label={`Role in ${m.companyName}`}
      >
        {(roles.data ?? [{ id: m.roleId, name: m.roleName, companyId: m.companyId, description: null }]).map((r) => (
          <option key={r.id} value={r.id}>
            {roleShort(r.name)}
          </option>
        ))}
      </select>
      <button
        className="btn-secondary px-2 py-1 text-2xs text-bad hover:bg-bad-soft"
        onClick={() => remove.mutate()}
        disabled={remove.isPending}
        aria-label={`Remove access to ${m.companyName}`}
      >
        <Trash2 size={12} /> Remove
      </button>
    </li>
  );
}

/** Super admins: which companies this person works in, and their role in each. */
function CompanyAccessModal({ user, onClose }: { user: UserRow; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [addCompany, setAddCompany] = useState('');
  const [addRole, setAddRole] = useState('');

  const access = useQuery({
    queryKey: ['user-companies', user.id],
    queryFn: () =>
      api<{ home: { id: string; name: string; roleName: string } | null; memberships: Membership[] }>(
        `/users/${user.id}/companies`,
      ),
  });
  const { data: companiesData } = useQuery({
    queryKey: ['companies'],
    queryFn: () => api<{ companies: Company[] }>('/companies'),
  });
  const addRoles = useCompanyRoles(addCompany);
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['user-companies', user.id] });
    void queryClient.invalidateQueries({ queryKey: ['users'] });
  };
  const add = useMutation({
    mutationFn: () => api(`/users/${user.id}/companies/${addCompany}`, { method: 'PUT', body: { roleId: addRole } }),
    onSuccess: () => {
      setAddCompany('');
      setAddRole('');
      refresh();
    },
  });

  const taken = new Set([access.data?.home?.id, ...(access.data?.memberships ?? []).map((m) => m.companyId)]);
  const available = (companiesData?.companies ?? []).filter((c) => c.status !== 'deleting' && !taken.has(c.id));

  return (
    <Modal title={`Companies for ${user.name}`} open onClose={onClose}>
      <p className="mb-3 text-sm text-ink-2">
        One login for every company this person works in. They pick the company from the header after signing in, and
        get the role shown here in each one — for example QA manager in one company and reviewer in another.
      </p>
      {access.isLoading ? (
        <Loading />
      ) : access.isError || !access.data ? (
        <ErrorState message="Could not load this person's companies." onRetry={() => void access.refetch()} />
      ) : (
        <>
          {access.data.home && (
            <div className="mb-2 flex items-center gap-2 rounded-md border border-ink/10 px-3 py-2 text-sm">
              <span className="min-w-0 flex-1 truncate font-medium">{access.data.home.name}</span>
              <span className="chip bg-brand-soft text-brand">{roleShort(access.data.home.roleName)}</span>
              <span className="text-2xs text-ink-3">own company</span>
            </div>
          )}
          <ul className="space-y-2">
            {access.data.memberships.map((m) => (
              <MembershipRow key={m.companyId} userId={user.id} m={m} onChanged={refresh} />
            ))}
          </ul>
          {access.data.memberships.length === 0 && (
            <p className="mt-1 text-2xs text-ink-3">No other companies yet.</p>
          )}

          <div className="mt-4 rounded-md border border-dashed border-ink/20 p-3">
            <div className="mb-2 text-2xs font-semibold uppercase tracking-wide text-ink-3">Give access to another company</div>
            <div className="flex flex-wrap gap-2">
              <select
                className="input min-w-0 flex-1"
                value={addCompany}
                onChange={(e) => {
                  setAddCompany(e.target.value);
                  setAddRole('');
                }}
                aria-label="Company"
              >
                <option value="">— company —</option>
                {available.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
              <select
                className="input w-44"
                value={addRole}
                onChange={(e) => setAddRole(e.target.value)}
                disabled={!addCompany || !addRoles.data}
                aria-label="Role there"
              >
                <option value="">— role there —</option>
                {addRoles.data?.map((r) => (
                  <option key={r.id} value={r.id}>
                    {roleShort(r.name)}
                  </option>
                ))}
              </select>
              <button className="btn-primary" onClick={() => add.mutate()} disabled={!addCompany || !addRole || add.isPending}>
                <Plus size={14} /> Give access
              </button>
            </div>
            {add.isError && (
              <div className="mt-2 text-2xs text-bad">{add.error instanceof ApiError ? add.error.message : 'Could not give access.'}</div>
            )}
          </div>
        </>
      )}
    </Modal>
  );
}

export function UsersPage() {
  const { companyId } = useCompanyScope();
  const { isSuperAdmin, user: me } = useAuth();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ name: '', email: '', password: '', roleId: '' });
  const [error, setError] = useState<string | null>(null);
  const [accessFor, setAccessFor] = useState<UserRow | null>(null);
  const [removing, setRemoving] = useState<UserRow | null>(null);
  // the company the list shows: the super admin's scope, everyone else's own
  const listCompany = isSuperAdmin ? companyId : (me?.companyId ?? '');

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

  const removeAccess = useMutation({
    mutationFn: (u: UserRow) => api(`/users/${u.id}/companies/${listCompany}`, { method: 'DELETE' }),
    onSuccess: () => {
      setRemoving(null);
      invalidate();
    },
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
        // the limits apply in the company being looked at
        body: { allowedFormIds: limitIds.length > 0 ? limitIds : null, companyId: companyId || undefined },
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
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="font-medium">{u.name}</span>
                      {u.shared && (
                        <span
                          className="chip bg-info-soft text-info"
                          title="Works in this company with access from another company — their account belongs there"
                        >
                          shared
                        </span>
                      )}
                      {!!u.extraCompanies && u.extraCompanies > 0 && (
                        <span className="chip bg-info-soft text-info" title="Also works in other companies">
                          +{u.extraCompanies} {u.extraCompanies === 1 ? 'company' : 'companies'}
                        </span>
                      )}
                    </div>
                    <div className="font-mono text-2xs text-ink-3">{u.email}</div>
                  </td>
                  <td className="td">
                    <span className="chip bg-brand-soft text-brand">{roleShort(u.roleName)}</span>
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
                    <div className="flex justify-end gap-1.5">
                      {isSuperAdmin && u.companyId && !u.shared && (
                        <button
                          className="btn-secondary px-2 py-1 text-2xs"
                          onClick={() => setAccessFor(u)}
                          title="Companies this person works in"
                        >
                          <Building2 size={12} /> Companies
                        </button>
                      )}
                      {u.shared ? (
                        <button
                          className="btn-secondary px-2 py-1 text-2xs text-bad hover:bg-bad-soft"
                          onClick={() => setRemoving(u)}
                          title="Take away this person's access to this company"
                        >
                          <UserMinus size={12} /> Remove access
                        </button>
                      ) : (
                        u.id !== me?.userId && (
                          <button
                            className="btn-secondary px-2 py-1 text-2xs"
                            onClick={() => setStatus.mutate({ id: u.id, status: u.status === 'active' ? 'disabled' : 'active' })}
                          >
                            {u.status === 'active' ? 'Disable' : 'Enable'}
                          </button>
                        )
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {accessFor && <CompanyAccessModal user={accessFor} onClose={() => setAccessFor(null)} />}

      <Modal title="Remove access" open={!!removing} onClose={() => setRemoving(null)}>
        <p className="text-sm text-ink-2">
          <span className="font-semibold text-ink">{removing?.name}</span> will no longer work in this company. Their open
          tasks and agent assignments here end; evaluations they finished stay. Their account and their other companies
          are not affected.
        </p>
        {removeAccess.isError && (
          <div className="mt-3 rounded-md bg-bad-soft px-3 py-2 text-sm text-bad">
            {removeAccess.error instanceof ApiError ? removeAccess.error.message : 'Could not remove access.'}
          </div>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <button className="btn-secondary" onClick={() => setRemoving(null)}>
            Cancel
          </button>
          <button
            className="btn-danger"
            onClick={() => removing && removeAccess.mutate(removing)}
            disabled={removeAccess.isPending || !listCompany}
          >
            <UserMinus size={14} /> Remove access
          </button>
        </div>
      </Modal>

      <Modal
        title={`QA methods for ${limitUser?.name ?? ''}`}
        open={!!limitUser}
        onClose={() => setLimitUser(null)}
      >
        <p className="mb-3 text-sm text-ink-2">
          Pick the evaluation methods this user may work with in this company. A limited user only sees their
          assigned methods — in the forms list, when starting an evaluation, and in the evaluations report. Leave
          all unchecked for full access.
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
        {saveLimits.isError && (
          <p className="mt-2 text-2xs text-bad">
            {saveLimits.error instanceof ApiError ? saveLimits.error.message : 'Could not save.'}
          </p>
        )}
        <p className="mt-2 text-2xs text-ink-3">
          {limitUser?.shared
            ? 'Applies in this company only — their other companies keep their own limits.'
            : 'Saving signs the user out so the new limits apply immediately.'}
        </p>
      </Modal>

      <Modal title="New user" open={open} onClose={() => setOpen(false)}>
        <div className="space-y-3">
          <Field label="Full name">
            <input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </Field>
          <Field
            label="Email"
            hint="Someone who already has an account in another company does not need a second one — a super admin gives them access from Users → Companies."
          >
            <input className="input" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          </Field>
          <Field label="Temporary password" hint="At least 10 characters. The user should change it after first sign-in.">
            <input className="input" type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} autoComplete="new-password" />
          </Field>
          <Field label="Role">
            <select className="input" value={form.roleId} onChange={(e) => setForm({ ...form, roleId: e.target.value })}>
              <option value="">— choose a role —</option>
              {rolesData?.roles
                // the company's own roles, plus super admin for super admins; the
                // platform-level copies of company roles are templates, never assigned
                .filter((r) => r.companyId !== null || (isSuperAdmin && r.name === 'super_admin'))
                .map((r) => (
                  <option key={r.id} value={r.id}>
                    {ROLE_LABELS[r.name] ?? roleShort(r.name)}
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
