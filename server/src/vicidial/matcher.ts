/**
 * Transfer → closer-call matching. Pure functions, unit-tested.
 *
 * No single VICIdial identifier is globally unique across dialers, so matches
 * are scored from several signals. Low-confidence or ambiguous results are
 * flagged for human review instead of silently linked.
 */

export interface XferSide {
  dialerServerId: string;
  viciLeadId: number | null;
  phoneNumber: string | null;
  xferTime: Date;
}

export interface CloserCandidate {
  callId: string;
  dialerServerId: string;
  viciLeadId: number | null;
  phoneNumber: string | null;
  callDate: Date;
}

export interface MatchScore {
  callId: string;
  score: number;
  reasons: string[];
}

export interface MatchOptions {
  autoThreshold: number; // >= auto-match (default 70)
  flagThreshold: number; // >= flag for review, below = unmatched (default 40)
  /** max seconds the closer leg may start before the fronter's xfer timestamp */
  maxEarlySec: number;
  /** max seconds after xfer the closer leg may start */
  maxLateSec: number;
  /** points gap below which two top candidates are considered ambiguous */
  ambiguityGap: number;
}

export const DEFAULT_MATCH_OPTIONS: MatchOptions = {
  autoThreshold: 70,
  flagThreshold: 40,
  maxEarlySec: 120,
  maxLateSec: 600,
  ambiguityGap: 10,
};

/** Last 10 digits — tolerates +1 / 1-prefix / formatting differences. */
export function normalizePhone(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 7) return null;
  return digits.slice(-10);
}

export function scoreCandidate(
  xfer: XferSide,
  cand: CloserCandidate,
  opts: MatchOptions = DEFAULT_MATCH_OPTIONS,
): MatchScore {
  let score = 0;
  const reasons: string[] = [];
  const sameDialer = xfer.dialerServerId === cand.dialerServerId;

  // Lead id only means something within one dialer.
  if (sameDialer && xfer.viciLeadId != null && cand.viciLeadId != null) {
    if (xfer.viciLeadId === cand.viciLeadId) {
      score += 40;
      reasons.push('lead_id match (same dialer)');
    } else {
      score -= 20;
      reasons.push('lead_id mismatch on same dialer');
    }
  }

  const xp = normalizePhone(xfer.phoneNumber);
  const cp = normalizePhone(cand.phoneNumber);
  if (xp && cp) {
    if (xp === cp) {
      score += 40;
      reasons.push('phone number match');
    } else {
      score -= 30;
      reasons.push('phone number mismatch');
    }
  }

  const deltaSec = (cand.callDate.getTime() - xfer.xferTime.getTime()) / 1000;
  if (deltaSec < -opts.maxEarlySec || deltaSec > opts.maxLateSec) {
    reasons.push(`outside time window (${Math.round(deltaSec)}s)`);
    return { callId: cand.callId, score: 0, reasons };
  }
  const absDelta = Math.abs(deltaSec);
  if (absDelta <= 120) {
    score += 30;
    reasons.push(`closer started within 2 min (${Math.round(deltaSec)}s)`);
  } else if (absDelta <= 300) {
    score += 20;
    reasons.push(`closer started within 5 min (${Math.round(deltaSec)}s)`);
  } else {
    score += 10;
    reasons.push(`closer started within 10 min (${Math.round(deltaSec)}s)`);
  }

  if (!sameDialer) reasons.push('cross-dialer candidate');
  return { callId: cand.callId, score: Math.max(0, Math.min(100, score)), reasons };
}

export interface MatchDecision {
  outcome: 'matched' | 'flagged' | 'unmatched';
  best?: MatchScore;
  runnerUp?: MatchScore;
  notes: string;
}

export function decideMatch(
  xfer: XferSide,
  candidates: CloserCandidate[],
  opts: MatchOptions = DEFAULT_MATCH_OPTIONS,
): MatchDecision {
  if (candidates.length === 0) {
    return { outcome: 'unmatched', notes: 'no closer candidates in window' };
  }
  const scored = candidates
    .map((c) => scoreCandidate(xfer, c, opts))
    .sort((a, b) => b.score - a.score);
  const best = scored[0];
  const runnerUp = scored[1];

  if (best.score < opts.flagThreshold) {
    return { outcome: 'unmatched', best, notes: `best score ${best.score} below flag threshold` };
  }
  // Ambiguous: two distinct candidates too close together — a human decides.
  if (runnerUp && best.score - runnerUp.score < opts.ambiguityGap) {
    return {
      outcome: 'flagged',
      best,
      runnerUp,
      notes: `ambiguous: top candidates within ${opts.ambiguityGap} points (${best.score} vs ${runnerUp.score})`,
    };
  }
  if (best.score >= opts.autoThreshold) {
    return { outcome: 'matched', best, notes: best.reasons.join('; ') };
  }
  return {
    outcome: 'flagged',
    best,
    notes: `score ${best.score} in review band; ${best.reasons.join('; ')}`,
  };
}
