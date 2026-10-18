import { z } from 'zod';

/**
 * QA form definition. Built in the admin form builder, validated server-side,
 * frozen into qa_form_versions on publish so completed evaluations always
 * keep the exact rules they were scored with.
 */

export const questionTypeEnum = z.enum(['yes_no', 'pass_fail', 'rating', 'dropdown', 'text', 'number', 'date']);

export const dropdownOptionSchema = z.object({
  value: z.string().min(1).max(100),
  label: z.string().min(1).max(300),
  /** 0..100 — percentage of the question weight this option earns */
  scorePct: z.number().min(0).max(100).default(0),
  /** selecting this option triggers an automatic evaluation failure */
  autoFail: z.boolean().default(false),
});

export const visibleIfSchema = z.object({
  questionId: z.string().min(1),
  equals: z.union([z.string(), z.number(), z.boolean()]),
});

export const questionSchema = z.object({
  id: z.string().min(1).max(64),
  text: z.string().min(1).max(1000),
  type: questionTypeEnum,
  /** points this question contributes to the form total (0 for text/number) */
  weight: z.number().min(0).max(1000).default(0),
  required: z.boolean().default(true),
  /** failing a critical question auto-fails the whole evaluation */
  critical: z.boolean().default(false),
  /** rating only: scale upper bound (1..scaleMax) */
  scaleMax: z.number().int().min(2).max(10).optional(),
  options: z.array(dropdownOptionSchema).max(50).optional(),
  /** conditional display based on a previous answer */
  visibleIf: visibleIfSchema.optional(),
  helpText: z.string().max(1000).optional(),
});

export const sectionSchema = z.object({
  id: z.string().min(1).max(64),
  title: z.string().min(1).max(200),
  description: z.string().max(1000).optional(),
  questions: z.array(questionSchema).min(1).max(100),
});

export const formDefinitionSchema = z
  .object({
    sections: z.array(sectionSchema).min(1).max(50),
  })
  .superRefine((form, ctx) => {
    const ids = new Set<string>();
    for (const s of form.sections) {
      for (const q of s.questions) {
        if (ids.has(q.id)) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Duplicate question id: ${q.id}` });
        }
        ids.add(q.id);
        if (q.type === 'rating' && !q.scaleMax) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Rating question ${q.id} needs scaleMax` });
        }
        if (q.type === 'dropdown' && (!q.options || q.options.length === 0)) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Dropdown question ${q.id} needs options` });
        }
      }
    }
    for (const s of form.sections) {
      for (const q of s.questions) {
        if (q.visibleIf && !ids.has(q.visibleIf.questionId)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Question ${q.id} depends on unknown question ${q.visibleIf.questionId}`,
          });
        }
        if (q.visibleIf && q.visibleIf.questionId === q.id) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Question ${q.id} cannot depend on itself` });
        }
      }
    }
  });

export type FormDefinition = z.infer<typeof formDefinitionSchema>;
export type Question = z.infer<typeof questionSchema>;

/** answers: questionId -> value. 'na' is accepted for optional yes_no/pass_fail. */
export const answersSchema = z.record(
  z.string(),
  z.union([z.string(), z.number(), z.boolean(), z.null()]),
);
export type Answers = z.infer<typeof answersSchema>;

export function allQuestions(form: FormDefinition): Question[] {
  return form.sections.flatMap((s) => s.questions);
}

/** Maximum achievable points of a form (all scorable questions visible). */
export function formMaxScore(form: FormDefinition): number {
  return allQuestions(form)
    .filter((q) => q.type !== 'text' && q.type !== 'number' && q.type !== 'date')
    .reduce((sum, q) => sum + q.weight, 0);
}
