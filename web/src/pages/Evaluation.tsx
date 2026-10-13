import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Save } from 'lucide-react';
import { api, ApiError } from '../api/client';
import type { Evaluation, FormDefinition, FormQuestion } from '../api/types';
import { Chip, ErrorState, Loading, PageHeader, fmtDateTime } from '../components/ui';

interface Detail {
  evaluation: Evaluation;
  reviewerName: string;
  formName: string;
  formVersion: number;
  formSchema: FormDefinition;
  maxScore: string;
  passThreshold: string;
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
    <div className="mx-auto max-w-3xl">
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

      {ev.transferId && (
        <Link to={`/transfers/${ev.transferId}`} className="text-sm font-medium text-brand hover:underline">
          ← Back to call detail (listen while you score)
        </Link>
      )}

      {done && (
        <div className={`card mt-3 flex items-center gap-4 p-4 ${ev.autoFailed || !ev.passed ? 'bg-bad-soft' : 'bg-good-soft'}`}>
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
      {message && <div className="mt-3 rounded-md bg-brand-soft px-3 py-2 text-sm text-brand">{message}</div>}

      <div className="mt-4 space-y-4">
        {data.formSchema.sections.map((section) => (
          <div key={section.id} className="card p-4">
            <h2 className="mb-3 font-display text-sm font-bold">{section.title}</h2>
            <div className="space-y-4">
              {section.questions.filter((q) => isVisible(q, answers)).map((q) => (
                <div key={q.id}>
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

        <div className="card space-y-3 p-4">
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
  );
}
