import { useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { api } from '../../api/client';
import type { PageMeta } from '../../api/types';
import { useCompanyScope } from '../../components/Layout';
import { EmptyState, ErrorState, Loading, PageHeader, Pagination, fmtDateTime } from '../../components/ui';

interface AuditRow {
  log: {
    id: string;
    action: string;
    entityType: string | null;
    entityId: string | null;
    ip: string | null;
    createdAt: string;
  };
  userName: string | null;
  userEmail: string | null;
}

export function AuditLogsPage() {
  const { companyId } = useCompanyScope();
  const [page, setPage] = useState(1);
  const [action, setAction] = useState('');

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['audit', companyId, page, action],
    queryFn: () =>
      api<{ logs: AuditRow[]; meta: PageMeta }>('/audit-logs', {
        query: { companyId: companyId || undefined, page, pageSize: 50, action: action || undefined },
      }),
    placeholderData: keepPreviousData,
  });

  return (
    <div>
      <PageHeader title="Audit log" subtitle="Sensitive actions across the platform, newest first" />
      <div className="card mb-3 flex items-center gap-3 p-3">
        <input
          className="input w-64 font-mono"
          placeholder="Filter by action, e.g. recording.play"
          value={action}
          onChange={(e) => {
            setAction(e.target.value);
            setPage(1);
          }}
          aria-label="Filter by action"
        />
      </div>

      {isLoading ? (
        <Loading />
      ) : isError || !data ? (
        <ErrorState message="Audit log could not load." onRetry={() => void refetch()} />
      ) : data.logs.length === 0 ? (
        <EmptyState title="No audit entries match" />
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b border-ink/10">
              <tr>
                <th className="th">When</th>
                <th className="th">Actor</th>
                <th className="th">Action</th>
                <th className="th">Entity</th>
                <th className="th">IP</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink/5">
              {data.logs.map(({ log, userName, userEmail }) => (
                <tr key={log.id} className="hover:bg-bg/60">
                  <td className="td font-mono text-2xs">{fmtDateTime(log.createdAt)}</td>
                  <td className="td">
                    <div className="font-medium">{userName ?? 'system'}</div>
                    <div className="font-mono text-2xs text-ink-3">{userEmail ?? ''}</div>
                  </td>
                  <td className="td font-mono text-2xs">{log.action}</td>
                  <td className="td font-mono text-2xs text-ink-2">
                    {log.entityType ? `${log.entityType}:${(log.entityId ?? '').slice(0, 8)}` : '—'}
                  </td>
                  <td className="td font-mono text-2xs text-ink-3">{log.ip ?? '—'}</td>
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
