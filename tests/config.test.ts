/* ═══════════════════════════════════════════════════════════════════════
   NoteFlow — config.test.ts
   Unit tests for UUID generation and encryption utilities.
   ═══════════════════════════════════════════════════════════════════════ */

import { describe, it, expect } from 'vitest';
import { genId } from '../src/modules/config';

// ─── genId() ──────────────────────────────────────────────────────────────

describe('genId()', () => {
  const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

  it('returns a valid UUID v4 format', () => {
    const id = genId();
    expect(id).toMatch(UUID_REGEX);
  });

  it('generates unique IDs across multiple calls', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) {
      ids.add(genId());
    }
    expect(ids.size).toBe(100);
  });

  it('has the correct version nibble (4)', () => {
    const id = genId();
    // The 13th character (index 14 in the full string with dashes) should be '4'
    expect(id[14]).toBe('4');
  });

  it('has a valid variant nibble (8, 9, a, or b)', () => {
    const id = genId();
    // The 17th character (index 19 in the full string with dashes) should be 8, 9, a, or b
    expect(['8', '9', 'a', 'b']).toContain(id[19]);
  });

  it('returns a string of length 36', () => {
    const id = genId();
    expect(id).toHaveLength(36);
  });

  it('has dashes at correct positions', () => {
    const id = genId();
    expect(id[8]).toBe('-');
    expect(id[13]).toBe('-');
    expect(id[18]).toBe('-');
    expect(id[23]).toBe('-');
  });
});

// ─── encryptData / decryptData ────────────────────────────────────────────
// Note: crypto.subtle is not available in jsdom/Node.js test environments
// without additional polyfills. These tests are skipped in environments
// where SubtleCrypto is unavailable.

describe('encryptData / decryptData', () => {
  const hasCryptoSubtle = typeof crypto !== 'undefined' && !!crypto.subtle;

  it.skipIf(!hasCryptoSubtle)('round-trips data through encrypt and decrypt', async () => {
    const { encryptData, decryptData } = await import('../src/modules/config');
    const plaintext = '{"revenue": [{"label": "Sales", "amount": 50000}]}';
    const email = 'test@example.com';
    const encrypted = await encryptData(plaintext, email);
    expect(encrypted).not.toBe(plaintext);
    expect(encrypted.startsWith('ENC:')).toBe(true);
    const decrypted = await decryptData(encrypted, email);
    expect(decrypted).toBe(plaintext);
  });

  it.skipIf(!hasCryptoSubtle)('produces different ciphertexts for the same plaintext (random IV)', async () => {
    const { encryptData } = await import('../src/modules/config');
    const plaintext = 'test data';
    const email = 'test@example.com';
    const enc1 = await encryptData(plaintext, email);
    const enc2 = await encryptData(plaintext, email);
    expect(enc1).not.toBe(enc2);
  });

  it.skipIf(!hasCryptoSubtle)('decryption fails with wrong email', async () => {
    const { encryptData, decryptData } = await import('../src/modules/config');
    const encrypted = await encryptData('secret', 'user1@example.com');
    // Different email should fail decryption (returns null)
    const result = await decryptData(encrypted, 'user2@example.com');
    expect(result).toBeNull();
  });
});
