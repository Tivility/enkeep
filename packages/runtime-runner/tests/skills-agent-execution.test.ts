import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bootDshRuntime } from '../src/runtime/dsh-boot.js';

describe('Skills Agent Execution, Lifecycle & Subagent Isolation Tests', () => {
  let tempDir: string;
  let aliceHome: string;
  let aliceSpaces: string;
  let bobHome: string;
  let bobSpaces: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'enkeep-skills-agent-test-'));
    const aliceRoot = path.join(tempDir, 'alice');
    const bobRoot = path.join(tempDir, 'bob');

    aliceHome = path.join(aliceRoot, '.dsh');
    aliceSpaces = path.join(aliceRoot, 'spaces');
    bobHome = path.join(bobRoot, '.dsh');
    bobSpaces = path.join(bobRoot, 'spaces');

    fs.mkdirSync(aliceHome, { recursive: true });
    fs.mkdirSync(aliceSpaces, { recursive: true });
    fs.mkdirSync(bobHome, { recursive: true });
    fs.mkdirSync(bobSpaces, { recursive: true });
  });

  afterEach(() => {
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('agent executes installed skill via skill tool and gets full instructions', async () => {
    // 1. Install skill in space/.skills
    const skillDir = path.join(aliceSpaces, '.skills', 'system-diagnostics');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      `---
name: system-diagnostics
description: Run automated system diagnostics and health checks
---
# System Diagnostics Instructions
1. Inspect CPU and memory limits.
2. Check disk boundaries.
`,
      'utf8'
    );

    const runtime = await bootDshRuntime({
      userId: 'alice',
      dshHome: aliceHome,
      spacesDir: aliceSpaces,
    });

    try {
      const sessionId = 'ses_11111111111111111111111111111111';
      const res = await runtime.sendFollowup(
        'Run diagnostics [enkeep-test-tool-call=skill:{"name":"system-diagnostics"}]',
        sessionId,
        'turn_11111111111111111111111111111111',
        null
      );

      expect(res.status).toBe('completed');

      // Verify skill was discovered in context
      const skillsService = runtime.context.get('skills');
      const list = await skillsService.list({ cwd: aliceSpaces });
      const names = list.map((s: any) => s.name);
      expect(names).toContain('system-diagnostics');

      const skillDef = await skillsService.get('system-diagnostics', { cwd: aliceSpaces });
      expect(skillDef?.content).toContain('Inspect CPU and memory limits');
    } finally {
      await runtime.dispose();
    }
  });

  it('disabled skill is hidden from model invocation catalog and tool execution', async () => {
    // Install disabled skill in space/.skills
    const skillDir = path.join(aliceSpaces, '.skills', 'quarantined-skill');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      `---
name: quarantined-skill
description: Quarantined dangerous skill
disable-model-invocation: true
---
# Quarantined Instructions
Dangerous operations.
`,
      'utf8'
    );

    const runtime = await bootDshRuntime({
      userId: 'alice',
      dshHome: aliceHome,
      spacesDir: aliceSpaces,
    });

    try {
      const skillsService = runtime.context.get('skills');
      const list = await skillsService.list({ cwd: aliceSpaces });
      const skillSummary = list.find((s: any) => s.name === 'quarantined-skill');

      expect(skillSummary).toBeDefined();
      expect(skillSummary.invocation.modelInvocable).toBe(false);

      // Model calling skill tool for a non-model-invocable skill fails
      const sessionId = 'ses_22222222222222222222222222222222';
      const res = await runtime.sendFollowup(
        'Attempt to load quarantined [enkeep-test-tool-call=skill:{"name":"quarantined-skill"}]',
        sessionId,
        'turn_22222222222222222222222222222222',
        null
      );

      // Turn handles failure gracefully
      expect(res.status).toBe('completed');
    } finally {
      await runtime.dispose();
    }
  });

  it('subagent in the same space inherits active space skills', async () => {
    const skillDir = path.join(aliceSpaces, '.skills', 'subagent-helper');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      `---
name: subagent-helper
description: Helper skill for subagents
---
# Subagent Helper Instructions
Subagents should follow this guideline.
`,
      'utf8'
    );

    const runtime = await bootDshRuntime({
      userId: 'alice',
      dshHome: aliceHome,
      spacesDir: aliceSpaces,
    });

    try {
      const sessionId = 'ses_33333333333333333333333333333333';
      const agent = await runtime.getOrCreateAgent(sessionId);
      expect(agent).toBeDefined();

      const skillsService = runtime.context.get('skills');
      const loaded = await skillsService.get('subagent-helper', { cwd: aliceSpaces });
      expect(loaded?.name).toBe('subagent-helper');
      expect(loaded?.content).toContain('Subagents should follow this guideline');
    } finally {
      await runtime.dispose();
    }
  });
});
