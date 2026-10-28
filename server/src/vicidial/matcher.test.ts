import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MATCH_OPTIONS,
  decideMatch,
  normalizePhone,
  scoreCandidate,
  type CloserCandidate,
  type XferSide,
} from './matcher.js';

const T0 = new Date('2026-01-10T15:00:00Z');
const sec = (n: number) => new Date(T0.getTime() + n * 1000);

const xferSameDialer: XferSide = {
  dialerServerId: 'dialer-a',
  viciLeadId: 12345,
  phoneNumber: '(555) 123-0001',
  xferTime: T0,
};

function candidate(partial: Partial<CloserCandidate>): CloserCandidate {
  return {
    callId: 'cand-1',
    dialerServerId: 'dialer-a',
    viciLeadId: 12345,
    phoneNumber: '5551230001',
    callDate: sec(30),
    ...partial,
  };
}

describe('normalizePhone', () => {
  it('matches +1/formatting variants to the same 10 digits', () => {
    expect(normalizePhone('+1 (555) 123-0001')).toBe('5551230001');
    expect(normalizePhone('15551230001')).toBe('5551230001');
    expect(normalizePhone('555.123.0001')).toBe('5551230001');
  });
  it('rejects garbage', () => {
    expect(normalizePhone('')).toBeNull();
    expect(normalizePhone('123')).toBeNull();
    expect(normalizePhone(null)).toBeNull();
  });
});

describe('scoreCandidate', () => {
  it('same dialer, same lead, same phone, tight timing -> max confidence', () => {
    const s = scoreCandidate(xferSameDialer, candidate({}));
    expect(s.score).toBe(100);
  });

  it('cross-dialer: lead ids differ by design, phone+time still auto-match', () => {
    const s = scoreCandidate(
      xferSameDialer,
      candidate({ dialerServerId: 'dialer-b', viciLeadId: 999888 }),
    );
    // no lead score cross-dialer: phone(40) + tight time(30)
    expect(s.score).toBe(70);
    expect(s.reasons).toContain('cross-dialer candidate');
  });

  it("linked closer dialer: warm handoff starts before the fronter's XFER and still auto-matches", () => {
    // closers on a sister company's dialer pick up while the fronter is still
    // on the line — the closer leg starts 0–2 min before the XFER timestamp
    const opts = { ...DEFAULT_MATCH_OPTIONS, maxEarlySec: 600 };
    const xfer = { ...xferSameDialer, phoneNumber: '+1 555-123-0001' };
    const d = decideMatch(
      xfer,
      [
        candidate({ callId: 'closer', dialerServerId: 'dialer-b', viciLeadId: 777, callDate: sec(-95) }),
        candidate({ callId: 'other', dialerServerId: 'dialer-b', viciLeadId: 778, phoneNumber: '5559990000', callDate: sec(-60) }),
      ],
      opts,
    );
    expect(d.outcome).toBe('matched');
    expect(d.best?.callId).toBe('closer');
    expect(d.best?.score).toBe(70);
  });

  it('same dialer with conflicting lead id is penalized', () => {
    const s = scoreCandidate(xferSameDialer, candidate({ viciLeadId: 99 }));
    // -20 lead mismatch + 40 phone + 30 time = 50
    expect(s.score).toBe(50);
  });

  it('candidate outside the time window scores zero', () => {
    const s = scoreCandidate(xferSameDialer, candidate({ callDate: sec(3600) }));
    expect(s.score).toBe(0);
  });

  it('closer leg slightly BEFORE xfer timestamp is tolerated', () => {
    const s = scoreCandidate(xferSameDialer, candidate({ callDate: sec(-60) }));
    expect(s.score).toBeGreaterThanOrEqual(70);
  });

  it('phone mismatch is penalized hard', () => {
    const s = scoreCandidate(xferSameDialer, candidate({ phoneNumber: '5559999999' }));
    // 40 lead - 30 phone + 30 time = 40
    expect(s.score).toBe(40);
  });
});

describe('decideMatch', () => {
  it('auto-matches an unambiguous candidate', () => {
    const d = decideMatch(xferSameDialer, [candidate({})]);
    expect(d.outcome).toBe('matched');
    expect(d.best?.callId).toBe('cand-1');
  });

  it('flags when two candidates are too close to call', () => {
    const d = decideMatch(xferSameDialer, [
      candidate({ callId: 'c1', callDate: sec(30) }),
      candidate({ callId: 'c2', callDate: sec(45) }),
    ]);
    expect(d.outcome).toBe('flagged');
    expect(d.notes).toContain('ambiguous');
  });

  it('flags a mid-confidence candidate instead of silently linking it', () => {
    const d = decideMatch(xferSameDialer, [
      candidate({ viciLeadId: 777, phoneNumber: '5551230001', callDate: sec(250) }),
    ]);
    // -20 lead mismatch + 40 phone + 20 time (within 5 min) = 40 -> review band
    expect(d.outcome).toBe('flagged');
  });

  it('returns unmatched when nothing is plausible', () => {
    const d = decideMatch(xferSameDialer, [
      candidate({ viciLeadId: 777, phoneNumber: '5550000000', callDate: sec(500) }),
    ]);
    expect(d.outcome).toBe('unmatched');
  });

  it('returns unmatched with no candidates', () => {
    const d = decideMatch(xferSameDialer, []);
    expect(d.outcome).toBe('unmatched');
  });

  it('respects a custom auto threshold', () => {
    const d = decideMatch(
      xferSameDialer,
      [candidate({ dialerServerId: 'dialer-b', viciLeadId: null })],
      { ...DEFAULT_MATCH_OPTIONS, autoThreshold: 90 },
    );
    expect(d.outcome).toBe('flagged'); // 70 < 90
  });
});
