/**
 * Regression: a session that recorded `compaction/settings` must resume after a runtime restart.
 *
 * `@tivility/dsh-compaction-window` writes a `compaction/settings` event (not marked ignorable)
 * whenever a session gets its own working context window: every top-level session whose turn
 * carries `contextWindow`, and every subagent child. DSH 0.2.1-rc.5 refuses to load a log that
 * holds an event type outside `KNOWN_SESSION_EVENT_TYPES`, so a cold resume of such a session
 * failed with "CRITICAL SESSION RESUME FAILURE". The type is registered through the pnpm patches
 * on `@deepseek-ai/dsh-session` and on the bundled verifier worker of
 * `@deepseek-ai/dsh-session-persistence-jsonl` (see pnpm-workspace.yaml patchedDependencies).
 *
 * Synthetic identifiers and temporary paths only.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { KNOWN_SESSION_EVENT_TYPES } from '@deepseek-ai/dsh-session';
import type { CompactionWindowEngine } from '@tivility/dsh-compaction-window';
import { bootDshRuntime, type DshBootedRuntime } from '../src/runtime/dsh-boot.js';

function filesContaining(root: string, needle: string): string[] {
  const hits: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && fs.readFileSync(full).includes(needle)) hits.push(full);
    }
  };
  walk(root);
  return hits;
}

describe('compaction/settings survives a cold resume', () => {
  let tmpDir: string;
  let dshHome: string;
  let spacesDir: string;
  let runtime: DshBootedRuntime | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'enkeep-compaction-settings-resume-'));
    dshHome = path.join(tmpDir, '.dsh');
    spacesDir = path.join(tmpDir, 'spaces');
    fs.mkdirSync(dshHome, { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.join(spacesDir, 'space-synthetic'), { recursive: true, mode: 0o700 });
  });

  afterEach(async () => {
    if (runtime) await runtime.dispose();
    runtime = undefined;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('registers compaction/settings as a known session event type', () => {
    expect(KNOWN_SESSION_EVENT_TYPES.has('compaction/settings')).toBe(true);
  });

  it('continues a top-level session whose log holds compaction/settings after the runtime restarts', async () => {
    const sessionId = 'ses_00000000000000000000000000000001';
    const boot = () => bootDshRuntime({ userId: 'user-synthetic-alice', dshHome, spacesDir, contextWindow: 1000000 });

    runtime = await boot();
    const first = await runtime.sendFollowup({
      prompt: 'First turn with a session working window',
      sessionId,
      turnId: 'turn_00000000000000000000000000000001',
      workspaceFolder: 'space-synthetic',
      contextWindow: 272000,
    });
    expect(first.status).toBe('completed');
    await runtime.dispose();
    runtime = undefined;

    // The event that used to break resume is really on disk.
    expect(filesContaining(dshHome, '"compaction/settings"').length).toBeGreaterThan(0);

    runtime = await boot();
    // Cold resume: loading the session replays its log, including compaction/settings, and the
    // persisted session override is read back.
    const compaction = runtime.context.get('compaction') as CompactionWindowEngine;
    const agent = await runtime.getOrCreateAgent(sessionId, null, 'space-synthetic');
    const effective = await compaction.effectiveSettings(agent.session);
    expect(effective.contextWindow.value).toBe(272000);
    expect(effective.contextWindow.source).toBe('session');

    // The platform passes the working window on every turn; the conversation continues.
    const second = await runtime.sendFollowup({
      prompt: 'Second turn after a cold resume',
      sessionId,
      turnId: 'turn_00000000000000000000000000000002',
      workspaceFolder: 'space-synthetic',
      contextWindow: 272000,
    });
    expect(second.status).toBe('completed');
  });
});
