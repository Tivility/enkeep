import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  ForbiddenError,
  NotFoundError,
  PlatformError,
  type User,
  ValidationError,
} from '@enkeep/platform-core'
import { createSuccessEnvelope } from '@enkeep/protocol'
import { API_CACHE_CONTROL_HEADERS, validateCsrf } from '../safety/limits.js'
import type { HappyClawMigrationService } from './happyclaw-migration-service.js'

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function sendJsonResponse(
  res: ServerResponse,
  statusCode: number,
  data: unknown,
  extraHeaders?: Record<string, string>
): void {
  const json = JSON.stringify(data)
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(json, 'utf8'),
    ...API_CACHE_CONTROL_HEADERS,
    ...extraHeaders,
  })
  res.end(json)
}

export async function readJsonBody(req: IncomingMessage, maxBytes: number = 1048576): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = ''
    let received = 0

    req.on('data', (chunk: Buffer) => {
      received += chunk.length
      if (received > maxBytes) {
        reject(new PlatformError('Payload Too Large', 'PAYLOAD_TOO_LARGE', 413))
        return
      }
      body += chunk.toString('utf8')
    })

    req.on('end', () => {
      if (body.trim() === '') {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(body))
      } catch {
        reject(new ValidationError('Invalid JSON request body'))
      }
    })

    req.on('error', (err) => {
      reject(err)
    })
  })
}

export class HappyClawMigrationRoutes {
  private readonly migrationService: HappyClawMigrationService
  private readonly expectedCsrfToken: string

  constructor(migrationService: HappyClawMigrationService, expectedCsrfToken: string = '') {
    this.migrationService = migrationService
    this.expectedCsrfToken = expectedCsrfToken
  }

