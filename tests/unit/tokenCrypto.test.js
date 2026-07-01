'use strict';

const {
  encryptToken, decryptToken, isEncrypted, requireEncryptionKey,
} = require('../../src/services/tokenCrypto');

describe('tokenCrypto', () => {
  test('requireEncryptionKey returns a 32-byte key from the test env', () => {
    const key = requireEncryptionKey();
    expect(key.length).toBe(32);
  });

  test('encryptToken produces the enc:v1: prefixed format', () => {
    const encrypted = encryptToken('EAASomeRealLookingMetaTokenValue123');
    expect(encrypted).toMatch(/^enc:v1:[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$/);
  });

  test('decryptToken round-trips the exact original plaintext', () => {
    const plaintext = 'EAASomeRealLookingMetaTokenValue123';
    const encrypted = encryptToken(plaintext);
    expect(decryptToken(encrypted)).toBe(plaintext);
  });

  test('isEncrypted distinguishes encrypted values from legacy plaintext', () => {
    const encrypted = encryptToken('token123');
    expect(isEncrypted(encrypted)).toBe(true);
    expect(isEncrypted('EAARawPlaintextToken')).toBe(false);
  });

  test('decryptToken returns legacy plaintext unchanged (no enc:v1: prefix)', () => {
    expect(decryptToken('EAARawLegacyPlaintextToken')).toBe('EAARawLegacyPlaintextToken');
  });

  test('encryptToken/decryptToken pass through null and undefined', () => {
    expect(encryptToken(null)).toBeNull();
    expect(encryptToken(undefined)).toBeUndefined();
    expect(decryptToken(null)).toBeNull();
    expect(decryptToken(undefined)).toBeUndefined();
  });

  test('two encryptions of the same plaintext produce different ciphertext (random IV)', () => {
    const a = encryptToken('same-plaintext');
    const b = encryptToken('same-plaintext');
    expect(a).not.toBe(b);
    expect(decryptToken(a)).toBe('same-plaintext');
    expect(decryptToken(b)).toBe('same-plaintext');
  });

  test('decryptToken throws on tampered ciphertext (GCM auth tag mismatch)', () => {
    const encrypted = encryptToken('token123');
    const tampered = encrypted.slice(0, -2) + (encrypted.slice(-2) === '00' ? '11' : '00');
    expect(() => decryptToken(tampered)).toThrow();
  });

  test('decryptToken throws on a malformed enc:v1: value missing parts', () => {
    expect(() => decryptToken('enc:v1:onlyonepart')).toThrow(/malformed/);
  });

  test('requireEncryptionKey rejects a key of the wrong length', () => {
    const original = process.env.TOKEN_ENCRYPTION_KEY;
    process.env.TOKEN_ENCRYPTION_KEY = 'tooshort';
    expect(() => requireEncryptionKey()).toThrow(/32 bytes/);
    process.env.TOKEN_ENCRYPTION_KEY = original;
  });

  test('requireEncryptionKey rejects a missing key', () => {
    const original = process.env.TOKEN_ENCRYPTION_KEY;
    delete process.env.TOKEN_ENCRYPTION_KEY;
    expect(() => requireEncryptionKey()).toThrow(/not set/);
    process.env.TOKEN_ENCRYPTION_KEY = original;
  });
});
