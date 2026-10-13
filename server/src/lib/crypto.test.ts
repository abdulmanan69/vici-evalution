import { describe, expect, it } from 'vitest';
import {
  decryptSecret,
  encryptSecret,
  hashPassword,
  newSessionToken,
  verifyPassword,
} from './crypto.js';

describe('password hashing', () => {
  it('verifies a correct password', async () => {
    const hash = await hashPassword('S3cure-Passw0rd!');
    expect(await verifyPassword('S3cure-Passw0rd!', hash)).toBe(true);
  });
  it('rejects a wrong password', async () => {
    const hash = await hashPassword('S3cure-Passw0rd!');
    expect(await verifyPassword('wrong', hash)).toBe(false);
  });
  it('rejects malformed stored hashes without throwing', async () => {
    expect(await verifyPassword('x', 'not-a-hash')).toBe(false);
  });
});

describe('secret encryption (AES-256-GCM)', () => {
  it('round-trips', () => {
    const enc = encryptSecret('vicidial-api-password');
    expect(enc).not.toContain('vicidial-api-password');
    expect(decryptSecret(enc)).toBe('vicidial-api-password');
  });
  it('unique ciphertext per call (random IV)', () => {
    expect(encryptSecret('same')).not.toBe(encryptSecret('same'));
  });
  it('tampered ciphertext fails authentication', () => {
    const enc = encryptSecret('secret');
    const parts = enc.split(':');
    const data = Buffer.from(parts[3], 'base64');
    data[0] = data[0] ^ 0xff;
    parts[3] = data.toString('base64');
    expect(() => decryptSecret(parts.join(':'))).toThrow();
  });
});

describe('session tokens', () => {
  it('stores only a hash of the token', () => {
    const { token, tokenHash } = newSessionToken();
    expect(token).toHaveLength(64);
    expect(tokenHash).toHaveLength(64);
    expect(tokenHash).not.toBe(token);
  });
});