  public async handle(
    req: IncomingMessage,
    res: ServerResponse,
    pathname: string,
    currentUser: User
  ): Promise<boolean> {
    const method = req.method?.toUpperCase()

    // 1. GET /api/admin/imports/staged
    if (pathname === '/api/admin/imports/staged') {
      if (method !== 'GET') {
        throw new PlatformError('Method Not Allowed', 'METHOD_NOT_ALLOWED', 405)
      }
      const items = await this.migrationService.listStaged(currentUser)
      sendJsonResponse(res, 200, createSuccessEnvelope(items))
      return true
    }

    // 2. POST /api/admin/imports/staged/upload
    if (pathname === '/api/admin/imports/staged/upload') {
      if (method !== 'POST') {
        throw new PlatformError('Method Not Allowed', 'METHOD_NOT_ALLOWED', 405)
      }
      validateCsrf(req, { csrfToken: this.expectedCsrfToken })
      const filenameHeader = req.headers['x-filename'] || req.headers['x-file-name']
      const filenameOverride = typeof filenameHeader === 'string' ? filenameHeader : undefined
      const uploaded = await this.migrationService.uploadStaged(currentUser, req, filenameOverride)
      sendJsonResponse(res, 200, createSuccessEnvelope(uploaded))
      return true
    }

    // 3. GET /api/admin/imports/staged/jobs/:jobId
    const jobStatusMatch = pathname.match(
      /^\/api\/admin\/imports\/staged\/jobs\/([a-zA-Z0-9_-]+)$/
    )
    if (jobStatusMatch) {
      if (method !== 'GET') {
        throw new PlatformError('Method Not Allowed', 'METHOD_NOT_ALLOWED', 405)
      }
      if (currentUser.role !== 'admin') {
        throw new ForbiddenError('Administrative access required')
      }
      const jobId = jobStatusMatch[1]!
      const status = this.migrationService.getJobStatus(jobId)
      if (!status) {
        throw new NotFoundError(`Migration job "${jobId}" not found`)
      }
      sendJsonResponse(res, 200, createSuccessEnvelope(status))
      return true
    }

    // 4. POST /api/admin/imports/staged/jobs/:jobId/cancel
    const jobCancelMatch = pathname.match(
      /^\/api\/admin\/imports\/staged\/jobs\/([a-zA-Z0-9_-]+)\/cancel$/
    )
    if (jobCancelMatch) {
      if (method !== 'POST') {
        throw new PlatformError('Method Not Allowed', 'METHOD_NOT_ALLOWED', 405)
      }
      validateCsrf(req, { csrfToken: this.expectedCsrfToken })
      if (currentUser.role !== 'admin') {
        throw new ForbiddenError('Administrative access required')
      }
      const jobId = jobCancelMatch[1]!
      const cancelled = this.migrationService.cancelJob(jobId)
      if (!cancelled) {
        throw new NotFoundError(`Migration job "${jobId}" not found or cannot be cancelled`)
      }
      sendJsonResponse(res, 200, createSuccessEnvelope({ cancelled: true, jobId }))
      return true
    }

    // 5. POST /api/admin/imports/staged/jobs/:jobId/resume
    const jobResumeMatch = pathname.match(
      /^\/api\/admin\/imports\/staged\/jobs\/([a-zA-Z0-9_-]+)\/resume$/
    )
    if (jobResumeMatch) {
      if (method !== 'POST') {
        throw new PlatformError('Method Not Allowed', 'METHOD_NOT_ALLOWED', 405)
      }
      validateCsrf(req, { csrfToken: this.expectedCsrfToken })
      if (currentUser.role !== 'admin') {
        throw new ForbiddenError('Administrative access required')
      }
      const jobId = jobResumeMatch[1]!
      const resumedStatus = await this.migrationService.resumeJob(currentUser, jobId)
      sendJsonResponse(res, 200, createSuccessEnvelope(resumedStatus))
      return true
    }

    // 6. POST /api/admin/imports/staged/:id/inspect
    const stagedInspectMatch = pathname.match(
      /^\/api\/admin\/imports\/staged\/([a-zA-Z0-9_-]+)\/inspect$/
    )
    if (stagedInspectMatch) {
      if (method !== 'POST') {
        throw new PlatformError('Method Not Allowed', 'METHOD_NOT_ALLOWED', 405)
      }
      validateCsrf(req, { csrfToken: this.expectedCsrfToken })
      const stagedId = stagedInspectMatch[1]!
      const body = await readJsonBody(req)
      const options: { limit?: number; offset?: number; search?: string } = {}
      if (isRecord(body)) {
        if (typeof body.limit === 'number') options.limit = body.limit
        if (typeof body.offset === 'number') options.offset = body.offset
        if (typeof body.search === 'string') options.search = body.search
      }
      const result = await this.migrationService.inspectStaged(currentUser, stagedId, options)
      sendJsonResponse(res, 200, createSuccessEnvelope(result))
      return true
    }

    // 7. POST /api/admin/imports/staged/:id/migrate
    const stagedMigrateMatch = pathname.match(
      /^\/api\/admin\/imports\/staged\/([a-zA-Z0-9_-]+)\/migrate$/
    )
    if (stagedMigrateMatch) {
      if (method !== 'POST') {
        throw new PlatformError('Method Not Allowed', 'METHOD_NOT_ALLOWED', 405)
      }
      validateCsrf(req, { csrfToken: this.expectedCsrfToken })
      const stagedId = stagedMigrateMatch[1]!
      const body = await readJsonBody(req)
      if (!isRecord(body)) {
        throw new ValidationError('Request body must be a JSON object')
      }

      const idempHeader = req.headers['idempotency-key'] || req.headers['x-idempotency-key']
      const idempotencyKey =
        typeof idempHeader === 'string'
          ? idempHeader
          : typeof body.idempotencyKey === 'string'
          ? body.idempotencyKey
          : undefined

      const conversationIds = Array.isArray(body.conversationIds)
        ? (body.conversationIds.filter((c) => typeof c === 'string') as string[])
        : undefined
      const conversations = Array.isArray(body.conversations)
        ? (body.conversations.filter((c) => typeof c === 'string') as string[])
        : undefined

      const result = await this.migrationService.migrateStaged(currentUser, stagedId, {
        targetUserId:
          typeof body.targetUserId === 'string'
            ? body.targetUserId
            : typeof body.userId === 'string'
            ? body.userId
            : undefined,
        conversationIds,
        conversations,
        all: typeof body.all === 'boolean' ? body.all : undefined,
        dryRun: typeof body.dryRun === 'boolean' ? body.dryRun : undefined,
        titleOverride: typeof body.titleOverride === 'string' ? body.titleOverride : undefined,
        targetSpace: typeof body.targetSpace === 'string' ? body.targetSpace : undefined,
        idempotencyKey,
      })

      sendJsonResponse(res, 200, createSuccessEnvelope(result))
      return true
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Migration V2 Endpoints (Canonical /api/manage/migrations/happyclaw[-v2] & Staged V2)
    // ─────────────────────────────────────────────────────────────────────────

    // 8. POST /api/manage/migrations/happyclaw/inspect or /happyclaw-v2/inspect or /api/admin/imports/staged/:id/v2/inspect
    const v2InspectMatch =
      pathname === '/api/manage/migrations/happyclaw/inspect' ||
      pathname === '/api/manage/migrations/happyclaw-v2/inspect' ||
      pathname.match(/^\/api\/admin\/imports\/staged\/([a-zA-Z0-9_-]+)\/v2\/inspect$/)

    if (v2InspectMatch) {
      if (method !== 'POST') {
        throw new PlatformError('Method Not Allowed', 'METHOD_NOT_ALLOWED', 405)
      }
      validateCsrf(req, { csrfToken: this.expectedCsrfToken })
      const body = await readJsonBody(req)
      const bodyObj = isRecord(body) ? body : {}
      const stagedId = Array.isArray(v2InspectMatch) ? v2InspectMatch[1] : typeof bodyObj.stagedId === 'string' ? bodyObj.stagedId : undefined
      const sourcePath = typeof bodyObj.sourcePath === 'string' ? bodyObj.sourcePath : undefined
      const groupsDir = typeof bodyObj.groupsDir === 'string' ? bodyObj.groupsDir : undefined

      const result = await this.migrationService.inspectV2(currentUser, { stagedId, sourcePath, groupsDir })
      sendJsonResponse(res, 200, createSuccessEnvelope(result))
      return true
    }

    // 9. POST /api/manage/migrations/happyclaw/dry-run or /happyclaw-v2/dry-run or /api/admin/imports/staged/:id/v2/dry-run
    const v2DryRunMatch =
      pathname === '/api/manage/migrations/happyclaw/dry-run' ||
      pathname === '/api/manage/migrations/happyclaw-v2/dry-run' ||
      pathname.match(/^\/api\/admin\/imports\/staged\/([a-zA-Z0-9_-]+)\/v2\/dry-run$/)

    if (v2DryRunMatch) {
      if (method !== 'POST') {
        throw new PlatformError('Method Not Allowed', 'METHOD_NOT_ALLOWED', 405)
      }
      validateCsrf(req, { csrfToken: this.expectedCsrfToken })
      const body = await readJsonBody(req)
      if (!isRecord(body)) {
        throw new ValidationError('Request body must be a JSON object')
      }

      const stagedId = Array.isArray(v2DryRunMatch) ? v2DryRunMatch[1] : typeof body.stagedId === 'string' ? body.stagedId : undefined
      const selectedWorkspaceIds = Array.isArray(body.selectedWorkspaceIds)
        ? (body.selectedWorkspaceIds.filter((w) => typeof w === 'string') as string[])
        : []

      const result = await this.migrationService.dryRunV2(currentUser, {
        stagedId,
        sourcePath: typeof body.sourcePath === 'string' ? body.sourcePath : undefined,
        sourceGroupsDir: typeof body.sourceGroupsDir === 'string' ? body.sourceGroupsDir : typeof body.groupsDir === 'string' ? body.groupsDir : undefined,
        targetUserId: typeof body.targetUserId === 'string' ? body.targetUserId : typeof body.userId === 'string' ? body.userId : undefined,
        selectedWorkspaceIds,
        scopes: isRecord(body.scopes) ? (body.scopes as any) : undefined,
        titleOverride: typeof body.titleOverride === 'string' ? body.titleOverride : undefined,
        targetSpace: typeof body.targetSpace === 'string' ? body.targetSpace : undefined,
      })

      sendJsonResponse(res, 200, createSuccessEnvelope(result))
      return true
    }

    // 10. POST /api/manage/migrations/happyclaw/authorize-credentials or /happyclaw-v2/authorize-credentials or /api/admin/imports/staged/:id/v2/authorize-credentials
    const v2AuthCredMatch =
      pathname === '/api/manage/migrations/happyclaw/authorize-credentials' ||
      pathname === '/api/manage/migrations/happyclaw-v2/authorize-credentials' ||
      pathname.match(/^\/api\/admin\/imports\/staged\/([a-zA-Z0-9_-]+)\/v2\/authorize-credentials$/)

    if (v2AuthCredMatch) {
      if (method !== 'POST') {
        throw new PlatformError('Method Not Allowed', 'METHOD_NOT_ALLOWED', 405)
      }
      validateCsrf(req, { csrfToken: this.expectedCsrfToken })
      const body = await readJsonBody(req)
      if (!isRecord(body)) {
        throw new ValidationError('Request body must be a JSON object')
      }

      if (!isRecord(body.capability)) {
        throw new ValidationError('Field "capability" is required and must be an object')
      }

      const stagedId = Array.isArray(v2AuthCredMatch) ? v2AuthCredMatch[1] : typeof body.stagedId === 'string' ? body.stagedId : undefined

      const result = await this.migrationService.authorizeCredentialsV2(currentUser, {
        capability: body.capability as any,
        stagedId,
        sourcePath: typeof body.sourcePath === 'string' ? body.sourcePath : undefined,
        targetUserId: typeof body.targetUserId === 'string' ? body.targetUserId : undefined,
        connectivityValidation: Boolean(body.connectivityValidation),
      })

      sendJsonResponse(res, 200, createSuccessEnvelope(result))
      return true
    }

    // 11. POST /api/manage/migrations/happyclaw/stage or /happyclaw-v2/stage or /api/admin/imports/staged/:id/v2/stage
    const v2StageMatch =
      pathname === '/api/manage/migrations/happyclaw/stage' ||
      pathname === '/api/manage/migrations/happyclaw-v2/stage' ||
      pathname.match(/^\/api\/admin\/imports\/staged\/([a-zA-Z0-9_-]+)\/v2\/stage$/)

    if (v2StageMatch) {
      if (method !== 'POST') {
        throw new PlatformError('Method Not Allowed', 'METHOD_NOT_ALLOWED', 405)
      }
      validateCsrf(req, { csrfToken: this.expectedCsrfToken })
      const body = await readJsonBody(req)
      if (!isRecord(body)) {
        throw new ValidationError('Request body must be a JSON object')
      }

      const stagedId = Array.isArray(v2StageMatch) ? v2StageMatch[1] : typeof body.stagedId === 'string' ? body.stagedId : undefined
      const selectedWorkspaceIds = Array.isArray(body.selectedWorkspaceIds)
        ? (body.selectedWorkspaceIds.filter((w) => typeof w === 'string') as string[])
        : []

      const result = await this.migrationService.stageV2(currentUser, {
        stagedId,
        sourcePath: typeof body.sourcePath === 'string' ? body.sourcePath : undefined,
        sourceGroupsDir: typeof body.sourceGroupsDir === 'string' ? body.sourceGroupsDir : typeof body.groupsDir === 'string' ? body.groupsDir : undefined,
        targetUserId: typeof body.targetUserId === 'string' ? body.targetUserId : typeof body.userId === 'string' ? body.userId : undefined,
        selectedWorkspaceIds,
        scopes: isRecord(body.scopes) ? (body.scopes as any) : undefined,
        credentialTransfer: isRecord(body.credentialTransfer) ? (body.credentialTransfer as any) : undefined,
      })

      sendJsonResponse(res, 200, createSuccessEnvelope(result))
      return true
    }

    // 12. POST /api/manage/migrations/happyclaw/execute-pilot or /happyclaw-v2/execute-pilot or /api/admin/imports/staged/:id/v2/execute-pilot
    const v2ExecutePilotMatch =
      pathname === '/api/manage/migrations/happyclaw/execute-pilot' ||
      pathname === '/api/manage/migrations/happyclaw-v2/execute-pilot' ||
      pathname.match(/^\/api\/admin\/imports\/staged\/([a-zA-Z0-9_-]+)\/v2\/execute-pilot$/)

    if (v2ExecutePilotMatch) {
      if (method !== 'POST') {
        throw new PlatformError('Method Not Allowed', 'METHOD_NOT_ALLOWED', 405)
      }
      validateCsrf(req, { csrfToken: this.expectedCsrfToken })
      const body = await readJsonBody(req)
      if (!isRecord(body)) {
        throw new ValidationError('Request body must be a JSON object')
      }

      const planId = typeof body.planId === 'string'
        ? body.planId
        : Array.isArray(v2ExecutePilotMatch)
        ? v2ExecutePilotMatch[1]
        : undefined

      if (!planId || typeof planId !== 'string' || planId.trim().length === 0) {
        throw new ValidationError('Field "planId" is required')
      }

      const idempotencyKey = typeof req.headers['idempotency-key'] === 'string'
        ? req.headers['idempotency-key']
        : typeof body.idempotencyKey === 'string'
        ? body.idempotencyKey
        : undefined

      const result = await this.migrationService.executePilotV2(currentUser, {
        planId,
        targetUserId: typeof body.targetUserId === 'string' ? body.targetUserId : undefined,
        idempotencyKey,
      })

      sendJsonResponse(res, 200, createSuccessEnvelope(result))
      return true
    }

    // 13. DELETE /api/manage/migrations/happyclaw/pilot/:planId or /happyclaw-v2/pilot/:planId or /api/admin/imports/staged/:planId/v2/pilot
    const v2DeletePilotMatch =
      pathname.match(/^\/api\/manage\/migrations\/happyclaw\/pilot\/([a-zA-Z0-9_-]+)$/) ||
      pathname.match(/^\/api\/manage\/migrations\/happyclaw-v2\/pilot\/([a-zA-Z0-9_-]+)$/) ||
      pathname.match(/^\/api\/admin\/imports\/staged\/([a-zA-Z0-9_-]+)\/v2\/pilot$/)

    if (v2DeletePilotMatch) {
      if (method !== 'DELETE') {
        throw new PlatformError('Method Not Allowed', 'METHOD_NOT_ALLOWED', 405)
      }
      validateCsrf(req, { csrfToken: this.expectedCsrfToken })

      const planId = v2DeletePilotMatch[1]
      if (!planId) {
        throw new ValidationError('Plan ID is required in URL')
      }

      const result = await this.migrationService.deletePilotV2(currentUser, planId)
      sendJsonResponse(res, 200, createSuccessEnvelope(result))
      return true
    }

    return false
  }
}
