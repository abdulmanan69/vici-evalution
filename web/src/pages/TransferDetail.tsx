import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ClipboardPlus, GitMerge, Radio, RefreshCw } from 'lucide-react';
import { api } from '../api/client';
import type { Call, Evaluation, QaForm, TransferEvent, Transfer } from '../api/types';
import { fetchNote, useFetchRecordings, useLiveRecordings, type LegState, type RecordingItem } from '../api/liveRecordings';
import { useAuth } from '../auth/AuthContext';
import { AudioPlayer } from '../components/AudioPlayer';
import { DispoChip, HangupChip } from '../components/DispoChip';
import { LeadCard } from '../components/LeadCard';
import { useLeadInfo } from '../api/lead';
import { SaleTypeChip } from './Queue';
import { Chip, ErrorState, Loading, Modal, PageHeader, fmtDateTime, fmtDuration } from '../components/ui';

interface Detail {
  transfer: Transfer;
  /** null for sales that had no fronter transfer */
  fronterCall: Call | null;
  closerCall: Call | null;
  /** a later call of the lead that carried the sale */
  saleCall: (Call & { agentName: string | null }) | null;
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
  noCloser,
  checking,
  onFetch,
  fetching,
}: {
  title: string;
  call: Call | null;
  agentName: string | null;
  agentUser: string | null;
  leg: LegState | undefined;
  recordings: RecordingItem[];
  /** no closer leg yet and the matcher is still looking */
  pendingMatch: boolean;
  /** the dialer has no closer-side call for this transfer */
  noCloser: boolean;
  /** the page is polling the dialer */
  checking: boolean;
  /** 'Fetch from dialer' — the reviewer's explicit retry */
  onFetch?: () => void;
  fetching?: boolean;
}) {
  const inProgress = leg?.inProgress ?? (call ? call.lengthSec == null : false);
  // a call under 5 s is a disposition-only entry (0 s: no call; 1-4 s: a quick
  // re-dial to save the result) — the conversation the server tagged onto this
  // leg is what gets played
  const legLen = leg?.lengthSec ?? call?.lengthSec ?? null;
  const dispoOnly = !inProgress && legLen != null && legLen < 5;
  const playable = recordings.filter((r) => r.status === 'available' && (r.lengthSec ?? 1) >= 5);
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
        ) : noCloser ? (
          <Note>
            No closer-side call on the dialer for this transfer: it did not reach a closer (dropped in queue, sent to an
            outside number, or dispositioned XFER without a transfer).
          </Note>
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
            {dispoOnly && (
              <Note>
                {legLen === 0 ? 'Disposition-only entry (0 s): the agent saved the result without a new call.' : `Very short call (${legLen} s): the agent saved the result on a quick re-dial, not a conversation.`}
                {playable.length > 0 ? ' The conversation on this lead:' : hasPending || checking ? ' Finding the conversation…' : ' No audio for this entry.'}
              </Note>
            )}
            {playable.map((rec) => (
              <div key={rec.id}>
                {dispoOnly && (
                  <div className="mb-1 flex flex-wrap items-center gap-x-2 text-2xs text-ink-2">
                    <span className="font-mono">{fmtDateTime(rec.startTime)}</span>
                    <DispoChip code={rec.callStatus} />
                    <HangupChip termReason={rec.termReason} status={rec.callStatus} />
                    <span className="font-mono text-ink-3">{fmtDuration(rec.lengthSec)}</span>
                  </div>
                )}
                <AudioPlayer recordingId={rec.id} label={rec.filename} lengthSec={rec.lengthSec} preload="metadata" />
              </div>
            ))}
            {playable.length === 0 &&
              !dispoOnly &&
              (inProgress ? (
                <Note pulse>Call in progress — the recording appears here automatically a minute or two after it ends.</Note>
              ) : hasPending || checking ? (
                <Note pulse>Recording is being prepared on the dialer — it appears here automatically.</Note>
              ) : hasMissing ? (
                <Note>The dialer has no recording file for this call.</Note>
              ) : (
                <Note>No recording on the dialer for this call.</Note>
              ))}
            {playable.length === 0 && !inProgress && onFetch && (
              <button className="btn-secondary mt-1" onClick={onFetch} disabled={fetching}>
                <RefreshCw size={12} className={fetching ? 'animate-spin' : ''} /> {fetching ? 'Fetching from dialer…' : 'Fetch from dialer'}
              </button>
            )}
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
              <AudioPlayer recordingId={rec.id} label={rec.filename} lengthSec={rec.lengthSec} />
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

export function TransferDetailPage() {
  const { id = '' } = useParams();
  // the queue the reviewer came from decides which method is recommended:
  // Transfers reviews the fronter (TRA), Unclosed / Closed review the closer
  const [search] = useSearchParams();
  const fromParam = search.get('from');
  const from: 'transfer' | 'unclosed' | 'closed' | null =
    fromParam === 'transfer' || fromParam === 'unclosed' || fromParam === 'closed' ? fromParam : null;
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
  const fetchRecs = useFetchRecordings(id);
  // lead details come from the dialer in parallel — the page never waits on them
  const leadQ = useLeadInfo(id);

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

  // a fronter form evaluates the fronter leg, a closer form the closer leg
  const legForForm = (f: QaForm) => {
    const fronter = data?.fronterCall ?? null;
    const closer = data?.saleCall ?? data?.closerCall ?? null;
    return f.queue === 'transfer' || f.target === 'fronter' ? (fronter ?? closer) : (closer ?? fronter);
  };
  const startEval = useMutation({
    mutationFn: (f: QaForm) => {
      const leg = legForForm(f) as (Call & { viciAgentId?: string | null }) | null;
      return api<{ evaluation: Evaluation }>('/evaluations', {
        method: 'POST',
        body: { transferId: id, formId: f.id, callId: leg?.id, targetAgentId: leg?.viciAgentId ?? undefined },
      });
    },
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
  // the matcher keeps looking for 30 min; after that (or once it gave up) the
  // honest answer is that the dialer has no closer leg for this transfer
  const minutesSinceXfer = (Date.now() - new Date(t.xferTime).getTime()) / 60_000;
  const pendingMatch = !data.closerCall && t.matchStatus === 'pending_match' && minutesSinceXfer < 30;
  // forms that fit this call: any-queue forms, the fronter form when there is
  // a fronter leg, the closer form of the call's current status, and whatever
  // the queue you came from uses — that one is listed first
  const hasFronter = !!data.fronterCall;
  const hasCloser = !!data.closerCall || !!data.saleCall;
  const fitsCall = (f: QaForm) =>
    !f.queue ||
    f.queue === from ||
    (f.queue === 'transfer' && hasFronter) ||
    ((f.queue === 'unclosed' || f.queue === 'closed') && hasCloser && f.queue === t.queueStatus);
  const recommended = (f: QaForm) => (from ? f.queue === from : f.queue === t.queueStatus);
  const formChoices = (formsData?.forms ?? [])
    .filter(fitsCall)
    .sort((a, b) => Number(recommended(b)) - Number(recommended(a)));
  const reviews = (f: QaForm) =>
    f.queue === 'transfer' || f.target === 'fronter' ? 'reviews the fronter' : f.queue ? 'reviews the closer' : 'any leg';
  const noCloser = !data.closerCall && !pendingMatch && t.kind === 'transfer';

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
        <span className="ml-auto flex flex-wrap items-center gap-2">
          {checking && (
            <span className="chip flex items-center gap-1 bg-info-soft text-info animate-pulse" title="Recordings refresh themselves while the dialer is still finishing this call">
              <Radio size={12} /> Live · checking the dialer every 8 s
            </span>
          )}
          {fetchNote(fetchRecs) && <span className="text-2xs text-ink-2">{fetchNote(fetchRecs)}</span>}
          <button
            className="btn-secondary"
            onClick={() => fetchRecs.mutate()}
            disabled={fetchRecs.isPending}
            title="Ask the dialer for this call's recordings right now"
          >
            <RefreshCw size={12} className={fetchRecs.isPending ? 'animate-spin' : ''} />{' '}
            {fetchRecs.isPending ? 'Fetching…' : 'Fetch from dialer'}
          </button>
        </span>
      </div>

      {/* how the sale came about — only a closed call is a sale */}
      {t.queueStatus === 'closed' && (
        <div className="mb-3">
          <SaleTypeChip transfer={t} />
        </div>
      )}
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
            noCloser={false}
            checking={checking}
            onFetch={() => fetchRecs.mutate()}
            fetching={fetchRecs.isPending}
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
          noCloser={noCloser}
          checking={checking}
          onFetch={() => fetchRecs.mutate()}
          fetching={fetchRecs.isPending}
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
            noCloser={false}
            checking={checking}
            onFetch={() => fetchRecs.mutate()}
            fetching={fetchRecs.isPending}
          />
        )}
      </div>

      {byLeg('other').length > 0 && <LeadRecordings items={byLeg('other')} />}

      {leadQ.data?.lead ? (
        <LeadCard lead={leadQ.data.lead} custom={leadQ.data.leadCustom} />
      ) : leadQ.isLoading ? (
        <div className="card mb-4 flex items-center gap-2 p-4 text-sm text-ink-3" role="status">
          <span className="h-3 w-3 animate-spin rounded-full border-2 border-brand border-t-transparent" aria-hidden />
          Loading lead details from the dialer…
        </div>
      ) : null}

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
        <p className="mb-3 text-sm text-ink-2">
          {from
            ? `You opened this call from the ${from === 'transfer' ? 'Transfers' : from === 'unclosed' ? 'Unclosed' : 'Closed'} queue — its method is first.`
            : 'Choose a published QA form for this call.'}
        </p>
        <div className="space-y-2">
          {formChoices.map((f) => (
            <button
              key={f.id}
              className={`card flex w-full items-center justify-between p-3 text-left hover:bg-bg ${recommended(f) ? 'border border-brand/40' : ''}`}
              onClick={() => startEval.mutate(f)}
              disabled={startEval.isPending}
            >
              <span>
                <span className="font-medium">{f.name}</span>
                <span className="ml-2 text-2xs text-ink-3">v{f.currentVersion} · {reviews(f)}</span>
                {recommended(f) && <span className="chip ml-2 bg-brand-soft text-brand">recommended</span>}
              </span>
              <span className="text-brand">Use →</span>
            </button>
          ))}
          {formsData && formChoices.length === 0 && (
            <p className="text-sm text-ink-2">No evaluation method for this call is available to you.</p>
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
