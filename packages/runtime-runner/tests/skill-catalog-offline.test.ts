import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { bootDshRuntime } from '../src/runtime/dsh-boot.js';
import { DshPlatformClient } from '@enkeep/dsh-platform-client';

describe('Skill Catalog Offline Integration Diagnostics', () => {
  let tmpDir: string;
  let testHome: string;
  let testSpaces: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'enkeep-skill-catalog-test-'));
    testHome = path.join(tmpDir, 'user', '.dsh');
    testSpaces = path.join(tmpDir, 'user', 'spaces');

    fs.mkdirSync(testHome, { recursive: true, mode: 0o700 });
    fs.mkdirSync(testSpaces, { recursive: true, mode: 0o700 });
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  it('diagnoses why skill catalog is empty in production', async () => {
    const spaceName = 'space-test';
    const spacePath = path.join(testSpaces, spaceName);
    const skillsDir = path.join(spacePath, '.skills', 'demo-skill');
    fs.mkdirSync(skillsDir, { recursive: true, mode: 0o700 });

    const skillContent = `---
name: demo-skill
description: A demo skill for testing catalog discovery
---
# Demo Skill Instructions
Execute demo skill properly.
`;
    fs.writeFileSync(path.join(skillsDir, 'SKILL.md'), skillContent, 'utf8');

    const mockPlatformClient = new DshPlatformClient({
      baseURL: 'http://127.0.0.1:9999/platform',
      timeoutMs: 1000,
    });

    const runtime = await bootDshRuntime({
      userId: 'test-user',
      dshHome: testHome,
      spacesDir: testSpaces,
      platformClient: mockPlatformClient,
    });

    try {
      const sessionId = 'ses_0123456789abcdef0123456789abcdef';
      const agent = await runtime.getOrCreateAgent(sessionId, null, spaceName);

      // (a) call ctx.skills.snapshot({cwd: spacePath, scope: agent}) and print {complete, skills: names}
      const fsService = agent.ctx.get('fs');
      console.log('FS_SERVICE_FOUND:', !!fsService);
      try {
        const resTarget = await fsService.resolve(path.join(spacePath, '.skills'));
        console.log('FS_RESOLVE_SKILLS:', resTarget);
        const listDirRes = await fsService.listDir(resTarget);
        console.log('FS_LIST_DIR_SKILLS:', listDirRes);
      } catch (err: any) {
        console.log('FS_TEST_ERR:', err);
      }

      const skillsService = (agent.ctx.get ? agent.ctx.get('skills') : undefined) ?? ((runtime as any).ctx?.get ? (runtime as any).ctx.get('skills') : undefined);
      console.log('SKILLS_SERVICE_FOUND:', !!skillsService);

      // Inspect providers in global layer vs agent layer
      const layers = (skillsService as any).layers;
      console.log('GLOBAL_PROVIDERS:', [...layers.global.providers.values()].map((p: any) => p.provider.name));
      const chainLayers = layers.chainLayers(agent);
      console.log('CHAIN_LAYERS_COUNT:', chainLayers.length);
      for (let i = 0; i < chainLayers.length; i++) {
        console.log(`CHAIN_LAYER_${i}_PROVIDERS:`, [...chainLayers[i].providers.values()].map((p: any) => p.provider.name));
      }

      const p0 = [...chainLayers[0].providers.values()][0].provider;
      console.log('P0_NAME:', p0.name);
      console.log('P0_CUSTOM_SKILL_DIRS:', (p0 as any).customSkillDirs);
      console.log('P0_INCLUDE_DEFAULT_ROOTS:', (p0 as any).includeDefaultRoots);
      if (typeof (p0 as any).roots === 'function') {
        const roots = await (p0 as any).roots(spacePath);
        console.log('P0_ROOTS_SPACE_PATH:', roots);
      }
      try {
        const p0List = await p0.list({ cwd: spacePath, scope: agent });
        console.log('P0_LIST_RESULT:', JSON.stringify(p0List));
      } catch (err: any) {
        console.log('P0_LIST_ERR:', err);
      }

      const snapshot = await skillsService.snapshot({ cwd: spacePath, scope: agent });
      const skillNames = snapshot.skills.map((s: any) => s.name);
      console.log('OBSERVED_SNAPSHOT:', JSON.stringify({ complete: snapshot.complete, skills: skillNames }));

      // (b) capture ctx.logger warnings containing 'skill file'
      const warnings: string[] = [];
      const originalWarn = agent.ctx.logger.warn.bind(agent.ctx.logger);
      agent.ctx.logger.warn = (msg: string, ...args: any[]) => {
        if (typeof msg === 'string' && msg.includes('skill file')) {
          warnings.push(msg);
        }
        originalWarn(msg, ...args);
      };

      // (c) run one agent/pre-step (or call the hook the same way dsh-tool-skill does) and assert a catalog message containing 'demo-skill' appears
      const preStepResult = await agent.ctx.waterfall('agent/pre-step', {
        agent,
        messages: [],
        turn: 1,
        step: 1,
        signal: new AbortController().signal,
      }, async () => ({ kind: 'enter', messages: [] } as any));
      console.log('PRE_STEP_RESULT_MESSAGES:', JSON.stringify(preStepResult));

      // (d) execute the skill tool with {name:'demo-skill'} and assert instructions text
      const toolsService = agent.ctx.tools ?? (agent.ctx.get ? agent.ctx.get('tools') : undefined);
      const skillTool = toolsService?.get?.('skill', agent);
      console.log('SKILL_TOOL_FOUND:', !!skillTool);
      expect(skillTool).toBeDefined();
      const toolResult = await skillTool.execute({ name: 'demo-skill' }, { agent });
      console.log('SKILL_TOOL_EXEC_RESULT:', JSON.stringify(toolResult));

      expect(snapshot.complete).toBe(true);
      expect(skillNames).toContain('demo-skill');
      expect(warnings).toHaveLength(0);
      expect(preStepResult.kind).toBe('enter');
      const catalogMsg = preStepResult.messages?.find((m: any) => m.source?.kind === 'skill-catalog');
      expect(catalogMsg).toBeDefined();
      expect(catalogMsg?.content?.[0]?.text).toContain('demo-skill');
      expect(toolResult.content).toContain('Execute demo skill properly.');
    } finally {
      await runtime.dispose();
    }
  });
});
