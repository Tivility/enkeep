import { closeSync, constants, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, normalize, relative, resolve } from 'node:path'
import { randomBytes, scrypt } from 'node:crypto'

export interface ProvisionedUserPassword {
  readonly userId: string
  readonly username: string
  readonly tempPassword: string
  readonly passwordHash: string
  readonly generatedAt: string
}

/**
 * Generates an unguessable 24-character base64url temporary password with high entropy.
 */
export function generateSecureTempPassword(): string {
  return randomBytes(18).toString('base64url')
}

/**
 * Computes canonical scrypt password hash matching Enkeep platform-auth format:
 * `scrypt$cost$blockSize$parallelization$saltHex$derivedKeyHex`
 * Default: cost=16384, blockSize=8, parallelization=1, keyLength=64, saltLength=16.
 */
export function hashPasswordScrypt(
  plaintext: string,
  options: { cost?: number; blockSize?: number; parallelization?: number; saltLength?: number } = {}
): Promise<string> {
  const cost = options.cost ?? 16384
  const blockSize = options.blockSize ?? 8
  const parallelization = options.parallelization ?? 1
  const saltLength = options.saltLength ?? 16
  const keyLength = 64

  if (!plaintext || typeof plaintext !== 'string') {
    return Promise.reject(new Error('Password must be a non-empty string'))
  }

  const salt = randomBytes(saltLength)

  return new Promise((res, rej) => {
    scrypt(
      plaintext,
      salt,
      keyLength,
      { N: cost, r: blockSize, p: parallelization, maxmem: 512 * 1024 * 1024 },
      (err, derivedKey) => {
        if (err) {
          rej(err)
        } else {
          const hashStr = `scrypt$${cost}$${blockSize}$${parallelization}$${salt.toString('hex')}$${(derivedKey as Buffer).toString('hex')}`
          res(hashStr)
        }
      }
    )
  })
}

/**
 * Asserts that a file path is safe to store private credentials:
 * - Must NOT be located inside the git repository
 * - Must NOT be located inside any reports directory
 * - Must resolve to an absolute path
 */
export function assertSafeCredentialsPath(filePath: string, repoRoot?: string): string {
  const absPath = resolve(filePath)
  const normalized = normalize(absPath)

  // Detect common workspace / repo locations
  const forbiddenRoots = [
    resolve(process.cwd()),
    resolve(homedir(), '<workspace-root>'),
  ]

  if (repoRoot) {
    forbiddenRoots.push(resolve(repoRoot))
  }

  for (const root of forbiddenRoots) {
    const rel = relative(root, normalized)
    // If the path is inside this root and does not start with ..
    if (!rel.startsWith('..') && !isAbsolute(rel)) {
      // Allow only if explicitly inside a hidden user home config like ~/.config
      const homeConfig = resolve(homedir(), '.config')
      const relHome = relative(homeConfig, normalized)
      if (relHome.startsWith('..') || isAbsolute(relHome)) {
        throw new Error(
          `Security violation: password file "${normalized}" must be stored ONLY outside repo/reports (e.g. ~/.config/enkeep/migration/...)`
        )
      }
    }
  }

  // Refuse root or home dir directly as target file
  if (normalized === '/' || normalized === homedir()) {
    throw new Error(`Security violation: cannot store password file directly at root or home directory`)
  }

  // Refuse if path contains 'reports' folder
  const parts = normalized.split(/[\/\\]/)
  if (parts.includes('reports')) {
    throw new Error(`Security violation: password file "${normalized}" cannot be stored inside any reports directory`)
  }

  return normalized
}

/**
 * Returns the default private password store path:
 * `~/.config/enkeep/migration/passwords-<timestamp>.json`
 */
export function getDefaultPasswordFilePath(timestamp?: string | number): string {
  const ts = timestamp ?? Date.now()
  return resolve(homedir(), '.config', 'enkeep', 'migration', `passwords-${ts}.json`)
}

/**
 * Saves generated temporary passwords strictly into a private 0600 file outside repo/reports.
 * Directory is created with 0700 permissions.
 * File is created with O_CREAT | O_WRONLY | O_TRUNC and mode 0600.
 */
export function savePrivatePasswordsFile(
  passwords: Readonly<Record<string, ProvisionedUserPassword>>,
  targetPath?: string,
  repoRoot?: string
): string {
  const filePath = targetPath ? assertSafeCredentialsPath(targetPath, repoRoot) : getDefaultPasswordFilePath()
  assertSafeCredentialsPath(filePath, repoRoot)

  const dir = dirname(filePath)
  mkdirSync(dir, { recursive: true, mode: 0o700 })

  const jsonContent = JSON.stringify(
    {
      description: 'Enkeep multi-user migration initial temporary passwords. Keep this file private (0600).',
      mustChangePasswordForced: true,
      users: passwords,
      createdAt: new Date().toISOString(),
    },
    null,
    2
  )

  const fd = openSync(
    filePath,
    constants.O_CREAT | constants.O_WRONLY | constants.O_TRUNC,
    0o600
  )
  try {
    writeSync(fd, Buffer.from(jsonContent, 'utf8'))
  } finally {
    closeSync(fd)
  }

  return filePath
}
