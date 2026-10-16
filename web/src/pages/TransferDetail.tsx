import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ClipboardPlus, GitMerge, Radio } from 'lucide-react';
import { api } from '../api/client';
import type { Call, Evaluation, QaForm, TransferEvent, Transfer } from '../api/types';
import { useLiveRecordings, type LegState, type RecordingItem } from '../api/liveRecordings';
import { useAuth } from '../auth/AuthContext';
import { AudioPlayer } from '../components/AudioPlayer';
import { DispoChip, HangupChip } from '../components/DispoChip';
import { SaleTypeChip } from './Queue';
import { Chip, ErrorState, Loading, Modal, PageHeader, fmtDateTime, fmtDuration } from '../components/ui';

type LeadInfo = Record<string, string | number | null>;

interface Detail {
  transfer: Transfer;
  /** null for sales that had no fronter transfer */
  fronterCall: Call | null;
  closerCall: Call | null;
  /** a later call of the lead that carried the sale */
  saleCall: (Call & { agentName: string | null }) | null;
  lead: LeadInfo | null;
  fronterAgentUser: string | null;
  fronterAgentName: string | null;
  closerAgentUser: string | null;
  closerAgentName: string | null;
  dialerName: string;
  /** the fronter leg was found on the lead (sale-only rows, late call rows) */
  fronterFromLead: boolean;
  /** snapshot for the first paint; the live query takes over from there */
  recordingItems: RecordingItem[];
  legs: Partial<Record<'fronter' | 'closer' | 'sale', LegState>>;
  live: boolean;
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

function Note({ children, pulse }: { children: React.ReactNode; pulse?: boolean }) {
  return (
    <p className={`flex items-center gap-1.5 text-2xs text-ink-2 ${pulse ? 'animate-pulse' : ''}`}>
      {pulse && <span className="inline-block h-1.5 w-1.5 rounded-full bg-info" />}
      {children}
    </p>
  );
}

function CallLeg({
  title,
  call,
  agentName,
  agentUser,
  leg,
  recordings,
  pendingMatch,
  checking,
}: {
  title: string;
  call: Call | null;
  agentName: string | null;
  agentUser: string | null;
  leg: LegState | undefined;
  recordings: RecordingItem[];
  /** no closer leg yet and the matcher is still looking */
  pendingMatch: boolean;
  /** the page is polling the dialer */
  checking: boolean;
}) {
  const playable = recordings.filter((r) => r.status === 'available');
  const inProgress = leg?.inProgress ?? (call ? call.lengthSec == null : false);
  const hasPending = recordings.some((r) => r.status === 'pending');
  const hasMissing = recordings.some((r) => r.status === 'missing');
  return (
    <div className="card p-4">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h2 className="font-display text-sm font-bold">{title}</h2>
        {call && <HangupChip termReason={leg?.termReason ?? call.termReason} inProgress={inProgress} status={leg?.status ?? call.status} />}
      </div>
      {!call ? (
        pendingMatch ? (
          <Note pulse>Closer leg not found yet — the closer may still be on the line. Checking automatically.</Note>
        ) : (
          <p className="text-sm text-ink-2">No linked call leg yet.</p>
        )
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
              <dd>
                <DispoChip code={leg?.status ?? call.status} />
              </dd>
            </div>
            <div>
              <dt className="label">Start</dt>
              <dd className="font-mono text-2xs">{fmtDateTime(call.callDate)}</dd>
            </div>
            <div>
              <dt className="label">Length</dt>
              <dd className="font-mono">{inProgress ? 'in progress' : fmtDuration(leg?.lengthSec ?? call.lengthSec)}</dd>
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
            {playable.map((rec) => (
              <div key={rec.id}>
                <AudioPlayer recordingId={rec.id} label={rec.filename} />
                {!rec.lengthSec && !inProgress && (
                  <p className="mt-1 text-2xs text-ink-3">
                    0-second dialer entry (disposition only) — hear the full call under the other legs below.
                  </p>
                )}
                {!rec.final && inProgress && (
                  <Note pulse>Live partial recording — the full file replaces it after hangup.</Note>
                )}
              </div>
            ))}
            {playable.length === 0 &&
              (inProgress ? (
                <Note pulse>Call in progress — the recording appears here automatically a minute or two after it ends.</Note>
              ) : hasPending || checking ? (
                <Note pulse>Recording is being prepared on the dialer — it appears here automatically.</Note>
              ) : hasMissing ? (
                <Note>The dialer has no recording file for this call.</Note>
              ) : (
                <Note>No recording on the dialer for this call.</Note>
              ))}
          </div>
        </>
      )}
    </div>
  );
}

function LeadRecordings({ items }: { items: RecordingItem[] }) {
  return (
    <div className="card mt-4 p-4">
      <h2 className="mb-1 font-display text-sm font-bold">Other recordings on this lead</h2>
      <p className="mb-3 text-2xs text-ink-3">Every call on this lead from 3 days before to 1 day after, newest first.</p>
      <div className="space-y-3">
        {items.map((rec) => (
          <div key={rec.id} className="rounded-md border border-ink/10 p-3">
            <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs">
              <span className="font-mono">{fmtDateTime(rec.startTime)}</span>
              <span className="chip bg-bg text-ink-2">{rec.callSource === 'vicidial_closer_log' ? 'Closer' : 'Fronter / outbound'}</span>
              <span>
                {rec.agentName ?? rec.callUser ?? '—'}{' '}
                {rec.callUser && <span className="font-mono text-ink-3">({rec.callUser})</span>}
              </span>
              <DispoChip code={rec.callStatus} />
              <HangupChip termReason={rec.termReason} status={rec.callStatus} />
              <span className="font-mono text-ink-3">{fmtDuration(rec.lengthSec)}</span>
            </div>
            {rec.status === 'available' ? (
              <AudioPlayer recordingId={rec.id} label={rec.filename} />
            ) : (
              <div className="flex items-center gap-2 text-2xs text-ink-2">
                <Chip value={rec.status} />
                <span className="truncate font-mono">{rec.filename}</span>
              </div>
            )}
          </div>
        ))}
      </div>
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
  const fields: Array<{ label: string; value: string; mono?: boolean; dispo?: boolean }> = [
    { label: 'Name', value: name },
    { label: 'Phone', value: s('phone_number'), mono: true },
    { label: 'Alt phone', value: s('alt_phone'), mono: true },
    { label: 'Email', value: s('email'), mono: true },
    { label: 'Address', value: address },
    { label: 'City / State / ZIP', value: cityLine },
    { label: 'Lead status', value: s('status'), dispo: true },
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
            {f.dispo ? (
              <dd>
                <DispoChip code={f.value} title="Current lead status on the dialer" />
              </dd>
            ) : (
              <dd className={`truncate ${f.mono ? 'font-mono text-[13px]' : ''}`} title={f.value}>
                {f.value}
              </dd>
            )}
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
  // recordings follow the dialer live; everything else is the snapshot above
  const liveQ = useLiveRecordings(id);

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
      void queryClient.invalidateQueries({ queryKey: ['transfer-recordings', id] });
    },
  });

