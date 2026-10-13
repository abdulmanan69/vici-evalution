/**
 * API-only ingestion helpers — pure, unit-tested.
 *
 * In 'api' source mode call records are synthesized from recording_lookup
 * rows (verified live: start_time|user|recording_id|lead_id|length|location)
 * plus lead_all_info (status = the lead's latest disposition, phone_number).
 */

export type AgentRole = 'fronter' | 'closer' | 'blended' | 'unknown';
export type LegSource = 'vicidial_log' | 'vicidial_closer_log';

export interface ApiRecordingRow {
  startTime: Date; // already UTC
  user: string;
  recordingId: number | null;
  leadId: number | null;
  lengthSec: number | null;
  locationUrl: string | null;
  filename: string;
}

/** Recording filenames embed the dialed number: 20261013-110325_8572879242-all.mp3 */
export function phoneFromFilename(filename: string | null | undefined): string | null {
  if (!filename) return null;
  const m = filename.match(/_(\d{6,16})[-.]/);
  return m ? m[1] : null;
}

/** Stable synthetic uniqueid so repeated imports stay idempotent. */
export function syntheticUniqueId(row: ApiRecordingRow): string {
  return row.recordingId != null ? `rec-${row.recordingId}` : `recf-${row.filename}`.slice(0, 32);
}

/**
 * Decides which leg of a transfer each recording of ONE lead represents.
 *
 * Explicit agent classification (Agents page) always wins. For unclassified
 * agents, time order decides: the lead's first-seen agent is the fronter leg,
 * any later different agent is a closer leg. Rows must belong to one lead.
 */
export function assignLegSources(
  rows: ApiRecordingRow[],
  roleOf: (user: string) => AgentRole,
): Array<{ row: ApiRecordingRow; source: LegSource; inferred: boolean }> {
  const sorted = [...rows].sort((a, b) => a.startTime.getTime() - b.startTime.getTime());
  let firstUnknownUser: string | null = null;
  return sorted.map((row) => {
    const role = roleOf(row.user);
    if (role === 'closer') return { row, source: 'vicidial_closer_log' as const, inferred: false };
    if (role === 'fronter') return { row, source: 'vicidial_log' as const, inferred: false };
    // unknown/blended: first distinct agent on the lead = fronter, later agents = closer
    if (firstUnknownUser === null || firstUnknownUser === row.user) {
      firstUnknownUser = row.user;
      return { row, source: 'vicidial_log' as const, inferred: true };
    }
    return { row, source: 'vicidial_closer_log' as const, inferred: true };
  });
}

/** recording_lookup header-parsed row -> normalized record (times still local). */
export function normalizeRecordingRow(raw: Record<string, string>): {
  startTimeLocal: string | null;
  user: string;
  recordingId: number | null;
  leadId: number | null;
  lengthSec: number | null;
  locationUrl: string | null;
  filename: string | null;
} {
  const location = raw.location && /^https?:\/\//i.test(raw.location) ? raw.location : null;
  const filename = location ? (location.split('/').pop() ?? null) : (raw.filename ?? null);
  const num = (v: string | undefined): number | null => {
    const n = Number(v);
    return v !== undefined && v !== '' && Number.isFinite(n) ? n : null;
  };
  return {
    startTimeLocal: raw.start_time && /^\d{4}-\d{2}-\d{2}/.test(raw.start_time) ? raw.start_time : null,
    user: (raw.user ?? '').trim(),
    recordingId: num(raw.recording_id),
    leadId: num(raw.lead_id),
    lengthSec: num(raw.length_in_sec),
    locationUrl: location,
    filename,
  };
}
