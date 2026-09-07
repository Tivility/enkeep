/**
 * Runtime Agent Attachment Context & Tool Execution Integration Tests
 *
 * Tests:
 * 1. sendFollowup injects model-visible attachment context via official agent.inject.
 * 2. Agent successfully calls read tool on .attachments/<sha>/<filename> snapshot path.
 * 3. Mutation after send: original workspace file is altered, but reading .attachments/... snapshot returns original content.
 * 4. Session persistence & resume preserves synthetic attachment context and allows continued agent turns without ignorable hacks.
 *
 * @module @enkeep/runtime-runner/tests/attachment-context-and-agent.test
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { bootDshRuntime } from '../src/runtime/dsh-boot.js';

function computeEtag(data: string | Buffer): string {
  const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  return `"${createHash('sha256').update(buf).digest('hex')}"`;
}

describe('Runtime Agent Attachment Context & Execution', () => {
  let tmpDir: string;
  let aliceHome: string;
  let aliceSpaces: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'enkeep-att-agent-test-'));
    aliceHome = path.join(tmpDir, 'alice', '.dsh');
    aliceSpaces = path.join(tmpDir, 'alice', 'spaces');

    fs.mkdirSync(aliceHome, { recursive: true, mode: 0o700 });
    fs.mkdirSync(aliceSpaces, { recursive: true, mode: 0o700 });
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  it('injects model-visible attachment context and agent executes read tool on snapshot path', async () => {
    const spaceName = 'space-alpha';
    const spacePath = path.join(aliceSpaces, spaceName);
    fs.mkdirSync(spacePath, { recursive: true, mode: 0o700 });

    // Seed original file and snapshot copy
    const originalContent = 'CONFIDENTIAL AUDIT DATA: 42 ISSUES RESOLVED';
    const etag = computeEtag(originalContent);
    const sha = etag.replace(/"/g, '');
    const snapshotDir = path.join(spacePath, '.attachments', sha);
    fs.mkdirSync(snapshotDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(spacePath, 'audit.txt'), originalContent, 'utf8');
    fs.writeFileSync(path.join(snapshotDir, 'audit.txt'), originalContent, 'utf8');

    const runtime = await bootDshRuntime({
      userId: 'alice',
      dshHome: aliceHome,
      spacesDir: aliceSpaces,
    });

    try {
      const sessionId = 'ses_0123456789abcdef0123456789000001';
      const turnId = 'turn_0123456789abcdef0123456789000001';

      const attachments = [
        {
          id: 'att_0123456789abcdef0123456789000001',
          relativePath: 'audit.txt',
          snapshotPath: `.attachments/${sha}/audit.txt`,
          etag,
          size: Buffer.byteLength(originalContent, 'utf8'),
          mediaType: 'text/plain; charset=utf-8',
          displayName: 'Audit Report',
        },
      ];

      // Prompt asking model to read attachment using read tool
      const prompt = `[enkeep-test-tool-call=read:{"file_path":".attachments/${sha}/audit.txt"}] Please read the audit report attachment and summarize it.`;

      const turnResult = await runtime.sendFollowup(
        prompt,
        sessionId,
        turnId,
        null,
        spaceName,
        attachments
      );

      expect(turnResult.status).toBe('completed');
      expect(turnResult.replyText).toBeDefined();

      const agent = await runtime.getOrCreateAgent(sessionId, null, spaceName);
      const events = agent.session.snapshotEvents();

      // 1. Verify synthetic attachment context user/message injected before human user message
      const attMsgEvent = events.find(
        (e) => e.type === 'user/message' && (e.data as any).source?.plugin === 'enkeep/attachments'
      );
      expect(attMsgEvent).toBeDefined();
      const attText = JSON.stringify((attMsgEvent!.data as any).content);
      expect(attText).toContain(`.attachments/${sha}/audit.txt`);
      expect(attText).toContain('Audit Report');

      // 2. Verify user message contains original text
      const userMsgEvent = events.find((e) => e.type === 'user/message' && (e.data as any).source?.kind === 'user');
      expect(userMsgEvent).toBeDefined();
      const userMsgData = userMsgEvent!.data as any;
      const textBlock = userMsgData.content.find((c: any) => c.type === 'text');
      expect(textBlock.text).toBe(prompt);

      // 3. Verify tool call and tool result on the snapshot path
      const toolCall = events.find((e) => e.type === 'tool/call' && (e.data as any).name === 'read');
      expect(toolCall).toBeDefined();
      expect((toolCall!.data as any).arguments).toContain(`.attachments/${sha}/audit.txt`);

      const toolResult = events.find((e) => e.type === 'tool/result');
      expect(toolResult).toBeDefined();
      const toolResultText = JSON.stringify((toolResult!.data as any).message?.content);
      expect(toolResultText).toContain('CONFIDENTIAL AUDIT DATA');
    } finally {
      await runtime.dispose();
    }
  });

  it('guarantees immutability: agent reading snapshot gets historical content after workspace file is mutated', async () => {
    const spaceName = 'space-beta';
    const spacePath = path.join(aliceSpaces, spaceName);
    fs.mkdirSync(spacePath, { recursive: true, mode: 0o700 });

    const v1Content = 'VERSION 1 IMMUTABLE AUDIT REPORT';
    const v1Etag = computeEtag(v1Content);
    const v1Sha = v1Etag.replace(/"/g, '');

    const snapshotDir = path.join(spacePath, '.attachments', v1Sha);
    fs.mkdirSync(snapshotDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(spacePath, 'contract.txt'), v1Content, 'utf8');
    fs.writeFileSync(path.join(snapshotDir, 'contract.txt'), v1Content, 'utf8');

    const runtime = await bootDshRuntime({
      userId: 'alice',
      dshHome: aliceHome,
      spacesDir: aliceSpaces,
    });

    try {
      const sessionId = 'ses_0123456789abcdef0123456789000002';

      // 1. Turn 1: Send message with v1 attachment
      const turn1Result = await runtime.sendFollowup(
        `[enkeep-test-tool-call=read:{"file_path":".attachments/${v1Sha}/contract.txt"}] Check contract v1`,
        sessionId,
        'turn_0123456789abcdef0123456789000002',
        null,
        spaceName,
        [
          {
            id: 'att_0002',
            relativePath: 'contract.txt',
            snapshotPath: `.attachments/${v1Sha}/contract.txt`,
            etag: v1Etag,
            size: Buffer.byteLength(v1Content, 'utf8'),
            mediaType: 'text/plain; charset=utf-8',
          },
        ]
      );
      expect(turn1Result.status).toBe('completed');

      // 2. User completely overwrites original workspace file with v2 breaking changes
      const v2Content = 'COMPLETELY OVERWRITTEN CONTENT (V2)';
      fs.writeFileSync(path.join(spacePath, 'contract.txt'), v2Content, 'utf8');

      // 3. Turn 2: Agent reads from original attachment snapshot path
      const turn2Result = await runtime.sendFollowup(
        `[enkeep-test-tool-call=read:{"file_path":".attachments/${v1Sha}/contract.txt"}] Re-verify contract v1 snapshot`,
        sessionId,
        'turn_0123456789abcdef0123456789000003',
        null,
        spaceName
      );
      expect(turn2Result.status).toBe('completed');

      const agent = await runtime.getOrCreateAgent(sessionId, null, spaceName);
      const toolResults = agent.session.snapshotEvents().filter((e) => e.type === 'tool/result');
      expect(toolResults.length).toBeGreaterThanOrEqual(2);

      const lastToolResultText = JSON.stringify((toolResults[toolResults.length - 1].data as any).message?.content);
      // Must contain VERSION 1, not the mutated V2
      expect(lastToolResultText).toContain('VERSION 1 IMMUTABLE AUDIT REPORT');
      expect(lastToolResultText).not.toContain('COMPLETELY OVERWRITTEN CONTENT');
    } finally {
      await runtime.dispose();
    }
  });

  it('preserves attachment history across runtime restart and session resume', async () => {
    const spaceName = 'space-gamma';
    const spacePath = path.join(aliceSpaces, spaceName);
    fs.mkdirSync(spacePath, { recursive: true, mode: 0o700 });

    const content = 'PERSISTENCE TEST CONTENT';
    const etag = computeEtag(content);
    const sha = etag.replace(/"/g, '');

    const snapshotDir = path.join(spacePath, '.attachments', sha);
    fs.mkdirSync(snapshotDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(spacePath, 'data.txt'), content, 'utf8');
    fs.writeFileSync(path.join(snapshotDir, 'data.txt'), content, 'utf8');

    const sessionId = 'ses_0123456789abcdef0123456789000003';

    // 1. Boot first runtime instance
    const runtime1 = await bootDshRuntime({
      userId: 'alice',
      dshHome: aliceHome,
      spacesDir: aliceSpaces,
    });

    await runtime1.sendFollowup(
      'Initial turn with attachment',
      sessionId,
      'turn_0123456789abcdef0123456789000011',
      null,
      spaceName,
      [
        {
          id: 'att_0003',
          relativePath: 'data.txt',
          snapshotPath: `.attachments/${sha}/data.txt`,
          etag,
          size: Buffer.byteLength(content, 'utf8'),
          mediaType: 'text/plain; charset=utf-8',
        },
      ]
    );
    await runtime1.dispose();

    // 2. Boot second runtime instance and resume session
    const runtime2 = await bootDshRuntime({
      userId: 'alice',
      dshHome: aliceHome,
      spacesDir: aliceSpaces,
    });

    try {
      const resumedAgent = await runtime2.getOrCreateAgent(sessionId, null, spaceName);
      const events = resumedAgent.session.snapshotEvents();

      const attMsgEvent = events.find(
        (e) => e.type === 'user/message' && (e.data as any).source?.plugin === 'enkeep/attachments'
      );
      expect(attMsgEvent).toBeDefined();
      const attText = JSON.stringify((attMsgEvent!.data as any).content);
      expect(attText).toContain(`.attachments/${sha}/data.txt`);

      // Continue session with follow-up turn
      const turn2 = await runtime2.sendFollowup(
        `[enkeep-test-tool-call=read:{"file_path":".attachments/${sha}/data.txt"}] Follow-up turn reading attachment`,
        sessionId,
        'turn_0123456789abcdef0123456789000012',
        null,
        spaceName
      );
      expect(turn2.status).toBe('completed');
    } finally {
      await runtime2.dispose();
    }
  });
});
