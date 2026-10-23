import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Clock, Lock, RefreshCw, Save } from 'lucide-react';
import { api, ApiError } from '../api/client';
import type { Evaluation, FormDefinition, FormQuestion } from '../api/types';
import { fetchNote, useFetchRecordings, useLiveRecordings, type Leg, type LegState, type RecordingItem } from '../api/liveRecordings';
import { AudioPlayer } from '../components/AudioPlayer';
import { DispoChip, HangupChip } from '../components/DispoChip';
import { LeadCard, type LeadInfo } from '../components/LeadCard';
import { Chip, ErrorState, Loading, Modal, PageHeader, fmtDateTime, fmtDuration } from '../components/ui';
import { scoreEvaluation, type LiveScore } from '../lib/scoring';

const LEG_STYLE: Record<RecordingItem['leg'], { label: string; cls: string }> = {
  fronter: { label: 'Fronter', cls: 'bg-info-soft text-info' },
  closer: { label: 'Closer', cls: 'bg-brand-soft text-brand' },
  sale: { label: 'Sale call', cls: 'bg-good-soft text-good' },
  other: { label: 'Same lead', cls: 'bg-bg text-ink-2' },
};

function RecordingsPanel({
  recordings,
  legs,
  live,
  onFetch,
  fetching,
  note,
}: {
  recordings: RecordingItem[];
  legs: Partial<Record<Leg, LegState>>;
  live: boolean;
  /** 'Fetch from dialer' — the reviewer's explicit retry */
  onFetch: () => void;
  fetching: boolean;
  note: string | null;
}) {
  const [onlyThisCall, setOnlyThisCall] = useState(false);
  // playable files, plus this call's own legs while the dialer still prepares them
  const usable = recordings.filter(
    (r) => (r.status === 'available' && (r.lengthSec ?? 1) > 0) || (r.status === 'pending' && r.leg !== 'other'),
  );
  const shown = onlyThisCall ? usable.filter((r) => r.leg !== 'other') : usable;
  const others = usable.filter((r) => r.leg === 'other').length;
  const inProgress = Object.values(legs).some((l) => l?.inProgress);
  return (
    <div className="mt-3">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <h2 className="font-display text-sm font-bold">Recordings</h2>
        <span className="text-2xs text-ink-3">
          newest first · {usable.filter((r) => r.status === 'available').length}
        </span>
        {live && <span className="chip bg-info-soft text-info animate-pulse">live · checking every 8 s</span>}
        <button className="btn-secondary" onClick={onFetch} disabled={fetching} title="Ask the dialer for this call's recordings right now">
          <RefreshCw size={12} className={fetching ? 'animate-spin' : ''} /> {fetching ? 'Fetching…' : 'Fetch from dialer'}
        </button>
        {others > 0 && (
          <label className="ml-auto flex cursor-pointer items-center gap-1.5 text-2xs text-ink-2">
            <input type="checkbox" checked={onlyThisCall} onChange={(e) => setOnlyThisCall(e.target.checked)} />
            This call only
          </label>
        )}
      </div>
      {note && <p className="mb-2 text-2xs text-ink-2">{note}</p>}
      {shown.length === 0 && (
        <p className="text-2xs text-ink-3">
          {inProgress
            ? 'Call in progress — the recording appears here automatically a minute or two after it ends.'
            : live
              ? 'Recording is being prepared on the dialer — it appears here automatically.'
              : 'No recording on the dialer for this call.'}
        </p>
      )}
      <div className="space-y-2">
        {shown.map((r) => (
          <div
            key={r.id}
            className={`rounded-md border p-2.5 ${r.leg === 'other' ? 'border-ink/10' : 'border-brand/30 bg-brand-soft/30'}`}
          >
            <div className="mb-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-2xs">
              <span className={`chip ${LEG_STYLE[r.leg].cls}`}>{LEG_STYLE[r.leg].label}</span>
              <span className="font-mono">{fmtDateTime(r.startTime)}</span>
              <span className="truncate">
                {r.agentName ?? r.callUser ?? '—'}
                {r.callUser && r.callUser !== r.agentName && <span className="font-mono text-ink-3"> ({r.callUser})</span>}
              </span>
              <DispoChip code={r.callStatus} />
              <HangupChip termReason={r.termReason} inProgress={r.leg !== 'other' && legs[r.leg]?.inProgress} status={r.callStatus} />
              <span className="ml-auto font-mono text-ink-3">{fmtDuration(r.lengthSec)}</span>
            </div>
            {r.status === 'available' ? (
              <AudioPlayer recordingId={r.id} lengthSec={r.lengthSec} preload={r.leg === 'other' ? 'none' : 'metadata'} />
            ) : (
              <p className="text-2xs text-ink-3 animate-pulse">Preparing on the dialer — appears automatically.</p>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

interface Detail {
  evaluation: Evaluation;
  reviewerName: string;
  formName: string;
  formVersion: number;
  formSchema: FormDefinition;
  maxScore: string;
  passThreshold: string;
  call: {
    phoneNumber: string | null;
    xferTime: string;
    queueStatus: string;
    fronterAgent: string | null;
    closerAgent: string | null;
    closerStatus: string | null;
    fronterTermReason: string | null;
    closerTermReason: string | null;
    closerInProgress: boolean;
    transferId: string;
  } | null;
  /** snapshot for the first paint; the live query takes over from there */
  recordings: RecordingItem[];
  /** manager setting: how long a completed evaluation stays editable */
  editWindowMinutes: number;
  /** when a completed evaluation locks; null for drafts */
  editableUntil: string | null;
  /** this user may change it right now (draft, or completed and inside the window) */
  canEdit: boolean;
}

type Answers = Record<string, string | number | boolean | null>;

function isVisible(q: FormQuestion, answers: Answers): boolean {
  if (!q.visibleIf) return true;
  return String(answers[q.visibleIf.questionId]) === String(q.visibleIf.equals);
}

function fmtRemaining(ms: number): string {
  if (ms <= 0) return 'now';
  const m = Math.ceil(ms / 60_000);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  if (h < 48) return rest ? `${h} h ${rest} min` : `${h} h`;
  return `${Math.round(h / 24)} days`;
}

function fmtWindow(minutes: number): string {
  if (minutes < 60) return `${minutes} minutes`;
  const h = minutes / 60;
  return Number.isInteger(h) ? `${h} hour${h === 1 ? '' : 's'}` : `${h.toFixed(1)} hours`;
}

/**
 * The score as it stands, recomputed on every answer with the same engine the
 * server uses on completion. Pinned so it stays in view while scrolling the
 * form; 0 % until the first scored question is answered.
 */
function LiveScoreBar({ live, passThreshold, final }: { live: LiveScore; passThreshold: number; final: boolean }) {
  const nothing = live.answered === 0 && !live.autoFailed;
  const allAnswered = live.scorable > 0 && live.answered >= live.scorable && live.missingRequired.length === 0;
  const passing = !live.autoFailed && live.rawPercent >= passThreshold;
  const tone = nothing ? 'neutral' : passing ? 'good' : 'bad';
  const label = live.autoFailed
    ? 'Automatic failure — a critical question failed'
    : nothing
      ? 'Not scored yet — the score builds up as you answer'
      : allAnswered || final
        ? passing
          ? 'Passing'
          : 'Below the pass mark'
        : passing
          ? 'On track to pass'
          : 'Below the pass mark so far';
  const cls = {
    neutral: { text: 'text-ink-2', bar: 'bg-ink/30' },
    good: { text: 'text-good', bar: 'bg-good' },
    bad: { text: 'text-bad', bar: 'bg-bad' },
  }[tone];
  const width = Math.min(100, live.percent);
  return (
    <div className="card sticky top-2 z-10 border border-ink/10 p-3 shadow-card">
      <div className="flex items-center gap-4">
        <div className={`font-display text-4xl font-bold leading-none tabular-nums ${cls.text}`}>{Math.round(live.percent)}%</div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
            <span className={`font-semibold ${cls.text}`}>
              {final ? 'Final score' : 'Live score'} · {label}
            </span>
            <span className="font-mono text-ink-2">
              {live.score} / {live.maxScore} pts
            </span>
            <span className="text-2xs text-ink-3">
              {live.answered} of {live.scorable} scored questions answered
            </span>
            {live.missingRequired.length > 0 && (
              <span className="chip bg-amber-soft text-amber-line">
                {live.missingRequired.length} required left
              </span>
            )}
          </div>
          <div className="relative mt-2 h-2.5 w-full rounded-full bg-ink/10">
            <div className={`h-full rounded-full transition-all duration-500 ${cls.bar}`} style={{ width: `${width}%` }} />
            <div
              className="absolute -top-1 h-[18px] w-0.5 bg-ink/60"
              style={{ left: `calc(${Math.min(100, passThreshold)}% - 1px)` }}
              title={`Pass mark ${passThreshold}%`}
            />
          </div>
          <div className="mt-1 flex justify-between font-mono text-2xs text-ink-3">
            <span>0%</span>
            <span>pass mark {passThreshold}%</span>
            <span>100%</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function AnswerControl({
  q,
  value,
  onChange,
  disabled,
}: {
  q: FormQuestion;
  value: string | number | boolean | null | undefined;
  onChange: (v: string | number | null) => void;
  disabled: boolean;
}) {
  switch (q.type) {
    case 'yes_no':
    case 'pass_fail': {
      const opts = q.type === 'yes_no' ? ['yes', 'no'] : ['pass', 'fail'];
      if (!q.required) opts.push('na');
      return (
        <div className="flex gap-1.5">
          {opts.map((opt) => (
            <button
              key={opt}
              disabled={disabled}
              onClick={() => onChange(opt)}
              className={`rounded-md px-3 py-1 text-sm font-medium capitalize transition-colors ${
                value === opt
                  ? opt === 'no' || opt === 'fail'
                    ? 'bg-bad text-white'
                    : opt === 'na'
                      ? 'bg-ink-2 text-white'
                      : 'bg-good text-white'
                  : 'bg-bg text-ink-2 hover:bg-ink/10'
              }`}
            >
              {opt === 'na' ? 'N/A' : opt}
            </button>
          ))}
        </div>
      );
    }
    case 'rating': {
      const max = q.scaleMax ?? 5;
      return (
        <div className="flex gap-1">
          {Array.from({ length: max }, (_, i) => i + 1).map((n) => (
            <button
              key={n}
              disabled={disabled}
              onClick={() => onChange(n)}
              className={`h-8 w-8 rounded-md text-sm font-semibold tabular-nums transition-colors ${
                Number(value) === n ? 'bg-brand text-white' : 'bg-bg text-ink-2 hover:bg-ink/10'
              }`}
              aria-label={`Rate ${n} of ${max}`}
            >
              {n}
            </button>
          ))}
        </div>
      );
    }
    case 'dropdown':
      return (
        <select
          className="input max-w-sm"
          value={value == null ? '' : String(value)}
          onChange={(e) => onChange(e.target.value || null)}
          disabled={disabled}
        >
          <option value="">— choose —</option>
          {q.options?.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      );
    case 'number':
      return (
        <input
          type="number"
          className="input max-w-[8rem]"
          value={value == null ? '' : String(value)}
          onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
          disabled={disabled}
        />
      );
    case 'date':
      return (
        <input
          type="date"
          className="input max-w-[12rem]"
          value={value == null ? '' : String(value)}
          onChange={(e) => onChange(e.target.value || null)}
          disabled={disabled}
        />
      );
    case 'text':
    default:
      return (
        <textarea
          className="input"
          rows={2}
          value={value == null ? '' : String(value)}
          onChange={(e) => onChange(e.target.value || null)}
          disabled={disabled}
        />
      );
  }
}

export function EvaluationPage() {
  const { id = '' } = useParams();
  const queryClient = useQueryClient();
  const [answers, setAnswers] = useState<Answers>({});
  const [comments, setComments] = useState('');
  const [coaching, setCoaching] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  // a clock for the edit-window countdown
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['evaluation', id],
    queryFn: () => api<Detail>(`/evaluations/${id}`),
  });
  // the recordings follow the dialer live while the call is still being finished
  const liveQ = useLiveRecordings(data?.call?.transferId);
  const fetchRecs = useFetchRecordings(data?.call?.transferId);
  // the lead's full record from the dialer, beside the recordings
  const leadQ = useQuery({
    queryKey: ['transfer-lead', data?.call?.transferId],
    queryFn: () => api<{ lead: LeadInfo | null; leadCustom: LeadInfo | null }>(`/queues/detail/${data?.call?.transferId}/lead`),
    enabled: !!data?.call?.transferId,
    staleTime: 60_000,
  });

  useEffect(() => {
    if (data) {
      setAnswers(data.evaluation.answers ?? {});
      setComments(data.evaluation.comments ?? '');
      setCoaching(data.evaluation.coachingNotes ?? '');
    }
  }, [data?.evaluation.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const body = () => ({ answers, comments: comments || undefined, coachingNotes: coaching || undefined });

  const save = useMutation({
    mutationFn: () => api(`/evaluations/${id}`, { method: 'PATCH', body: body() }),
    onSuccess: () => setMessage('Draft saved.'),
    onError: (err) => setMessage(err instanceof ApiError ? err.message : 'Save failed.'),
  });

  // changes to a completed evaluation inside the edit window — re-scored by the server
  const saveEdits = useMutation({
    mutationFn: () => api(`/evaluations/${id}`, { method: 'PATCH', body: body() }),
    onSuccess: () => {
      setMessage('Changes saved and re-scored.');
      void queryClient.invalidateQueries({ queryKey: ['evaluation', id] });
    },
    onError: (err) => setMessage(err instanceof ApiError ? err.message : 'Save failed.'),
  });

  const complete = useMutation({
    mutationFn: async () => {
      await api(`/evaluations/${id}`, { method: 'PATCH', body: body() });
      return api(`/evaluations/${id}/complete`, { method: 'POST' });
    },
    onSuccess: () => {
      setMessage(null);
      void queryClient.invalidateQueries({ queryKey: ['evaluation', id] });
    },
    onError: (err) => setMessage(err instanceof ApiError ? err.message : 'Completion failed.'),
  });

  if (isLoading) return <Loading />;
  if (isError || !data) return <ErrorState message="Evaluation could not load." onRetry={() => void refetch()} />;

  const ev = data.evaluation;
  const done = ev.status === 'completed';
  const passThreshold = Number(data.passThreshold);
  const live = scoreEvaluation(data.formSchema, answers, passThreshold);
  const editableUntil = data.editableUntil ? new Date(data.editableUntil) : null;
  const remainingMs = editableUntil ? editableUntil.getTime() - now : 0;
  const canEdit = !done || (data.canEdit && remainingMs > 0);
  const locked = done && !canEdit;
  const windowMin = data.editWindowMinutes;

  return (
    <div className="mx-auto max-w-[1700px]">
      <PageHeader
        title={data.formName}
        subtitle={`Version ${data.formVersion} · reviewer ${data.reviewerName} · pass at ${data.passThreshold}%`}
        actions={
          !done ? (
            <>
              <button className="btn-secondary" onClick={() => save.mutate()} disabled={save.isPending}>
                <Save size={14} /> Save draft
              </button>
              <button className="btn-primary" onClick={() => setConfirmOpen(true)} disabled={complete.isPending}>
                <CheckCircle2 size={14} /> Complete & score
              </button>
            </>
          ) : canEdit ? (
            <button className="btn-primary" onClick={() => saveEdits.mutate()} disabled={saveEdits.isPending}>
              <Save size={14} /> {saveEdits.isPending ? 'Saving…' : 'Save changes'}
            </button>
          ) : (
            <span className="chip flex items-center gap-1 bg-bg text-ink-2">
              <Lock size={12} /> Locked
            </span>
          )
        }
      />

      <div className="mt-2 grid items-start gap-4 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
        {/* left: the call and every recording, pinned while the form scrolls */}
        <aside className="card p-3 lg:sticky lg:top-2 lg:max-h-[calc(100vh-1rem)] lg:overflow-y-auto">
          {data.call ? (
            <>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                <span className="font-mono font-semibold">{data.call.phoneNumber ?? 'unknown number'}</span>
                <Chip value={data.call.queueStatus} />
                <span className="font-mono text-2xs text-ink-3">{fmtDateTime(data.call.xferTime)}</span>
                <Link to={`/transfers/${data.call.transferId}`} className="ml-auto text-2xs font-medium text-brand hover:underline">
                  Full call detail →
                </Link>
              </div>
              <dl className="mt-2 grid grid-cols-3 gap-2 text-2xs">
                <div>
                  <dt className="label">Fronter</dt>
                  <dd className="text-sm font-medium">{data.call.fronterAgent ?? '—'}</dd>
                  <dd className="mt-0.5">
                    <HangupChip
                      termReason={liveQ.data?.legs.fronter?.termReason ?? data.call.fronterTermReason}
                      inProgress={liveQ.data?.legs.fronter?.inProgress}
                      status={liveQ.data?.legs.fronter?.status ?? 'XFER'}
                    />
                  </dd>
                </div>
                <div>
                  <dt className="label">Closer</dt>
                  <dd className="text-sm font-medium">{data.call.closerAgent ?? '—'}</dd>
                  <dd className="mt-0.5">
                    <HangupChip
                      termReason={liveQ.data?.legs.closer?.termReason ?? data.call.closerTermReason}
                      inProgress={liveQ.data?.legs.closer?.inProgress ?? data.call.closerInProgress}
                    />
                  </dd>
                </div>
                <div>
                  <dt className="label">Closer dispo</dt>
                  <dd>
                    <DispoChip code={liveQ.data?.legs.closer?.status ?? data.call.closerStatus} />
                  </dd>
                </div>
              </dl>
              <RecordingsPanel
                recordings={liveQ.data?.items ?? data.recordings}
                legs={liveQ.data?.legs ?? {}}
                live={liveQ.data?.live ?? false}
                onFetch={() => fetchRecs.mutate()}
                fetching={fetchRecs.isPending}
                note={fetchNote(fetchRecs)}
              />
              {leadQ.data?.lead && <LeadCard lead={leadQ.data.lead} custom={leadQ.data.leadCustom} compact />}
            </>
          ) : (
            <p className="text-sm text-ink-2">This evaluation is not linked to a call.</p>
          )}
        </aside>

        {/* right: live score, status and form */}
        <div className="min-w-0 space-y-4">
          <LiveScoreBar live={live} passThreshold={passThreshold} final={done} />

          {done && (
            <div className={`card flex flex-wrap items-center gap-3 p-3 text-sm ${locked ? 'bg-bg' : 'bg-brand-soft/40'}`}>
              {locked ? <Lock size={16} className="shrink-0 text-ink-2" /> : <Clock size={16} className="shrink-0 text-brand" />}
              <span className="font-semibold">Completed {fmtDateTime(ev.completedAt)}</span>
              {locked ? (
                <span className="text-ink-2">
                  Locked —{' '}
                  {windowMin > 0 && editableUntil
                    ? `the edit window closed ${fmtDateTime(editableUntil.toISOString())}`
                    : 'evaluations lock the moment they are completed'}
                  . The score above is final.
                </span>
              ) : (
                <span className="text-ink-2">
                  You can still change answers for <strong>{fmtRemaining(remainingMs)}</strong> (until{' '}
                  {fmtDateTime(editableUntil!.toISOString())}); after that it locks. Press <strong>Save changes</strong> to re-score.
                </span>
              )}
              <Chip value={ev.status} />
            </div>
          )}
          {message && <div className="rounded-md bg-brand-soft px-3 py-2 text-sm text-brand">{message}</div>}

          {data.formSchema.sections.map((section) => (
            <div key={section.id} className="card p-4">
              <h2 className="mb-3 font-display text-sm font-bold">{section.title}</h2>
              <div className="grid gap-x-6 gap-y-4 2xl:grid-cols-2">
                {section.questions.filter((q) => isVisible(q, answers)).map((q) => (
                  <div key={q.id} className={q.type === 'text' ? '2xl:col-span-2' : ''}>
                    <div className="mb-1.5 flex items-baseline gap-2">
                      <span className="text-sm font-medium">{q.text}</span>
                      {q.critical && <span className="chip bg-bad-soft text-bad">critical</span>}
                      {q.required && <span className="text-2xs text-ink-3">required</span>}
                      {q.weight > 0 && <span className="ml-auto font-mono text-2xs text-ink-3">{q.weight} pts</span>}
                    </div>
                    <AnswerControl
                      q={q}
                      value={answers[q.id]}
                      disabled={!canEdit}
                      onChange={(v) => setAnswers((a) => ({ ...a, [q.id]: v }))}
                    />
                  </div>
                ))}
              </div>
            </div>
          ))}

          <div className="card grid gap-3 p-4 xl:grid-cols-2">
            <div>
              <label className="label">Reviewer comments</label>
              <textarea className="input" rows={3} value={comments} onChange={(e) => setComments(e.target.value)} disabled={!canEdit} />
            </div>
            <div>
              <label className="label">Coaching notes (shared with the agent's manager)</label>
              <textarea className="input" rows={3} value={coaching} onChange={(e) => setCoaching(e.target.value)} disabled={!canEdit} />
            </div>
          </div>
        </div>
      </div>

      <Modal title="Complete this evaluation?" open={confirmOpen} onClose={() => setConfirmOpen(false)}>
        <div className="space-y-3 text-sm">
          <div className={`rounded-md p-3 ${live.autoFailed || !live.passed ? 'bg-bad-soft' : 'bg-good-soft'}`}>
            <div className="font-display text-2xl font-bold tabular-nums">{Math.round(live.percent)}%</div>
            <div>
              {live.score} / {live.maxScore} points ·{' '}
              {live.autoFailed ? 'automatic failure (critical question)' : live.passed ? 'passes' : 'fails'} the {passThreshold}% pass mark
            </div>
          </div>
          {live.missingRequired.length > 0 && (
            <div className="rounded-md bg-bad-soft px-3 py-2 text-bad">
              {live.missingRequired.length} required question{live.missingRequired.length === 1 ? ' is' : 's are'} still unanswered — answer them before completing.
            </div>
          )}
          <p className="text-ink-2">
            {windowMin > 0 ? (
              <>
                After completing you can still correct this evaluation for <strong>{fmtWindow(windowMin)}</strong> (until about{' '}
                {fmtDateTime(new Date(Date.now() + windowMin * 60_000).toISOString())}). <strong>After that it is locked</strong> and
                cannot be changed.
              </>
            ) : (
              <>
                <strong>Once completed, this evaluation is locked immediately</strong> and cannot be changed.
              </>
            )}
          </p>
          <div className="flex justify-end gap-2">
            <button className="btn-secondary" onClick={() => setConfirmOpen(false)}>
              Keep editing
            </button>
            <button
              className="btn-primary"
              disabled={live.missingRequired.length > 0 || complete.isPending}
              onClick={() => {
                setConfirmOpen(false);
                complete.mutate();
              }}
            >
              <CheckCircle2 size={14} /> Yes, complete & score
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
