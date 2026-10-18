import { allQuestions, type Answers, type FormDefinition, type Question } from './formSchema.js';

/**
 * Deterministic scoring engine. Pure, unit-tested. The engine only ever runs
 * against a frozen form version, so historical evaluations never change when
 * a form is edited.
 */

export interface ScoreResult {
  score: number;
  maxScore: number;
  percent: number; // 0..100, rounded to 2 decimals
  passed: boolean;
  autoFailed: boolean;
  missingRequired: string[];
  perQuestion: Array<{ questionId: string; earned: number; possible: number; visible: boolean }>;
}

function isVisible(q: Question, answers: Answers): boolean {
  if (!q.visibleIf) return true;
  const actual = answers[q.visibleIf.questionId];
  // normalize booleans/strings so 'yes'/true compare predictably
  return String(actual) === String(q.visibleIf.equals);
}

function isAnswered(value: unknown): boolean {
  return value !== undefined && value !== null && value !== '';
}

export function scoreEvaluation(
  form: FormDefinition,
  answers: Answers,
  passThresholdPct: number,
): ScoreResult {
  let earnedTotal = 0;
  let possibleTotal = 0;
  let autoFailed = false;
  const missingRequired: string[] = [];
  const perQuestion: ScoreResult['perQuestion'] = [];

  for (const q of allQuestions(form)) {
    const visible = isVisible(q, answers);
    if (!visible) {
      perQuestion.push({ questionId: q.id, earned: 0, possible: 0, visible: false });
      continue;
    }
    const value = answers[q.id];
    const answered = isAnswered(value);
    if (q.required && !answered) missingRequired.push(q.id);

    let earned = 0;
    let possible = 0;

    switch (q.type) {
      case 'yes_no': {
        if (String(value) === 'na' && !q.required) break; // excluded from possible
        possible = q.weight;
        if (String(value) === 'yes' || value === true) earned = q.weight;
        else if (answered && q.critical) autoFailed = true;
        break;
      }
      case 'pass_fail': {
        if (String(value) === 'na' && !q.required) break;
        possible = q.weight;
        if (String(value) === 'pass') earned = q.weight;
        else if (answered && q.critical) autoFailed = true;
        break;
      }
      case 'rating': {
        possible = q.weight;
        const max = q.scaleMax ?? 5;
        const n = Number(value);
        if (answered && Number.isFinite(n)) {
          const clamped = Math.min(Math.max(n, 0), max);
          earned = round2(q.weight * (clamped / max));
          if (q.critical && clamped === 0) autoFailed = true;
        }
        break;
      }
      case 'dropdown': {
        possible = q.weight;
        const opt = q.options?.find((o) => o.value === String(value));
        if (opt) {
          earned = round2(q.weight * (opt.scorePct / 100));
          if (opt.autoFail) autoFailed = true;
        }
        break;
      }
      case 'date':
      case 'text':
      case 'number':
        // informational — never scored
        break;
    }

    earnedTotal += earned;
    possibleTotal += possible;
    perQuestion.push({ questionId: q.id, earned, possible, visible: true });
  }

  earnedTotal = round2(earnedTotal);
  possibleTotal = round2(possibleTotal);
  const rawPercent = possibleTotal > 0 ? (earnedTotal / possibleTotal) * 100 : 0;
  const percent = autoFailed ? 0 : round2(rawPercent);
  const passed = !autoFailed && rawPercent >= passThresholdPct;

  return {
    score: earnedTotal,
    maxScore: possibleTotal,
    percent,
    passed,
    autoFailed,
    missingRequired,
    perQuestion,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
