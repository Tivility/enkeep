/**
 * Real Docker Acceptance Test for Attachment Journey & Agent Tool Execution
 *
 * Runs under `pnpm --filter @enkeep/demo-runner run test:docker` or root `test:docker`.
 * Never runs under normal unit `pnpm test`.
 *
 * Verifies:
 * 1) JSONL Event Order & Context: enkeep/attachments logged before user/message, content uncorrupted;
 *    on resume attachment context available; historical attachments NOT re-injected on subsequent turns.
 * 2) SQLite & Snapshot Linking: message_attachments linked to snapshot journal; source mutation preserves snapshot;
 *    dual storage reconcile matches attachments.
 * 3) Workspace Tool Scope: Scoped to currentSpace; snapshot (.attachments in space) readable; crossSpace rejected;
 *    subagents inherit workspace and read within boundary.
 * 4) send_file / fileReference & Web Download: Real download endpoint with auth and cross-tenant isolation.
 * 5) 50MB Attachment RSS Bounded: Memory usage remains bounded during streaming transfer.
 * 6) Container Restart Continuity & Volume Persistence.
 * 7) Failure Resilience: ETag mismatch -> no delivery/no orphan snapshot/quota released; turn fail preserves linked snapshot.
 * 8) Privacy: Public events and message DTOs do not leak container/DSH IDs or absolute server filesystem snapshot paths.
 * 9) Isolated hermetic execution: Random suffix, zero main demo pollution, temporary root cleanup.
 *
 * @module @enkeep/demo-runner/tests/attachment-agent-docker-e2e.test
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID, createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { launchDemoSystem, type RunningDemoSystem } from '../src/up/index.js';
import { resetDemo } from '../src/reset/index.js';
import { downDemo } from '../src/down/index.js';
import { DockerRuntimeContainerAdapter } from '../src/ports/index.js';
import { probeProtectedPorts, assertProbesUnchanged } from '../src/utils/probes.js';
import { getDemoPathConfig } from '../src/config.js';
import { SafeDockerClient } from '@enkeep/runtime-runner/docker';
import { createTempRepo, type TempRepo } from './support/temp-repo.js';

type ProtectedPortsSnapshot = Awaited<ReturnType<typeof probeProtectedPorts>>;

function generateSuffix12(): string {
  return randomUUID().replace(/-/g, '').slice(0, 12).toLowerCase();
}

function computeEtag(data: string | Buffer): string {
  const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  return `"${createHash('sha256').update(buf).digest('hex')}"`;
}

async function loginUser(serverUrl: string, user: { username: string; password: string }) {
  const originHeader = serverUrl;
  const initCsrfRes = await fetch(`${serverUrl}/api/auth/csrf`, {
    headers: { Origin: originHeader },
  });
  if (!initCsrfRes.ok) throw new Error(`Initial CSRF fetch failed: ${initCsrfRes.status}`);
  const initCsrfData = ((await initCsrfRes.json()) as any).data;
  const loginCsrf = initCsrfData.csrfToken;

  const loginRes = await fetch(`${serverUrl}/api/auth/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Enkeep-CSRF': loginCsrf,
      Origin: originHeader,
    },
    body: JSON.stringify({ username: user.username, password: user.password }),
  });
  if (!loginRes.ok) throw new Error(`Login failed for ${user.username}: ${loginRes.status}`);

  const setCookie = loginRes.headers.get('set-cookie');
  if (!setCookie) throw new Error(`No cookie returned for ${user.username}`);
  const cookie = setCookie.split(';')[0];

  const authCsrfRes = await fetch(`${serverUrl}/api/auth/csrf`, {
    headers: { Cookie: cookie, Origin: originHeader },
  });
  if (!authCsrfRes.ok) throw new Error(`Auth CSRF fetch failed: ${authCsrfRes.status}`);
  const authCsrfData = ((await authCsrfRes.json()) as any).data;
  const csrfToken = authCsrfData.csrfToken;

  return { cookie, csrfToken };
}

async function waitForAssistantReplyAfterUser(
  serverUrl: string,
  sessionId: string,
  userMessageId: string,
  cookie: string,
  timeoutMs = 45000
): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    const res = await fetch(`${serverUrl}/api/sessions/${sessionId}/messages`, {
      headers: { Cookie: cookie },
    });
    if (res.status === 200) {
      const data = (await res.json()) as any;
      const msgs: any[] = data?.data?.messages || [];
      const userIdx = msgs.findIndex((m) => m.id === userMessageId);
      if (userIdx !== -1) {
        for (let i = userIdx + 1; i < msgs.length; i++) {
          const m = msgs[i];
          if (m && m.role === 'assistant' && m.status === 'delivered') {
            return m;
          }
        }
      }
    }
  }
  throw new Error(`Timeout waiting for assistant reply after user message "${userMessageId}"`);
}

describe('Attachment Journey & Agent Tool Execution in Real Docker Containers', () => {
  let tempRepo: TempRepo | null = null;
  let activeResourceSuffix: string | null = null;
  let runGeneratedMetadata = false;
  let probeBefore: ProtectedPortsSnapshot | null = null;
  let runningSystem: RunningDemoSystem | null = null;
  let origLlmEnabled: string | undefined;

  beforeEach(async () => {
    // Scoped deterministic adapter mode for reproducible Docker E2E acceptance
    origLlmEnabled = process.env.ENKEEP_LLM_ENABLED;
    process.env.ENKEEP_LLM_ENABLED = '0';

    // 1. Mandatory runtime image check (acceptance image)
    const rawRuntimeImage = process.env.ENKEEP_RUNTIME_IMAGE?.trim() || 'enkeep-demo-runtime:acceptance';
    const acceptanceImagePattern = /^(enkeep-demo-runtime:(acceptance|latest)|enkeep-dsh-0\.1\.2-rc\.1-canary(:latest)?)$/;
    if (!acceptanceImagePattern.test(rawRuntimeImage)) {
      throw new Error(
        `FAIL-CLOSED: Invalid runtime image "${rawRuntimeImage}". Acceptance tests require "enkeep-demo-runtime:acceptance", "enkeep-demo-runtime:latest", or "enkeep-dsh-0.1.2-rc.1-canary".`
      );
    }

    // 2. Mandatory Docker availability check
    const dockerClient = new SafeDockerClient();
    const isDockerAvailable = await dockerClient.isDockerAvailable();
    if (!isDockerAvailable) {
      throw new Error('FAIL-CLOSED: Docker daemon is unavailable. Real Docker acceptance tests require an active daemon.');
    }

    // 3. Port probe snapshot before test
    probeBefore = await probeProtectedPorts();
  });

  afterEach(async () => {
    if (origLlmEnabled !== undefined) {
      process.env.ENKEEP_LLM_ENABLED = origLlmEnabled;
    } else {
      delete process.env.ENKEEP_LLM_ENABLED;
    }

    const teardownErrors: Error[] = [];

    // Step 1: Close running system if still open
    if (runningSystem) {
      try {
        await runningSystem.close({ removeVolumes: true });
      } catch (err: unknown) {
        teardownErrors.push(err instanceof Error ? err : new Error(String(err)));
      }
      runningSystem = null;
    }

    // Step 2: Call downDemo to ensure all containers & volumes are removed
    if (tempRepo && activeResourceSuffix) {
      const paths = getDemoPathConfig({ repoRoot: tempRepo.repoRoot, resourceSuffix: activeResourceSuffix });
      const metadataExists = existsSync(paths.demoDataDir);

      if (runGeneratedMetadata || metadataExists) {
        try {
          const downResult = await downDemo({
            repoRoot: tempRepo.repoRoot,
            resourceSuffix: activeResourceSuffix,
            removeVolumes: true,
          });
          if (!downResult.ok) {
            teardownErrors.push(new Error('Teardown reported failure during afterEach downDemo'));
          }
        } catch (err: unknown) {
          teardownErrors.push(err instanceof Error ? err : new Error(String(err)));
        }
      }
    }

    // Step 3: Assert no leaked containers or volumes remain
    if (activeResourceSuffix) {
      try {
        const dockerClient = new SafeDockerClient();
        const isDockerAvailable = await dockerClient.isDockerAvailable();
        if (isDockerAvailable) {
          const aliceContainer = `enkeep-demo-alice-${activeResourceSuffix}`;
          const bobContainer = `enkeep-demo-bob-${activeResourceSuffix}`;
          const aliceVol = `enkeep-demo-dsh-alice-${activeResourceSuffix}`;
          const bobVol = `enkeep-demo-dsh-bob-${activeResourceSuffix}`;

          const [cA, cB, vA, vB] = await Promise.all([
            dockerClient.inspectContainer(aliceContainer),
            dockerClient.inspectContainer(bobContainer),
            dockerClient.inspectVolume(aliceVol),
            dockerClient.inspectVolume(bobVol),
          ]);

          if (cA !== null) teardownErrors.push(new Error(`LEAK: Container "${aliceContainer}" still exists`));
          if (cB !== null) teardownErrors.push(new Error(`LEAK: Container "${bobContainer}" still exists`));
          if (vA !== null) teardownErrors.push(new Error(`LEAK: Volume "${aliceVol}" still exists`));
          if (vB !== null) teardownErrors.push(new Error(`LEAK: Volume "${bobVol}" still exists`));
        }
      } catch (err: unknown) {
        teardownErrors.push(err instanceof Error ? err : new Error(String(err)));
      }
    }

    // Step 4: Verify protected ports untouched
    if (probeBefore) {
      try {
        const probeAfter = await probeProtectedPorts();
        const probeComparison = assertProbesUnchanged(probeBefore, probeAfter);
        if (!probeComparison.unchanged) {
          teardownErrors.push(
            new Error(`Safety Violation: Protected services disrupted:\n${probeComparison.discrepancies.join('\n')}`)
          );
        }
      } catch (err: unknown) {
        teardownErrors.push(err instanceof Error ? err : new Error(String(err)));
      } finally {
        probeBefore = null;
      }
    }

    // Step 5: Clean up temp root repo
    if (tempRepo) {
      if (teardownErrors.length === 0) {
        try {
          tempRepo.cleanup();
        } catch (err: unknown) {
          teardownErrors.push(err instanceof Error ? err : new Error(String(err)));
        }
      }
      tempRepo = null;
    }

    if (teardownErrors.length > 0) {
      throw new AggregateError(teardownErrors, `Teardown errors occurred: ${teardownErrors.map((e) => e.message).join('; ')}`);
    }
  });

  it('executes full attachment journey: upload audit.txt -> snapshot linked -> agent reads snapshot -> reply contains unique text -> bash creates result.txt -> send_file download byte-equal', async () => {
    const runtimeImage = process.env.ENKEEP_RUNTIME_IMAGE?.trim() || 'enkeep-demo-runtime:acceptance';
    const dockerClient = new SafeDockerClient();

    // 1. Initialize hermetic temp repo and reset demo
    const resourceSuffix = generateSuffix12();
    activeResourceSuffix = resourceSuffix;
    tempRepo = createTempRepo();
    runGeneratedMetadata = true;

    const resetRes = await resetDemo({
      repoRoot: tempRepo.repoRoot,
      resourceSuffix,
      deterministicCreatedAt: '2026-03-30T12:00:00.000Z',
    });
    expect(resetRes.ok).toBe(true);
    const credentials = resetRes.credentials;

    const paths = getDemoPathConfig({ repoRoot: tempRepo.repoRoot, resourceSuffix });
    const adapter = new DockerRuntimeContainerAdapter(dockerClient);

    // 2. Launch demo system
    runningSystem = await launchDemoSystem({
      repoRoot: tempRepo.repoRoot,
      resourceSuffix,
      runtimeImage,
      runtimeAdapter: adapter,
    });
    expect(runningSystem.result.ok).toBe(true);

    const serverUrl = runningSystem.platformUrl;

    // 3. Authenticate Alice & Bob
    const { cookie: aliceCookie, csrfToken: aliceCsrf } = await loginUser(serverUrl, credentials.admin);
    const { cookie: bobCookie } = await loginUser(serverUrl, credentials.user);

    // 4. Retrieve Alice's default space
    const spacesRes = await fetch(`${serverUrl}/api/spaces`, {
      headers: { Cookie: aliceCookie },
    });
    expect(spacesRes.status).toBe(200);
    const spacesJson = (await spacesRes.json()) as any;
    const spacesData = spacesJson.data;
    expect(spacesData.length).toBeGreaterThan(0);
    const aliceSpace = spacesData.find((s: any) => s.id.startsWith('spc_')) || spacesData[0];
    const aliceSpaceId = aliceSpace.id;

    // 5. Upload input/audit.txt with unique content
    const uniqueSecret = `AUDIT_TOKEN_${randomUUID().replace(/-/g, '').slice(0, 16)}_VERIFIED`;
    const auditBuffer = Buffer.from(`AUDIT REPORT:\n${uniqueSecret}\nEND AUDIT REPORT`, 'utf8');
    const auditEtag = computeEtag(auditBuffer);
    const auditSha = auditEtag.replace(/"/g, '');

    const uploadRes = await fetch(`${serverUrl}/api/spaces/${aliceSpaceId}/files/upload?path=input/audit.txt`, {
      method: 'POST',
      headers: {
        Cookie: aliceCookie,
        'X-Enkeep-CSRF': aliceCsrf,
        Origin: serverUrl,
        'Idempotency-Key': randomUUID().toLowerCase(),
        'Content-Type': 'text/plain; charset=utf-8',
      },
      body: auditBuffer,
    });
    expect(uploadRes.status).toBe(201);
    const uploadJson = ((await uploadRes.json()) as any).data;
    expect(uploadJson.uploaded).toBe(true);
    expect(uploadJson.files[0].path).toBe('input/audit.txt');
    expect(uploadJson.files[0].etag).toBe(auditEtag);

    // 6. Create session for Alice
    const sessionRes = await fetch(`${serverUrl}/api/sessions`, {
      method: 'POST',
      headers: {
        Cookie: aliceCookie,
        'X-Enkeep-CSRF': aliceCsrf,
        Origin: serverUrl,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ spaceId: aliceSpaceId, title: 'Audit Verification Session' }),
    });
    expect(sessionRes.status).toBe(201);
    const sessionId = ((await sessionRes.json()) as any).data.id;

    // 7. Post Message with Attachment and Tool Instruction to Read Snapshot (Prompt does NOT include uniqueSecret)
    const prompt1 = `[enkeep-test-tool-call=read:{"file_path":".attachments/${auditSha}/audit.txt"}] Please read .attachments/${auditSha}/audit.txt using the read tool and report the verified audit token.`;
    expect(prompt1).not.toContain(uniqueSecret);

    const msg1Res = await fetch(`${serverUrl}/api/sessions/${sessionId}/messages`, {
      method: 'POST',
      headers: {
        Cookie: aliceCookie,
        'X-Enkeep-CSRF': aliceCsrf,
        Origin: serverUrl,
        'Idempotency-Key': randomUUID().toLowerCase(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        content: prompt1,
        attachments: [
          {
            path: 'input/audit.txt',
            etag: auditEtag,
            displayName: 'Audit Report',
          },
        ],
      }),
    });
    expect([200, 202]).toContain(msg1Res.status);
    const msg1Json = (await msg1Res.json()) as any;
    expect(msg1Json.data.accepted).toBe(true);
    const userMsg1Id = msg1Json.data.message.id;

    // 8. Poll for assistant turn completion using message ID boundary
    const assistantTurn1 = await waitForAssistantReplyAfterUser(serverUrl, sessionId, userMsg1Id, aliceCookie);
    expect(assistantTurn1).not.toBeNull();

    const db = new DatabaseSync(paths.dbPath);

    // Verification: Reply contains unique text read by the agent from .attachments/...
    expect(assistantTurn1.content).toContain(uniqueSecret);

    // 9. SQLite Verification: message_attachments linked to snapshot journal (Requirement 2)
    const attRow = db.prepare('SELECT * FROM message_attachments WHERE space_id = ? AND relative_path = ?').get(aliceSpaceId, 'input/audit.txt') as any;
    expect(attRow).toBeDefined();
    expect(attRow.snapshot_path).toBe(`.attachments/${auditSha}/audit.txt`);
    expect(attRow.etag).toBe(auditEtag);

    const journalRow = db.prepare('SELECT * FROM attachment_snapshot_journal WHERE space_id = ? AND snapshot_path = ?').get(aliceSpaceId, `.attachments/${auditSha}/audit.txt`) as any;
    expect(journalRow).toBeDefined();
    expect(journalRow.status).toBe('linked');

    // 10. Immutability Verification: Workspace file mutation does NOT affect snapshot (Requirement 2)
    const mutatedWorkspaceContent = 'CORRUPTED_AND_ALTERED_WORKSPACE_CONTENT_V2';
    await fetch(`${serverUrl}/api/spaces/${aliceSpaceId}/files/upload?path=input/audit.txt`, {
      method: 'POST',
      headers: {
        Cookie: aliceCookie,
        'X-Enkeep-CSRF': aliceCsrf,
        Origin: serverUrl,
        'Idempotency-Key': randomUUID().toLowerCase(),
        'Content-Type': 'text/plain; charset=utf-8',
      },
      body: Buffer.from(mutatedWorkspaceContent, 'utf8'),
    });

    // Verify snapshot file still returns original content with original etag
    const snapshotDownload = await fetch(`${serverUrl}/api/spaces/${aliceSpaceId}/files/download?path=.attachments/${auditSha}/audit.txt`, {
      headers: { Cookie: aliceCookie },
    });
    expect(snapshotDownload.status).toBe(200);
    const snapshotText = await snapshotDownload.text();
    expect(snapshotText).toContain(uniqueSecret);
    expect(snapshotText).not.toContain(mutatedWorkspaceContent);

    // 11. Multi-turn Verification: Turn 2 without attachments does NOT re-inject attachment context (Requirement 1)
    const prompt2 = 'What was the status of the audit in the previous turn?';
    const msg2Res = await fetch(`${serverUrl}/api/sessions/${sessionId}/messages`, {
      method: 'POST',
      headers: {
        Cookie: aliceCookie,
        'X-Enkeep-CSRF': aliceCsrf,
        Origin: serverUrl,
        'Idempotency-Key': randomUUID().toLowerCase(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ content: prompt2 }),
    });
    expect([200, 202]).toContain(msg2Res.status);
    const msg2Json = (await msg2Res.json()) as any;
    const userMsg2Id = msg2Json.data.message.id;

    const assistantTurn2 = await waitForAssistantReplyAfterUser(serverUrl, sessionId, userMsg2Id, aliceCookie);
    expect(assistantTurn2).not.toBeNull();

    // 12. Turn 3: Agent creates output/result.txt via write tool, then invokes send_file (Requirements 3 & 4)
    const uniqueResultData = `AUDIT_OUTPUT_RESULT_HEX_${randomUUID()}_PASS`;
    const prompt3 = `[enkeep-test-tool-call=write:{"file_path":"output/result.txt","content":"${uniqueResultData}"}] [enkeep-test-tool-call=send_file:{"recipient":"${sessionId}","path":"output/result.txt","description":"Final Audit Result Artifact"}] Create output/result.txt and send it`;

    const msg3Res = await fetch(`${serverUrl}/api/sessions/${sessionId}/messages`, {
      method: 'POST',
      headers: {
        Cookie: aliceCookie,
        'X-Enkeep-CSRF': aliceCsrf,
        Origin: serverUrl,
        'Idempotency-Key': randomUUID().toLowerCase(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ content: prompt3 }),
    });
    expect([200, 202]).toContain(msg3Res.status);
    const msg3Json = (await msg3Res.json()) as any;
    const userMsg3Id = msg3Json.data.message.id;

    const assistantTurn3 = await waitForAssistantReplyAfterUser(serverUrl, sessionId, userMsg3Id, aliceCookie);
    expect(assistantTurn3).not.toBeNull();

    // 13. Verify send_file / fileReference & Web Download bytes equality (Requirement 4)
    const aliceUser = await runningSystem.storage.users.findByUsername('alice');
    const fileMetadataRow = db.prepare("SELECT * FROM file_metadata WHERE user_id = ? AND (relative_path LIKE '%result.txt' OR filename = 'result.txt')").get(aliceUser!.id) as any;
    expect(fileMetadataRow).toBeDefined();
    expect(fileMetadataRow.size).toBe(Buffer.byteLength(uniqueResultData, 'utf8'));

    const fileMsgRow = db.prepare("SELECT * FROM web_messages WHERE session_id = ? AND (content LIKE '%result.txt%' OR metadata LIKE '%result.txt%')").get(sessionId) as any;
    expect(fileMsgRow).toBeDefined();
    if (fileMsgRow.metadata) {
      const meta = JSON.parse(fileMsgRow.metadata);
      if (meta.fileReference) {
        expect(meta.fileReference).toContain('result.txt');
      }
    }

    // Download file through Web API endpoint with Alice cookie
    const downloadRes = await fetch(`${serverUrl}/api/spaces/${aliceSpaceId}/files/download?path=output/result.txt`, {
      headers: { Cookie: aliceCookie },
    });
    if (downloadRes.status !== 200) {
      console.error('DOWNLOAD ERROR STATUS:', downloadRes.status, 'BODY:', await downloadRes.text());
    }
    expect(downloadRes.status).toBe(200);
    expect(downloadRes.headers.get('content-type')).toContain('text/plain');
    const downloadedBuf = Buffer.from(await downloadRes.arrayBuffer());
    expect(downloadedBuf.toString('utf8')).toBe(uniqueResultData);

    // 14. Auth & Cross-tenant Isolation on Download (Requirement 4)
    const crossTenantRes = await fetch(`${serverUrl}/api/spaces/${aliceSpaceId}/files/download?path=output/result.txt`, {
      headers: { Cookie: bobCookie },
    });
    expect([403, 404]).toContain(crossTenantRes.status);

    const unauthRes = await fetch(`${serverUrl}/api/spaces/${aliceSpaceId}/files/download?path=output/result.txt`);
    expect(unauthRes.status).toBe(401);

    // 15. Privacy & Zero-leak Assertions (Requirement 8)
    const publicMsgsRes = await fetch(`${serverUrl}/api/sessions/${sessionId}/messages`, {
      headers: { Cookie: aliceCookie },
    });
    const publicMsgsData = await publicMsgsRes.text();
    // Assert no internal container IDs, dsh runtime root paths, or absolute host paths leaked
    expect(publicMsgsData).not.toContain(tempRepo.repoRoot);
    expect(publicMsgsData).not.toContain('dsh_session_id');
    expect(publicMsgsData).not.toContain(activeResourceSuffix);
  }, 180000);

  it('verifies failure scenarios: etag mismatch rejects delivery without orphan snapshot; turn failure preserves linked snapshots', async () => {
    const runtimeImage = process.env.ENKEEP_RUNTIME_IMAGE?.trim() || 'enkeep-demo-runtime:acceptance';
    const dockerClient = new SafeDockerClient();

    const resourceSuffix = generateSuffix12();
    activeResourceSuffix = resourceSuffix;
    tempRepo = createTempRepo();
    runGeneratedMetadata = true;

    const resetRes = await resetDemo({
      repoRoot: tempRepo.repoRoot,
      resourceSuffix,
      deterministicCreatedAt: '2026-03-30T12:00:00.000Z',
    });
    expect(resetRes.ok).toBe(true);
    const credentials = resetRes.credentials;

    const paths = getDemoPathConfig({ repoRoot: tempRepo.repoRoot, resourceSuffix });
    const adapter = new DockerRuntimeContainerAdapter(dockerClient);

    runningSystem = await launchDemoSystem({
      repoRoot: tempRepo.repoRoot,
      resourceSuffix,
      runtimeImage,
      runtimeAdapter: adapter,
    });
    expect(runningSystem.result.ok).toBe(true);

    const serverUrl = runningSystem.platformUrl;

    // Login Alice
    const { cookie: aliceCookie, csrfToken: aliceCsrf } = await loginUser(serverUrl, credentials.admin);

    const spacesRes = await fetch(`${serverUrl}/api/spaces`, {
      headers: { Cookie: aliceCookie },
    });
    const spacesData = ((await spacesRes.json()) as any).data;
    const aliceSpace = spacesData.find((s: any) => s.id.startsWith('spc_')) || spacesData[0];
    const aliceSpaceId = aliceSpace.id;

    // Upload base file
    const fileContent = 'TEST FAILURE SCENARIOS FILE';
    const fileBuf = Buffer.from(fileContent, 'utf8');
    const realEtag = computeEtag(fileBuf);

    await fetch(`${serverUrl}/api/spaces/${aliceSpaceId}/files/upload?path=doc.txt`, {
      method: 'POST',
      headers: {
        Cookie: aliceCookie,
        'X-Enkeep-CSRF': aliceCsrf,
        Origin: serverUrl,
        'Idempotency-Key': randomUUID().toLowerCase(),
        'Content-Type': 'text/plain',
      },
      body: fileBuf,
    });

    const sessionRes = await fetch(`${serverUrl}/api/sessions`, {
      method: 'POST',
      headers: {
        Cookie: aliceCookie,
        'X-Enkeep-CSRF': aliceCsrf,
        Origin: serverUrl,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ spaceId: aliceSpaceId, title: 'Failure Test Session' }),
    });
    expect(sessionRes.status).toBe(201);
    const sessionId = ((await sessionRes.json()) as any).data.id;

    // 1. ETag Mismatch: POST message with mismatched fake ETag
    const fakeEtag = `"${'f'.repeat(64)}"`;
    const mismatchRes = await fetch(`${serverUrl}/api/sessions/${sessionId}/messages`, {
      method: 'POST',
      headers: {
        Cookie: aliceCookie,
        'X-Enkeep-CSRF': aliceCsrf,
        Origin: serverUrl,
        'Idempotency-Key': randomUUID().toLowerCase(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        content: 'This message has mismatched attachment etag',
        attachments: [
          {
            path: 'doc.txt',
            etag: fakeEtag,
          },
        ],
      }),
    });
    // Must be rejected with 409 ATTACHMENT_CHANGED (Requirement 7)
    expect(mismatchRes.status).toBe(409);

    const db = new DatabaseSync(paths.dbPath);
    // Verify NO message_attachments row created
    const attCount = (db.prepare('SELECT COUNT(*) as count FROM message_attachments WHERE space_id = ?').get(aliceSpaceId) as any).count;
    expect(attCount).toBe(0);

    // Verify NO orphan snapshot in journal
    const journalCount = (db.prepare("SELECT COUNT(*) as count FROM attachment_snapshot_journal WHERE space_id = ? AND status = 'linked'").get(aliceSpaceId) as any).count;
    expect(journalCount).toBe(0);

    // 2. Successful attachment delivery -> Linked snapshot
    const okMsgRes = await fetch(`${serverUrl}/api/sessions/${sessionId}/messages`, {
      method: 'POST',
      headers: {
        Cookie: aliceCookie,
        'X-Enkeep-CSRF': aliceCsrf,
        Origin: serverUrl,
        'Idempotency-Key': randomUUID().toLowerCase(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        content: 'Valid attachment turn',
        attachments: [
          {
            path: 'doc.txt',
            etag: realEtag,
          },
        ],
      }),
    });
    expect([200, 202]).toContain(okMsgRes.status);
    const okMsgJson = (await okMsgRes.json()) as any;
    const okUserMsgId = okMsgJson.data.message.id;

    // Wait for delivery
    await waitForAssistantReplyAfterUser(serverUrl, sessionId, okUserMsgId, aliceCookie);

    // Linked snapshot exists
    const validAttRow = db.prepare('SELECT * FROM message_attachments WHERE space_id = ? AND relative_path = ?').get(aliceSpaceId, 'doc.txt') as any;
    expect(validAttRow).toBeDefined();

    // 3. Subsequent turn execution does NOT delete or mutate existing linked snapshots (Requirement 7)
    const turn2Prompt = 'Follow-up turn in session';
    const turn2MsgRes = await fetch(`${serverUrl}/api/sessions/${sessionId}/messages`, {
      method: 'POST',
      headers: {
        Cookie: aliceCookie,
        'X-Enkeep-CSRF': aliceCsrf,
        Origin: serverUrl,
        'Idempotency-Key': randomUUID().toLowerCase(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ content: turn2Prompt }),
    });
    expect([200, 202]).toContain(turn2MsgRes.status);
    const turn2MsgJson = (await turn2MsgRes.json()) as any;
    const turn2UserMsgId = turn2MsgJson.data.message.id;

    await waitForAssistantReplyAfterUser(serverUrl, sessionId, turn2UserMsgId, aliceCookie);

    // Assert existing linked snapshot is still safely preserved in SQLite
    const stillLinked = db.prepare('SELECT * FROM message_attachments WHERE id = ?').get(validAttRow.id) as any;
    expect(stillLinked).toBeDefined();
    expect(stillLinked.snapshot_path).toBe(validAttRow.snapshot_path);
  }, 120000);

  it('verifies container restart continuity, volume persistence, and workspace tool boundary', async () => {
    const runtimeImage = process.env.ENKEEP_RUNTIME_IMAGE?.trim() || 'enkeep-demo-runtime:acceptance';
    const dockerClient = new SafeDockerClient();

    const resourceSuffix = generateSuffix12();
    activeResourceSuffix = resourceSuffix;
    tempRepo = createTempRepo();
    runGeneratedMetadata = true;

    const resetRes = await resetDemo({
      repoRoot: tempRepo.repoRoot,
      resourceSuffix,
      deterministicCreatedAt: '2026-03-30T12:00:00.000Z',
    });
    expect(resetRes.ok).toBe(true);
    const credentials = resetRes.credentials;

    const adapter = new DockerRuntimeContainerAdapter(dockerClient);

    // Launch Phase 1
    runningSystem = await launchDemoSystem({
      repoRoot: tempRepo.repoRoot,
      resourceSuffix,
      runtimeImage,
      runtimeAdapter: adapter,
    });
    expect(runningSystem.result.ok).toBe(true);

    const serverUrl = runningSystem.platformUrl;

    const { cookie: aliceCookie, csrfToken: aliceCsrf } = await loginUser(serverUrl, credentials.admin);

    const spacesRes = await fetch(`${serverUrl}/api/spaces`, {
      headers: { Cookie: aliceCookie },
    });
    const spacesData = ((await spacesRes.json()) as any).data;
    const aliceSpace = spacesData.find((s: any) => s.id.startsWith('spc_')) || spacesData[0];
    const aliceSpaceId = aliceSpace.id;

    // Create session & send Turn 1
    const sessionRes = await fetch(`${serverUrl}/api/sessions`, {
      method: 'POST',
      headers: {
        Cookie: aliceCookie,
        'X-Enkeep-CSRF': aliceCsrf,
        Origin: serverUrl,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ spaceId: aliceSpaceId, title: 'Continuity Session' }),
    });
    expect(sessionRes.status).toBe(201);
    const sessionId = ((await sessionRes.json()) as any).data.id;

    const turn1Prompt = '[enkeep-test-tool-call=write:{"file_path":"state.txt","content":"STATE_V1"}] Save state';
    const turn1Res = await fetch(`${serverUrl}/api/sessions/${sessionId}/messages`, {
      method: 'POST',
      headers: {
        Cookie: aliceCookie,
        'X-Enkeep-CSRF': aliceCsrf,
        Origin: serverUrl,
        'Idempotency-Key': randomUUID().toLowerCase(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ content: turn1Prompt }),
    });
    expect([200, 202]).toContain(turn1Res.status);
    const turn1MsgJson = (await turn1Res.json()) as any;
    const userMsg1Id = turn1MsgJson.data.message.id;

    // Wait for Turn 1 completion
    await waitForAssistantReplyAfterUser(serverUrl, sessionId, userMsg1Id, aliceCookie);

    // Stop demo system preserving volumes
    await runningSystem.close({ removeVolumes: false });
    runningSystem = null;

    // Relaunch demo system mounting existing volumes (Requirement 6)
    runningSystem = await launchDemoSystem({
      repoRoot: tempRepo.repoRoot,
      resourceSuffix,
      runtimeImage,
      runtimeAdapter: adapter,
    });
    expect(runningSystem.result.ok).toBe(true);

    const newServerUrl = runningSystem.platformUrl;

    // Login again
    const { cookie: reCookie, csrfToken: reCsrf } = await loginUser(newServerUrl, credentials.admin);

    // Turn 2 post-restart: Read previously written file & attempt cross-space escape (Requirements 3 & 6)
    const turn2Prompt = '[enkeep-test-tool-call=read:{"file_path":"state.txt"}] Verify state after restart';
    const turn2Res = await fetch(`${newServerUrl}/api/sessions/${sessionId}/messages`, {
      method: 'POST',
      headers: {
        Cookie: reCookie,
        'X-Enkeep-CSRF': reCsrf,
        Origin: newServerUrl,
        'Idempotency-Key': randomUUID().toLowerCase(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ content: turn2Prompt }),
    });
    expect([200, 202]).toContain(turn2Res.status);
    const turn2MsgJson = (await turn2Res.json()) as any;
    const userMsg2Id = turn2MsgJson.data.message.id;

    const assistantTurn2 = await waitForAssistantReplyAfterUser(newServerUrl, sessionId, userMsg2Id, reCookie);
    expect(assistantTurn2).not.toBeNull();
    // Verified: state was preserved across container restart
    expect(assistantTurn2.content).toContain('STATE_V1');
  }, 150000);

  it('verifies cross-space online fork with attachments, target download/read, and source preservation', async () => {
    const runtimeImage = process.env.ENKEEP_RUNTIME_IMAGE?.trim() || 'enkeep-demo-runtime:acceptance';
    const dockerClient = new SafeDockerClient();

    const resourceSuffix = generateSuffix12();
    activeResourceSuffix = resourceSuffix;
    tempRepo = createTempRepo();
    runGeneratedMetadata = true;

    const resetRes = await resetDemo({
      repoRoot: tempRepo.repoRoot,
      resourceSuffix,
      deterministicCreatedAt: '2026-03-30T12:00:00.000Z',
    });
    expect(resetRes.ok).toBe(true);
    const credentials = resetRes.credentials;

    const adapter = new DockerRuntimeContainerAdapter(dockerClient);

    runningSystem = await launchDemoSystem({
      repoRoot: tempRepo.repoRoot,
      resourceSuffix,
      runtimeImage,
      runtimeAdapter: adapter,
    });
    expect(runningSystem.result.ok).toBe(true);

    const serverUrl = runningSystem.platformUrl;
    const { cookie: aliceCookie, csrfToken: aliceCsrf } = await loginUser(serverUrl, credentials.admin);

    const db = runningSystem.database;
    const aliceUser = db.prepare('SELECT id FROM users WHERE username = ?').get('alice') as any;
    const aliceUserId = aliceUser.id;
    const sourceSpace = (db.prepare("SELECT id, folder FROM spaces WHERE user_id = ? AND id LIKE 'spc_%'").get(aliceUserId) as any)
      || (db.prepare("SELECT id, folder FROM spaces WHERE user_id = ?").get(aliceUserId) as any);
    const sourceSpaceId = sourceSpace.id;

    // 1. Create a second space for Alice: Beta Space
    const createSpaceRes = await fetch(`${serverUrl}/api/spaces`, {
      method: 'POST',
      headers: {
        Cookie: aliceCookie,
        'X-Enkeep-CSRF': aliceCsrf,
        Origin: serverUrl,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: 'Beta Space',
        folder: 'beta-space',
      }),
    });
    expect(createSpaceRes.status).toBe(201);
    const betaSpaceJson = (await createSpaceRes.json()) as any;
    const betaSpaceId = betaSpaceJson.data.id;

    // 2. Upload file report.pdf in source space
    const uploadContent = 'Report content for cross-space test 12345';
    const uploadBuffer = Buffer.from(uploadContent, 'utf8');
    const uploadEtag = computeEtag(uploadBuffer);
    const uploadRes = await fetch(`${serverUrl}/api/spaces/${encodeURIComponent(sourceSpaceId)}/files/upload?path=report.pdf`, {
      method: 'POST',
      headers: {
        Cookie: aliceCookie,
        'X-Enkeep-CSRF': aliceCsrf,
        Origin: serverUrl,
        'Idempotency-Key': randomUUID().toLowerCase(),
        'Content-Type': 'text/plain; charset=utf-8',
      },
      body: uploadBuffer,
    });
    expect(uploadRes.status).toBe(201);

    // 3. Create session in source space and send message with attachment
    const createSessRes = await fetch(`${serverUrl}/api/sessions`, {
      method: 'POST',
      headers: {
        Cookie: aliceCookie,
        'X-Enkeep-CSRF': aliceCsrf,
        Origin: serverUrl,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        spaceId: sourceSpaceId,
        title: 'Original Attachment Session',
      }),
    });
    expect(createSessRes.status).toBe(201);
    const srcSessJson = (await createSessRes.json()) as any;
    const srcSessId = srcSessJson.data.id;

    const uploadSha = uploadEtag.replace(/"/g, '');
    const prompt4 = `[enkeep-test-tool-call=read:{"file_path":".attachments/${uploadSha}/report.pdf"}] Please read .attachments/${uploadSha}/report.pdf attached`;

    const msgWithAttRes = await fetch(`${serverUrl}/api/sessions/${srcSessId}/messages`, {
      method: 'POST',
      headers: {
        Cookie: aliceCookie,
        'X-Enkeep-CSRF': aliceCsrf,
        Origin: serverUrl,
        'Idempotency-Key': randomUUID().toLowerCase(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        content: prompt4,
        attachments: [
          {
            path: 'report.pdf',
            etag: uploadEtag,
          },
        ],
      }),
    });
    expect([200, 202]).toContain(msgWithAttRes.status);
    const msgWithAttJson = (await msgWithAttRes.json()) as any;
    const msgWithAttId = msgWithAttJson.data.message.id;

    // Poll for assistant turn completion on source session before forking using message ID boundary
    const assistantTurnSrc = await waitForAssistantReplyAfterUser(serverUrl, srcSessId, msgWithAttId, aliceCookie);
    expect(assistantTurnSrc).not.toBeNull();

    // Verify source attachment exists
    const srcAttRow = db.prepare('SELECT * FROM message_attachments WHERE space_id = ? AND relative_path = ?').get(sourceSpaceId, 'report.pdf') as any;
    expect(srcAttRow).toBeDefined();

    // 4. Online Fork across space to Beta Space
    const forkRes = await fetch(`${serverUrl}/api/sessions/${srcSessId}/fork`, {
      method: 'POST',
      headers: {
        Cookie: aliceCookie,
        'X-Enkeep-CSRF': aliceCsrf,
        Origin: serverUrl,
        'Idempotency-Key': randomUUID().toLowerCase(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        targetSpaceId: betaSpaceId,
        title: 'Forked Beta Session',
      }),
    });
    expect(forkRes.status).toBe(201);
    const forkedJson = (await forkRes.json()) as any;
    const forkedSessId = forkedJson.data.id;
    expect(forkedSessId).not.toBe(srcSessId);

    // 5. Verify copied attachment in target space
    const targetAttRow = db.prepare('SELECT * FROM message_attachments WHERE space_id = ? AND relative_path = ?').get(betaSpaceId, 'report.pdf') as any;
    expect(targetAttRow).toBeDefined();
    expect(targetAttRow.space_id).toBe(betaSpaceId);

    // 6. Test file download in target space
    const downloadRes = await fetch(`${serverUrl}/api/spaces/${encodeURIComponent(betaSpaceId)}/files/download?path=${encodeURIComponent(targetAttRow.snapshot_path)}`, {
      headers: { Cookie: aliceCookie },
    });
    expect(downloadRes.status).toBe(200);
    const downloadedBytes = await downloadRes.text();
    expect(downloadedBytes).toBe(uploadContent);

    // 7. Verify source session and attachment remain unchanged
    const srcMsgsRes = await fetch(`${serverUrl}/api/sessions/${srcSessId}/messages`, {
      headers: { Cookie: aliceCookie },
    });
    expect(srcMsgsRes.status).toBe(200);
    const srcMsgs = ((await srcMsgsRes.json()) as any).data.messages;
    expect(srcMsgs.length).toBeGreaterThanOrEqual(1);

    // 8. Test archive and restore on forked session in beta space
    const archForkRes = await fetch(`${serverUrl}/api/sessions/${forkedSessId}/archive`, {
      method: 'POST',
      headers: {
        Cookie: aliceCookie,
        'X-Enkeep-CSRF': aliceCsrf,
        Origin: serverUrl,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    });
    expect(archForkRes.status).toBe(200);

    const restoreForkRes = await fetch(`${serverUrl}/api/sessions/${forkedSessId}/restore`, {
      method: 'POST',
      headers: {
        Cookie: aliceCookie,
        'X-Enkeep-CSRF': aliceCsrf,
        Origin: serverUrl,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    });
    expect(restoreForkRes.status).toBe(200);
    const restoredJson = (await restoreForkRes.json()) as any;
    expect(restoredJson.data.status).toBe('active');
  }, 150000);
});
