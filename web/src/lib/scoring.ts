import type { FormDefinition, FormQuestion } from '../api/types';

/**
 * Live scoring for the evaluation page — a line-for-line port of the server's
 * engine (server/src/services/scoring.ts) so the number a reviewer watches
 * while answering is the number the server stores on completion. Keep the
 * two in step: same N/A exclusion, same rounding, same auto-fail rules.
 */
export type Answers = Record<string, string | number | boolean | null | undefined>;

export interface LiveScore {
  score: number;
  maxScore: number;
  /** 0 when auto-failed, like the server */
  percent: number;
  /** before the auto-fail override — what the answers alone add up to */
  rawPercent: number;
  passed: boolean;
  autoFailed: boolean;
  missingRequired: string[];
  /** visible questions that carry points */
  scorable: number;
  /** of those, how many have an answer */
  answered: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

function isVisible(q: FormQuestion, answers: Answers): boolean {
  if (!q.visibleIf) return true;
  return String(answers[q.visibleIf.questionId]) === String(q.visibleIf.equals);
}

const isAnswered = (v: unknown) => v !== undefined && v !== null && v !== '';

export function scoreEvaluation(form: FormDefinition, answers: Answers, passThresholdPct: number): LiveScore {
  let earnedTotal = 0;
  let possibleTotal = 0;
  let autoFailed = false;
  let scorable = 0;
  let answeredCount = 0;
  const missingRequired: string[] = [];

  for (const section of form.sections) {
    for (const q of section.questions) {
      if (!isVisible(q, answers)) continue;
      const value = answers[q.id];
      const answered = isAnswered(value);
      if (q.required && !answered) missingRequired.push(q.id);
      const scored = q.type !== 'text' && q.type !== 'number' && q.type !== 'date' && q.weight > 0;
      if (scored) {
        scorable += 1;
        if (answered) answeredCount += 1;
      }

      let earned = 0;
      let possible = 0;
      switch (q.type) {
        case 'yes_no': {
          if (String(value) === 'na' && !q.required) break;
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
        default:
          break; // text / number / date are informational
      }
      earnedTotal += earned;
      possibleTotal += possible;
    }
  }

  earnedTotal = round2(earnedTotal);
  possibleTotal = round2(possibleTotal);
  const rawPercent = possibleTotal > 0 ? round2((earnedTotal / possibleTotal) * 100) : 0;
  return {
    score: earnedTotal,
    maxScore: possibleTotal,
    percent: autoFailed ? 0 : rawPercent,
    rawPercent,
    passed: !autoFailed && rawPercent >= passThresholdPct,
    autoFailed,
    missingRequired,
    scorable,
    answered: answeredCount,
  };
}
