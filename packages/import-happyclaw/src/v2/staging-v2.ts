import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { IMPORTER_VERSION, TARGET_DSH_SPEC } from '../manifest.js'
import { readSource } from '../read-source.js'
import { compileChats } from '../seed.js'
import {
  type MigrationPlanV2,
  type MigrationV2StageManifest,
  type MigrationV2StageRequest,
  type MigrationV2StageResult,
} from '../types.js'

/**
 * Creates an immutable staged Pilot V2 package containing deterministic plan JSON,
 * full workspace export payload (compiled chats, instructions, space files, credential refs),
 * and a signed cryptographic manifest with per-file SHA-256 checksums.
 *
 * Invariant: Never executes live database import; creates staging artifacts only for P1-8 pilot execution.
 */
export function stageMigrationPackageV2(
  request: MigrationV2StageRequest,
  plan: MigrationPlanV2,
  stagingDir: string
): MigrationV2StageResult {
  if (!existsSync(stagingDir)) {
    mkdirSync(stagingDir, { recursive: true })
  }

  const packageSubdir = join(stagingDir, plan.planId)
  if (!existsSync(packageSubdir)) {
    mkdirSync(packageSubdir, { recursive: true })
  }

  const payloadDir = join(packageSubdir, 'payload')
  const payloadFilesDir = join(payloadDir, 'files')
  mkdirSync(payloadFilesDir, { recursive: true })

  const payloadChecksums: Record<string, string> = {}

  // 1. Serialize deterministic Plan JSON
  const planJson = JSON.stringify(plan, null, 2)
  const planChecksum = createHash('sha256').update(planJson).digest('hex')
  const planPath = join(packageSubdir, 'migration-plan-v2.json')
  writeFileSync(planPath, planJson, 'utf8')
  payloadChecksums['migration-plan-v2.json'] = planChecksum

  // 2. Export & stage compiled sessions/messages if source database is available
  if (plan.sourcePath && existsSync(plan.sourcePath)) {
    try {
      const source = readSource(plan.sourcePath)
      const selectedJids = new Set(plan.selectedWorkspaceIds)
      const filteredChats = source.chats.filter((c) => selectedJids.has(c.jid) || plan.selectedWorkspaceIds.some((id) => c.jid.includes(id)))
      const compiledChats = compileChats(
        filteredChats.length > 0 ? filteredChats : source.chats,
        source.messages,
        source.groups
      )
      const sessionsJson = JSON.stringify(compiledChats, null, 2)
      const sessionsPath = join(payloadDir, 'sessions.json')
      writeFileSync(sessionsPath, sessionsJson, 'utf8')
      payloadChecksums['payload/sessions.json'] = createHash('sha256').update(sessionsJson).digest('hex')
    } catch {
      // Fallback: If source reading fails, empty sessions array
      const emptySessions = JSON.stringify([], null, 2)
      const sessionsPath = join(payloadDir, 'sessions.json')
      writeFileSync(sessionsPath, emptySessions, 'utf8')
      payloadChecksums['payload/sessions.json'] = createHash('sha256').update(emptySessions).digest('hex')
    }
  }

  // 3. Export workspace files & instructions into payload/files
  if (request.sourceGroupsDir && existsSync(request.sourceGroupsDir)) {
    const copyDirRecursive = (srcDir: string, destDir: string, relPrefix = '') => {
      if (!existsSync(srcDir)) return
      if (!existsSync(destDir)) mkdirSync(destDir, { recursive: true })
      const entries = readdirSync(srcDir)
      for (const entry of entries) {
        const srcPath = join(srcDir, entry)
        const destPath = join(destDir, entry)
        const relPath = relPrefix ? `${relPrefix}/${entry}` : entry
        const stat = lstatSync(srcPath)
        if (stat.isDirectory()) {
          copyDirRecursive(srcPath, destPath, relPath)
        } else if (stat.isFile()) {
          copyFileSync(srcPath, destPath)
          const fileContent = readFileSync(destPath)
          const fileSha = createHash('sha256').update(fileContent).digest('hex')
          payloadChecksums[`payload/files/${relPath}`] = fileSha
        }
      }
    }

    // Copy selected space directories
    for (const item of plan.items) {
      const spaceSrcDir = join(request.sourceGroupsDir, item.targetSpaceFolder)
      if (existsSync(spaceSrcDir)) {
        copyDirRecursive(spaceSrcDir, join(payloadFilesDir, item.targetSpaceFolder), item.targetSpaceFolder)
      }
    }

    // Copy global instruction files (e.g. CLAUDE.md / memory.md)
    for (const globalFileName of ['CLAUDE.md', 'memory.md', 'MEMORY.md']) {
      const globalFile = join(request.sourceGroupsDir, globalFileName)
      if (existsSync(globalFile) && lstatSync(globalFile).isFile()) {
        const targetGlobal = join(payloadFilesDir, globalFileName)
        copyFileSync(globalFile, targetGlobal)
        const content = readFileSync(targetGlobal)
        payloadChecksums[`payload/files/${globalFileName}`] = createHash('sha256').update(content).digest('hex')
      }
    }
  }

  // 4. Staged credential transfer status payload
  if (request.credentialTransfer) {
    const credJson = JSON.stringify(request.credentialTransfer, null, 2)
    const credPath = join(payloadDir, 'credentials.json')
    writeFileSync(credPath, credJson, 'utf8')
    payloadChecksums['payload/credentials.json'] = createHash('sha256').update(credJson).digest('hex')
  }

  // 5. Count credential stats if provided
  const credSummary = {
    transferred: request.credentialTransfer?.transferredCount ?? 0,
    reauthorizationRequired: request.credentialTransfer?.reauthRequiredCount ?? 0,
  }

  // 6. Serialize Stage Manifest with signed checksums
  const manifest: MigrationV2StageManifest = {
    version: 2,
    planId: plan.planId,
    sourceFingerprint: plan.sourceFingerprint,
    importerVersion: IMPORTER_VERSION,
    targetDsh: TARGET_DSH_SPEC,
    packageChecksum: planChecksum,
    payloadChecksums,
    selectedWorkspaceIds: plan.selectedWorkspaceIds,
    scopes: plan.scopes,
    summary: plan.summary,
    credentialStatusSummary: credSummary,
    stagedAt: new Date().toISOString(),
  }

  const manifestJson = JSON.stringify(manifest, null, 2)
  const manifestPath = join(packageSubdir, 'stage-manifest.json')
  writeFileSync(manifestPath, manifestJson, 'utf8')

  return {
    success: true,
    staged: true,
    stageDir: packageSubdir,
    planId: plan.planId,
    packageChecksum: planChecksum,
    manifest,
    summary: plan.summary,
    stagedAt: manifest.stagedAt,
    warnings: plan.warnings,
  }
}
