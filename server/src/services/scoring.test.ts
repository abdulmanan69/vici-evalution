import { describe, expect, it } from 'vitest';
import { formDefinitionSchema, formMaxScore, type FormDefinition } from './formSchema.js';
import { scoreEvaluation } from './scoring.js';

const form: FormDefinition = formDefinitionSchema.parse({
  sections: [
    {
      id: 's1',
      title: 'Opening',
      questions: [
        { id: 'greeting', text: 'Proper greeting?', type: 'yes_no', weight: 10, required: true, critical: false },
        { id: 'recap', text: 'Recap quality', type: 'rating', scaleMax: 5, weight: 20, required: true, critical: false },
        {
          id: 'objection',
          text: 'Objection handling',
          type: 'dropdown',
          weight: 20,
          required: true,
          critical: false,
          options: [
            { value: 'excellent', label: 'Excellent', scorePct: 100, autoFail: false },
            { value: 'partial', label: 'Partial', scorePct: 50, autoFail: false },
            { value: 'none', label: 'None', scorePct: 0, autoFail: false },
          ],
        },
      ],
    },
    {
      id: 's2',
      title: 'Compliance',
      questions: [
        { id: 'consent', text: 'Disclosure given?', type: 'pass_fail', weight: 50, required: true, critical: true },
        { id: 'notes', text: 'Notes', type: 'text', weight: 0, required: false, critical: false },
        {
          id: 'followup',
          text: 'Follow-up scheduled correctly?',
          type: 'yes_no',
          weight: 10,
          required: true,
          critical: false,
          visibleIf: { questionId: 'objection', equals: 'partial' },
        },
      ],
    },
  ],
});

describe('formMaxScore', () => {
  it('sums scorable weights only (text excluded)', () => {
    expect(formMaxScore(form)).toBe(110);
  });
});

describe('scoreEvaluation', () => {
  it('scores a perfect evaluation', () => {
    const r = scoreEvaluation(
      form,
      { greeting: 'yes', recap: 5, objection: 'excellent', consent: 'pass' },
      80,
    );
    // followup hidden (objection != partial) -> possible 100
    expect(r.maxScore).toBe(100);
    expect(r.score).toBe(100);
    expect(r.percent).toBe(100);
    expect(r.passed).toBe(true);
    expect(r.autoFailed).toBe(false);
  });

  it('applies weighted partial credit for ratings and dropdowns', () => {
    const r = scoreEvaluation(
      form,
      { greeting: 'no', recap: 3, objection: 'partial', consent: 'pass', followup: 'yes' },
      80,
    );
    // greeting 0/10, recap 12/20, objection 10/20, consent 50/50, followup 10/10 (visible)
    expect(r.maxScore).toBe(110);
    expect(r.score).toBe(82);
    expect(r.percent).toBeCloseTo(74.55, 1);
    expect(r.passed).toBe(false); // 74.55 < 80
  });

  it('critical failure auto-fails the evaluation regardless of score', () => {
    const r = scoreEvaluation(
      form,
      { greeting: 'yes', recap: 5, objection: 'excellent', consent: 'fail' },
      80,
    );
    expect(r.autoFailed).toBe(true);
    expect(r.passed).toBe(false);
    expect(r.percent).toBe(0);
  });

  it('conditional question only counts when visible', () => {
    const hidden = scoreEvaluation(
      form,
      { greeting: 'yes', recap: 5, objection: 'excellent', consent: 'pass' },
      80,
    );
    const visible = scoreEvaluation(
      form,
      { greeting: 'yes', recap: 5, objection: 'partial', consent: 'pass', followup: 'no' },
      80,
    );
    expect(hidden.maxScore).toBe(100);
    expect(visible.maxScore).toBe(110);
  });

  it('reports missing required answers (hidden questions exempt)', () => {
    const r = scoreEvaluation(form, { greeting: 'yes' }, 80);
    expect(r.missingRequired).toContain('recap');
    expect(r.missingRequired).toContain('consent');
    expect(r.missingRequired).not.toContain('followup'); // hidden
    expect(r.missingRequired).not.toContain('notes'); // optional
  });

  it('na on an optional yes_no removes it from the denominator', () => {
    const naForm = formDefinitionSchema.parse({
      sections: [
        {
          id: 's',
          title: 'S',
          questions: [
            { id: 'a', text: 'A', type: 'yes_no', weight: 10, required: false, critical: false },
            { id: 'b', text: 'B', type: 'yes_no', weight: 10, required: true, critical: false },
          ],
        },
      ],
    });
    const r = scoreEvaluation(naForm, { a: 'na', b: 'yes' }, 80);
    expect(r.maxScore).toBe(10);
    expect(r.percent).toBe(100);
  });

  it('rejects duplicate question ids at the schema level', () => {
    const bad = {
      sections: [
        {
          id: 's',
          title: 'S',
          questions: [
            { id: 'dup', text: 'A', type: 'yes_no', weight: 10 },
            { id: 'dup', text: 'B', type: 'yes_no', weight: 10 },
          ],
        },
      ],
    };
    expect(formDefinitionSchema.safeParse(bad).success).toBe(false);
  });
});
