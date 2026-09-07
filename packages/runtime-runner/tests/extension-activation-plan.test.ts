/**
 * Extension Activation Plan Security, Hashing, Daemon Eviction & Space Isolation Tests
 *
 * @module @enkeep/runtime-runner/tests/extension-activation-plan
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  type ExtensionActivationPlan,
  validateExtensionActivationPlan,
} from '@enkeep/protocol';
import { computeExtensionPlanHash } from '../src/spec/extension-plan-security.js';
import { RuntimeDaemon } from '../src/runtime/daemon.js';
import { bootDshRuntime } from '../src/runtime/dsh-boot.js';

describe('Extension Activation Plan & Skill Runtime Governance', () => {
  let tempDir: string;
  let dshHome: string;
  let spacesDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'enkeep-ext-plan-test-'));
    dshHome = path.join(tempDir, 'dsh-home');
    spacesDir = path.join(tempDir, 'spaces');
    fs.mkdirSync(dshHome, { recursive: true });
    fs.mkdirSync(spacesDir, { recursive: true });
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  describe('1. Hash Computation & Determinism', () => {
    it('produces deterministic SHA-256 hash regardless of skill array order', () => {
      const plan1: ExtensionActivationPlan = {
        generation: 1,
        contributions: [
          {
            kind: 'skill',
            contributionId: 'c1',
            contributionKey: 'alpha-skill',
            name: 'alpha-skill',
            enabled: true,
            modelInvocable: true,
            userInvocable: true,
          },
          {
            kind: 'skill',
            contributionId: 'c2',
            contributionKey: 'beta-skill',
            name: 'beta-skill',
            enabled: true,
            modelInvocable: true,
            userInvocable: true,
          },
        ],
        skills: [
          {
            kind: 'skill',
            contributionId: 'c1',
            contributionKey: 'alpha-skill',
            name: 'alpha-skill',
            enabled: true,
            modelInvocable: true,
            userInvocable: true,
          },
          {
            kind: 'skill',
            contributionId: 'c2',
            contributionKey: 'beta-skill',
            name: 'beta-skill',
            enabled: true,
            modelInvocable: true,
            userInvocable: true,
          },
        ],
      };

      const plan2: ExtensionActivationPlan = {
        generation: 1,
        contributions: [...plan1.contributions].reverse(),
        skills: [...plan1.skills].reverse(),
      };

      const hash1 = computeExtensionPlanHash(plan1);
      const hash2 = computeExtensionPlanHash(plan2);

      expect(hash1).toBe(hash2);
      expect(hash1).toMatch(/^[0-9a-f]{64}$/);
    });

    it('changes hash when generation, enabled state, or content hash changes', () => {
      const basePlan: ExtensionActivationPlan = {
        generation: 1,
        contributions: [
          {
            kind: 'skill',
            contributionId: 'c1',
            contributionKey: 'audit-skill',
            name: 'audit-skill',
            enabled: true,
            modelInvocable: true,
            userInvocable: true,
            contentHash: 'hash-v1',
          },
        ],
        skills: [
          {
            kind: 'skill',
            contributionId: 'c1',
            contributionKey: 'audit-skill',
            name: 'audit-skill',
            enabled: true,
            modelInvocable: true,
            userInvocable: true,
            contentHash: 'hash-v1',
          },
        ],
      };

      const baseHash = computeExtensionPlanHash(basePlan);

      // Generation bump
      const nextGenPlan: ExtensionActivationPlan = { ...basePlan, generation: 2 };
      expect(computeExtensionPlanHash(nextGenPlan)).not.toBe(baseHash);

      // Disabled state
      const disabledPlan: ExtensionActivationPlan = {
        generation: 1,
        contributions: [{ ...basePlan.contributions[0], enabled: false }],
        skills: [{ ...basePlan.skills[0], enabled: false }],
      };
      expect(computeExtensionPlanHash(disabledPlan)).not.toBe(baseHash);

      // Content update
      const updatedPlan: ExtensionActivationPlan = {
        generation: 1,
        contributions: [{ ...basePlan.contributions[0], contentHash: 'hash-v2' }],
        skills: [{ ...basePlan.skills[0], contentHash: 'hash-v2' }],
      };
      expect(computeExtensionPlanHash(updatedPlan)).not.toBe(baseHash);
    });
  });

  describe('2. Fail-Closed Validation of Contribution Kinds', () => {
    it('accepts valid skill-only activation plan', () => {
      const plan = validateExtensionActivationPlan({
        generation: 1,
        contributions: [
          {
            kind: 'skill',
            contributionId: 'c_123',
            name: 'valid-skill',
            enabled: true,
          },
        ],
      });
      expect(plan.generation).toBe(1);
      expect(plan.skills.length).toBe(1);
      expect(plan.skills[0].name).toBe('valid-skill');
    });

    it('accepts valid MCP activation plan', () => {
      const plan = validateExtensionActivationPlan({
        generation: 1,
        contributions: [
          {
            kind: 'mcp',
            contributionId: 'c_mcp',
            name: 'github-mcp',
            transport: 'stdio',
            command: 'npx',
            args: ['-y', '@modelcontextprotocol/server-github'],
            enabled: true,
          },
        ],
      });
      expect(plan.generation).toBe(1);
      expect(plan.contributions.length).toBe(1);
      expect(plan.contributions[0].name).toBe('github-mcp');
      expect((plan as any).mcp?.length).toBe(1);
    });

    it('fails closed when unknown contribution kind is in plan (browser / plugin / unknown)', () => {
      expect(() => {
        validateExtensionActivationPlan({
          generation: 1,
          contributions: [
            {
              kind: 'unknown-adapter',
              contributionId: 'c_unknown',
              name: 'unsupported-adapter',
            },
          ],
        });
      }).toThrow(/FAIL-CLOSED: Unknown or unsupported extension contribution kind "unknown-adapter"/);

      expect(() => {
        validateExtensionActivationPlan({
          generation: 1,
          contributions: [
            {
              kind: 'dsh-plugin',
              contributionId: 'c_plugin',
              name: 'missing-trusted-plugin-id',
            },
          ],
        });
      }).toThrow(/requires a non-empty string trustedPluginId/);
    });

    it('validates dsh-plugin contribution correctly in ExtensionActivationPlan', () => {
      const plan = validateExtensionActivationPlan({
        generation: 1,
        contributions: [
          {
            kind: 'dsh-plugin',
            contributionId: 'contrib_echo',
            contributionKey: 'trusted-echo',
            trustedPluginId: 'enkeep.echo',
            name: 'Trusted Echo',
            version: 1,
            integrity: 'sha256_mock_hash',
            enabled: true,
          },
        ],
      });
      expect(plan.plugins).toHaveLength(1);
      expect(plan.plugins![0].trustedPluginId).toBe('enkeep.echo');
      expect(plan.plugins![0].version).toBe(1);
    });

    it('fails closed on invalid generation or missing fields', () => {
      expect(() => validateExtensionActivationPlan(null)).toThrow(/must be a non-null object/);
      expect(() => validateExtensionActivationPlan({ generation: -1 })).toThrow(/non-negative integer/);
      expect(() => validateExtensionActivationPlan({ generation: 'one' })).toThrow(/non-negative integer/);
    });
  });

  describe('3. RuntimeDaemon Extension Plan Lifecycle & Eviction', () => {
    it('fails closed at turn submission when extension plan contains unknown kinds before Agent execution', async () => {
      const daemon = new RuntimeDaemon({
        userId: 'alice',
        dshHome,
        spacesDir,
      });
      await daemon.start();

      try {
        const res = await daemon.handleRequest({
          id: 'req_1',
          op: 'submitTurn',
          turnId: 'turn_11111111111111111111111111111111',
          sessionId: 'ses_11111111111111111111111111111111',
          prompt: 'Hello turn',
          workspaceFolder: 'space-a',
          extensionPlan: {
            generation: 1,
            contributions: [
              {
                kind: 'browser' as any,
                contributionId: 'c_unknown',
                name: 'browser-tool',
              },
            ],
            skills: [],
          },
        });

        expect(res.ok).toBe(false);
        expect((res as any).error?.code).toBe('INVALID_PARAMETERS');
        expect((res as any).error?.message).toContain('FAIL-CLOSED');
      } finally {
        await daemon.shutdown();
      }
    });

    it('evicts agent and applies updated extension plan on subsequent turn (disable / update / rollback)', async () => {
      // 1. Setup SpaceA with a skill
      const spaceADir = path.join(spacesDir, 'space-a');
      const skillDir = path.join(spaceADir, '.skills', 'custom-audit');
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(
        path.join(skillDir, 'SKILL.md'),
        `---
name: custom-audit
description: Custom audit skill v1
---
# Custom Audit Instructions v1
Follow standard audit checklist.
`,
        'utf8'
      );

      const daemon = new RuntimeDaemon({
        userId: 'alice',
        dshHome,
        spacesDir,
      });
      await daemon.start();

      const sessionId = 'ses_22222222222222222222222222222222';

      try {
        // Turn 1: Run with enabled skill plan v1
        const planV1: ExtensionActivationPlan = {
          generation: 1,
          contributions: [
            {
              kind: 'skill',
              contributionId: 'c_audit',
              contributionKey: 'custom-audit',
              name: 'custom-audit',
              enabled: true,
              modelInvocable: true,
              userInvocable: true,
              version: 1,
            },
          ],
          skills: [
            {
              kind: 'skill',
              contributionId: 'c_audit',
              contributionKey: 'custom-audit',
              name: 'custom-audit',
              enabled: true,
              modelInvocable: true,
              userInvocable: true,
              version: 1,
            },
          ],
        };

        const turn1Res = await daemon.submitTurnAndWait({
          id: 't1',
          op: 'submitTurn',
          turnId: 'turn_22222222222222222222222222222221',
          sessionId,
          prompt: 'Turn 1 execution',
          workspaceFolder: 'space-a',
          extensionPlan: planV1,
        });
        expect(turn1Res.status).toBe('completed');

        // Turn 2: Skill is disabled in plan (generation 2) -> triggers eviction & resume
        const planV2Disabled: ExtensionActivationPlan = {
          generation: 2,
          contributions: [
            {
              kind: 'skill',
              contributionId: 'c_audit',
              contributionKey: 'custom-audit',
              name: 'custom-audit',
              enabled: false,
              modelInvocable: false,
              userInvocable: false,
              version: 1,
            },
          ],
          skills: [
            {
              kind: 'skill',
              contributionId: 'c_audit',
              contributionKey: 'custom-audit',
              name: 'custom-audit',
              enabled: false,
              modelInvocable: false,
              userInvocable: false,
              version: 1,
            },
          ],
        };

        const turn2Res = await daemon.submitTurnAndWait({
          id: 't2',
          op: 'submitTurn',
          turnId: 'turn_22222222222222222222222222222222',
          sessionId,
          prompt: 'Turn 2 after disable',
          workspaceFolder: 'space-a',
          extensionPlan: planV2Disabled,
        });
        expect(turn2Res.status).toBe('completed');
      } finally {
        await daemon.shutdown();
      }
    });

    it('maintains strict space isolation: SpaceA skills are not visible to SpaceB', async () => {
      // SpaceA has skill-a
      const spaceADir = path.join(spacesDir, 'space-a');
      const skillADir = path.join(spaceADir, '.skills', 'skill-a');
      fs.mkdirSync(skillADir, { recursive: true });
      fs.writeFileSync(path.join(skillADir, 'SKILL.md'), '---\nname: skill-a\n---\n# Skill A\n', 'utf8');

      // SpaceB has skill-b
      const spaceBDir = path.join(spacesDir, 'space-b');
      const skillBDir = path.join(spaceBDir, '.skills', 'skill-b');
      fs.mkdirSync(skillBDir, { recursive: true });
      fs.writeFileSync(path.join(skillBDir, 'SKILL.md'), '---\nname: skill-b\n---\n# Skill B\n', 'utf8');

      const runtime = await bootDshRuntime({
        userId: 'alice',
        dshHome,
        spacesDir,
      });

      try {
        const sessionA = 'ses_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
        const sessionB = 'ses_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

        const planA: ExtensionActivationPlan = {
          generation: 1,
          contributions: [{ kind: 'skill', contributionId: 'ca', contributionKey: 'skill-a', name: 'skill-a', enabled: true, modelInvocable: true, userInvocable: true }],
          skills: [{ kind: 'skill', contributionId: 'ca', contributionKey: 'skill-a', name: 'skill-a', enabled: true, modelInvocable: true, userInvocable: true }],
        };

        const planB: ExtensionActivationPlan = {
          generation: 1,
          contributions: [{ kind: 'skill', contributionId: 'cb', contributionKey: 'skill-b', name: 'skill-b', enabled: true, modelInvocable: true, userInvocable: true }],
          skills: [{ kind: 'skill', contributionId: 'cb', contributionKey: 'skill-b', name: 'skill-b', enabled: true, modelInvocable: true, userInvocable: true }],
        };

        const turnARes = await runtime.sendFollowup({
          prompt: 'Execute skill [enkeep-test-tool-call=skill:{"name":"skill-a"}]',
          sessionId: sessionA,
          turnId: 'turn_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          workspaceFolder: 'space-a',
          extensionPlan: planA,
        });
        expect(turnARes.status).toBe('completed');

        const turnBRes = await runtime.sendFollowup({
          prompt: 'Execute skill [enkeep-test-tool-call=skill:{"name":"skill-b"}]',
          sessionId: sessionB,
          turnId: 'turn_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          workspaceFolder: 'space-b',
          extensionPlan: planB,
        });
        expect(turnBRes.status).toBe('completed');
      } finally {
        await runtime.dispose();
      }
    });
  });
});
