import { useEffect, useState } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import { api } from '../../api/client';
import type { Agent, PageMeta } from '../../api/types';
import { useCompanyScope } from '../../components/Layout';
import { Chip, EmptyState, ErrorState, Loading, PageHeader, Pagination } from '../../components/ui';

export function AgentsPage() {
  const { companyId } = useCompanyScope();
  const queryClient = useQueryClient();
  const [page, setPage] = useState(1);
  const [role, setRole] = useState('');
  const [search, setSearch] = useState('');

  useEffect(() => setPage(1), [companyId, role, search]);

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['agents', companyId, page, role, search],
    queryFn: () =>
      api<{ agents: Agent[]; meta: PageMeta }>('/agents', {
        query: {
          companyId: companyId || undefined,
          page,
          pageSize: 50,
          role: role || undefined,
          search: search || undefined,
        },
      }),
    placeholderData: keepPreviousData,
  });

  const setAgentRole = useMutation({
    mutationFn: ({ id, agentRole }: { id: string; agentRole: string }) =>
      api(`/agents/${id}`, { method: 'PATCH', body: { agentRole } }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['agents'] }),
  });

  return (
    <div>
      <PageHeader
        title="Agents"
        subtitle="Synced from each dialer's user list — classify them as fronters or closers for QA targeting"
      />
      <div className="card mb-3 flex items-center gap-3 p-3">
        <div className="relative">
          <Search size={14} className="absolute left-2.5 top-2.5 text-ink-3" />
          <input
            className="input w-56 pl-8"
            placeholder="User or name"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Search agents"
          />
        </div>
        <select className="input w-40" value={role} onChange={(e) => setRole(e.target.value)} aria-label="Role">
          <option value="">All roles</option>
          <option value="fronter">Fronters</option>
          <option value="closer">Closers</option>
          <option value="blended">Blended</option>
          <option value="unknown">Unclassified</option>
        </select>
      </div>

      {isLoading ? (
        <Loading />
      ) : isError || !data ? (
        <ErrorState message="Agents could not load." onRetry={() => void refetch()} />
      ) : data.agents.length === 0 ? (
        <EmptyState title="No agents found" hint="Run a dialer sync to import the user roster." />
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b border-ink/10">
              <tr>
                <th className="th">VICIdial user</th>
                <th className="th">Name</th>
                <th className="th">User group</th>
                <th className="th">Dialer</th>
                <th className="th">Active</th>
                <th className="th">QA role</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink/5">
              {data.agents.map((a) => (
                <tr key={a.id} className="hover:bg-bg/60">
                  <td className="td font-mono">{a.viciUser}</td>
                  <td className="td font-medium">{a.fullName ?? '—'}</td>
                  <td className="td text-ink-2">{a.userGroup ?? '—'}</td>
                  <td className="td text-ink-2">{a.dialerName}</td>
                  <td className="td">
                    <Chip value={a.active ? 'active' : 'disabled'} label={a.active ? 'active' : 'inactive'} />
                  </td>
                  <td className="td">
                    <select
                      className="input w-36"
                      value={a.agentRole}
                      onChange={(e) => setAgentRole.mutate({ id: a.id, agentRole: e.target.value })}
                      aria-label={`QA role for ${a.viciUser}`}
                    >
                      <option value="unknown">Unclassified</option>
                      <option value="fronter">Fronter</option>
                      <option value="closer">Closer</option>
                      <option value="blended">Blended</option>
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <Pagination meta={data.meta} onPage={setPage} />
        </div>
      )}
    </div>
  );
}
