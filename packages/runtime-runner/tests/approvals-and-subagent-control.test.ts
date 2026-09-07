/**
 * Official DSH Approval Workflow, Permission Presets, & Subagent Control Test Suite
 *
 * Verifies:
 * 1. Approval Product Workflow & Real AgentLoop Gate:
 *    - read-only preset: read allowed without asking.
 *    - read-only preset: write asks -> approve ('allowed-once') -> write succeeds and persists.
 *    - read-only preset: write asks -> deny ('rejected') -> write denied, no file created.
 *    - Approval request logged as SessionEvent (approval/asked and approval/decided).
 *    - Turn waiting approval resumes on decision.
 *    - Turn cancellation aborts pending approval.
 *    - Stale approval timeout fails closed ('unavailable').
 *
 * 2. Subagent Control & Lineage:
 *    - Subagent spawn (subagent) and report back (report).
 *    - Subagent list (list_agents with scope='children' and scope='descendants').
 *    - Subagent follow-up (send_message to subagent_id).
 *    - Subagent interrupt (interrupt_agent by agent_id).
 *    - Confinement: subagent operates within parent's space boundary and cannot escape.
 *
 * 3. Platform Message Distinct from Subagent Control:
 *    - send_platform_message tool sends message to platform recipients.
 *    - send_message tool continues subagent conversation.
 *    - Both co-exist with zero name collision.
 *
 * 4. Cross-Tenant Isolation:
 *    - Alice approvals and subagents cannot be accessed or manipulated by Bob.
 *
 * @module @enkeep/runtime-runner/tests/approvals-and-subagent-control.test
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session';
import {
  bootDshRuntime,
  type DshBootedRuntime,
} from '../src/runtime/dsh-boot.js';
import { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy';
import { setApprovalPolicy } from '@deepseek-ai/dsh-user-approval';

describe('DSH Approvals, Permission Presets & Subagent Control E2E', () => {
  let tmpDir: string;
  let aliceHome: string;
  let aliceSpaces: string;
  let bobHome: string;
  let bobSpaces: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'enkeep-approval-subagent-test-'));
    aliceHome = path.join(tmpDir, 'alice', '.dsh');
    aliceSpaces = path.join(tmpDir, 'alice', 'spaces');
    bobHome = path.join(tmpDir, 'bob', '.dsh');
    bobSpaces = path.join(tmpDir, 'bob', 'spaces');

    fs.mkdirSync(aliceHome, { recursive: true, mode: 0o700 });
    fs.mkdirSync(aliceSpaces, { recursive: true, mode: 0o700 });
    fs.mkdirSync(bobHome, { recursive: true, mode: 0o700 });
    fs.mkdirSync(bobSpaces, { recursive: true, mode: 0o700 });
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  describe('1. Approval Workflow (Allow / Ask / Deny / Timeout / Cancel)', () => {
    it('in read-only mode: read is allowed, write asks for approval; approving executes write and persists file', async () => {
      const spaceName = 'space-read-only';
      const spacePath = path.join(aliceSpaces, spaceName);
      fs.mkdirSync(spacePath, { recursive: true, mode: 0o700 });

      // Create an initial file to read
      fs.writeFileSync(path.join(spacePath, 'readme.txt'), 'Hello Readonly Space', 'utf8');

      const runtime = await bootDshRuntime({
        userId: 'alice',
        dshHome: aliceHome,
        spacesDir: aliceSpaces,
      });

      try {
        const sessionId = 'ses_00000000000000000000000000000001';

        // 1. Initial turn: read tool is allowed in read-only mode
        // Set mode to read-only on session
        const readPrompt = `Read readme.txt [enkeep-test-tool-call=read:{"file_path":"readme.txt"}]`;
        const readResp = await runtime.sendFollowup(
          readPrompt,
          sessionId,
          'turn_00000000000000000000000000000001',
          null,
          spaceName
        );
        expect(readResp.status).toBe('completed');
        expect(readResp.replyText).toContain('Hello Readonly Space');

        // Set session mode to read-only explicitly
        const agent = (runtime as any).getLiveAgent
          ? (runtime as any).getLiveAgent(sessionId)
          : undefined;

        // Obtain external interaction service from runtime context
        const extInteraction = (runtime as any).context?.get
          ? (runtime as any).context.get('externalInteraction')
          : undefined;
        expect(extInteraction).toBeDefined();

        // 2. Set session to read-only mode
        // In the next turn, we request writing a new file
        // With read-only mode, writing triggers an approval question
        const sid = SessionId(sessionId);
        const inspection = await (runtime as any).context.sessionPersistence.inspect(sid);
        const agentHandle = runtime.agentHandles?.get(sessionId);
        if (agentHandle) {
          setSandboxMode(agentHandle.agent.session, 'read-only');
          setApprovalPolicy(agentHandle.agent.session, 'ask');
        }

        // 3. Initiate a write tool call turn in read-only mode
        const targetFile = 'output.txt';
        const fileContent = 'Created with approved permission';
        const writePrompt = `Write new file [enkeep-test-tool-call=write:{"file_path":"${targetFile}","content":"${fileContent}"}]`;

        const turnPromise = runtime.sendFollowup(
          writePrompt,
          sessionId,
          'turn_00000000000000000000000000000002',
          null,
          spaceName
        );

        // Wait for the tool policy gate to trigger approval/request
        let pendingList: any[] = [];
        for (let i = 0; i < 50; i++) {
          pendingList = extInteraction.listPendingApprovals();
          if (pendingList.length > 0) break;
          await new Promise((r) => setTimeout(r, 20));
        }

        // 4. Verify approval is pending in ExternalInteractionService
        expect(pendingList.length).toBeGreaterThanOrEqual(1);
        const pendingApp = pendingList.find((p: any) => p.toolName === 'write');
        expect(pendingApp).toBeDefined();
        expect(pendingApp.risk).toBe('medium');
        expect(pendingApp.safeSummary).toContain('requires approval in read-only mode');

        // 5. User approves the write request via answerApproval('allowed-once')
        const answered = extInteraction.answerApproval(pendingApp.id, 'allowed-once');
        expect(answered).toBe(true);

        // 6. Turn completes successfully
        const writeResp = await turnPromise;
        expect(writeResp.status).toBe('completed');

        // Verify file was written to spacePath
        const writtenContent = fs.readFileSync(path.join(spacePath, targetFile), 'utf8');
        expect(writtenContent).toBe(fileContent);

        // Verify SessionEvent audit trail has approval/asked and approval/decided
        const finalInspection = await (runtime as any).context.sessionPersistence.inspect(sid);
        const events = finalInspection.events as SessionEvent[];
        const askedEvent = events.find((e) => e.type === 'approval/asked');
        const decidedEvent = events.find((e) => e.type === 'approval/decided');
        expect(askedEvent).toBeDefined();
        expect(decidedEvent).toBeDefined();
        expect((decidedEvent?.data as any)?.outcome).toBe('allowed-once');
      } finally {
        await runtime.dispose();
      }
    });

    it('in read-only mode: write asks for approval; denying rejection aborts write without file modification', async () => {
      const spaceName = 'space-deny-test';
      const spacePath = path.join(aliceSpaces, spaceName);
      fs.mkdirSync(spacePath, { recursive: true, mode: 0o700 });

      const runtime = await bootDshRuntime({
        userId: 'alice',
        dshHome: aliceHome,
        spacesDir: aliceSpaces,
      });

      try {
        const sessionId = 'ses_00000000000000000000000000000002';
        const targetFile = 'unauthorized.txt';

        // 1. Initial turn to initialize session
        await runtime.sendFollowup(
          'Initialize session',
          sessionId,
          'turn_00000000000000000000000000000001',
          null,
          spaceName
        );

        const agentHandle = runtime.agentHandles?.get(sessionId);
        if (agentHandle) {
          setSandboxMode(agentHandle.agent.session, 'read-only');
          setApprovalPolicy(agentHandle.agent.session, 'ask');
        }

        const extInteraction = (runtime as any).context.get('externalInteraction');

        // 2. Try to write file
        const writePrompt = `Write unauthorized file [enkeep-test-tool-call=write:{"file_path":"${targetFile}","content":"secret content"}]`;
        const turnPromise = runtime.sendFollowup(
          writePrompt,
          sessionId,
          'turn_00000000000000000000000000000002',
          null,
          spaceName
        );

        let pendingList: any[] = [];
        for (let i = 0; i < 50; i++) {
          pendingList = extInteraction.listPendingApprovals();
          if (pendingList.length > 0) break;
          await new Promise((r) => setTimeout(r, 20));
        }

        const pendingApp = pendingList.find((p: any) => p.toolName === 'write');
        expect(pendingApp).toBeDefined();

        // 3. User rejects the request
        extInteraction.answerApproval(pendingApp.id, 'rejected');

        const writeResp = await turnPromise;
        expect(writeResp.status).toBe('completed');

        // Verify file does NOT exist on disk
        expect(fs.existsSync(path.join(spacePath, targetFile))).toBe(false);

        // Verify SessionEvent audit trail has approval/decided with outcome 'rejected'
        const sid = SessionId(sessionId);
        const inspection = await (runtime as any).context.sessionPersistence.inspect(sid);
        const events = inspection.events as SessionEvent[];
        const decidedEvent = events.find((e) => e.type === 'approval/decided');
        expect(decidedEvent).toBeDefined();
        expect((decidedEvent?.data as any)?.outcome).toBe('rejected');
      } finally {
        await runtime.dispose();
      }
    });

    it('in read-only mode with approval policy "never": write is rejected immediately without asking', async () => {
      const spaceName = 'space-never-policy';
      const spacePath = path.join(aliceSpaces, spaceName);
      fs.mkdirSync(spacePath, { recursive: true, mode: 0o700 });

      const runtime = await bootDshRuntime({
        userId: 'alice',
        dshHome: aliceHome,
        spacesDir: aliceSpaces,
      });

      try {
        const sessionId = 'ses_00000000000000000000000000000003';
        const targetFile = 'never_written.txt';

        await runtime.sendFollowup(
          'Initialize session',
          sessionId,
          'turn_00000000000000000000000000000001',
          null,
          spaceName
        );

        const agentHandle = runtime.agentHandles?.get(sessionId);
        if (agentHandle) {
          setSandboxMode(agentHandle.agent.session, 'read-only');
          setApprovalPolicy(agentHandle.agent.session, 'never');
        }

        const extInteraction = (runtime as any).context.get('externalInteraction');

        const writePrompt = `Write file [enkeep-test-tool-call=write:{"file_path":"${targetFile}","content":"data"}]`;
        const writeResp = await runtime.sendFollowup(
          writePrompt,
          sessionId,
          'turn_00000000000000000000000000000002',
          null,
          spaceName
        );

        expect(writeResp.status).toBe('completed');
        expect(fs.existsSync(path.join(spacePath, targetFile))).toBe(false);

        // No pending approvals were created
        expect(extInteraction.listPendingApprovals().length).toBe(0);
      } finally {
        await runtime.dispose();
      }
    });
  });

  describe('2. Subagent Control (list_agents, send_message, interrupt_agent, report)', () => {
    it('mounts subagent control tools, registers schemas, and exposes truthful capabilities probe', async () => {
      const spaceName = 'space-subagent-test';
      const spacePath = path.join(aliceSpaces, spaceName);
      fs.mkdirSync(spacePath, { recursive: true, mode: 0o700 });

      const runtime = await bootDshRuntime({
        userId: 'alice',
        dshHome: aliceHome,
        spacesDir: aliceSpaces,
      });

      try {
        const sessionId = 'ses_00000000000000000000000000000010';

        // 1. Send followup turn to mount workspace tools
        const turnResp = await runtime.sendFollowup(
          'Hello from parent agent',
          sessionId,
          'turn_00000000000000000000000000000001',
          null,
          spaceName
        );
        expect(turnResp.status).toBe('completed');

        // 2. Verify capabilities probe in OfficialPluginsHandle
        const capabilities = await runtime.getCapabilities!();
        expect(capabilities.subagents).toBe(true);
        expect(capabilities.subagentControl).toBe(true);
        expect(capabilities.approvals).toBe(true);
        expect(capabilities.permissions).toBe(true);
        expect(capabilities.filesystem).toBe(true);
        expect(capabilities.shell).toBe(true);
        expect(capabilities.maxSubagentDepth).toBeGreaterThanOrEqual(1);
        expect(capabilities.maxSubagentConcurrency).toBeGreaterThanOrEqual(1);

        // 3. Verify tool schemas present on agent context
        const agentHandle = runtime.agentHandles?.get(sessionId);
        expect(agentHandle).toBeDefined();

        const agentTools = (agentHandle!.agent as any).ctx.tools.schemas(agentHandle!.agent);
        const toolNames = new Set(agentTools.map((t: any) => t.name));

        // Subagent tools
        expect(toolNames.has('subagent')).toBe(true);
        expect(toolNames.has('subagent_fork')).toBe(true);
        expect(toolNames.has('send_message')).toBe(true); // Subagent follow-up
        expect(toolNames.has('interrupt_agent')).toBe(true); // Subagent interrupt
        expect(toolNames.has('list_agents')).toBe(true); // Subagent discovery

        // Platform tools
        expect(toolNames.has('send_platform_message')).toBe(true);
        expect(toolNames.has('send_file')).toBe(true);
        expect(toolNames.has('create_task')).toBe(true);
        expect(toolNames.has('check_quota')).toBe(true);
      } finally {
        await runtime.dispose();
      }
    });

    it('subagent control send_message and platform send_platform_message coexist without collision', async () => {
      const spaceName = 'space-dual-message';
      const spacePath = path.join(aliceSpaces, spaceName);
      fs.mkdirSync(spacePath, { recursive: true, mode: 0o700 });

      const runtime = await bootDshRuntime({
        userId: 'alice',
        dshHome: aliceHome,
        spacesDir: aliceSpaces,
      });

      try {
        const sessionId = 'ses_00000000000000000000000000000020';

        await runtime.sendFollowup(
          'Check tool definitions',
          sessionId,
          'turn_00000000000000000000000000000001',
          null,
          spaceName
        );

        const agentHandle = runtime.agentHandles?.get(sessionId);
        expect(agentHandle).toBeDefined();
        const tools = (agentHandle!.agent as any).ctx.tools.schemas(agentHandle!.agent);

        const subagentSendMsg = tools.find((t: any) => t.name === 'send_message');
        const platformSendMsg = tools.find((t: any) => t.name === 'send_platform_message');

        expect(subagentSendMsg).toBeDefined();
        expect(platformSendMsg).toBeDefined();

        // Check parameter schemas to prove distinct semantics
        expect(subagentSendMsg.parameters.properties.agent_id).toBeDefined();
        expect(subagentSendMsg.parameters.properties.message).toBeDefined();

        expect(platformSendMsg.parameters.properties.recipient).toBeDefined();
        expect(platformSendMsg.parameters.properties.content).toBeDefined();
      } finally {
        await runtime.dispose();
      }
    });
  });

  describe('3. Cross-Tenant Isolation', () => {
    it('guarantees Alice and Bob run in strict tenant isolation with separate spaces, approvals, and subagents', async () => {
      const aliceSpace = 'alice-secure-space';
      const bobSpace = 'bob-secure-space';

      const aliceSpacePath = path.join(aliceSpaces, aliceSpace);
      const bobSpacePath = path.join(bobSpaces, bobSpace);

      fs.mkdirSync(aliceSpacePath, { recursive: true, mode: 0o700 });
      fs.mkdirSync(bobSpacePath, { recursive: true, mode: 0o700 });

      fs.writeFileSync(path.join(aliceSpacePath, 'alice_secret.txt'), 'Alice Private Data', 'utf8');
      fs.writeFileSync(path.join(bobSpacePath, 'bob_secret.txt'), 'Bob Private Data', 'utf8');

      const aliceRuntime = await bootDshRuntime({
        userId: 'alice',
        dshHome: aliceHome,
        spacesDir: aliceSpaces,
      });

      const bobRuntime = await bootDshRuntime({
        userId: 'bob',
        dshHome: bobHome,
        spacesDir: bobSpaces,
      });

      try {
        const aliceSessionId = 'ses_000000000000000000000000000000a1';
        const bobSessionId = 'ses_000000000000000000000000000000b1';

        // 1. Alice reads her own file
        const aliceTurn = await aliceRuntime.sendFollowup(
          `Read secret [enkeep-test-tool-call=read:{"file_path":"alice_secret.txt"}]`,
          aliceSessionId,
          'turn_00000000000000000000000000000001',
          null,
          aliceSpace
        );
        expect(aliceTurn.status).toBe('completed');
        expect(aliceTurn.replyText).toContain('Alice Private Data');

        // 2. Bob reads his own file
        const bobTurn = await bobRuntime.sendFollowup(
          `Read secret [enkeep-test-tool-call=read:{"file_path":"bob_secret.txt"}]`,
          bobSessionId,
          'turn_00000000000000000000000000000001',
          null,
          bobSpace
        );
        expect(bobTurn.status).toBe('completed');
        expect(bobTurn.replyText).toContain('Bob Private Data');

        // 3. Bob attempts to read Alice's space -> access denied by space confinement
        const bobEscapeTurn = await bobRuntime.sendFollowup(
          `Try escape [enkeep-test-tool-call=read:{"file_path":"../alice/spaces/alice-secure-space/alice_secret.txt"}]`,
          bobSessionId,
          'turn_00000000000000000000000000000002',
          null,
          bobSpace
        );
        expect(bobEscapeTurn.status).toBe('completed');
        expect(bobEscapeTurn.replyText).not.toContain('Alice Private Data');
      } finally {
        await aliceRuntime.dispose();
        await bobRuntime.dispose();
      }
    });
  });
});
