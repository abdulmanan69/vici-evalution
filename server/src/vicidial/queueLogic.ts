/**
 * Disposition semantics + Transfer/Unclosed/Closed state machine.
 * Pure functions, unit-tested. A disposition NEVER implies "sale" by its
 * name — only an explicit active mapping row does.
 */

export type DispoMeaning = 'transfer' | 'sale' | 'no_sale' | 'callback' | 'dnc' | 'other';
export type QueueStatus = 'transfer' | 'unclosed' | 'closed';

export interface MappingRow {
  dialerServerId: string | null; // null = all dialers of the company
  campaignId: string | null; // null = all campaigns
  dispositionCode: string;
  meaning: DispoMeaning;
  active: boolean;
}

export interface DispoContext {
  dialerServerId: string;
  campaignId: string | null;
  dispositionCode: string | null;
}

/**
 * Most-specific active mapping wins:
 * campaign+dialer > campaign > dialer > company-wide. Returns null when the
 * disposition has no configured meaning.
 */
export function resolveMeaning(mappings: MappingRow[], ctx: DispoContext): DispoMeaning | null {
  if (!ctx.dispositionCode) return null;
  const code = ctx.dispositionCode.trim().toUpperCase();
  let best: { specificity: number; meaning: DispoMeaning } | null = null;
  for (const m of mappings) {
    if (!m.active) continue;
    if (m.dispositionCode.trim().toUpperCase() !== code) continue;
    if (m.dialerServerId && m.dialerServerId !== ctx.dialerServerId) continue;
    if (m.campaignId && m.campaignId !== ctx.campaignId) continue;
    const specificity = (m.campaignId ? 2 : 0) + (m.dialerServerId ? 1 : 0);
    if (!best || specificity > best.specificity) {
      best = { specificity, meaning: m.meaning };
    }
  }
  return best?.meaning ?? null;
}

export interface QueueInput {
  matched: boolean;
  closerDisposition: string | null;
  closerMeaning: DispoMeaning | null;
}

/**
 * Transfer: fronter transferred, no identified closer leg yet.
 * Unclosed: closer leg identified, not a configured sale disposition.
 * Closed: closer disposition explicitly mapped to 'sale'.
 */
export function computeQueueStatus(input: QueueInput): QueueStatus {
  if (!input.matched) return 'transfer';
  if (input.closerMeaning === 'sale') return 'closed';
  return 'unclosed';
}

export interface TransitionResult {
  next: QueueStatus;
  changed: boolean;
  /** true when a previously closed sale regressed (dispo corrected) */
  regression: boolean;
}

export function transition(current: QueueStatus, input: QueueInput): TransitionResult {
  const next = computeQueueStatus(input);
  return {
    next,
    changed: next !== current,
    regression: current === 'closed' && next !== 'closed',
  };
}
