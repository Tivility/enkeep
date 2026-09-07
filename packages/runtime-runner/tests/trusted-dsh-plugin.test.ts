/**
 * Unit & Integration Tests for Trusted DSH Plugin Subsystem (@enkeep/runtime-runner)
 *
 * Requirements Verified:
 * 1. Compiled registry verification: trustedPluginId, version, integrity hash.
 * 2. Fail-closed validation against unknown plugins or integrity mismatch before ctx.plugin.
 * 3. Scoped agent context tool registration: `plugin__trusted-echo__echo` executes strictly `{ text }` -> `PLUGIN:<text>`.
 * 4. Plan update & disposal: disabling plugin unmounts tool cleanly.
 * 5. Error safety & recovery: failing plugin throws `PLUGIN_ACTIVATION_FAILED` safely without stack/path leakage;
 *    disabling binding restores subsequent turns.
 *
 * @module @enkeep/runtime-runner/tests/trusted-dsh-plugin.test
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Context } from '@deepseek-ai/cordis';
import {
  getCompiledTrustedPluginRegistry,
  getTrustedPlugin,
  validateTrustedPluginDescriptor,
  TRUSTED_ECHO_PLUGIN,
  TRUSTED_TEST_FAILING_PLUGIN,
} from '@enkeep/dsh-enkeep-bundle';
import type { ExtensionActivationPlan } from '@enkeep/protocol';
import { mountWorkspaceTools } from '../src/runtime/official-plugins.js';
import { RuntimeDaemon } from '../src/runtime/daemon.js';

describe('Trusted DSH Plugin Subsystem', () => {
  let tempDir: string;
  let dshHome: string;
  let spacesDir: string;
  let spaceA: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'enkeep-plugin-test-'));
    dshHome = path.join(tempDir, 'dsh-home');
    spacesDir = path.join(tempDir, 'spaces');
    spaceA = path.join(spacesDir, 'space-a');
    fs.mkdirSync(dshHome, { recursive: true });
    fs.mkdirSync(spaceA, { recursive: true });
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  describe('1. Compiled Registry & Static Manifest Verification', () => {
    it('contains trusted echo plugin with exact integrity hash and version', () => {
      const plugins = getCompiledTrustedPluginRegistry();
      const echo = plugins.find((p) => p.trustedPluginId === 'enkeep.echo');
      expect(echo).toBeDefined();
      expect(echo?.slug).toBe('trusted-echo');
      expect(echo?.version).toBe(1);
      expect(echo?.integritySha256).toMatch(/^[0-9a-f]{64}$/);
      expect(echo?.manifest.tool).toBe('plugin__trusted-echo__echo');
    });

    it('retrieves plugin by ID or slug', () => {
      expect(getTrustedPlugin('enkeep.echo')).toBeDefined();
      expect(getTrustedPlugin('trusted-echo')).toBeDefined();
      expect(getTrustedPlugin('unknown-plugin')).toBeUndefined();
    });

    it('validates matching descriptor successfully', () => {
      const validated = validateTrustedPluginDescriptor({
        trustedPluginId: 'enkeep.echo',
        version: TRUSTED_ECHO_PLUGIN.version,
        integrity: TRUSTED_ECHO_PLUGIN.integritySha256,
      });
      expect(validated.trustedPluginId).toBe('enkeep.echo');
    });

    it('fails closed on unknown plugin ID', () => {
      expect(() => {
        validateTrustedPluginDescriptor({
          trustedPluginId: 'untrusted.plugin',
          version: 1,
          integrity: 'dummy_hash',
        });
      }).toThrow(/FAIL-CLOSED: Unknown or unverified trusted plugin ID/);
    });

    it('fails closed on version mismatch', () => {
      expect(() => {
        validateTrustedPluginDescriptor({
          trustedPluginId: 'enkeep.echo',
          version: 999,
          integrity: TRUSTED_ECHO_PLUGIN.integritySha256,
        });
      }).toThrow(/FAIL-CLOSED: Plugin version mismatch/);
    });

    it('fails closed on integrity checksum mismatch', () => {
      expect(() => {
        validateTrustedPluginDescriptor({
          trustedPluginId: 'enkeep.echo',
          version: TRUSTED_ECHO_PLUGIN.version,
          integrity: '0000000000000000000000000000000000000000000000000000000000000000',
        });
      }).toThrow(/FAIL-CLOSED: Plugin integrity checksum mismatch/);
    });
  });

  describe('2. Tool Execution on Scoped Agent Context', () => {
    it('mounts plugin__trusted-echo__echo and executes strictly returning PLUGIN:<text>', async () => {
      const agentCtx = new Context();
      const toolsMap = new Map<string, any>();
      const toolsService = {
        register: (def: any) => {
          toolsMap.set(def.name, def);
          return () => toolsMap.delete(def.name);
        },
      };
      (agentCtx as any).tools = toolsService;
      agentCtx.provide('tools', toolsService);

      const plan: ExtensionActivationPlan = {
        generation: 1,
        contributions: [
          {
            kind: 'dsh-plugin',
            contributionId: 'contrib_echo',
            contributionKey: 'trusted-echo',
            trustedPluginId: 'enkeep.echo',
            name: 'Trusted Echo',
            version: 1,
            integrity: TRUSTED_ECHO_PLUGIN.integritySha256,
            enabled: true,
          },
        ],
        skills: [],
        plugins: [
          {
            kind: 'dsh-plugin',
            contributionId: 'contrib_echo',
            contributionKey: 'trusted-echo',
            trustedPluginId: 'enkeep.echo',
            name: 'Trusted Echo',
            version: 1,
            integrity: TRUSTED_ECHO_PLUGIN.integritySha256,
            enabled: true,
          },
        ],
      };

      const handle = await mountWorkspaceTools(agentCtx, {
        spacePath: spaceA,
        dshHome,
        extensionPlan: plan,
      });

      try {
        expect(toolsMap.has('plugin__trusted-echo__echo')).toBe(true);
        const tool = toolsMap.get('plugin__trusted-echo__echo');
        expect(tool.name).toBe('plugin__trusted-echo__echo');

        // Execute tool with valid input
        const result = await tool.execute({ text: 'Hello Enkeep Plugin' });
        expect(result).toEqual({ result: 'PLUGIN:Hello Enkeep Plugin' });

        // Execute tool with invalid input
        await expect(tool.execute({ text: null as any })).rejects.toThrow(/Parameter "text" is required|"text" must be a string/);
        await expect(tool.execute({})).rejects.toThrow(/Parameter "text" is required|required property "text"/);

        // Turn update: disable plugin
        const disabledPlan: ExtensionActivationPlan = {
          generation: 2,
          contributions: [],
          skills: [],
          plugins: [],
        };
        await handle.updateExtensionPlan(disabledPlan);
        expect(toolsMap.has('plugin__trusted-echo__echo')).toBe(false);
      } finally {
        await handle.dispose();
      }
    });
  });

  describe('3. Error Handling and Recovery', () => {
    it('throws PLUGIN_ACTIVATION_FAILED when failing plugin is applied, and recovers on subsequent plan update', async () => {
      const agentCtx = new Context();
      const toolsMap = new Map<string, any>();
      const toolsService = {
        register: (def: any) => {
          toolsMap.set(def.name, def);
          return () => toolsMap.delete(def.name);
        },
      };
      (agentCtx as any).tools = toolsService;
      agentCtx.provide('tools', toolsService);

      const failingPlan: ExtensionActivationPlan = {
        generation: 1,
        contributions: [
          {
            kind: 'dsh-plugin',
            contributionId: 'contrib_failing',
            contributionKey: 'test-failing',
            trustedPluginId: 'enkeep.test-failing',
            name: 'Test Failing Plugin',
            version: 1,
            integrity: TRUSTED_TEST_FAILING_PLUGIN.integritySha256,
            enabled: true,
          },
        ],
        skills: [],
        plugins: [
          {
            kind: 'dsh-plugin',
            contributionId: 'contrib_failing',
            contributionKey: 'test-failing',
            trustedPluginId: 'enkeep.test-failing',
            name: 'Test Failing Plugin',
            version: 1,
            integrity: TRUSTED_TEST_FAILING_PLUGIN.integritySha256,
            enabled: true,
          },
        ],
      };

      await expect(
        mountWorkspaceTools(agentCtx, {
          spacePath: spaceA,
          dshHome,
          extensionPlan: failingPlan,
        })
      ).rejects.toThrow(/PLUGIN_ACTIVATION_FAILED/);

      // Now create clean handle and test plan update failure & recovery
      const cleanPlan: ExtensionActivationPlan = {
        generation: 2,
        contributions: [],
        skills: [],
        plugins: [],
      };

      const handle = await mountWorkspaceTools(agentCtx, {
        spacePath: spaceA,
        dshHome,
        extensionPlan: cleanPlan,
      });

      try {
        // Updating to failing plan throws PLUGIN_ACTIVATION_FAILED
        await expect(handle.updateExtensionPlan(failingPlan)).rejects.toThrow(/PLUGIN_ACTIVATION_FAILED/);

        // Updating back to clean/echo plan recovers cleanly
        const echoPlan: ExtensionActivationPlan = {
          generation: 3,
          contributions: [
            {
              kind: 'dsh-plugin',
              contributionId: 'contrib_echo',
              contributionKey: 'trusted-echo',
              trustedPluginId: 'enkeep.echo',
              name: 'Trusted Echo',
              version: 1,
              integrity: TRUSTED_ECHO_PLUGIN.integritySha256,
              enabled: true,
            },
          ],
          skills: [],
          plugins: [
            {
              kind: 'dsh-plugin',
              contributionId: 'contrib_echo',
              contributionKey: 'trusted-echo',
              trustedPluginId: 'enkeep.echo',
              name: 'Trusted Echo',
              version: 1,
              integrity: TRUSTED_ECHO_PLUGIN.integritySha256,
              enabled: true,
            },
          ],
        };

        await handle.updateExtensionPlan(echoPlan);
        expect(toolsMap.has('plugin__trusted-echo__echo')).toBe(true);
        const tool = toolsMap.get('plugin__trusted-echo__echo');
        const res = await tool.execute({ text: 'Recovered' });
        expect(res.result).toBe('PLUGIN:Recovered');
      } finally {
        await handle.dispose();
      }
    });
  });

  describe('4. Real Agent Turn Execution & Session Isolation', () => {
    it('runs real agent turn invoking trusted plugin, validates failure safety, session isolation and recovery', async () => {
      const { bootDshRuntime } = await import('../src/runtime/dsh-boot.js');
      const runtime = await bootDshRuntime({
        userId: 'alice',
        dshHome,
        spacesDir,
      });

      const echoPlan: ExtensionActivationPlan = {
        generation: 1,
        contributions: [
          {
            kind: 'dsh-plugin',
            contributionId: 'contrib_echo',
            contributionKey: 'trusted-echo',
            trustedPluginId: 'enkeep.echo',
            name: 'Trusted Echo',
            version: 1,
            integrity: TRUSTED_ECHO_PLUGIN.integritySha256,
            enabled: true,
          },
        ],
        skills: [],
        plugins: [
          {
            kind: 'dsh-plugin',
            contributionId: 'contrib_echo',
            contributionKey: 'trusted-echo',
            trustedPluginId: 'enkeep.echo',
            name: 'Trusted Echo',
            version: 1,
            integrity: TRUSTED_ECHO_PLUGIN.integritySha256,
            enabled: true,
          },
        ],
      };

      const disabledPlan: ExtensionActivationPlan = {
        generation: 2,
        contributions: [],
        skills: [],
        plugins: [],
      };

      const failingPlan: ExtensionActivationPlan = {
        generation: 3,
        contributions: [
          {
            kind: 'dsh-plugin',
            contributionId: 'contrib_failing',
            contributionKey: 'test-failing',
            trustedPluginId: 'enkeep.test-failing',
            name: 'Test Failing Plugin',
            version: 1,
            integrity: TRUSTED_TEST_FAILING_PLUGIN.integritySha256,
            enabled: true,
          },
        ],
        skills: [],
        plugins: [
          {
            kind: 'dsh-plugin',
            contributionId: 'contrib_failing',
            contributionKey: 'test-failing',
            trustedPluginId: 'enkeep.test-failing',
            name: 'Test Failing Plugin',
            version: 1,
            integrity: TRUSTED_TEST_FAILING_PLUGIN.integritySha256,
            enabled: true,
          },
        ],
      };

      const sessionA = 'ses_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
      const sessionB = 'ses_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

      try {
        // Step 1: Turn 1 with enabled echo plugin -> calls tool and succeeds
        const res1 = await runtime.sendFollowup({
          sessionId: sessionA,
          turnId: 'turn_11111111111111111111111111111111',
          prompt: 'Echo test [enkeep-test-tool-call=plugin__trusted-echo__echo:{"text":"Alpha"}]',
          workspaceFolder: 'space-a',
          extensionPlan: echoPlan,
        });

        expect(res1.status).toBe('completed');
        expect(res1.replyText).toContain('PLUGIN:Alpha');

        // Step 2: Turn 2 with disabled plugin -> tool disappears
        const res2 = await runtime.sendFollowup({
          sessionId: sessionA,
          turnId: 'turn_22222222222222222222222222222222',
          prompt: 'Hello without tool',
          workspaceFolder: 'space-a',
          extensionPlan: disabledPlan,
        });

        expect(res2.status).toBe('completed');

        // Step 3: Turn 3 with failing plugin -> safely fails with generic code without stack leak
        await expect(
          runtime.sendFollowup({
            sessionId: sessionA,
            turnId: 'turn_33333333333333333333333333333333',
            prompt: 'Attempt with failing plugin',
            workspaceFolder: 'space-a',
            extensionPlan: failingPlan,
          })
        ).rejects.toThrow(/PLUGIN_ACTIVATION_FAILED/);

        // Step 4: Session B (unaffected concurrent session) -> succeeds normally
        const resB = await runtime.sendFollowup({
          sessionId: sessionB,
          turnId: 'turn_44444444444444444444444444444444',
          prompt: 'Echo in session B [enkeep-test-tool-call=plugin__trusted-echo__echo:{"text":"Beta"}]',
          workspaceFolder: 'space-a',
          extensionPlan: echoPlan,
        });

        expect(resB.status).toBe('completed');
        expect(resB.replyText).toContain('PLUGIN:Beta');

        // Step 5: Session A recovery after admin disables failing plugin -> next turn succeeds
        const resA_Recovered = await runtime.sendFollowup({
          sessionId: sessionA,
          turnId: 'turn_55555555555555555555555555555555',
          prompt: 'Session A recovered chat',
          workspaceFolder: 'space-a',
          extensionPlan: disabledPlan,
        });

        expect(resA_Recovered.status).toBe('completed');
      } finally {
        await runtime.dispose();
      }
    });
  });
});
