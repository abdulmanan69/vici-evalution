import { describe, expect, it } from 'vitest';
import { decryptSecret, encryptSecret } from '../../lib/crypto.js';
import { isInternalHost } from '../connections/catalog.js';
import { normalizeLinkUrl, parseStoredLinks, readStoredLinks, resolveCrmLink, resolveHrmsLink, sameOrigin, usable, type StoredCrmLink, type StoredHrmsLink } from './resolve.js';

const ENV = {
  HRMS_URL: 'https://hrms.env.example',
  HRMS_API_KEYS: 'acme=hrms_env_acme,beta=hrms_env_beta',
  HRMS_WEBHOOK_SECRETS: 'acme=whsec_env_acme',
  CRM_URL: 'https://crm.env.example',
  CRM_API_KEY: 'crm_env_key',
} as NodeJS.ProcessEnv;

const hrmsWeb = (over: Partial<StoredHrmsLink> = {}): StoredHrmsLink => ({
  url: 'https://hr.vertexpakistan.com',
  apiKeyEnc: encryptSecret('hrms_web_key_1234'),
  keyLast4: '1234',
  webhookSecretEnc: null,
  enabled: true,
  ...over,
});
const crmWeb = (over: Partial<StoredCrmLink> = {}): StoredCrmLink => ({
  url: 'https://crm.vertexpakistan.com',
  apiKeyEnc: encryptSecret('crm_web_key_9876'),
  keyLast4: '9876',
  enabled: true,
  ...over,
});

describe('HRMS link resolution', () => {
  it('uses the web link over the environment', () => {
    const r = resolveHrmsLink(hrmsWeb(), 'acme', decryptSecret, ENV);
    expect(r).toMatchObject({ source: 'web', url: 'https://hr.vertexpakistan.com', apiKey: 'hrms_web_key_1234' });
    expect(usable(r)).toBe(true);
  });

  it('falls back to the environment exactly as before when nothing is saved', () => {
    expect(resolveHrmsLink(undefined, 'acme', decryptSecret, ENV)).toMatchObject({ source: 'env', url: 'https://hrms.env.example', apiKey: 'hrms_env_acme', webhookSecret: 'whsec_env_acme' });
    expect(resolveHrmsLink(undefined, 'beta', decryptSecret, ENV)).toMatchObject({ source: 'env', apiKey: 'hrms_env_beta', webhookSecret: null });
    // a company the environment does not name: nothing, as before
    const none = resolveHrmsLink(undefined, 'gamma', decryptSecret, ENV);
    expect(none.source).toBe('none');
    expect(usable(none)).toBe(false);
    // the single-key form still covers every company
    expect(resolveHrmsLink(undefined, 'gamma', decryptSecret, { HRMS_URL: 'https://h', HRMS_API_KEY: 'k1' } as NodeJS.ProcessEnv)).toMatchObject({ source: 'env', apiKey: 'k1' });
    expect(resolveHrmsLink(undefined, 'acme', decryptSecret, {} as NodeJS.ProcessEnv).source).toBe('none');
  });

  it('treats a disabled web link as off for the company, not as the environment', () => {
    const r = resolveHrmsLink(hrmsWeb({ enabled: false }), 'acme', decryptSecret, ENV);
    expect(r).toMatchObject({ source: 'off', apiKey: null, webhookSecret: null });
    expect(usable(r)).toBe(false);
  });

  it('uses the web webhook secret, else the environment one', () => {
    expect(resolveHrmsLink(hrmsWeb({ webhookSecretEnc: encryptSecret('whsec_web') }), 'acme', decryptSecret, ENV).webhookSecret).toBe('whsec_web');
    expect(resolveHrmsLink(hrmsWeb(), 'acme', decryptSecret, ENV).webhookSecret).toBe('whsec_env_acme');
    expect(resolveHrmsLink(hrmsWeb(), 'beta', decryptSecret, ENV).webhookSecret).toBeNull();
  });

  it('reports an unreadable key instead of using it or the environment', () => {
    const r = resolveHrmsLink(hrmsWeb({ apiKeyEnc: 'v1:bad:bad:bad' }), 'acme', decryptSecret, ENV);
    expect(r.source).toBe('web');
    expect(r.error).toMatch(/cannot be read/);
    expect(usable(r)).toBe(false);
  });
});

