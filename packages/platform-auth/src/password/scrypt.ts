import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

export interface ScryptOptions {
  cost?: number; // N (default: 16384, allowed: 16384..262144, power-of-two)
  blockSize?: number; // r (default: 8, allowed: 8..16)
  parallelization?: number; // p (default: 1, allowed: 1..4)
  keyLength?: number; // keylen (default: 64, exactly 64)
  saltLength?: number; // bytes (default: 16, exactly 16)
}

const DEFAULT_COST = 16384;
const DEFAULT_BLOCK_SIZE = 8;
const DEFAULT_PARALLELIZATION = 1;
const DEFAULT_KEY_LENGTH = 64;
const DEFAULT_SALT_LENGTH = 16;

const MIN_COST = 16384;
const MAX_COST = 262144;
const MIN_BLOCK_SIZE = 8;
const MAX_BLOCK_SIZE = 16;
const MIN_PARALLELIZATION = 1;
const MAX_PARALLELIZATION = 4;
const MAX_PASSWORD_BYTES = 1024;
const MAX_SCRYPT_MEM = 512 * 1024 * 1024; // 512MB maxmem to safely permit N=262144, r=16

const CANONICAL_INT_REGEX = /^[1-9][0-9]*$/;
const HEX_LOWER_32_REGEX = /^[0-9a-f]{32}$/;
const HEX_LOWER_128_REGEX = /^[0-9a-f]{128}$/;

function isPowerOfTwo(n: number): boolean {
  return n > 0 && (n & (n - 1)) === 0;
}

function deriveScrypt(
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number }
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keylen, options, (err, derivedKey) => {
      if (err) {
        reject(err);
      } else {
        resolve(derivedKey as Buffer);
      }
    });
  });
}

/**
 * Hash a password using Node's crypto.scrypt with a secure random salt.
 * Output format: scrypt$cost$blockSize$parallelization$saltHex$hashHex
 */
export async function hashPassword(plaintext: string, options: ScryptOptions = {}): Promise<string> {
  if (typeof plaintext !== 'string' || !plaintext) {
    throw new Error('Password must be a non-empty string');
  }

  const byteLen = Buffer.byteLength(plaintext, 'utf8');
  if (byteLen < 1 || byteLen > MAX_PASSWORD_BYTES) {
    throw new Error('Password must be a non-empty string of at most 1024 bytes');
  }

  const cost = options.cost ?? DEFAULT_COST;
  if (
    typeof cost !== 'number' ||
    !Number.isSafeInteger(cost) ||
    cost < MIN_COST ||
    cost > MAX_COST ||
    !isPowerOfTwo(cost)
  ) {
    throw new Error(`Invalid scrypt cost option: must be power of 2 between ${MIN_COST} and ${MAX_COST}`);
  }

  const blockSize = options.blockSize ?? DEFAULT_BLOCK_SIZE;
  if (
    typeof blockSize !== 'number' ||
    !Number.isSafeInteger(blockSize) ||
    blockSize < MIN_BLOCK_SIZE ||
    blockSize > MAX_BLOCK_SIZE
  ) {
    throw new Error(`Invalid scrypt blockSize option: must be integer between ${MIN_BLOCK_SIZE} and ${MAX_BLOCK_SIZE}`);
  }

  const parallelization = options.parallelization ?? DEFAULT_PARALLELIZATION;
  if (
    typeof parallelization !== 'number' ||
    !Number.isSafeInteger(parallelization) ||
    parallelization < MIN_PARALLELIZATION ||
    parallelization > MAX_PARALLELIZATION
  ) {
    throw new Error(
      `Invalid scrypt parallelization option: must be integer between ${MIN_PARALLELIZATION} and ${MAX_PARALLELIZATION}`
    );
  }

  const keyLength = options.keyLength ?? DEFAULT_KEY_LENGTH;
  if (keyLength !== DEFAULT_KEY_LENGTH) {
    throw new Error(`Invalid scrypt keyLength option: must be ${DEFAULT_KEY_LENGTH}`);
  }

  const saltLength = options.saltLength ?? DEFAULT_SALT_LENGTH;
  if (saltLength !== DEFAULT_SALT_LENGTH) {
    throw new Error(`Invalid scrypt saltLength option: must be ${DEFAULT_SALT_LENGTH}`);
  }

  const salt = randomBytes(saltLength);

  const derivedKey = await deriveScrypt(plaintext, salt, keyLength, {
    N: cost,
    r: blockSize,
    p: parallelization,
    maxmem: MAX_SCRYPT_MEM,
  });

  return `scrypt$${cost}$${blockSize}$${parallelization}$${salt.toString('hex')}$${derivedKey.toString('hex')}`;
}

/**
 * Verify a password against an scrypt hash using timingSafeEqual.
 * Never throws on malformed hashes or inputs; strictly bounds work factors before calling scrypt.
 */
export async function verifyPassword(plaintext: string, storedHash: string): Promise<boolean> {
  if (typeof plaintext !== 'string' || typeof storedHash !== 'string') {
    return false;
  }

  const pwdByteLen = Buffer.byteLength(plaintext, 'utf8');
  if (pwdByteLen < 1 || pwdByteLen > MAX_PASSWORD_BYTES) {
    return false;
  }

  const parts = storedHash.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') {
    return false;
  }

  const [, costStr, blockSizeStr, parallelizationStr, saltHex, hashHex] = parts;

  if (
    !CANONICAL_INT_REGEX.test(costStr) ||
    !CANONICAL_INT_REGEX.test(blockSizeStr) ||
    !CANONICAL_INT_REGEX.test(parallelizationStr)
  ) {
    return false;
  }

  const cost = Number(costStr);
  const blockSize = Number(blockSizeStr);
  const parallelization = Number(parallelizationStr);

  if (
    !Number.isSafeInteger(cost) ||
    cost < MIN_COST ||
    cost > MAX_COST ||
    !isPowerOfTwo(cost)
  ) {
    return false;
  }

  if (
    !Number.isSafeInteger(blockSize) ||
    blockSize < MIN_BLOCK_SIZE ||
    blockSize > MAX_BLOCK_SIZE
  ) {
    return false;
  }

  if (
    !Number.isSafeInteger(parallelization) ||
    parallelization < MIN_PARALLELIZATION ||
    parallelization > MAX_PARALLELIZATION
  ) {
    return false;
  }

  if (!HEX_LOWER_32_REGEX.test(saltHex)) {
    return false;
  }

  const salt = Buffer.from(saltHex, 'hex');
  if (salt.length !== 16 || salt.toString('hex') !== saltHex) {
    return false;
  }

  if (!HEX_LOWER_128_REGEX.test(hashHex)) {
    return false;
  }

  const storedDerivedKey = Buffer.from(hashHex, 'hex');
  if (storedDerivedKey.length !== 64 || storedDerivedKey.toString('hex') !== hashHex) {
    return false;
  }

  try {
    const derivedKey = await deriveScrypt(plaintext, salt, storedDerivedKey.length, {
      N: cost,
      r: blockSize,
      p: parallelization,
      maxmem: MAX_SCRYPT_MEM,
    });

    if (derivedKey.length !== storedDerivedKey.length) {
      return false;
    }

    return timingSafeEqual(derivedKey, storedDerivedKey);
  } catch {
    return false;
  }
}
