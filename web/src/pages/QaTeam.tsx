import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Search, X } from 'lucide-react';
import { api, ApiError } from '../api/client';
import type { Agent, PageMeta } from '../api/types';
import { useCompanyScope } from '../components/Layout';
import { EmptyState, ErrorState, Loading, PageHeader } from '../components/ui';
import { QaSettingsCard } from '../components/QaSettingsCard';

type Method = 'transfer' | 'unclosed' | 'closed';
const METHODS: Array<{ key: Method; label: string; short: string }> = [
  { key: 'transfer', label: 'Transfer', short: 'T' },
  { key: 'unclosed', label: 'Unclosed', short: 'U' },
  { key: 'closed', label: 'Closed', short: 'C' },
];

interface Reviewer {
  id: string;
  name: string;
  email: string;
  status: string;
  roleName: string;
  /** reviews here with access from another company */
  shared?: boolean;
  agentCount: number;
  methodCounts: Record<Method, number>;
}

interface Assignment {
  viciAgentId: string;
  methods: Method[];
  viciUser: string;
  fullName: string | null;
  agentRole: string;
  dialerName: string;
}

function MethodToggle({
  method,
  on,
  onClick,
}: {
  method: (typeof METHODS)[number];
  on: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={method.label}
      aria-pressed={on}
      className={`chip min-w-[4.5rem] justify-center transition-colors ${
        on ? 'bg-brand text-white' : 'bg-bg text-ink-3 hover:text-ink'
      }`}
    >
      {method.label}
    </button>
  );
}

