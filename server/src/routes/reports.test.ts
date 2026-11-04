import { describe, expect, it } from 'vitest';
import { csvEscape, evaluationQuestionColumns } from './reports.js';

const schema = (questions: Array<Record<string, unknown>>) => ({ sections: [{ questions }] });
const greet = { id: 'greeting', text: 'Greeting', type: 'rating', weight: 5, scaleMax: 5 };
const verdict = { id: 'final_status', text: 'Final Status', type: 'dropdown', weight: 0, options: [{ value: 'pass', label: 'Pass' }] };
const rebuttal = { id: 'rebuttal', text: 'Rebuttal', type: 'dropdown', weight: 10, options: [{ value: 'good', label: 'Good' }] };

function row(
  formId: string,
  formName: string,
  companyName: string,
  formVersion: number,
  questions: Array<Record<string, unknown>>,
  answers: Record<string, unknown>,
) {
  return { formId, formName, companyName, formVersion, schema: schema(questions), evaluation: { answers } };
}

describe('evaluationQuestionColumns', () => {
  it('keeps two companies’ forms of the same name in separate blocks', () => {
    const rows = [
      row('f-a', 'Unclosed - Closer Call', 'Company A', 6, [greet], { greeting: 4 }),
      row('f-b', 'Unclosed - Closer Call', 'Company B', 1, [greet], { greeting: 2 }),
    ];
    const cols = evaluationQuestionColumns(rows);
    expect(cols.map((c) => c.header)).toEqual([
      'Unclosed - Closer Call (Company A): Greeting (out of 5)',
      'Unclosed - Closer Call (Company B): Greeting (out of 5)',
    ]);
    // each row fills only its own form's column
    expect(cols.map((c) => c.cell(rows[0]))).toEqual([4, '']);
    expect(cols.map((c) => c.cell(rows[1]))).toEqual(['', 2]);
  });

  it('keeps questions only older versions asked, and reads each row by its own version', () => {
    const rows = [
      row('f1', 'Unclosed', 'Co', 6, [greet, rebuttal], { greeting: 5, rebuttal: 'good' }),
      row('f1', 'Unclosed', 'Co', 3, [greet, rebuttal, verdict], { greeting: 3, rebuttal: 'good', final_status: 'pass' }),
    ];
    const cols = evaluationQuestionColumns(rows);
    expect(cols.map((c) => c.header)).toEqual(['Greeting (out of 5)', 'Rebuttal (10 pts)', 'Final Status']);
    expect(cols.map((c) => c.cell(rows[0]))).toEqual([5, 'Good', '']); // v6 never asked Final Status
    expect(cols.map((c) => c.cell(rows[1]))).toEqual([3, 'Good', 'Pass']);
  });

  it('writes ratings as numbers — "4/5" would turn into a date in Excel', () => {
    const r = row('f1', 'TRA', 'Co', 1, [greet], { greeting: '4' });
    const [col] = evaluationQuestionColumns([r]);
    expect(col.cell(r)).toBe(4);
  });
});

describe('csvEscape', () => {
  it('quotes commas, quotes and line breaks', () => {
    expect(csvEscape('a, "b"\nc')).toBe('"a, ""b""\nc"');
  });
  it('keeps text that Excel would run as a formula plain', () => {
    expect(csvEscape('- no rebuttal')).toBe(' - no rebuttal');
    expect(csvEscape('=HYPERLINK("x")')).toBe('" =HYPERLINK(""x"")"');
    expect(csvEscape('@sum')).toBe(' @sum');
  });
  it('leaves numbers and negative numbers alone', () => {
    expect(csvEscape(-5)).toBe('-5');
    expect(csvEscape('-12.5')).toBe('-12.5');
    expect(csvEscape(87.5)).toBe('87.5');
    expect(csvEscape(null)).toBe('');
  });
});
