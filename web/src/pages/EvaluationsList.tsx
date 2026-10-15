import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Download, Headphones, X } from 'lucide-react';
import { api } from '../api/client';
import type { Evaluation, FormDefinition, FormQuestion, PageMeta } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { useCompanyScope } from '../components/Layout';
import { AudioPlayer } from '../components/AudioPlayer';
import { Chip, EmptyState, ErrorState, Loading, PageHeader, Pagination } from '../components/ui';

interface Row {
  evaluation: Evaluation;
  reviewerName: string;
  formName: string;
  formTarget: 'fronter' | 'closer' | 'any';
  formId: string;
  formVersion: number;
  formVersionId: string;
  phone: string | null;
  callTime: string | null;
  queueStatus: string | null;
  fronterAgent: string | null;
  fronterUser: string | null;
  closerAgent: string | null;
  closerUser: string | null;
  hasRecording: boolean;
}

interface ListResponse {
  evaluations: Row[];
  forms: Record<string, { version: number; schema: FormDefinition }>;
  meta: PageMeta;
}

interface DrawerDetail {
  evaluation: Evaluation;
  reviewerName: string;
  formName: string;
  formVersion: number;
  formSchema: FormDefinition;
  passThreshold: string;
  call: {
    phoneNumber: string | null;
    xferTime: string;
    fronterAgent: string | null;
    closerAgent: string | null;
    closerStatus: string | null;
    transferId: string;
  } | null;
  recordings: Array<{ id: string; status: string; leg: 'fronter' | 'closer' }>;
}

interface QaFormLite {
  id: string;
  name: string;
}

function agentOf(r: Row): string {
  return (
    (r.formTarget === 'fronter' ? (r.fronterAgent ?? r.fronterUser) : (r.closerAgent ?? r.closerUser)) ??
    r.fronterAgent ??
    r.closerAgent ??
    '—'
  );
}

function answerCell(q: FormQuestion, answers: Evaluation['answers']): { text: string; sub: string; ratio: number } | null {
  const v = answers?.[q.id];
  if (v === null || v === undefined || v === '') return null;
  if (q.type === 'rating') {
    const n = Number(v);
    const max = q.scaleMax ?? 5;
    return { text: String(n), sub: `${n}/${max}`, ratio: max > 0 ? n / max : 0 };
  }
  if (q.type === 'dropdown') {
    const opt = q.options?.find((o) => o.value === String(v));
    const pct = opt?.scorePct ?? 0;
    const earned = Math.round(((q.weight * pct) / 100) * 100) / 100;
    return { text: opt?.label ?? String(v), sub: `${earned}/${q.weight}`, ratio: pct / 100 };
  }
  return { text: String(v), sub: '', ratio: 1 };
}

function dateParts(iso: string | null): { d: string; t: string } {
  if (!iso) return { d: '—', t: '' };
  const x = new Date(iso);
  return {
    d: x.toLocaleDateString(undefined, { day: '2-digit', month: 'short' }),
    t: x.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }),
  };
}

