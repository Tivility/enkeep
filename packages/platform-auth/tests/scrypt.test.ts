import { describe, it, expect } from 'vitest';
import { hashPassword, verifyPassword } from '../src/index.js';

describe('Scrypt Password Hashing and Bounded Verification', () => {
  const validSaltHex = '0123456789abcdef0123456789abcdef';
  const validHashHex =
    '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

  it('hashes passwords using scrypt with secure format and random salts', async () => {
    const pwd = 'CorrectHorseBatteryStaple123!';
    const hash1 = await hashPassword(pwd);
    const hash2 = await hashPassword(pwd);

    // Format check: scrypt$16384$8$1$<saltHex(32)>$<hashHex(128)>
    expect(hash1.startsWith('scrypt$16384$8$1$')).toBe(true);
    expect(hash2.startsWith('scrypt$16384$8$1$')).toBe(true);

    const parts1 = hash1.split('$');
    expect(parts1.length).toBe(6);
    expect(parts1[4].length).toBe(32);
    expect(parts1[5].length).toBe(128);

    // Unique salts produce unique hashes
    expect(hash1).not.toEqual(hash2);
    expect(hash1).not.toContain(pwd); // Never plaintext
  });

  it('verifies correct password against hash', async () => {
    const pwd = 'SuperSecretPassword!';
    const hash = await hashPassword(pwd);

    const match = await verifyPassword(pwd, hash);
    expect(match).toBe(true);
  });

  it('rejects incorrect password against hash', async () => {
    const pwd = 'SuperSecretPassword!';
    const hash = await hashPassword(pwd);

    const wrongMatch = await verifyPassword('WrongPassword!', hash);
    expect(wrongMatch).toBe(false);
  });

  it('rejects passwords exceeding 1024 UTF-8 bytes', async () => {
    const validLongPwd = 'a'.repeat(1024);
    const hash = await hashPassword(validLongPwd);
    expect(await verifyPassword(validLongPwd, hash)).toBe(true);

    const tooLongPwd = 'a'.repeat(1025);
    await expect(hashPassword(tooLongPwd)).rejects.toThrow('Password must be a non-empty string of at most 1024 bytes');
    expect(await verifyPassword(tooLongPwd, hash)).toBe(false);

    // Multibyte characters exceeding byte limit
    const multibyteChar = '€'; // 3 bytes in UTF-8
    const longMultibyte = multibyteChar.repeat(342); // 342 * 3 = 1026 bytes
    await expect(hashPassword(longMultibyte)).rejects.toThrow();
    expect(await verifyPassword(longMultibyte, hash)).toBe(false);
  });

  it('rejects empty or non-string passwords without throwing in verifyPassword', async () => {
    await expect(hashPassword('')).rejects.toThrow('Password must be a non-empty string');
    // @ts-expect-error test non-string input
    await expect(hashPassword(null)).rejects.toThrow();
    // @ts-expect-error test non-string input
    await expect(hashPassword(undefined)).rejects.toThrow();

    // verifyPassword must return false without throwing
    expect(await verifyPassword('', `scrypt$16384$8$1$${validSaltHex}$${validHashHex}`)).toBe(false);
    // @ts-expect-error test non-string input
    expect(await verifyPassword(null, `scrypt$16384$8$1$${validSaltHex}$${validHashHex}`)).toBe(false);
    // @ts-expect-error test non-string input
    expect(await verifyPassword(undefined, `scrypt$16384$8$1$${validSaltHex}$${validHashHex}`)).toBe(false);
    // @ts-expect-error test non-string hash
    expect(await verifyPassword('pwd', null)).toBe(false);
    // @ts-expect-error test non-string hash
    expect(await verifyPassword('pwd', undefined)).toBe(false);
  });

  it('rejects huge N, out-of-bounds N, and non-power-of-two N', async () => {
    // Huge N (e.g. 524288, 1048576, 2^30)
    expect(await verifyPassword('pwd', `scrypt$524288$8$1$${validSaltHex}$${validHashHex}`)).toBe(false);
    expect(await verifyPassword('pwd', `scrypt$1073741824$8$1$${validSaltHex}$${validHashHex}`)).toBe(false);

    // Too small N (< 16384)
    expect(await verifyPassword('pwd', `scrypt$8192$8$1$${validSaltHex}$${validHashHex}`)).toBe(false);
    expect(await verifyPassword('pwd', `scrypt$1$8$1$${validSaltHex}$${validHashHex}`)).toBe(false);
    expect(await verifyPassword('pwd', `scrypt$2$8$1$${validSaltHex}$${validHashHex}`)).toBe(false);

    // Non-power-of-two N
    expect(await verifyPassword('pwd', `scrypt$20000$8$1$${validSaltHex}$${validHashHex}`)).toBe(false);
    expect(await verifyPassword('pwd', `scrypt$16385$8$1$${validSaltHex}$${validHashHex}`)).toBe(false);
    expect(await verifyPassword('pwd', `scrypt$32767$8$1$${validSaltHex}$${validHashHex}`)).toBe(false);
    expect(await verifyPassword('pwd', `scrypt$65535$8$1$${validSaltHex}$${validHashHex}`)).toBe(false);
  });

  it('rejects negative numbers in cost, blockSize, or parallelization', async () => {
    expect(await verifyPassword('pwd', `scrypt$-16384$8$1$${validSaltHex}$${validHashHex}`)).toBe(false);
    expect(await verifyPassword('pwd', `scrypt$16384$-8$1$${validSaltHex}$${validHashHex}`)).toBe(false);
    expect(await verifyPassword('pwd', `scrypt$16384$8$-1$${validSaltHex}$${validHashHex}`)).toBe(false);
    expect(await verifyPassword('pwd', `scrypt$-1$-1$-1$${validSaltHex}$${validHashHex}`)).toBe(false);
  });

  it('rejects non-canonical decimal representations (leading zeroes, +, hex, exponents, floats, whitespace)', async () => {
    // Leading zeros
    expect(await verifyPassword('pwd', `scrypt$016384$8$1$${validSaltHex}$${validHashHex}`)).toBe(false);
    expect(await verifyPassword('pwd', `scrypt$16384$08$1$${validSaltHex}$${validHashHex}`)).toBe(false);
    expect(await verifyPassword('pwd', `scrypt$16384$8$01$${validSaltHex}$${validHashHex}`)).toBe(false);

    // Explicit plus sign
    expect(await verifyPassword('pwd', `scrypt$+16384$8$1$${validSaltHex}$${validHashHex}`)).toBe(false);
    expect(await verifyPassword('pwd', `scrypt$16384$+8$1$${validSaltHex}$${validHashHex}`)).toBe(false);
    expect(await verifyPassword('pwd', `scrypt$16384$8$+1$${validSaltHex}$${validHashHex}`)).toBe(false);

    // Hex notations
    expect(await verifyPassword('pwd', `scrypt$0x4000$8$1$${validSaltHex}$${validHashHex}`)).toBe(false);
    expect(await verifyPassword('pwd', `scrypt$16384$0x8$1$${validSaltHex}$${validHashHex}`)).toBe(false);

    // Exponent notation (e.g. 1e5)
    expect(await verifyPassword('pwd', `scrypt$16384e0$8$1$${validSaltHex}$${validHashHex}`)).toBe(false);
    expect(await verifyPassword('pwd', `scrypt$1e4$8$1$${validSaltHex}$${validHashHex}`)).toBe(false);

    // Floating point numbers
    expect(await verifyPassword('pwd', `scrypt$16384.0$8$1$${validSaltHex}$${validHashHex}`)).toBe(false);
    expect(await verifyPassword('pwd', `scrypt$16384$8.0$1$${validSaltHex}$${validHashHex}`)).toBe(false);
    expect(await verifyPassword('pwd', `scrypt$16384$8$1.0$${validSaltHex}$${validHashHex}`)).toBe(false);

    // Whitespace / Trailing characters
    expect(await verifyPassword('pwd', `scrypt$ 16384 $8$1$${validSaltHex}$${validHashHex}`)).toBe(false);
    expect(await verifyPassword('pwd', `scrypt$16384 $8$1$${validSaltHex}$${validHashHex}`)).toBe(false);
    expect(await verifyPassword('pwd', `scrypt$16384a$8$1$${validSaltHex}$${validHashHex}`)).toBe(false);
  });

  it('rejects NaN, Infinity, and non-numeric work factors', async () => {
    expect(await verifyPassword('pwd', `scrypt$NaN$8$1$${validSaltHex}$${validHashHex}`)).toBe(false);
    expect(await verifyPassword('pwd', `scrypt$16384$NaN$1$${validSaltHex}$${validHashHex}`)).toBe(false);
    expect(await verifyPassword('pwd', `scrypt$16384$8$NaN$${validSaltHex}$${validHashHex}`)).toBe(false);
    expect(await verifyPassword('pwd', `scrypt$Infinity$8$1$${validSaltHex}$${validHashHex}`)).toBe(false);
    expect(await verifyPassword('pwd', `scrypt$abc$8$1$${validSaltHex}$${validHashHex}`)).toBe(false);
    expect(await verifyPassword('pwd', `scrypt$$8$1$${validSaltHex}$${validHashHex}`)).toBe(false);
  });

  it('rejects out-of-bounds blockSize (r) and parallelization (p)', async () => {
    // r bounds: 8..16
    expect(await verifyPassword('pwd', `scrypt$16384$7$1$${validSaltHex}$${validHashHex}`)).toBe(false);
    expect(await verifyPassword('pwd', `scrypt$16384$0$1$${validSaltHex}$${validHashHex}`)).toBe(false);
    expect(await verifyPassword('pwd', `scrypt$16384$17$1$${validSaltHex}$${validHashHex}`)).toBe(false);
    expect(await verifyPassword('pwd', `scrypt$16384$32$1$${validSaltHex}$${validHashHex}`)).toBe(false);

    // p bounds: 1..4
    expect(await verifyPassword('pwd', `scrypt$16384$8$0$${validSaltHex}$${validHashHex}`)).toBe(false);
    expect(await verifyPassword('pwd', `scrypt$16384$8$5$${validSaltHex}$${validHashHex}`)).toBe(false);
    expect(await verifyPassword('pwd', `scrypt$16384$8$10$${validSaltHex}$${validHashHex}`)).toBe(false);
  });

  it('rejects malformed, odd-length, uppercase, or invalid length salt and hash hex strings', async () => {
    // Odd length hex
    const oddSalt = validSaltHex.slice(0, 31);
    expect(await verifyPassword('pwd', `scrypt$16384$8$1$${oddSalt}$${validHashHex}`)).toBe(false);
    const oddHash = validHashHex.slice(0, 127);
    expect(await verifyPassword('pwd', `scrypt$16384$8$1$${validSaltHex}$${oddHash}`)).toBe(false);

    // Wrong lengths (salt must be exactly 16 bytes = 32 hex, hash must be exactly 64 bytes = 128 hex)
    const shortSalt = '0123456789abcdef'; // 16 hex = 8 bytes
    expect(await verifyPassword('pwd', `scrypt$16384$8$1$${shortSalt}$${validHashHex}`)).toBe(false);

    const longSalt = validSaltHex + '00'; // 34 hex = 17 bytes
    expect(await verifyPassword('pwd', `scrypt$16384$8$1$${longSalt}$${validHashHex}`)).toBe(false);

    const shortHash = validHashHex.slice(0, 64); // 64 hex = 32 bytes
    expect(await verifyPassword('pwd', `scrypt$16384$8$1$${validSaltHex}$${shortHash}`)).toBe(false);

    const longHash = validHashHex + '00'; // 130 hex = 65 bytes
    expect(await verifyPassword('pwd', `scrypt$16384$8$1$${validSaltHex}$${longHash}`)).toBe(false);

    // Uppercase hex
    const upperSalt = validSaltHex.toUpperCase();
    expect(await verifyPassword('pwd', `scrypt$16384$8$1$${upperSalt}$${validHashHex}`)).toBe(false);

    const upperHash = validHashHex.toUpperCase();
    expect(await verifyPassword('pwd', `scrypt$16384$8$1$${validSaltHex}$${upperHash}`)).toBe(false);

    // Non-hex characters
    const nonHexSalt = 'g' + validSaltHex.slice(1);
    expect(await verifyPassword('pwd', `scrypt$16384$8$1$${nonHexSalt}$${validHashHex}`)).toBe(false);

    const nonHexHash = 'z' + validHashHex.slice(1);
    expect(await verifyPassword('pwd', `scrypt$16384$8$1$${validSaltHex}$${nonHexHash}`)).toBe(false);
  });

  it('rejects invalid hash structure (not 6 parts, not starting with scrypt)', async () => {
    expect(await verifyPassword('pwd', 'not-a-valid-hash')).toBe(false);
    expect(await verifyPassword('pwd', `bcrypt$16384$8$1$${validSaltHex}$${validHashHex}`)).toBe(false);
    expect(await verifyPassword('pwd', `scrypt$16384$8$1$${validSaltHex}`)).toBe(false);
    expect(await verifyPassword('pwd', `scrypt$16384$8$1$${validSaltHex}$${validHashHex}$extra`)).toBe(false);
  });

  it('validates hashPassword option boundaries strictly', async () => {
    const pwd = 'TestPassword123!';

    // Valid custom options
    const customHash = await hashPassword(pwd, {
      cost: 32768,
      blockSize: 8,
      parallelization: 2,
    });
    expect(customHash.startsWith('scrypt$32768$8$2$')).toBe(true);
    expect(await verifyPassword(pwd, customHash)).toBe(true);

    // Invalid cost
    await expect(hashPassword(pwd, { cost: 524288 })).rejects.toThrow('Invalid scrypt cost option');
    await expect(hashPassword(pwd, { cost: 20000 })).rejects.toThrow('Invalid scrypt cost option');
    await expect(hashPassword(pwd, { cost: -16384 })).rejects.toThrow('Invalid scrypt cost option');

    // Invalid blockSize
    await expect(hashPassword(pwd, { blockSize: 7 })).rejects.toThrow('Invalid scrypt blockSize option');
    await expect(hashPassword(pwd, { blockSize: 17 })).rejects.toThrow('Invalid scrypt blockSize option');

    // Invalid parallelization
    await expect(hashPassword(pwd, { parallelization: 0 })).rejects.toThrow(
      'Invalid scrypt parallelization option'
    );
    await expect(hashPassword(pwd, { parallelization: 5 })).rejects.toThrow(
      'Invalid scrypt parallelization option'
    );

    // Invalid keyLength / saltLength
    await expect(hashPassword(pwd, { keyLength: 32 })).rejects.toThrow('Invalid scrypt keyLength option');
    await expect(hashPassword(pwd, { saltLength: 32 })).rejects.toThrow('Invalid scrypt saltLength option');
  });
});
