import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Download, Search } from 'lucide-react';
import { api } from '../api/client';
import { DispoChip } from '../components/DispoChip';
import type { Dialer, PageMeta, QueueItem, Transfer } from '../api/types';
import { useCompanyScope } from '../components/Layout';
import { useAuth } from '../auth/AuthContext';
import { Chip, EmptyState, ErrorState, Loading, PageHeader, Pagination, fmtDateTime, fmtDuration } from '../components/ui';

const TITLES: Record<string, { title: string; subtitle: string }> = {
  transfer: { title: 'Transfers', subtitle: 'Every call a fronter transferred — the full log, with each call’s current state' },
  unclosed: { title: 'Unclosed', subtitle: 'Reached a closer but not yet a configured sale' },
  closed: {
    title: 'Closed',
    subtitle: "Every sale — transfer, callback and inbound — so the count matches the dialer's SALE column",
  },
};

/** How a Closed entry became a sale — together these add up to the dialer's SALE count. */
export function SaleTypeChip({ transfer }: { transfer: Transfer }) {
  if (transfer.kind === 'inbound_sale') {
    return <span className="chip bg-info-soft text-info" title="Reached the closer group with no fronter transfer">Inbound sale</span>;
  }
  if (transfer.kind === 'callback_sale') {
    return <span className="chip bg-amber-soft text-amber-line" title="Closer's own follow-up call, no transfer in the window">Callback sale</span>;
  }
  if (transfer.saleCallId) {
    return <span className="chip bg-brand-soft text-brand" title="Transferred, then sold on a later call of the same lead">Transfer · sold later</span>;
  }
  return <span className="chip bg-good-soft text-good" title="Sold on the transfer's closer call">Transfer sale</span>;
}