function Drawer({ id, onClose }: { id: string; onClose: () => void }) {
  const { data, isLoading } = useQuery({
    queryKey: ['evaluation', id],
    queryFn: () => api<DrawerDetail>(`/evaluations/${id}`),
  });
  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-ink/30" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="h-full w-full max-w-md overflow-y-auto bg-surface p-4 shadow-xl">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="font-display text-base font-bold">Evaluation</h2>
          <button onClick={onClose} className="text-ink-3 hover:text-ink" aria-label="Close">
            <X size={18} />
          </button>
        </div>
        {isLoading || !data ? (
          <Loading />
        ) : (
          <div className="space-y-4">
            <div className={`rounded-md p-3 ${data.evaluation.autoFailed || data.evaluation.passed === false ? 'bg-bad-soft' : data.evaluation.passed ? 'bg-good-soft' : 'bg-bg'}`}>
              <div className="flex items-baseline gap-3">
                <span className="font-display text-2xl font-bold tabular-nums">
                  {data.evaluation.percent != null ? `${data.evaluation.percent}%` : '—'}
                </span>
                <Chip value={data.evaluation.status} />
                {data.evaluation.status === 'completed' && (
                  <span className="text-sm font-semibold">
                    {data.evaluation.autoFailed ? 'Auto-fail' : data.evaluation.passed ? 'Pass' : 'Fail'}
                  </span>
                )}
              </div>
              <div className="mt-1 text-2xs text-ink-2">
                {data.formName} v{data.formVersion} · reviewer {data.reviewerName} · pass ≥ {data.passThreshold}%
              </div>
            </div>

            {data.call && (
              <div className="rounded-md bg-bg p-3 text-sm">
                <div className="font-mono font-semibold">{data.call.phoneNumber ?? '—'}</div>
                <div className="mt-0.5 text-2xs text-ink-2">
                  {data.call.fronterAgent && <>fronter {data.call.fronterAgent}</>}
                  {data.call.closerAgent && <> · closer {data.call.closerAgent}</>}
                  {data.call.closerStatus && <> · dispo <span className="font-mono">{data.call.closerStatus}</span></>}
                </div>
              </div>
            )}

            {data.recordings.filter((r) => r.status === 'available').map((r) => (
              <div key={r.id}>
                <div className="label">{r.leg} recording</div>
                <AudioPlayer recordingId={r.id} />
              </div>
            ))}

            <div>
              <div className="label">Scores</div>
              <div className="divide-y divide-ink/5 rounded-md border border-ink/10">
                {data.formSchema.sections.flatMap((s) => s.questions).map((q) => {
                  const cell = answerCell(q, data.evaluation.answers);
                  return (
                    <div key={q.id} className="flex items-center justify-between gap-3 px-3 py-1.5 text-sm">
                      <span className="min-w-0 flex-1 truncate" title={q.text}>{q.text}</span>
                      {cell ? (
                        <span className={`shrink-0 font-mono tabular-nums ${q.weight > 0 && cell.ratio <= 0.5 ? 'font-semibold text-bad' : ''}`}>
                          {cell.text}
                          {cell.sub && <span className="ml-1 text-2xs text-ink-3">{cell.sub}</span>}
                        </span>
                      ) : (
                        <span className="text-ink-3">—</span>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            {data.evaluation.comments && (
              <div>
                <div className="label">Comments</div>
                <p className="whitespace-pre-wrap rounded-md bg-bg p-3 text-sm">{data.evaluation.comments}</p>
              </div>
            )}

            <Link to={`/qa/evaluations/${data.evaluation.id}`} className="btn-primary w-full justify-center">
              Open full evaluation
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}

export function EvaluationsListPage() {
  const { companyId } = useCompanyScope();
  const { hasPerm } = useAuth();
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState('');
  const [mine, setMine] = useState(false);
  const [agent, setAgent] = useState('');
  const [formId, setFormId] = useState('');
  const [result, setResult] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [drawerId, setDrawerId] = useState<string | null>(null);

  useEffect(() => setPage(1), [companyId, status, mine, agent, formId, result, dateFrom, dateTo]);

  const { data: formsList } = useQuery({
    queryKey: ['forms', companyId],
    queryFn: () => api<{ forms: QaFormLite[] }>('/qa/forms', { query: { companyId: companyId || undefined } }),
    staleTime: 60_000,
  });

  const filters = {
    companyId: companyId || undefined,
    status: status || undefined,
    mine: mine || undefined,
    agent: agent || undefined,
    formId: formId || undefined,
    result: result || undefined,
    dateFrom: dateFrom || undefined,
    dateTo: dateTo || undefined,
  };

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['evaluations', filters, page],
    queryFn: () =>
      api<ListResponse>('/evaluations', { query: { ...filters, page, pageSize: 25 } }),
    placeholderData: keepPreviousData,
  });

  // one column per scored question, grouped by the forms present on this page
  const columns: Array<{ key: string; formVersionId: string; q: FormQuestion }> = [];
  if (data) {
    const seenForms = new Set<string>();
    for (const row of data.evaluations) {
      if (seenForms.has(row.formVersionId)) continue;
      seenForms.add(row.formVersionId);
      const form = data.forms[row.formVersionId];
      if (!form) continue;
      for (const q of form.schema.sections.flatMap((s) => s.questions)) {
        if (q.weight > 0) columns.push({ key: `${row.formVersionId}:${q.id}`, formVersionId: row.formVersionId, q });
      }
    }
  }

  const csvQs = Object.entries(filters)
    .filter(([k, v]) => v !== undefined && k !== 'status' && k !== 'mine')
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
    .join('&');

  return (
    <div>
      <PageHeader
        title="Evaluations"
        subtitle="Every scored call with its per-question marks — click a row for the full record and audio"
        actions={
          hasPerm('reports.export') && (
            <a href={`/api/v1/reports/evaluations.csv${csvQs ? `?${csvQs}` : ''}`} className="btn-secondary" download>
              <Download size={14} /> Export CSV
            </a>
          )
        }
      />

      <div className="card mb-3 flex flex-wrap items-end gap-3 p-3">
        <input
          className="input w-44"
          placeholder="Agent name or ID"
          value={agent}
          onChange={(e) => setAgent(e.target.value)}
          aria-label="Agent"
        />
        <select className="input w-52" value={formId} onChange={(e) => setFormId(e.target.value)} aria-label="Form">
          <option value="">All forms</option>
          {formsList?.forms.map((f) => (
            <option key={f.id} value={f.id}>{f.name}</option>
          ))}
        </select>
        <select className="input w-36" value={result} onChange={(e) => setResult(e.target.value)} aria-label="Result">
          <option value="">Any result</option>
          <option value="pass">Pass</option>
          <option value="fail">Fail</option>
          <option value="auto_fail">Auto-fail</option>
        </select>
        <select className="input w-36" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status">
          <option value="">All statuses</option>
          <option value="completed">Completed</option>
          <option value="draft">Draft</option>
        </select>
        <input type="date" className="input w-38" value={dateFrom} max={dateTo || undefined} onChange={(e) => setDateFrom(e.target.value)} aria-label="From (dialer date)" />
        <input type="date" className="input w-38" value={dateTo} min={dateFrom || undefined} onChange={(e) => setDateTo(e.target.value)} aria-label="To" />
        <label className="flex items-center gap-1.5 pb-2 text-sm text-ink-2">
          <input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} />
          My evaluations
        </label>
      </div>

      {isLoading ? (
        <Loading />
      ) : isError || !data ? (
        <ErrorState message="Evaluations could not load." onRetry={() => void refetch()} />
      ) : data.evaluations.length === 0 ? (
        <EmptyState title="No evaluations match" hint="Widen the filters, or open a call in a queue and start one." />
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b border-ink/10">
              <tr>
                <th className="th">Number</th>
                <th className="th">Agent</th>
                <th className="th">Evaluator</th>
                <th className="th">Date</th>
                <th className="th">Time</th>
                <th className="th">Method</th>
                <th className="th">Result</th>
                <th className="th">Score</th>
                {columns.map((c) => (
                  <th key={c.key} className="th max-w-36">
                    <span className="block max-w-32 truncate" title={c.q.text}>{c.q.text}</span>
                    <span className="font-normal text-ink-3">/{c.q.weight}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-ink/5">
              {data.evaluations.map((row) => {
                const when = dateParts(row.evaluation.completedAt ?? row.evaluation.createdAt);
                return (
                  <tr
                    key={row.evaluation.id}
                    className="cursor-pointer hover:bg-bg/60"
                    onClick={() => setDrawerId(row.evaluation.id)}
                  >
                    <td className="td">
                      <span className="flex items-center gap-1.5 font-mono">
                        {row.hasRecording && <Headphones size={13} className="shrink-0 text-brand" />}
                        {row.phone ?? '—'}
                      </span>
                    </td>
                    <td className="td font-medium">{agentOf(row)}</td>
                    <td className="td text-brand">{row.reviewerName}</td>
                    <td className="td font-mono text-2xs">{when.d}</td>
                    <td className="td font-mono text-2xs">{when.t}</td>
                    <td className="td text-ink-2">{row.formName.split(' ')[0]}</td>
                    <td className="td">
                      {row.evaluation.status === 'completed' ? (
                        <span className={`font-semibold ${row.evaluation.autoFailed || !row.evaluation.passed ? 'text-bad' : 'text-good'}`}>
                          {row.evaluation.autoFailed ? 'auto-fail' : row.evaluation.passed ? 'pass' : 'fail'}
                        </span>
                      ) : (
                        <span className="text-ink-3">—</span>
                      )}
                    </td>
                    <td className="td font-mono font-semibold tabular-nums">
                      {row.evaluation.percent != null ? `${Math.round(Number(row.evaluation.percent))}%` : '—'}
                    </td>
                    {columns.map((c) => {
                      if (c.formVersionId !== row.formVersionId) {
                        return <td key={c.key} className="td text-ink-3">—</td>;
                      }
                      const cell = answerCell(c.q, row.evaluation.answers);
                      return (
                        <td key={c.key} className="td">
                          {cell ? (
                            <span className={`font-mono tabular-nums ${cell.ratio <= 0.5 ? 'font-semibold text-bad' : ''}`}>
                              {cell.text}
                              {cell.sub && <span className="ml-1 text-2xs font-normal text-ink-3">{cell.sub}</span>}
                            </span>
                          ) : (
                            <span className="text-ink-3">—</span>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
          <Pagination meta={data.meta} onPage={setPage} />
        </div>
      )}

      {drawerId && <Drawer id={drawerId} onClose={() => setDrawerId(null)} />}
    </div>
  );
}
