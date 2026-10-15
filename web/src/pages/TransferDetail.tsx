import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ClipboardPlus, GitMerge } from 'lucide-react';
import { api } from '../api/client';
import type { Call, Evaluation, QaForm, Recording, TransferEvent, Transfer } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { AudioPlayer } from '../components/AudioPlayer';
import { Chip, ErrorState, Loading, Modal, PageHeader, fmtDateTime, fmtDuration } from '../components/ui';

type LeadInfo = Record<string, string | number | null>;

interface Detail {
  transfer: Transfer;
  fronterCall: Call;
  closerCall: Call | null;
  lead: LeadInfo | null;
  fronterAgentUser: string | null;
  fronterAgentName: string | null;
  closerAgentUser: string | null;
  closerAgentName: string | null;
  dialerName: string;
  recordings: Recording[];
  events: TransferEvent[];
  evaluations: Evaluation[];
}

interface Candidate {
  call: Call;
  agentUser: string | null;
  agentName: string | null;
  dialerName: string;
  match: { score: number; reasons: string[] };
}

function CallLeg({
  title,
  call,
  agentName,
  agentUser,
  recordings,
}: {
  title: string;
  call: Call | null;
  agentName: string | null;
  agentUser: string | null;
  recordings: Recording[];
}) {
  return (
    <div className="card p-4">
      <h2 className="mb-3 font-display text-sm font-bold">{title}</h2>
      {!call ? (
        <p className="text-sm text-ink-2">No linked call leg yet.</p>
      ) : (
        <>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
            <div>
              <dt className="label">Agent</dt>
              <dd>
                {agentName ?? call.viciUserRaw ?? '—'}{' '}
                {agentUser && <span className="font-mono text-2xs text-ink-3">({agentUser})</span>}
              </dd>
            </div>
            <div>
              <dt className="label">Disposition</dt>
              <dd className="font-mono">{call.status ?? '—'}</dd>
            </div>
            <div>
              <dt className="label">Start</dt>
              <dd className="font-mono text-2xs">{fmtDateTime(call.callDate)}</dd>
            </div>
            <div>
              <dt className="label">Length</dt>
              <dd className="font-mono">{fmtDuration(call.lengthSec)}</dd>
            </div>
            <div>
              <dt className="label">Lead ID</dt>
              <dd className="font-mono">{call.viciLeadId ?? '—'}</dd>
            </div>
            <div>
              <dt className="label">Unique ID</dt>
              <dd className="font-mono text-2xs">{call.viciUniqueId ?? '—'}</dd>
            </div>
          </dl>
          <div className="mt-3 space-y-2">
            {recordings.length === 0 && <p className="text-2xs text-ink-3">No recording linked to this leg.</p>}
            {recordings.map((rec) =>
              rec.status === 'available' ? (
                <AudioPlayer key={rec.id} recordingId={rec.id} label={rec.filename} />
              ) : (
                <div key={rec.id} className="flex items-center gap-2 rounded-md bg-bg px-3 py-2 text-2xs text-ink-2">
                  <Chip value={rec.status} />
                  <span className="truncate font-mono">{rec.filename}</span>
                </div>
              ),
            )}
          </div>
        </>
      )}
    </div>
  );
}

function LeadCard({ lead }: { lead: LeadInfo }) {
  const s = (k: string): string => {
    const v = lead[k];
    return v === null || v === undefined || v === '' ? '' : String(v);
  };
  const name = [s('title'), s('first_name'), s('middle_initial'), s('last_name')]
    .filter(Boolean)
    .join(' ');
  const address = [s('address1'), s('address2'), s('address3')].filter(Boolean).join(', ');
  const cityLine = [s('city'), s('state'), s('postal_code')].filter(Boolean).join(', ');
  const fields: Array<{ label: string; value: string; mono?: boolean }> = [
    { label: 'Name', value: name },
    { label: 'Phone', value: s('phone_number'), mono: true },
    { label: 'Alt phone', value: s('alt_phone'), mono: true },
    { label: 'Email', value: s('email'), mono: true },
    { label: 'Address', value: address },
    { label: 'City / State / ZIP', value: cityLine },
    { label: 'Lead status', value: s('status'), mono: true },
    { label: 'Lead ID', value: s('lead_id'), mono: true },
    { label: 'List ID', value: s('list_id'), mono: true },
    { label: 'Vendor code', value: s('vendor_lead_code'), mono: true },
    { label: 'Times called', value: s('called_count'), mono: true },
    { label: 'Last call', value: s('last_local_call_time'), mono: true },
    { label: 'Entered', value: s('entry_date'), mono: true },
    { label: 'Security phrase', value: s('security_phrase') },
  ].filter((f) => f.value !== '');
  const comments = s('comments');

  return (
    <div className="card mt-4 p-4">
      <h2 className="mb-3 font-display text-sm font-bold">Lead details</h2>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm md:grid-cols-3 lg:grid-cols-4">
        {fields.map((f) => (
          <div key={f.label} className="min-w-0">
            <dt className="label">{f.label}</dt>
            <dd className={`truncate ${f.mono ? 'font-mono text-[13px]' : ''}`} title={f.value}>
              {f.value}
            </dd>
          </div>
        ))}
      </dl>
      {comments && (
        <div className="mt-3 rounded-md bg-bg px-3 py-2 text-sm">
          <span className="label">Comments</span>
          <p className="whitespace-pre-wrap">{comments}</p>
        </div>
      )}
    </div>
  );
}