export function QueuePage() {
  const { status = 'transfer' } = useParams();
  const { companyId } = useCompanyScope();
  const { hasPerm } = useAuth();
  // the dialer list is an admin endpoint — reviewers just see all dialers
  const canListDialers = hasPerm('admin.dialers');
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [dialerId, setDialerId] = useState('');
  const [matchStatus, setMatchStatus] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');

  // filters reset pagination
  useEffect(() => setPage(1), [status, companyId, search, dialerId, matchStatus, dateFrom, dateTo]);

  const { data: dialers } = useQuery({
    queryKey: ['dialers', companyId],
    queryFn: () => api<{ dialers: Dialer[] }>('/dialers', { query: { companyId: companyId || undefined } }),
    staleTime: 60_000,
    enabled: canListDialers,
  });

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['queue', status, companyId, page, search, dialerId, matchStatus, dateFrom, dateTo],
    queryFn: () =>
      api<{ items: QueueItem[]; meta: PageMeta }>(`/queues/${status}`, {
        query: {
          companyId: companyId || undefined,
          page,
          pageSize: 25,
          search: search || undefined,
          dialerServerId: dialerId || undefined,
          matchStatus: matchStatus || undefined,
          // plain dates: the server interprets them as the dialer's day
          dateFrom: dateFrom || undefined,
          dateTo: dateTo || undefined,
        },
      }),
    placeholderData: keepPreviousData,
  });

  const meta = TITLES[status] ?? TITLES.transfer;
  const exportUrl = `/api/v1/reports/transfers.csv?queueStatus=${status}${companyId ? `&companyId=${companyId}` : ''}`;

  return (
    <div>
      <PageHeader
        title={meta.title}
        subtitle={meta.subtitle}
        actions={
          <a href={exportUrl} className="btn-secondary" download>
            <Download size={14} /> Export CSV
          </a>
        }
      />

      <div className="card mb-3 flex flex-wrap items-end gap-3 p-3">
        <form
          className="relative"
          onSubmit={(e) => {
            e.preventDefault();
            setSearch(searchInput);
          }}
        >
          <Search size={14} className="absolute left-2.5 top-2.5 text-ink-3" />
          <input
            className="input w-56 pl-8"
            placeholder="Phone or lead ID"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            aria-label="Search by phone or lead ID"
          />
        </form>
        {canListDialers && (
          <select className="input w-48" value={dialerId} onChange={(e) => setDialerId(e.target.value)} aria-label="Dialer">
            <option value="">All dialers</option>
            {dialers?.dialers.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        )}
        <select className="input w-44" value={matchStatus} onChange={(e) => setMatchStatus(e.target.value)} aria-label="Match status">
          <option value="">Any match status</option>
          <option value="pending_match">Pending match</option>
          <option value="matched">Matched</option>
          <option value="flagged">Flagged for review</option>
          <option value="unmatched">Unmatched</option>
        </select>
        <input type="date" className="input w-40" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} aria-label="From date" />
        <input type="date" className="input w-40" value={dateTo} onChange={(e) => setDateTo(e.target.value)} aria-label="To date" />
      </div>

      {isLoading ? (
        <Loading />
      ) : isError || !data ? (
        <ErrorState message="Queue could not load." onRetry={() => void refetch()} />
      ) : data.items.length === 0 ? (
        <EmptyState
          title={`No ${meta.title.toLowerCase()} match these filters`}
          hint="Widen the date range or clear the filters above."
        />
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b border-ink/10">
              <tr>
                <th className="th">{status === 'closed' ? 'Time' : 'Transferred'}</th>
                {status === 'transfer' && <th className="th">State</th>}
                {status === 'closed' && <th className="th">Sale type</th>}
                <th className="th">Phone</th>
                <th className="th">Fronter</th>
                <th className="th">Campaign</th>
                <th className="th">Closer</th>
                <th className="th">Closer dispo</th>
                <th className="th">Match</th>
                <th className="th">Dialer</th>
                <th className="th"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink/5">
              {data.items.map((row) => (
                <tr key={row.transfer.id} className="hover:bg-bg/60">
                  <td className="td font-mono text-2xs">{fmtDateTime(row.transfer.xferTime)}</td>
                  {status === 'transfer' && (
                    <td className="td">
                      <Chip value={row.transfer.queueStatus} />
                    </td>
                  )}
                  {status === 'closed' && (
                    <td className="td">
                      <SaleTypeChip transfer={row.transfer} />
                    </td>
                  )}
                  <td className="td font-mono">{row.transfer.phoneNumber ?? '—'}</td>
                  <td className="td">
                    {row.fronterCall ? (
                      <>
                        <div className="font-medium">{row.fronterAgentName ?? row.fronterCall.viciUserRaw ?? '—'}</div>
                        <div className="font-mono text-2xs text-ink-3">{row.fronterAgentUser ?? ''}</div>
                      </>
                    ) : (
                      <span className="text-2xs text-ink-3">no fronter</span>
                    )}
                  </td>
                  <td className="td text-ink-2">{row.campaignName ?? row.viciCampaignId ?? '—'}</td>
                  <td className="td">
                    {row.closerAgentName || row.closerAgentUser ? (
                      <>
                        <div className="font-medium">{row.closerAgentName ?? row.closerAgentUser}</div>
                        <div className="font-mono text-2xs text-ink-3">
                          {fmtDuration(row.closerLength)} on closer
                        </div>
                      </>
                    ) : (
                      <span className="text-ink-3">—</span>
                    )}
                  </td>
                  <td className="td">
                    <DispoChip code={row.closerStatus} />
                  </td>
                  <td className="td">
                    <Chip value={row.transfer.matchStatus} />
                    {row.transfer.matchConfidence != null && (
                      <span className="ml-1 font-mono text-2xs text-ink-3">{row.transfer.matchConfidence}</span>
                    )}
                  </td>
                  <td className="td text-ink-2">{row.dialerName}</td>
                  <td className="td">
                    <Link to={`/transfers/${row.transfer.id}?from=${status}`} className="font-medium text-brand hover:underline">
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
