import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { qaForms, qaFormVersions } from '../db/schema.js';
import { DEFAULT_FORMS } from './defaultForms.js';
import { allQuestions, formDefinitionSchema, formMaxScore } from './formSchema.js';

export interface DefaultFormsResult {
  created: string[];
  existing: string[];
}

/**
 * Give a company every built-in scorecard it does not currently have (by
 * name; archived ones do not count), published as version 1. Idempotent, so
 * it runs at every boot, on company creation and behind the managers'
 * "Load default forms" button. Existing forms are never modified.
 */
export async function ensureDefaultForms(companyId: string, createdBy: string | null): Promise<DefaultFormsResult> {
  const rows = await db
    .select({ name: qaForms.name, state: qaForms.state })
    .from(qaForms)
    .where(eq(qaForms.companyId, companyId));
  const live = new Set(rows.filter((r) => r.state !== 'archived').map((r) => r.name.trim().toLowerCase()));
  const result: DefaultFormsResult = { created: [], existing: [] };
  for (const def of DEFAULT_FORMS) {
    if (live.has(def.name.toLowerCase())) {
      result.existing.push(def.name);
      continue;
    }
    const schema = formDefinitionSchema.parse(def.schema);
    const maxScore = formMaxScore(schema);
    const [form] = await db
      .insert(qaForms)
      .values({
        companyId,
        name: def.name,
        description: def.description,
        target: def.target,
        queue: def.queue,
        state: 'published',
        currentVersion: 1,
        draftSchema: schema,
        createdBy,
      })
      .returning();
    await db.insert(qaFormVersions).values({
      formId: form.id,
      version: 1,
      schema,
      maxScore: String(maxScore),
      passThreshold: String(def.passThreshold),
      createdBy,
    });
    result.created.push(def.name);
  }
  await alignDateQuestions(companyId);
  return result;
}

/**
 * Copies of a default form made before the 'date' question type existed
 * hold "Callback Date"-style questions as free text. Retype them in place
 * (draft and every published version) so the evaluation page shows a
 * calendar picker — unscored text to unscored date changes no score.
 */
async function alignDateQuestions(companyId: string): Promise<void> {
  const dateIdsByName = new Map<string, Set<string>>();
  for (const def of DEFAULT_FORMS) {
    const s = formDefinitionSchema.parse(def.schema);
    dateIdsByName.set(
      def.name.toLowerCase(),
      new Set(allQuestions(s).filter((q) => q.type === 'date').map((q) => q.id)),
    );
  }
  const retype = (schema: unknown, ids: Set<string>) => {
    const parsed = formDefinitionSchema.safeParse(schema);
    if (!parsed.success) return null;
    let changed = false;
    for (const sec of parsed.data.sections) {
      for (const q of sec.questions) {
        if (ids.has(q.id) && q.type === 'text') {
          q.type = 'date';
          changed = true;
        }
      }
    }
    return changed ? parsed.data : null;
  };
  const forms = await db.select().from(qaForms).where(eq(qaForms.companyId, companyId));
  for (const f of forms) {
    const ids = dateIdsByName.get(f.name.trim().toLowerCase());
    if (!ids || ids.size === 0) continue;
    const draft = retype(f.draftSchema, ids);
    if (draft) await db.update(qaForms).set({ draftSchema: draft, updatedAt: new Date() }).where(eq(qaForms.id, f.id));
    const versions = await db.select().from(qaFormVersions).where(eq(qaFormVersions.formId, f.id));
    for (const v of versions) {
      const s = retype(v.schema, ids);
      if (s) await db.update(qaFormVersions).set({ schema: s }).where(eq(qaFormVersions.id, v.id));
    }
  }
}
