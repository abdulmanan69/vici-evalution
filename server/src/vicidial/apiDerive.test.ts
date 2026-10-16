import { describe, expect, it } from 'vitest';
import { fixRecordingRow, parsePipeWithHeader } from './apiClient.js';
import {
  assignLegSources,
  normalizeRecordingRow,
  phoneFromFilename,
  syntheticUniqueId,
  type ApiRecordingRow,
} from './apiDerive.js';

function rec(partial: Partial<ApiRecordingRow>): ApiRecordingRow {
  return {
    startTime: new Date('2026-10-13T15:00:00Z'),
    user: '1001',
    recordingId: 1,
    leadId: 500,
    lengthSec: 60,
    locationUrl: 'http://10.0.0.1/RECORDINGS/MP3/20261013-110325_8572879242-all.mp3',
    filename: '20261013-110325_8572879242-all.mp3',
    ...partial,
  };
}

describe('recording_lookup duration-column repair', () => {
  it('remaps the shifted URL when duration=Y adds an unlisted column (live 2.14 shape)', () => {
    const body = [
      'start_time|user|recording_id|lead_id|location',
      '2026-10-13 11:03:25|WTI100790|648464|8203539|23|http://10.0.0.1/RECORDINGS/MP3/20261013-110325_8572879242-all.mp3',
    ].join('\n');
    const [row] = parsePipeWithHeader(body).map(fixRecordingRow);
    expect(row.location).toMatch(/^http:\/\//);
    expect(row.length_in_sec).toBe('23');
    expect(row.lead_id).toBe('8203539');
  });

  it('keeps a still-recording row (seconds, no URL yet) out of the location slot', () => {
    const body = [
      'start_time|user|recording_id|lead_id|location',
      '2026-10-16 14:36:25|WTI1015|680777|8724694|192',
    ].join('\n');
    const [row] = parsePipeWithHeader(body).map(fixRecordingRow);
    expect(row.location).toBe('');
    expect(row.length_in_sec).toBe('192');
    expect(row.recording_id).toBe('680777');
  });

  it('leaves well-formed rows untouched', () => {
    const body = [
      'start_time|user|recording_id|lead_id|length_in_sec|location',
      '2026-10-13 11:03:25|A|1|2|30|http://x/y.mp3',
    ].join('\n');
    const [row] = parsePipeWithHeader(body).map(fixRecordingRow);
    expect(row.location).toBe('http://x/y.mp3');
    expect(row.length_in_sec).toBe('30');
  });
});

describe('phoneFromFilename', () => {
  it('extracts the dialed number', () => {
    expect(phoneFromFilename('20261013-110325_8572879242-all.mp3')).toBe('8572879242');
  });
  it('returns null when absent', () => {
    expect(phoneFromFilename('weird.mp3')).toBeNull();
    expect(phoneFromFilename(null)).toBeNull();
  });
});

describe('syntheticUniqueId', () => {
  it('prefers the recording id and stays stable', () => {
    expect(syntheticUniqueId(rec({ recordingId: 648464 }))).toBe('rec-648464');
    expect(syntheticUniqueId(rec({ recordingId: null }))).toMatch(/^recf-/);
  });
});

describe('assignLegSources', () => {
  const t = (s: number) => new Date(Date.UTC(2026, 9, 13, 15, 0, s));

  it('explicit roles always win', () => {
    const out = assignLegSources(
      [rec({ user: 'C1', startTime: t(0) }), rec({ user: 'F1', startTime: t(30) })],
      (u) => (u === 'C1' ? 'closer' : 'fronter'),
    );
    expect(out[0].source).toBe('vicidial_closer_log');
    expect(out[1].source).toBe('vicidial_log');
    expect(out.every((o) => !o.inferred)).toBe(true);
  });

  it('unknown roles: first agent on the lead is the fronter, later agents are closers', () => {
    const out = assignLegSources(
      [
        rec({ user: 'A', startTime: t(0) }),
        rec({ user: 'A', startTime: t(10) }),
        rec({ user: 'B', startTime: t(120) }),
      ],
      () => 'unknown',
    );
    expect(out.map((o) => o.source)).toEqual(['vicidial_log', 'vicidial_log', 'vicidial_closer_log']);
    expect(out.every((o) => o.inferred)).toBe(true);
  });

  it('sorts by time before assigning', () => {
    const out = assignLegSources(
      [rec({ user: 'B', startTime: t(120) }), rec({ user: 'A', startTime: t(0) })],
      () => 'unknown',
    );
    expect(out[0].row.user).toBe('A');
    expect(out[0].source).toBe('vicidial_log');
    expect(out[1].source).toBe('vicidial_closer_log');
  });
});

describe('normalizeRecordingRow', () => {
  it('normalizes the live shape', () => {
    const n = normalizeRecordingRow({
      start_time: '2026-10-13 11:03:25',
      user: 'WTI100790',
      recording_id: '648464',
      lead_id: '8203539',
      length_in_sec: '23',
      location: 'http://10.0.0.1/RECORDINGS/MP3/20261013-110325_8572879242-all.mp3',
    });
    expect(n.user).toBe('WTI100790');
    expect(n.recordingId).toBe(648464);
    expect(n.leadId).toBe(8203539);
    expect(n.lengthSec).toBe(23);
    expect(n.filename).toBe('20261013-110325_8572879242-all.mp3');
  });

  it('tolerates junk cells', () => {
    const n = normalizeRecordingRow({ start_time: 'garbage', user: '', recording_id: 'x', location: '23' });
    expect(n.startTimeLocal).toBeNull();
    expect(n.recordingId).toBeNull();
    expect(n.locationUrl).toBeNull();
  });
});
