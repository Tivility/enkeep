import { existsSync, readdirSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { SeedEvent } from './types.js'

export type SessionModule = {
  Session: {
    create(
      id: unknown,
      seed?: readonly unknown[],
      header?: unknown,
      inheritedEventCount?: unknown
    ): {
      snapshotEvents(fromSeq?: unknown, toSeqExclusive?: unknown): readonly unknown[]
      header: {
        version: number
        id: unknown
        createdAt: number
        isSeeded: boolean
        cwd?: string
        parentSession?: unknown
        origin?: 'subagent'
        delegationDepth?: number
        agentPreset?: string
      }
      inheritedEventCount: unknown
      firstLiveSeq: unknown
      seq: unknown
      append(type: string, data: unknown, options?: unknown): unknown
      deriveMessages(): readonly unknown[]
    }
    fromRestore?(
      id: unknown,
      seed: readonly unknown[],
      header: unknown,
      inheritedEventCount: unknown
    ): unknown
  }
  SessionId: (id: string) => unknown
  SessionSeq?: (value: number) => unknown
  SessionLogOffset?: (value: number) => unknown
  SESSION_FORMAT_VERSION: number
}

let loadedModule: SessionModule | undefined

/**
 * Dynamically resolves the @deepseek-ai/dsh-session library from node_modules
 * or parent workspace monorepo paths without hardcoded absolute machine paths.
 */
export function findSessionLib(startDir?: string): string {
  return findPackageLib('@deepseek-ai/dsh-session', 'lib/index.js', startDir)
}

export function findPackageLib(pkgName: string, subpath = 'lib/index.js', startDir?: string): string {
  const currentDir = startDir ?? dirname(fileURLToPath(import.meta.url))
  let dir = currentDir

  for (let i = 0; i < 10; i += 1) {
    const direct = join(dir, 'node_modules', pkgName, subpath)
    if (existsSync(direct)) {
      return direct
    }

    const pnpmDir = join(dir, 'node_modules', '.pnpm')
    if (existsSync(pnpmDir)) {
      const entries = readdirSync(pnpmDir)
      const pkgKey = pkgName.replace('/', '+')
      const matches = entries.filter((e) => e.includes(pkgKey) && !e.includes('0.1.1'))
      for (const match of matches) {
        const candidate = join(pnpmDir, match, 'node_modules', pkgName, subpath)
        if (existsSync(candidate)) {
          const candidateModules = join(pnpmDir, match, 'node_modules')
          let hasOld = false
          if (existsSync(candidateModules)) {
            const checkDir = (d: string) => {
              for (const n of readdirSync(d)) {
                const sub = join(d, n)
                if (n.startsWith('@')) {
                  checkDir(sub)
                } else if (existsSync(sub)) {
                  try {
                    const real = realpathSync(sub)
                    if (real.includes('0.1.1')) hasOld = true
                  } catch {
                    // ignore
                  }
                }
              }
            }
            checkDir(candidateModules)
          }
          if (!hasOld) return candidate
        }
      }
    }

    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }

  // Also try node module resolution if available
  try {
    const resolved = import.meta.resolve?.(pkgName)
    if (resolved) {
      return fileURLToPath(resolved)
    }
  } catch {
    // Ignore and fallback
  }

  throw new Error(`cannot locate ${pkgName} from ${currentDir}`)
}

export async function getSessionModule(): Promise<SessionModule> {
  if (loadedModule) return loadedModule
  const libPath = findSessionLib()
  const mod = (await import(pathToFileURL(libPath).href)) as SessionModule
  loadedModule = mod
  return loadedModule
}

/**
 * Validates the seed through the real @deepseek-ai/dsh-session Session.create constructor.
 * This runs the actual DSH invariant engine verifying JSON losslessness, envelope schemas,
 * contiguous seq numbering, turn/step nesting, message roles, sources, and surface ops.
 */
export async function assertLegalSeed(sessionId: string, seed: readonly SeedEvent[]): Promise<void> {
  const { Session, SessionId } = await getSessionModule()
  Session.create(SessionId(sessionId), seed)
}