function ReviewerEditor({ reviewer, onSaved }: { reviewer: Reviewer; onSaved: () => void }) {
  const { companyId } = useCompanyScope();
  const [search, setSearch] = useState('');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [pickMethods, setPickMethods] = useState<Set<Method>>(new Set(['transfer']));
  const [list, setList] = useState<Assignment[]>([]);
  const [dirty, setDirty] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  // assignments are per company — someone reviewing for several companies
  // has a separate list in each
  const { data: current, isLoading } = useQuery({
    queryKey: ['qa-team-assignments', reviewer.id, companyId],
    queryFn: () =>
      api<{ assignments: Assignment[] }>(`/qa/team/${reviewer.id}/assignments`, {
        query: { companyId: companyId || undefined },
      }),
  });
  useEffect(() => {
    if (current) {
      setList(current.assignments);
      setDirty(false);
      setPicked(new Set());
      setMessage(null);
    }
  }, [current]);

  const { data: agentsData } = useQuery({
    queryKey: ['agents-pick', companyId, search],
    queryFn: () =>
      api<{ agents: Agent[]; meta: PageMeta }>('/agents', {
        query: { companyId: companyId || undefined, search: search || undefined, pageSize: 200 },
      }),
    staleTime: 60_000,
  });

  const assignedIds = useMemo(() => new Set(list.map((a) => a.viciAgentId)), [list]);
  const available = (agentsData?.agents ?? []).filter((a) => !assignedIds.has(a.id));

  const update = (next: Assignment[]) => {
    setList(next);
    setDirty(true);
    setMessage(null);
  };

  const assignPicked = () => {
    if (picked.size === 0 || pickMethods.size === 0) return;
    const add: Assignment[] = available
      .filter((a) => picked.has(a.id))
      .map((a) => ({
        viciAgentId: a.id,
        methods: [...pickMethods],
        viciUser: a.viciUser,
        fullName: a.fullName,
        agentRole: a.agentRole,
        dialerName: a.dialerName ?? '',
      }));
    update([...list, ...add]);
    setPicked(new Set());
  };

  const toggleMethod = (agentId: string, m: Method) => {
    update(
      list.flatMap((a) => {
        if (a.viciAgentId !== agentId) return [a];
        const methods = a.methods.includes(m) ? a.methods.filter((x) => x !== m) : [...a.methods, m];
        // an agent with no methods left is no longer assigned
        return methods.length > 0 ? [{ ...a, methods }] : [];
      }),
    );
  };

  const save = useMutation({
    mutationFn: () =>
      api(`/qa/team/${reviewer.id}/assignments`, {
        method: 'PUT',
        query: { companyId: companyId || undefined },
        body: { assignments: list.map((a) => ({ viciAgentId: a.viciAgentId, methods: a.methods })) },
      }),
    onSuccess: () => {
      setDirty(false);
      setMessage(`Saved — ${reviewer.name} now covers ${list.length} agent${list.length === 1 ? '' : 's'}.`);
      onSaved();
    },
    onError: (err) => setMessage(err instanceof ApiError ? err.message : 'Save failed.'),
  });

  if (isLoading) return <Loading />;

  const allShownPicked = available.length > 0 && available.every((a) => picked.has(a.id));

  return (
    <div className="space-y-4">
      <div className="card flex flex-wrap items-center justify-between gap-3 p-4">
        <div>
          <h2 className="font-display text-base font-bold">{reviewer.name}</h2>
          <p className="text-2xs text-ink-3">
            {reviewer.email} ·{' '}
            {list.length === 0
              ? 'no agents assigned — sees every agent'
              : `covers ${list.length} agent${list.length === 1 ? '' : 's'}`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {message && <span className="text-2xs font-medium text-brand">{message}</span>}
          {dirty && <span className="text-2xs text-amber-line">Unsaved changes</span>}
          <button className="btn-secondary" disabled={!dirty || save.isPending} onClick={() => current && setList(current.assignments)}>
            Discard
          </button>
          <button className="btn-primary" disabled={!dirty || save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <div className="card flex min-h-0 flex-col p-4">
          <h3 className="mb-2 font-display text-sm font-bold">Add agents</h3>
          <div className="relative mb-2">
            <Search size={14} className="absolute left-2.5 top-2.5 text-ink-3" />
            <input
              className="input pl-8"
              placeholder="Search agent name or user ID"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              aria-label="Search agents"
            />
          </div>
          <label className="mb-1 flex items-center gap-2 px-1 text-2xs text-ink-2">
            <input
              type="checkbox"
              checked={allShownPicked}
              onChange={(e) => setPicked(e.target.checked ? new Set(available.map((a) => a.id)) : new Set())}
            />
            Select all shown ({available.length})
          </label>
          <div className="max-h-80 min-h-0 flex-1 divide-y divide-ink/5 overflow-y-auto rounded-md border border-ink/10">
            {available.map((a) => (
              <label key={a.id} className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm hover:bg-bg/60">
                <input
                  type="checkbox"
                  checked={picked.has(a.id)}
                  onChange={(e) => {
                    const next = new Set(picked);
                    if (e.target.checked) next.add(a.id);
                    else next.delete(a.id);
                    setPicked(next);
                  }}
                />
                <span className="min-w-0 flex-1 truncate">{a.fullName ?? a.viciUser}</span>
                <span className="font-mono text-2xs text-ink-3">{a.viciUser}</span>
              </label>
            ))}
            {available.length === 0 && (
              <p className="px-3 py-6 text-center text-2xs text-ink-3">
                {search ? 'No unassigned agent matches.' : 'Every agent is already assigned.'}
              </p>
            )}
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <span className="text-2xs font-semibold uppercase tracking-wider text-ink-2">Methods</span>
            {METHODS.map((m) => (
              <MethodToggle
                key={m.key}
                method={m}
                on={pickMethods.has(m.key)}
                onClick={() => {
                  const next = new Set(pickMethods);
                  if (next.has(m.key)) next.delete(m.key);
                  else next.add(m.key);
                  setPickMethods(next);
                }}
              />
            ))}
            <button
              className="btn-primary ml-auto"
              disabled={picked.size === 0 || pickMethods.size === 0}
              onClick={assignPicked}
            >
              Assign {picked.size > 0 ? picked.size : ''} agent{picked.size === 1 ? '' : 's'}
            </button>
          </div>
        </div>

        <div className="card flex min-h-0 flex-col p-4">
          <div className="mb-2 flex items-center justify-between">
            <h3 className="font-display text-sm font-bold">Assigned agents ({list.length})</h3>
            {list.length > 0 && (
              <button className="text-2xs font-medium text-bad hover:underline" onClick={() => update([])}>
                Remove all
              </button>
            )}
          </div>
          {list.length === 0 ? (
            <p className="rounded-md bg-bg px-3 py-6 text-center text-sm text-ink-2">
              No agents assigned. This reviewer sees every agent's calls in every queue they can access.
            </p>
          ) : (
            <div className="max-h-[26rem] min-h-0 flex-1 divide-y divide-ink/5 overflow-y-auto rounded-md border border-ink/10">
              {list.map((a) => (
                <div key={a.viciAgentId} className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium">{a.fullName ?? a.viciUser}</div>
                    <div className="font-mono text-2xs text-ink-3">{a.viciUser}</div>
                  </div>
                  <div className="flex gap-1">
                    {METHODS.map((m) => (
                      <MethodToggle
                        key={m.key}
                        method={m}
                        on={a.methods.includes(m.key)}
                        onClick={() => toggleMethod(a.viciAgentId, m.key)}
                      />
                    ))}
                  </div>
                  <button
                    className="text-ink-3 hover:text-bad"
                    onClick={() => update(list.filter((x) => x.viciAgentId !== a.viciAgentId))}
                    aria-label={`Remove ${a.fullName ?? a.viciUser}`}
                  >
                    <X size={15} />
                  </button>
                </div>
              ))}
            </div>
          )}
          <p className="mt-2 text-2xs text-ink-3">
            Transfer reviews the fronter's leg; Unclosed and Closed review the closer's leg.
          </p>
        </div>
      </div>
    </div>
  );
}

export function QaTeamPage() {
  const { companyId } = useCompanyScope();
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['qa-team', companyId],
    queryFn: () => api<{ reviewers: Reviewer[] }>('/qa/team', { query: { companyId: companyId || undefined } }),
  });

  const reviewers = data?.reviewers ?? [];
  const selected = reviewers.find((r) => r.id === selectedId) ?? reviewers[0] ?? null;

  return (
    <div>
      <PageHeader
        title="QA team"
        subtitle="Choose which agents each reviewer evaluates, and with which methods"
      />
      <QaSettingsCard />
      {isLoading ? (
        <Loading />
      ) : isError ? (
        <ErrorState message="QA team could not load." onRetry={() => void refetch()} />
      ) : reviewers.length === 0 ? (
        <EmptyState
          title="No QA reviewers yet"
          hint="Create users with the QA reviewer role under Users & roles, then assign them agents here."
        />
      ) : (
        <div className="grid gap-4 lg:grid-cols-[18rem_minmax(0,1fr)]">
          <div className="card h-fit divide-y divide-ink/5">
            {reviewers.map((r) => {
              const active = selected?.id === r.id;
              return (
                <button
                  key={r.id}
                  onClick={() => setSelectedId(r.id)}
                  className={`block w-full px-4 py-3 text-left transition-colors ${active ? 'bg-brand-soft' : 'hover:bg-bg/60'}`}
                >
                  <div className={`font-medium ${active ? 'text-brand' : ''}`}>
                    {r.name}
                    {r.shared && (
                      <span className="chip ml-1.5 bg-info-soft text-info" title="Reviews here with access from another company">
                        shared
                      </span>
                    )}
                  </div>
                  <div className="mt-1 flex flex-wrap gap-1 text-2xs">
                    {r.agentCount === 0 ? (
                      <span className="chip bg-bg text-ink-2">All agents</span>
                    ) : (
                      <>
                        <span className="chip bg-amber-soft text-amber-line">
                          {r.agentCount} agent{r.agentCount === 1 ? '' : 's'}
                        </span>
                        {METHODS.filter((m) => r.methodCounts[m.key] > 0).map((m) => (
                          <span key={m.key} className="chip bg-bg text-ink-2">
                            {m.label} {r.methodCounts[m.key]}
                          </span>
                        ))}
                      </>
                    )}
                    {r.status !== 'active' && <span className="chip bg-bad-soft text-bad">disabled</span>}
                  </div>
                </button>
              );
            })}
          </div>
          {selected && (
            <ReviewerEditor
              key={selected.id}
              reviewer={selected}
              onSaved={() => void queryClient.invalidateQueries({ queryKey: ['qa-team'] })}
            />
          )}
        </div>
      )}
    </div>
  );
}