  if (isLoading) return <Loading />;
  if (isError || !data) return <ErrorState message="Transfer could not load." onRetry={() => void refetch()} />;

  const t = data.transfer;
  const live = liveQ.data;
  const items = live?.items ?? data.recordingItems;
  const legs = live?.legs ?? data.legs;
  const checking = live?.live ?? data.live;
  const byLeg = (leg: RecordingItem['leg']) => items.filter((r) => r.leg === leg);
  const saleOnly = t.kind !== 'transfer';
  const showFronter = !saleOnly || !!data.fronterCall;
  const legCount = (showFronter ? 1 : 0) + 1 + (data.saleCall ? 1 : 0);
  const fronterTitle = data.fronterFromLead
    ? saleOnly
      ? 'Fronter call on this lead'
      : 'Fronter leg (found on the lead)'
    : 'Fronter leg';
  const pendingMatch = !data.closerCall && t.matchStatus === 'pending_match';

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
          <span className="flex items-center gap-1 text-2xs text-ink-2">
            sale: <DispoChip code={t.saleDisposition} />
          </span>
        )}
        {t.matchNotes && <span className="text-2xs text-ink-3">{t.matchNotes}</span>}
        {checking && (
          <span className="chip ml-auto flex items-center gap-1 bg-info-soft text-info animate-pulse" title="Recordings refresh themselves while the dialer is still finishing this call">
            <Radio size={12} /> Live · checking the dialer every 8 s
          </span>
        )}
      </div>

      <div className="mb-3">
        <SaleTypeChip transfer={t} />
      </div>
      <div className={`grid gap-4 ${legCount === 3 ? 'lg:grid-cols-3' : legCount === 2 ? 'lg:grid-cols-2' : ''}`}>
        {showFronter && (
          <CallLeg
            title={fronterTitle}
            call={data.fronterCall}
            agentName={data.fronterAgentName}
            agentUser={data.fronterAgentUser}
            leg={legs.fronter}
            recordings={byLeg('fronter')}
            pendingMatch={false}
            checking={checking}
          />
        )}
        <CallLeg
          title={saleOnly ? (t.kind === 'inbound_sale' ? 'Inbound sale call' : 'Callback sale call') : 'Closer leg'}
          call={data.closerCall}
          agentName={data.closerAgentName}
          agentUser={data.closerAgentUser}
          leg={legs.closer}
          recordings={byLeg('closer')}
          pendingMatch={pendingMatch}
          checking={checking}
        />
        {data.saleCall && (
          <CallLeg
            title="Sold on a later call"
            call={data.saleCall}
            agentName={data.saleCall.agentName}
            agentUser={data.saleCall.viciUserRaw}
            leg={legs.sale}
            recordings={byLeg('sale')}
            pendingMatch={false}
            checking={checking}
          />
        )}
      </div>

      {byLeg('other').length > 0 && <LeadRecordings items={byLeg('other')} />}

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
                <div className="flex flex-wrap items-center gap-x-2 font-mono text-2xs text-ink-2">
                  {fmtDateTime(c.call.callDate)} · {c.call.phoneNumber} · lead {c.call.viciLeadId ?? '—'} ·{' '}
                  <DispoChip code={c.call.status} />
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
