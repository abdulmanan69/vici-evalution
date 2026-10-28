import { describe, expect, it } from 'vitest';
import { friendlySyncError, isNoRecordingsAnswer, summarizeFailures } from './sync.js';

describe('isNoRecordingsAnswer', () => {
  it('treats an empty recording_lookup as an answer', () => {
    expect(isNoRecordingsAnswer('VICIdial API error: ERROR: recording_lookup NO RECORDINGS FOUND - apiuser||23693310||')).toBe(true);
  });
  it('keeps real refusals as failures', () => {
    expect(isNoRecordingsAnswer('VICIdial API error: ERROR: recording_lookup USER DOES NOT HAVE PERMISSION TO GET RECORDING INFO - apiuser|1')).toBe(false);
    expect(isNoRecordingsAnswer('VICIdial API error: ERROR: Invalid Username/Password: |apiuser|')).toBe(false);
  });
});

describe('friendlySyncError', () => {
  it('names an unknown host', () => {
    expect(friendlySyncError('getaddrinfo ENOTFOUND db.example.invalid')).toBe(
      'The dialer address db.example.invalid could not be found — check the host name',
    );
  });
  it('explains a dialer that does not answer', () => {
    expect(friendlySyncError('connect ETIMEDOUT 10.0.0.5:3306')).toMatch(/did not answer/);
    expect(friendlySyncError('connect ECONNREFUSED 10.0.0.5:3306')).toMatch(/did not answer/);
  });
  it('explains a refused login', () => {
    expect(friendlySyncError("Access denied for user 'ro'@'1.2.3.4' (using password: YES)")).toMatch(/refused the database login/);
  });
  it('leaves other errors as they are', () => {
    expect(friendlySyncError('something else broke')).toBe('something else broke');
  });
});

describe('summarizeFailures', () => {
  it('says an error shared by every step once', () => {
    const s = summarizeFailures([
      'Reading agents, campaigns and in-groups: getaddrinfo ENOTFOUND db.invalid',
      'Importing outbound calls: getaddrinfo ENOTFOUND db.invalid',
      'Importing closer calls: getaddrinfo ENOTFOUND db.invalid',
    ]);
    expect(s).toBe('The dialer address db.invalid could not be found — check the host name');
  });
  it('keeps distinct problems apart and names their steps', () => {
    const s = summarizeFailures([
      'Reading the recording log: SELECT command denied to user ro for table recording_log',
      'Importing outbound calls: connect ETIMEDOUT 10.0.0.5:3306',
    ]);
    expect(s).toContain('Reading the recording log: The read-only database user is missing a permission');
    expect(s).toContain('Importing outbound calls: The dialer did not answer');
  });
});