describe('CRM link resolution', () => {
  it('uses the company web link over the shared environment key', () => {
    expect(resolveCrmLink(crmWeb(), decryptSecret, ENV)).toMatchObject({ source: 'web', apiKey: 'crm_web_key_9876' });
  });
  it('falls back to CRM_URL / CRM_API_KEY', () => {
    expect(resolveCrmLink(undefined, decryptSecret, ENV)).toMatchObject({ source: 'env', url: 'https://crm.env.example', apiKey: 'crm_env_key' });
    expect(resolveCrmLink(undefined, decryptSecret, { CRM_URL: 'https://c' } as NodeJS.ProcessEnv).source).toBe('none');
  });
  it('a disabled web link is off', () => {
    expect(resolveCrmLink(crmWeb({ enabled: false }), decryptSecret, ENV)).toMatchObject({ source: 'off', apiKey: null });
  });
});

describe('stored links', () => {
  it('keeps keys encrypted: the stored form never contains the key', () => {
    const link = hrmsWeb();
    const json = JSON.stringify({ links: { hrms: link } });
    expect(json).not.toContain('hrms_web_key_1234');
    expect(link.apiKeyEnc).toMatch(/^v1:/);
    expect(decryptSecret(link.apiKeyEnc!)).toBe('hrms_web_key_1234');
    // a fresh IV each time
    expect(encryptSecret('same')).not.toBe(encryptSecret('same'));
  });

  it('reads companies.settings.links and ignores anything malformed', () => {
    expect(readStoredLinks({ qa: { x: 1 } })).toEqual({});
    expect(readStoredLinks(null)).toEqual({});
    expect(parseStoredLinks({ hrms: { url: '' }, crm: 'nope' })).toEqual({});
    const l = readStoredLinks({ links: { hrms: { url: 'https://h', apiKeyEnc: 'v1:x', enabled: false } } });
    expect(l.hrms).toMatchObject({ url: 'https://h', enabled: false, webhookSecretEnc: null });
  });
});

describe('link URLs', () => {
  const admin = { superAdmin: false, isInternalHost };
  const superAdmin = { superAdmin: true, isInternalHost };
  const ok = (u: string, o = admin) => {
    const r = normalizeLinkUrl(u, o);
    return r.ok ? r.url : `ERR ${r.error}`;
  };

  it('tidies trailing slashes and API paths', () => {
    expect(ok('https://hr.vertexpakistan.com/')).toBe('https://hr.vertexpakistan.com');
    expect(ok('  https://hr.vertexpakistan.com//  ')).toBe('https://hr.vertexpakistan.com');
    expect(ok('https://hr.vertexpakistan.com/api/v1/')).toBe('https://hr.vertexpakistan.com');
    expect(ok('https://crm.vertexpakistan.com/api/ext/v1')).toBe('https://crm.vertexpakistan.com');
    expect(ok('https://example.com:8443/hr')).toBe('https://example.com:8443/hr');
  });

  it('accepts https only', () => {
    expect(ok('http://hr.vertexpakistan.com')).toMatch(/^ERR .*https/);
    expect(ok('ftp://hr.vertexpakistan.com')).toMatch(/^ERR/);
    expect(ok('hr.vertexpakistan.com')).toMatch(/^ERR/);
    expect(ok('')).toMatch(/^ERR/);
  });

  it('allows http://localhost for super admins only', () => {
    expect(ok('http://localhost:3000', superAdmin)).toBe('http://localhost:3000');
    expect(ok('http://127.0.0.1:3000/', superAdmin)).toBe('http://127.0.0.1:3000');
    expect(ok('http://localhost:3000')).toMatch(/^ERR/);
    expect(ok('http://hr.vertexpakistan.com', superAdmin)).toMatch(/^ERR/);
  });

  it('keeps company admins off internal hosts, credentials and query strings', () => {
    expect(ok('https://localhost')).toMatch(/^ERR .*public/);
    expect(ok('https://10.0.0.5')).toMatch(/^ERR .*public/);
    expect(ok('https://10.0.0.5', superAdmin)).toBe('https://10.0.0.5');
    expect(ok('https://user:pw@hr.vertexpakistan.com')).toMatch(/^ERR/);
    expect(ok('https://hr.vertexpakistan.com/?key=1')).toMatch(/^ERR/);
  });

  it('compares servers by origin', () => {
    expect(sameOrigin('https://hr.vertexpakistan.com', 'https://hr.vertexpakistan.com/x')).toBe(true);
    expect(sameOrigin('https://hr.vertexpakistan.com', 'https://evil.example')).toBe(false);
    expect(sameOrigin('https://hr.vertexpakistan.com', null)).toBe(false);
  });
});
