import { useEffect, useState } from 'react';
import { Navigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, Plus, Save, Trash2, UploadCloud } from 'lucide-react';
import { api, ApiError } from '../api/client';
import type { FormDefinition, FormQuestion, FormSection, QaForm } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { Chip, ErrorState, Field, Loading, PageHeader } from '../components/ui';

let uid = 0;
const newId = (prefix: string) => `${prefix}_${Date.now().toString(36)}_${(uid += 1)}`;

const QUESTION_TYPES: { value: FormQuestion['type']; label: string }[] = [
  { value: 'yes_no', label: 'Yes / No' },
  { value: 'pass_fail', label: 'Pass / Fail' },
  { value: 'rating', label: 'Rating scale' },
  { value: 'dropdown', label: 'Dropdown' },
  { value: 'text', label: 'Text (unscored)' },
  { value: 'date', label: 'Date (calendar picker, unscored)' },
  { value: 'number', label: 'Number (unscored)' },
];

function move<T>(arr: T[], from: number, to: number): T[] {
  if (to < 0 || to >= arr.length) return arr;
  const next = [...arr];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

function QuestionEditor({
  q,
  allQuestions,
  onChange,
  onDelete,
  onMove,
  readOnly,
}: {
  q: FormQuestion;
  allQuestions: FormQuestion[];
  onChange: (q: FormQuestion) => void;
  onDelete: () => void;
  onMove: (dir: -1 | 1) => void;
  readOnly: boolean;
}) {
  const scorable = q.type !== 'text' && q.type !== 'number' && q.type !== 'date';
  return (
    <div className="rounded-md border border-ink/10 bg-bg/50 p-3">
      <div className="flex items-start gap-2">
        <div className="flex-1 space-y-2">
          <input
            className="input"
            value={q.text}
            placeholder="Question text"
            onChange={(e) => onChange({ ...q, text: e.target.value })}
            disabled={readOnly}
          />
          <div className="flex flex-wrap items-center gap-2">
            <select
              className="input w-40"
              value={q.type}
              onChange={(e) => onChange({ ...q, type: e.target.value as FormQuestion['type'] })}
              disabled={readOnly}
              aria-label="Question type"
            >
              {QUESTION_TYPES.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
            {scorable && (
              <label className="flex items-center gap-1 text-2xs text-ink-2">
                Weight
                <input
                  type="number"
                  min={0}
                  className="input w-20"
                  value={q.weight}
                  onChange={(e) => onChange({ ...q, weight: Number(e.target.value) })}
                  disabled={readOnly}
                />
              </label>
            )}
            {q.type === 'rating' && (
              <label className="flex items-center gap-1 text-2xs text-ink-2">
                Scale 1–
                <input
                  type="number"
                  min={2}
                  max={10}
                  className="input w-16"
                  value={q.scaleMax ?? 5}
                  onChange={(e) => onChange({ ...q, scaleMax: Number(e.target.value) })}
                  disabled={readOnly}
                />
              </label>
            )}
            <label className="flex items-center gap-1 text-2xs text-ink-2">
              <input
                type="checkbox"
                checked={q.required}
                onChange={(e) => onChange({ ...q, required: e.target.checked })}
                disabled={readOnly}
              />
              Required
            </label>
            {scorable && (
              <label className="flex items-center gap-1 text-2xs font-semibold text-bad">
                <input
                  type="checkbox"
                  checked={q.critical}
                  onChange={(e) => onChange({ ...q, critical: e.target.checked })}
                  disabled={readOnly}
                />
                Critical (auto-fail)
              </label>
            )}
          </div>

          {q.type === 'dropdown' && (
            <div className="space-y-1.5">
              {(q.options ?? []).map((opt, i) => (
                <div key={i} className="flex items-center gap-2">
                  <input
                    className="input flex-1"
                    value={opt.label}
                    placeholder="Option label"
                    onChange={(e) => {
                      const options = [...(q.options ?? [])];
                      options[i] = { ...opt, label: e.target.value, value: e.target.value.toLowerCase().replace(/\s+/g, '_') || opt.value };
                      onChange({ ...q, options });
                    }}
                    disabled={readOnly}
                  />
                  <label className="flex items-center gap-1 text-2xs text-ink-2">
                    Score %
                    <input
                      type="number"
                      min={0}
                      max={100}
                      className="input w-20"
                      value={opt.scorePct}
                      onChange={(e) => {
                        const options = [...(q.options ?? [])];
                        options[i] = { ...opt, scorePct: Number(e.target.value) };
                        onChange({ ...q, options });
                      }}
                      disabled={readOnly}
                    />
                  </label>
                  <label className="flex items-center gap-1 text-2xs text-bad">
                    <input
                      type="checkbox"
                      checked={opt.autoFail}
                      onChange={(e) => {
                        const options = [...(q.options ?? [])];
                        options[i] = { ...opt, autoFail: e.target.checked };
                        onChange({ ...q, options });
                      }}
                      disabled={readOnly}
                    />
                    auto-fail
                  </label>
                  {!readOnly && (
                    <button
                      onClick={() => onChange({ ...q, options: (q.options ?? []).filter((_, j) => j !== i) })}
                      className="text-ink-3 hover:text-bad"
                      aria-label="Delete option"
                    >
                      <Trash2 size={13} />
                    </button>
                  )}
                </div>
              ))}
              {!readOnly && (
                <button
                  className="btn-secondary px-2 py-1 text-2xs"
                  onClick={() =>
                    onChange({
                      ...q,
                      options: [...(q.options ?? []), { value: newId('opt'), label: '', scorePct: 100, autoFail: false }],
                    })
                  }
                >
                  <Plus size={12} /> Option
                </button>
              )}
            </div>
          )}

          <div className="flex items-center gap-2 text-2xs text-ink-2">
            Show only when
            <select
              className="input w-56"
              value={q.visibleIf?.questionId ?? ''}
              onChange={(e) =>
                onChange({
                  ...q,
                  visibleIf: e.target.value ? { questionId: e.target.value, equals: q.visibleIf?.equals ?? 'yes' } : undefined,
                })
              }
              disabled={readOnly}
              aria-label="Conditional question"
            >
              <option value="">always visible</option>
              {allQuestions
                .filter((other) => other.id !== q.id)
                .map((other) => (
                  <option key={other.id} value={other.id}>
                    {other.text.slice(0, 50) || other.id}
                  </option>
                ))}
            </select>
            {q.visibleIf && (
              <>
                equals
                <input
                  className="input w-28"
                  value={String(q.visibleIf.equals)}
                  onChange={(e) => onChange({ ...q, visibleIf: { ...q.visibleIf!, equals: e.target.value } })}
                  disabled={readOnly}
                />
              </>
            )}
          </div>
        </div>
        {!readOnly && (
          <div className="flex flex-col gap-1">
            <button onClick={() => onMove(-1)} className="text-ink-3 hover:text-ink" aria-label="Move up">
              <ArrowUp size={14} />
            </button>
            <button onClick={() => onMove(1)} className="text-ink-3 hover:text-ink" aria-label="Move down">
              <ArrowDown size={14} />
            </button>
            <button onClick={onDelete} className="text-ink-3 hover:text-bad" aria-label="Delete question">
              <Trash2 size={14} />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export function FormBuilderPage() {
  const { id = '' } = useParams();
  const queryClient = useQueryClient();
  const { hasPerm } = useAuth();
  const [def, setDef] = useState<FormDefinition>({ sections: [] });
  const [dirty, setDirty] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [passThreshold, setPassThreshold] = useState(80);

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['form', id],
    queryFn: () => api<{ form: QaForm; versions: { version: number; maxScore: string; publishedAt: string }[] }>(`/qa/forms/${id}`),
  });

  useEffect(() => {
    if (data?.form.draftSchema) setDef(data.form.draftSchema);
  }, [data?.form.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const readOnly = !hasPerm('qa.forms.manage');

  const update = (next: FormDefinition) => {
    setDef(next);
    setDirty(true);
    setMessage(null);
  };

  const save = useMutation({
    mutationFn: () => api(`/qa/forms/${id}`, { method: 'PATCH', body: { draftSchema: def } }),
    onSuccess: () => {
      setDirty(false);
      setMessage('Draft saved.');
      void queryClient.invalidateQueries({ queryKey: ['form', id] });
    },
    onError: (err) => setMessage(err instanceof ApiError ? err.message : 'Save failed.'),
  });

  const publish = useMutation({
    mutationFn: async () => {
      await api(`/qa/forms/${id}`, { method: 'PATCH', body: { draftSchema: def } });
      return api(`/qa/forms/${id}/publish`, { method: 'POST', body: { passThreshold } });
    },
    onSuccess: () => {
      setDirty(false);
      setMessage('Published. Evaluations now use the new version; completed ones keep the old one.');
      void queryClient.invalidateQueries({ queryKey: ['form', id] });
    },
    onError: (err) => setMessage(err instanceof ApiError ? err.message : 'Publish failed.'),
  });

  // the builder is a manager tool; reviewers reach forms through evaluations
  if (readOnly) return <Navigate to="/" replace />;
  if (isLoading) return <Loading />;
  if (isError || !data) return <ErrorState message="Form could not load." onRetry={() => void refetch()} />;

  const setQueue = async (queue: string) => {
    try {
      await api(`/qa/forms/${id}`, { method: 'PATCH', body: { queue: queue || null } });
      setMessage('Queue saved.');
      void queryClient.invalidateQueries({ queryKey: ['form', id] });
    } catch (err) {
      setMessage(err instanceof ApiError ? err.message : 'Saving the queue failed.');
    }
  };

  const totalWeight = def.sections
    .flatMap((s) => s.questions)
    .filter((q) => q.type !== 'text' && q.type !== 'number' && q.type !== 'date')
    .reduce((sum, q) => sum + q.weight, 0);
  const allQuestions = def.sections.flatMap((s) => s.questions);

  return (
    <div>
      <PageHeader
        title={data.form.name}
        subtitle={`Max score ${totalWeight} points · pass at ${passThreshold}%`}
        actions={
          !readOnly && (
            <>
              <label className="flex items-center gap-1 text-2xs text-ink-2">
                Queue
                <select
                  className="input w-32"
                  value={data.form.queue ?? ''}
                  onChange={(e) => void setQueue(e.target.value)}
                  title="Reviewers limited to this form only see this queue"
                >
                  <option value="">Any queue</option>
                  <option value="transfer">Transfers</option>
                  <option value="unclosed">Unclosed</option>
                  <option value="closed">Closed</option>
                </select>
              </label>
              <label className="flex items-center gap-1 text-2xs text-ink-2">
                Pass %
                <input
                  type="number"
                  min={0}
                  max={100}
                  className="input w-20"
                  value={passThreshold}
                  onChange={(e) => setPassThreshold(Number(e.target.value))}
                />
              </label>
              <button className="btn-secondary" onClick={() => save.mutate()} disabled={save.isPending || !dirty}>
                <Save size={14} /> Save draft
              </button>
              <button className="btn-primary" onClick={() => publish.mutate()} disabled={publish.isPending}>
                <UploadCloud size={14} /> Publish v{data.form.currentVersion + 1}
              </button>
            </>
          )
        }
      />

      <div className="mb-3 flex items-center gap-2">
        <Chip value={data.form.state} />
        <span className="text-2xs text-ink-3">
          {data.versions.length} published version{data.versions.length === 1 ? '' : 's'}
        </span>
        {message && <span className="text-2xs font-medium text-brand">{message}</span>}
        {dirty && <span className="text-2xs text-amber-line">Unsaved changes</span>}
      </div>

      <div className="space-y-4">
        {def.sections.map((section, si) => (
          <div key={section.id} className="card p-4">
            <div className="mb-3 flex items-center gap-2">
              <input
                className="input max-w-md font-display font-semibold"
                value={section.title}
                onChange={(e) =>
                  update({
                    sections: def.sections.map((s, i) => (i === si ? { ...s, title: e.target.value } : s)),
                  })
                }
                disabled={readOnly}
                aria-label="Section title"
              />
              {!readOnly && (
                <>
                  <button
                    onClick={() => update({ sections: move(def.sections, si, si - 1) })}
                    className="text-ink-3 hover:text-ink"
                    aria-label="Move section up"
                  >
                    <ArrowUp size={14} />
                  </button>
                  <button
                    onClick={() => update({ sections: move(def.sections, si, si + 1) })}
                    className="text-ink-3 hover:text-ink"
                    aria-label="Move section down"
                  >
                    <ArrowDown size={14} />
                  </button>
                  <button
                    onClick={() => update({ sections: def.sections.filter((_, i) => i !== si) })}
                    className="text-ink-3 hover:text-bad"
                    aria-label="Delete section"
                  >
                    <Trash2 size={14} />
                  </button>
                </>
              )}
            </div>
            <div className="space-y-2">
              {section.questions.map((q, qi) => (
                <QuestionEditor
                  key={q.id}
                  q={q}
                  allQuestions={allQuestions}
                  readOnly={readOnly}
                  onChange={(next) =>
                    update({
                      sections: def.sections.map((s, i) =>
                        i === si ? { ...s, questions: s.questions.map((old, j) => (j === qi ? next : old)) } : s,
                      ),
                    })
                  }
                  onDelete={() =>
                    update({
                      sections: def.sections.map((s, i) =>
                        i === si ? { ...s, questions: s.questions.filter((_, j) => j !== qi) } : s,
                      ),
                    })
                  }
                  onMove={(dir) =>
                    update({
                      sections: def.sections.map((s, i) =>
                        i === si ? { ...s, questions: move(s.questions, qi, qi + dir) } : s,
                      ),
                    })
                  }
                />
              ))}
              {!readOnly && (
                <button
                  className="btn-secondary"
                  onClick={() =>
                    update({
                      sections: def.sections.map((s, i) =>
                        i === si
                          ? {
                              ...s,
                              questions: [
                                ...s.questions,
                                {
                                  id: newId('q'),
                                  text: '',
                                  type: 'yes_no',
                                  weight: 10,
                                  required: true,
                                  critical: false,
                                } satisfies FormQuestion,
                              ],
                            }
                          : s,
                      ),
                    })
                  }
                >
                  <Plus size={14} /> Question
                </button>
              )}
            </div>
          </div>
        ))}
        {!readOnly && (
          <button
            className="btn-secondary"
            onClick={() =>
              update({
                sections: [
                  ...def.sections,
                  { id: newId('sec'), title: `Section ${def.sections.length + 1}`, questions: [] } satisfies FormSection,
                ],
              })
            }
          >
            <Plus size={14} /> Section
          </button>
        )}
      </div>
    </div>
  );
}
