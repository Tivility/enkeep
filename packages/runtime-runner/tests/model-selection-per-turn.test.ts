import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  bootDshRuntime,
  type BootedDshRuntime,
} from '../src/runtime/dsh-boot.js';

describe('Per-Turn Model Selection Resolution & Dynamic Live Agent Update', () => {
  let tempDir: string;
  let dshHome: string;
  let spacesDir: string;
  let runtime: BootedDshRuntime;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'enkeep-model-sel-test-'));
    dshHome = path.join(tempDir, '.dsh');
    spacesDir = path.join(tempDir, 'spaces');
    fs.mkdirSync(dshHome, { recursive: true });
    fs.mkdirSync(spacesDir, { recursive: true });

    runtime = await bootDshRuntime({
      userId: 'alice',
      dshHome,
      spacesDir,
      provider: 'demo-provider',
      model: 'demo-model',
      llmEnabled: false,
    });
  });

  afterEach(async () => {
    try {
      await runtime.dispose();
    } catch {}
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  it('Turn 1 executes with default model, Turn 2 dynamically switches model on the SAME live agent, and logs official request/context event', async () => {
    const sessionId = 'ses_11112222333344445555666677778888';
    const turn1Id = 'turn_00000000000000000000000000000001';

    // 1. Turn 1: No explicit modelSelection override (uses default demo-model)
    const res1 = await runtime.sendFollowup({
      prompt: 'Hello from turn 1',
      sessionId,
      turnId: turn1Id,
      profile: null,
    });

    expect(res1.status).toBe('completed');
    expect(res1.modelInfo?.model).toBe('demo-model');
    expect(res1.modelInfo?.provider).toBe('demo-provider');

    // 2. Turn 2: Provide per-turn modelSelection override on the live agent
    const turn2Id = 'turn_00000000000000000000000000000002';
    const res2 = await runtime.sendFollowup({
      prompt: 'Hello from turn 2 with model override',
      sessionId,
      turnId: turn2Id,
      profile: null,
      modelSelection: {
        provider: 'cpa-gemini',
        model: 'gemini-3.7-flash-tiered',
        reasoningEffort: 'max',
        source: 'session',
        fallbackChain: [{ provider: 'cpa-claude', model: 'claude-fable-5' }],
      },
    });

    expect(res2.status).toBe('completed');
    expect(res2.modelInfo?.model).toBe('gemini-3.7-flash-tiered');
    expect(res2.modelInfo?.provider).toBe('cpa-gemini');
    expect(res2.modelInfo?.reasoningEffort).toBe('max');
    expect(res2.modelInfo?.source).toBe('session');

    // 3. Inspect session persistence JSONL to verify only official known events are logged
    const sessionsDir = path.join(dshHome, 'sessions');
    const jsonlFiles: string[] = [];
    if (fs.existsSync(sessionsDir)) {
      const entries = fs.readdirSync(sessionsDir, { recursive: true });
      for (const e of entries) {
        const full = path.join(sessionsDir, String(e));
        if (fs.statSync(full).isFile() && full.endsWith('.jsonl')) {
          jsonlFiles.push(full);
        }
      }
    }
    expect(jsonlFiles.length).toBeGreaterThan(0);
    const sessionFilePath = jsonlFiles[0];

    const lines = fs.readFileSync(sessionFilePath, 'utf8').trim().split('\n');
    const events = lines.map((l) => JSON.parse(l));

    for (const e of events) {
      expect(e.type).not.toMatch(/^enkeep\//);
    }

    const requestContextEvent = events.filter((e) => e.type === 'request/context').pop();
    expect(requestContextEvent).toBeDefined();
    expect(requestContextEvent.data.provider).toBe('cpa-gemini');
    expect(requestContextEvent.data.model).toBe('gemini-3.7-flash-tiered');

    const requestHeaderEvent = events.filter((e) => e.type === 'request/header').pop();
    expect(requestHeaderEvent).toBeDefined();
    expect(requestHeaderEvent.data.header.config.provider).toBe('cpa-gemini');
    expect(requestHeaderEvent.data.header.config.model).toBe('gemini-3.7-flash-tiered');
    expect(requestHeaderEvent.data.header.config.reasoningEffort).toBe('max');

    // 4. Clean runtime recreation / resumption from JSONL persistence
    await runtime.dispose();

    const resumedRuntime = await bootDshRuntime({
      userId: 'alice',
      dshHome,
      spacesDir,
      provider: 'demo-provider',
      model: 'demo-model',
      llmEnabled: false,
    });

    try {
      const turn3Id = 'turn_00000000000000000000000000000003';
      const res3 = await resumedRuntime.sendFollowup({
        prompt: 'Hello from turn 3 on resumed runtime',
        sessionId,
        turnId: turn3Id,
        profile: null,
      });

      expect(res3.status).toBe('completed');
      expect(res3.eventsCount).toBeGreaterThan(res2.eventsCount);
    } finally {
      await resumedRuntime.dispose();
    }
  });
});
