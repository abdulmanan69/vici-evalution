import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { qaForms, qaFormVersions } from '../db/schema.js';
import { DEFAULT_FORMS } from './defaultForms.js';
import { formDefinitionSchema, formMaxScore } from './formSchema.js';

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
  return result;
}
