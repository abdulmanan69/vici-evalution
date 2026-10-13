import { useState } from 'react';
import { Link } from 'react-router-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Download } from 'lucide-react';
import { api } from '../api/client';
import type { Evaluation, PageMeta } from '../api/types';
import { useCompanyScope } from '../components/Layout';
import { Chip, EmptyState, ErrorState, Loading, PageHeader, Pagination, fmtDateTime } from '../components/ui';

interface Row {
  evaluation: Evaluation;
  reviewerName: string;
  formName: string;
  formVersion: number;
}

export function EvaluationsListPage() {
  const { companyId } = useCompanyScope();
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState('');

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['evaluations', companyId, page, status],
    queryFn: () =>
      api<{ evaluations: Row[]; meta: PageMeta }>('/evaluations', {
        query: { companyId: companyId || undefined, page, pageSize: 25, status: status || undefined },
      }),
    placeholderData: keepPreviousData,
  });

  const exportUrl = `/api/v1/reports/evaluations.csv${companyId ? `?companyId=${companyId}` : ''}`;

  return (
    <div>
      <PageHeader
        title="Evaluations"
        subtitle="Every scored call, with the exact form version used"
        actions={
          <a href={exportUrl} className="btn-secondary" download>
            <Download size={14} /> Export CSV
          </a>
        }
      />
      <div className="card mb-3 flex items-center gap-3 p-3">
        <select
          className="input w-44"
          value={status}
          onChange={(e) => {
            setStatus(e.target.value);
            setPage(1);
          }}
          aria-label="Status"
        >
          <option value="">All statuses</option>
          <option value="draft">Draft</option>
          <option value="completed">Completed</option>
        </select>
      </div>

      {isLoading ? (
        <Loading />
      ) : isError || !data ? (
        <ErrorState message="Evaluations could not load." onRetry={() => void refetch()} />
      ) : data.evaluations.length === 0 ? (
        <EmptyState title="No evaluations yet" hint="Open a call in a queue and start an evaluation." />
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b border-ink/10">
              <tr>
                <th className="th">Created</th>
                <th className="th">Form</th>
                <th className="th">Reviewer</th>
                <th className="th">Status</th>
                <th className="th">Score</th>
                <th className="th">Result</th>
                <th className="th"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink/5">
              {data.evaluations.map((row) => (
                <tr key={row.evaluation.id} className="hover:bg-bg/60">
                  <td className="td font-mono text-2xs">{fmtDateTime(row.evaluation.createdAt)}</td>
                  <td className="td">
                    {row.formName} <span className="font-mono text-2xs text-ink-3">v{row.formVersion}</span>
                  </td>
                  <td className="td">{row.reviewerName}</td>
                  <td className="td">
                    <Chip value={row.evaluation.status} />
                  </td>
                  <td className="td font-mono tabular-nums">
                    {row.evaluation.percent != null ? `${row.evaluation.percent}%` : '—'}
                  </td>
                  <td className="td">
                    {row.evaluation.status === 'completed' ? (
                      row.evaluation.autoFailed ? (
                        <span className="chip bg-bad-soft text-bad">auto-fail</span>
                      ) : row.evaluation.passed ? (
                        <span className="chip bg-good-soft text-good">pass</span>
                      ) : (
                        <span className="chip bg-bad-soft text-bad">fail</span>
                      )
                    ) : (
                      '—'
                    )}
                  </td>
                  <td className="td">
                    <Link to={`/qa/evaluations/${row.evaluation.id}`} className="font-medium text-brand hover:underline">
                      Open
                    </Link>
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
