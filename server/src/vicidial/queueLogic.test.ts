import { describe, expect, it } from 'vitest';
import { computeQueueStatus, resolveMeaning, transition, type MappingRow } from './queueLogic.js';

const mappings: MappingRow[] = [
  { dialerServerId: null, campaignId: null, dispositionCode: 'XFER', meaning: 'transfer', active: true },
  { dialerServerId: null, campaignId: null, dispositionCode: 'SALE', meaning: 'sale', active: true },
  { dialerServerId: 'dialer-b', campaignId: null, dispositionCode: 'SALE', meaning: 'no_sale', active: true },
  { dialerServerId: null, campaignId: 'camp-1', dispositionCode: 'XFER', meaning: 'other', active: true },
  { dialerServerId: null, campaignId: null, dispositionCode: 'OLD', meaning: 'sale', active: false },
];

describe('resolveMeaning', () => {
  it('resolves a company-wide mapping', () => {
    expect(
      resolveMeaning(mappings, { dialerServerId: 'dialer-a', campaignId: null, dispositionCode: 'SALE' }),
    ).toBe('sale');
  });

  it('a dialer-specific mapping overrides the company-wide one', () => {
    expect(
      resolveMeaning(mappings, { dialerServerId: 'dialer-b', campaignId: null, dispositionCode: 'SALE' }),
    ).toBe('no_sale');
  });

  it('a campaign-specific mapping wins over everything less specific', () => {
    expect(
      resolveMeaning(mappings, { dialerServerId: 'dialer-a', campaignId: 'camp-1', dispositionCode: 'XFER' }),
    ).toBe('other');
  });

  it('is case/whitespace tolerant on the code', () => {
    expect(
      resolveMeaning(mappings, { dialerServerId: 'dialer-a', campaignId: null, dispositionCode: ' xfer ' }),
    ).toBe('transfer');
  });

  it('inactive mappings never apply', () => {
    expect(
      resolveMeaning(mappings, { dialerServerId: 'dialer-a', campaignId: null, dispositionCode: 'OLD' }),
    ).toBeNull();
  });

  it('a dispo containing the word sale is NOT a sale without explicit mapping', () => {
    expect(
      resolveMeaning(mappings, { dialerServerId: 'dialer-a', campaignId: null, dispositionCode: 'PRESALE' }),
    ).toBeNull();
  });
});

describe('computeQueueStatus / transition', () => {
  it('unmatched transfer stays in Transfer', () => {
    expect(computeQueueStatus({ matched: false, closerDisposition: null, closerMeaning: null })).toBe('transfer');
  });

  it('matched without a sale mapping -> Unclosed', () => {
    expect(computeQueueStatus({ matched: true, closerDisposition: 'NI', closerMeaning: 'no_sale' })).toBe('unclosed');
    expect(computeQueueStatus({ matched: true, closerDisposition: 'WEIRD', closerMeaning: null })).toBe('unclosed');
  });

  it('explicit sale mapping -> Closed', () => {
    expect(computeQueueStatus({ matched: true, closerDisposition: 'SALE', closerMeaning: 'sale' })).toBe('closed');
  });

  it('detects a disposition correction regressing a closed sale', () => {
    const r = transition('closed', { matched: true, closerDisposition: 'NI', closerMeaning: 'no_sale' });
    expect(r.next).toBe('unclosed');
    expect(r.changed).toBe(true);
    expect(r.regression).toBe(true);
  });

  it('no-op transition reports changed=false', () => {
    const r = transition('unclosed', { matched: true, closerDisposition: 'NI', closerMeaning: 'no_sale' });
    expect(r.changed).toBe(false);
    expect(r.regression).toBe(false);
  });
});
