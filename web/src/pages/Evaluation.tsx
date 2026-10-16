import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Save } from 'lucide-react';
import { api, ApiError } from '../api/client';
import type { Evaluation, FormDefinition, FormQuestion } from '../api/types';
import { useLiveRecordings, type Leg, type LegState, type RecordingItem } from '../api/liveRecordings';
import { AudioPlayer } from '../components/AudioPlayer';
import { DispoChip, HangupChip } from '../components/DispoChip';
import { Chip, ErrorState, Loading, PageHeader, fmtDateTime, fmtDuration } from '../components/ui';

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
}: {
  recordings: RecordingItem[];
  legs: Partial<Record<Leg, LegState>>;
  live: boolean;
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
        {others > 0 && (
          <label className="ml-auto flex cursor-pointer items-center gap-1.5 text-2xs text-ink-2">
            <input type="checkbox" checked={onlyThisCall} onChange={(e) => setOnlyThisCall(e.target.checked)} />
            This call only
          </label>
        )}
      </div>
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
              <>
                <AudioPlayer recordingId={r.id} />
                {!r.final && r.leg !== 'other' && legs[r.leg]?.inProgress && (
                  <p className="mt-1 text-2xs text-ink-3 animate-pulse">Live partial recording — the full file replaces it after hangup.</p>
                )}
              </>
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
}

type Answers = Record<string, string | number | boolean | null>;

function isVisible(q: FormQuestion, answers: Answers): boolean {
  if (!q.visibleIf) return true;
  return String(answers[q.visibleIf.questionId]) === String(q.visibleIf.equals);
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

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['evaluation', id],
    queryFn: () => api<Detail>(`/evaluations/${id}`),
  });
  // the recordings follow the dialer live while the call is still being finished
  const liveQ = useLiveRecordings(data?.call?.transferId);

  useEffect(() => {
    if (data) {
      setAnswers(data.evaluation.answers ?? {});
      setComments(data.evaluation.comments ?? '');
      setCoaching(data.evaluation.coachingNotes ?? '');
    }
  }, [data?.evaluation.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = useMutation({
    mutationFn: () =>
      api(`/evaluations/${id}`, {
        method: 'PATCH',
        body: { answers, comments: comments || undefined, coachingNotes: coaching || undefined },
      }),
    onSuccess: () => setMessage('Draft saved.'),
    onError: (err) => setMessage(err instanceof ApiError ? err.message : 'Save failed.'),
  });

  const complete = useMutation({
    mutationFn: async () => {
      await api(`/evaluations/${id}`, {
        method: 'PATCH',
        body: { answers, comments: comments || undefined, coachingNotes: coaching || undefined },
      });
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

  const done = data.evaluation.status === 'completed';
  const ev = data.evaluation;

  return (
    <div className="mx-auto max-w-[1700px]">
      <PageHeader
        title={data.formName}
        subtitle={`Version ${data.formVersion} · reviewer ${data.reviewerName} · pass at ${data.passThreshold}%`}
        actions={
          !done && (
            <>
              <button className="btn-secondary" onClick={() => save.mutate()} disabled={save.isPending}>
                <Save size={14} /> Save draft
              </button>
              <button className="btn-primary" onClick={() => complete.mutate()} disabled={complete.isPending}>
                <CheckCircle2 size={14} /> Complete & score
              </button>
            </>
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
              />
            </>
          ) : (
            <p className="text-sm text-ink-2">This evaluation is not linked to a call.</p>
          )}
        </aside>

        {/* right: score and form */}
        <div className="min-w-0 space-y-4">
          {done && (
            <div className={`card flex items-center gap-4 p-4 ${ev.autoFailed || !ev.passed ? 'bg-bad-soft' : 'bg-good-soft'}`}>
              <div className="font-display text-3xl font-bold tabular-nums">{ev.percent}%</div>
              <div className="text-sm">
                <div className="font-semibold">
                  {ev.autoFailed ? 'Automatic failure (critical question)' : ev.passed ? 'Passed' : 'Failed'}
                </div>
                <div className="text-ink-2">
                  {ev.score} / {ev.maxScore} points · completed {fmtDateTime(ev.completedAt)}
                </div>
              </div>
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
                      disabled={done}
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
              <textarea className="input" rows={3} value={comments} onChange={(e) => setComments(e.target.value)} disabled={done} />
            </div>
            <div>
              <label className="label">Coaching notes (shared with the agent's manager)</label>
              <textarea className="input" rows={3} value={coaching} onChange={(e) => setCoaching(e.target.value)} disabled={done} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