export function TransferDetailPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { hasPerm } = useAuth();
  const [evalModal, setEvalModal] = useState(false);
  const [resolveOpen, setResolveOpen] = useState(false);

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['transfer', id],
    queryFn: () => api<Detail>(`/queues/detail/${id}`),
  });

  const { data: formsData } = useQuery({
    queryKey: ['forms', data?.transfer.companyId],
    queryFn: () =>
      api<{ forms: QaForm[] }>('/qa/forms', {
        query: { companyId: data?.transfer.companyId, state: 'published' },
      }),
    enabled: evalModal && !!data,
  });

  const { data: candidates } = useQuery({
    queryKey: ['candidates', id],
    queryFn: () => api<{ candidates: Candidate[] }>(`/queues/detail/${id}/candidates`),
    enabled: resolveOpen,
  });

  const startEval = useMutation({
    mutationFn: (formId: string) =>
      api<{ evaluation: Evaluation }>('/evaluations', { method: 'POST', body: { transferId: id, formId } }),
    onSuccess: (res) => navigate(`/qa/evaluations/${res.evaluation.id}`),
  });

  const resolve = useMutation({
    mutationFn: (closerCallId: string | null) =>
      api(`/queues/detail/${id}/resolve`, { method: 'POST', body: { closerCallId, note: 'resolved from UI' } }),
    onSuccess: () => {
      setResolveOpen(false);
      void queryClient.invalidateQueries({ queryKey: ['transfer', id] });
    },
  });

  if (isLoading) return <Loading />;
  if (isError || !data) return <ErrorState message="Transfer could not load." onRetry={() => void refetch()} />;

  const t = data.transfer;
  const fronterRecs = data.recordings.filter((r) => r.callId === data.fronterCall.id);
  const closerRecs = data.recordings.filter((r) => data.closerCall && r.callId === data.closerCall.id);

  return (
    <div>
      <PageHeader
        title={`Transfer · ${t.phoneNumber ?? 'unknown number'}`}
        subtitle={`${data.dialerName} · transferred ${fmtDateTime(t.xferTime)}${t.isMock ? ' · MOCK DATA' : ''}`}
        actions={
          <>
            {hasPerm('qa.assign') && (t.matchStatus === 'flagged' || t.matchStatus === 'unmatched') && (
              <button className="btn-secondary" onClick={() => setResolveOpen(true)}>
                <GitMerge size={14} /> Resolve match
              </button>
            )}
            {hasPerm('qa.evaluate') && (
              <button className="btn-primary" onClick={() => setEvalModal(true)}>
                <ClipboardPlus size={14} /> Start evaluation
              </button>
            )}
          </>
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Chip value={t.queueStatus} />
        <Chip value={t.matchStatus} />
        {t.matchConfidence != null && (
          <span className="font-mono text-2xs text-ink-2">confidence {t.matchConfidence}/100</span>
        )}
        {t.saleDisposition && (
          <span className="chip bg-good-soft text-good">sale: {t.saleDisposition}</span>
        )}
        {t.matchNotes && <span className="text-2xs text-ink-3">{t.matchNotes}</span>}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <CallLeg
          title="Fronter leg"
          call={data.fronterCall}
          agentName={data.fronterAgentName}
          agentUser={data.fronterAgentUser}
          recordings={fronterRecs}
        />
        <CallLeg
          title="Closer leg"
          call={data.closerCall}
          agentName={data.closerAgentName}
          agentUser={data.closerAgentUser}
          recordings={closerRecs}
        />
      </div>

      {data.lead && <LeadCard lead={data.lead} />}

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <div className="card p-4">
          <h2 className="mb-3 font-display text-sm font-bold">Status history</h2>
          <ol className="space-y-2">
            {data.events.map((e) => (
              <li key={e.id} className="flex gap-3 text-sm">
                <span className="w-28 shrink-0 font-mono text-2xs text-ink-3">{fmtDateTime(e.createdAt)}</span>
                <span>
                  <Chip value={e.toStatus} />{' '}
                  <span className="text-ink-2">{e.reason}</span>
                </span>
              </li>
            ))}
            {data.events.length === 0 && <p className="text-sm text-ink-2">No events recorded.</p>}
          </ol>
        </div>

        <div className="card p-4">
          <h2 className="mb-3 font-display text-sm font-bold">Evaluations</h2>
          {data.evaluations.length === 0 ? (
            <p className="text-sm text-ink-2">No evaluations yet. Start one from the button above.</p>
          ) : (
            <ul className="space-y-2">
              {data.evaluations.map((ev) => (
                <li key={ev.id} className="flex items-center justify-between text-sm">
                  <span className="flex items-center gap-2">
                    <Chip value={ev.status} />
                    {ev.status === 'completed' && (
                      <span className="font-mono">
                        {ev.percent}% {ev.autoFailed ? '(auto-fail)' : ev.passed ? '(pass)' : '(fail)'}
                      </span>
                    )}
                  </span>
                  <Link to={`/qa/evaluations/${ev.id}`} className="font-medium text-brand hover:underline">
                    Open
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <Modal title="Start evaluation" open={evalModal} onClose={() => setEvalModal(false)}>
        <p className="mb-3 text-sm text-ink-2">Choose a published QA form for this call.</p>
        <div className="space-y-2">
          {formsData?.forms.filter((f) => !f.queue || f.queue === t.queueStatus).map((f) => (
            <button
              key={f.id}
              className="card flex w-full items-center justify-between p-3 text-left hover:bg-bg"
              onClick={() => startEval.mutate(f.id)}
              disabled={startEval.isPending}
            >
              <span>
                <span className="font-medium">{f.name}</span>
                <span className="ml-2 text-2xs text-ink-3">v{f.currentVersion} · {f.target}</span>
              </span>
              <span className="text-brand">Use →</span>
            </button>
          ))}
          {formsData && formsData.forms.filter((f) => !f.queue || f.queue === t.queueStatus).length === 0 && (
            <p className="text-sm text-ink-2">
              No evaluation method for this queue is available to you.
            </p>
          )}
        </div>
      </Modal>

      <Modal title="Resolve closer match" open={resolveOpen} onClose={() => setResolveOpen(false)} wide>
        <p className="mb-3 text-sm text-ink-2">
          Candidates within the transfer window, scored by lead, phone and timing. Pick the correct closer
          leg, or mark the transfer unmatched.
        </p>
        <div className="max-h-96 space-y-2 overflow-y-auto">
          {candidates?.candidates.map((c) => (
            <div key={c.call.id} className="card flex items-center justify-between p-3">
              <div className="text-sm">
                <div className="font-medium">
                  {c.agentName ?? c.agentUser ?? c.call.viciUserRaw ?? 'Unknown agent'}{' '}
                  <span className="font-mono text-2xs text-ink-3">{c.dialerName}</span>
                </div>
                <div className="font-mono text-2xs text-ink-2">
                  {fmtDateTime(c.call.callDate)} · {c.call.phoneNumber} · lead {c.call.viciLeadId ?? '—'} ·{' '}
                  {c.call.status}
                </div>
                <div className="mt-0.5 text-2xs text-ink-3">{c.match.reasons.join('; ')}</div>
              </div>
              <div className="flex items-center gap-3">
                <span className="font-display text-lg font-bold tabular-nums">{c.match.score}</span>
                <button className="btn-primary" onClick={() => resolve.mutate(c.call.id)} disabled={resolve.isPending}>
                  Link
                </button>
              </div>
            </div>
          ))}
          {candidates && candidates.candidates.length === 0 && (
            <p className="text-sm text-ink-2">No closer calls found in the matching window.</p>
          )}
        </div>
        <div className="mt-4 flex justify-end">
          <button className="btn-secondary" onClick={() => resolve.mutate(null)} disabled={resolve.isPending}>
            Mark unmatched
          </button>
        </div>
      </Modal>
    </div>
  );
}
