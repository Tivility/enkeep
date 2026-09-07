/**
 * Test Suite: Official DSH Agent Profile In-Container Loading and System Prompt Injection
 *
 * Verifies:
 * 1. Strict validation: profileId, version (positive safe integer >= 1), promptHash (exact lowercase),
 *    64KiB UTF-8 byte cap, forbidden Unicode Cc/Cf control/format chars, Unicode NFC normalization,
 *    rejection of unknown keys, template variable syntax `{{...}}`.
 * 2. Canonical SHA-256 hash computation over the four sections (identity, soul, agents, tools).
 * 3. Official prompt assembly: 4 ordered scoped sections (`profile:identity`, `profile:soul`, `profile:agents`, `profile:tools`)
 *    appended after persona (0) while preserving Harness identity (-100) and deployment persona.
 * 4. Scoped isolation between different sessions (Session A with Profile A, Session B with Profile B, Session C without profile).
 * 5. Resumed sessions from persisted JSONL correctly load and inject the profile snapshot into scoped assembly.
 * 6. Hash mismatch rejection.
 * 7. Template variable syntax `{{...}}` rejection.
 * 8. Oversize (>64KiB) rejection.
 * 9. Control characters rejection (rejecting Cc/Cf/Zl/Zp like \x00, \x07, \x1b, \u200B, \u202E, \u2028; allowing \n, \r, \t and multi-byte UTF-8).
 * 10. Same-session drift rejection (fail-closed with generic message requiring generational reset or dispose/recreate without leaking hashes).
 * 11. Scoped disposal lifecycle (handle disposal cleans up scoped prompt sections).
 * 12. Unprofiled sessions retain legacy default behavior without alteration.
 * 13. ExecTransport.sendFollowup forwards turnId and profile snapshot correctly.
 *
 * @module @enkeep/runtime-runner/tests/agent-profile.test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { renderPrompt } from '@deepseek-ai/dsh-system-prompt';
import {
  bootDshRuntime,
  computeAgentProfilePromptHash,
  validateAgentProfileSnapshot,
  installAgentProfile,
  AgentProfileValidationError,
  AgentProfileSessionMismatchError,
  PROFILE_SECTION_NAMES,
  PROFILE_SECTION_ORDERS,
  MAX_PROFILE_PROMPT_BYTES,
  type AgentProfileSnapshot,
  type DshBootedRuntime,
} from '../src/index.js';
import { DockerExecTransport } from '../src/transport/exec-transport.js';
import type { DockerClient, ContainerExpectation } from '../src/docker/index.js';

describe('Official DSH Agent Profile Runtime Integration', () => {
  let tmpDir: string;
  let dshHome: string;
  let spacesDir: string;
  const createdRuntimes: DshBootedRuntime[] = [];

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'enkeep-agent-profile-test-'));
    dshHome = path.join(tmpDir, 'dsh');
    spacesDir = path.join(tmpDir, 'spaces');
    fs.mkdirSync(dshHome, { recursive: true, mode: 0o700 });
    fs.mkdirSync(spacesDir, { recursive: true, mode: 0o700 });
  });

  afterEach(async () => {
    for (const runtime of createdRuntimes) {
      try {
        await runtime.dispose();
      } catch (_err) {
        // cleanup ignore
      }
    }
    createdRuntimes.length = 0;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function createTestRuntime(userId = 'alice'): Promise<DshBootedRuntime> {
    const runtime = await bootDshRuntime({
      userId,
      dshHome,
      spacesDir,
    });
    createdRuntimes.push(runtime);
    return runtime;
  }

  function createValidProfileSnapshot(overrides: Partial<AgentProfileSnapshot> = {}): AgentProfileSnapshot {
    const identity = overrides.identity ?? 'You are Enkeep Code Auditor, specialized in TypeScript and security review.';
    const soul = overrides.soul ?? 'Meticulous, calm, evidence-driven, never makes ungrounded assumptions.';
    const agents = overrides.agents ?? 'Subagent hierarchy: delegated code reviewer, security scanner, regression analyst.';
    const tools = overrides.tools ?? 'Preferred tools: read, grep, glob, bash. Always verify file existence before editing.';

    const promptHash = overrides.promptHash ?? computeAgentProfilePromptHash({ identity, soul, agents, tools });

    return {
      profileId: overrides.profileId ?? 'profile-code-auditor-v1',
      version: overrides.version ?? 1,
      promptHash,
      identity,
      soul,
      agents,
      tools,
    };
  }

  describe('1. Profile Snapshot Validation & Canonical Hashing', () => {
    it('computes canonical SHA-256 hash deterministically and accurately', () => {
      const sections = {
        identity: 'Identity A',
        soul: 'Soul B',
        agents: 'Agents C',
        tools: 'Tools D',
      };
      const hash1 = computeAgentProfilePromptHash(sections);
      const hash2 = computeAgentProfilePromptHash(sections);
      expect(hash1).toBe(hash2);
      expect(hash1).toMatch(/^[0-9a-f]{64}$/);

      // Verify canonical key ordering: mutating section object key order does not change hash
      const reverseKeySections = {
        tools: 'Tools D',
        soul: 'Soul B',
        identity: 'Identity A',
        agents: 'Agents C',
      };
      const hashReversed = computeAgentProfilePromptHash(reverseKeySections);
      expect(hashReversed).toBe(hash1);
    });

    it('successfully validates a well-formed profile snapshot', () => {
      const snapshot = createValidProfileSnapshot();
      const validated = validateAgentProfileSnapshot(snapshot);
      expect(validated.profileId).toBe('profile-code-auditor-v1');
      expect(validated.version).toBe(1);
      expect(validated.promptHash).toBe(snapshot.promptHash);
      expect(validated.identity).toBe(snapshot.identity);
      expect(validated.soul).toBe(snapshot.soul);
      expect(validated.agents).toBe(snapshot.agents);
      expect(validated.tools).toBe(snapshot.tools);
    });

    it('strictly rejects unknown / unexpected keys in profile snapshot', () => {
      const snapshotWithExtra = {
        ...createValidProfileSnapshot(),
        extraField: 'malicious-or-unexpected',
      };
      expect(() => validateAgentProfileSnapshot(snapshotWithExtra)).toThrow(AgentProfileValidationError);
      expect(() => validateAgentProfileSnapshot(snapshotWithExtra)).toThrow(/unexpected keys/);
    });

    it('strictly rejects promptHash containing uppercase characters without silently lowercasing', () => {
      const valid = createValidProfileSnapshot();
      const uppercaseHash = valid.promptHash.toUpperCase();
      const snapshotWithUpper = {
        ...valid,
        promptHash: uppercaseHash,
      };
      expect(() => validateAgentProfileSnapshot(snapshotWithUpper)).toThrow(AgentProfileValidationError);
      expect(() => validateAgentProfileSnapshot(snapshotWithUpper)).toThrow(/must be a 64-character lowercase hex SHA-256 string/);
    });

    it('supports positive safe integer versions and rejects 0, negative, non-integers, and untrimmed strings', () => {
      // Valid positive safe integer
      expect(validateAgentProfileSnapshot(createValidProfileSnapshot({ version: 1 })).version).toBe(1);
      expect(validateAgentProfileSnapshot(createValidProfileSnapshot({ version: 42 })).version).toBe(42);
      expect(validateAgentProfileSnapshot(createValidProfileSnapshot({ version: '3' })).version).toBe(3);

      // Rejects 0 and negative numbers
      expect(() => validateAgentProfileSnapshot(createValidProfileSnapshot({ version: 0 }))).toThrow(
        AgentProfileValidationError
      );
      expect(() => validateAgentProfileSnapshot(createValidProfileSnapshot({ version: -1 }))).toThrow(
        AgentProfileValidationError
      );

      // Rejects non-integers
      expect(() => validateAgentProfileSnapshot(createValidProfileSnapshot({ version: 1.5 }))).toThrow(
        AgentProfileValidationError
      );

      // Rejects untrimmed strings (semantic alteration forbidden)
      expect(() => validateAgentProfileSnapshot(createValidProfileSnapshot({ version: ' 1 ' }))).toThrow(
        AgentProfileValidationError
      );
      expect(() => validateAgentProfileSnapshot(createValidProfileSnapshot({ version: '1\n' }))).toThrow(
        AgentProfileValidationError
      );

      // Rejects non-numeric string versions
      expect(() => validateAgentProfileSnapshot(createValidProfileSnapshot({ version: 'v1.2.0' }))).toThrow(
        AgentProfileValidationError
      );
    });

    it('supports UTF-8 multi-byte characters and emoji in sections', () => {
      const snapshot = createValidProfileSnapshot({
        identity: '你是一个专业的智能代理 🚀，专注于分布式系统架构设计。',
        soul: '恪尽职守，严谨求实，注重代码可维护性与防御性设计。',
        agents: '协作子智能体：代码审查员、安全分析员。',
        tools: '首选工具：read, write, grep, glob。',
      });
      const validated = validateAgentProfileSnapshot(snapshot);
      expect(validated.identity).toContain('🚀');
      expect(validated.identity).toContain('专业的智能代理');
    });

    it('rejects strings not in Unicode NFC normalization form without silent mutation', () => {
      // NFD decomposed 'e\u0301' (é) vs NFC 'é' (\u00e9)
      const nfdIdentity = 'De\u0301veloppeur';
      expect(nfdIdentity.normalize('NFC')).not.toBe(nfdIdentity);

      const nfdSnapshot = createValidProfileSnapshot({
        identity: nfdIdentity,
      });
      expect(() => validateAgentProfileSnapshot(nfdSnapshot)).toThrow(AgentProfileValidationError);
      expect(() => validateAgentProfileSnapshot(nfdSnapshot)).toThrow(/must be in Unicode NFC normalized form/);
    });

    it('rejects Unicode Cf format characters (bidi controls, zero-width space) and Unicode line/paragraph separators', () => {
      // Zero-width space \u200B (Cf)
      const badZeroWidth = createValidProfileSnapshot({
        identity: 'Zero-width\u200Bspace',
      });
      expect(() => validateAgentProfileSnapshot(badZeroWidth)).toThrow(AgentProfileValidationError);
      expect(() => validateAgentProfileSnapshot(badZeroWidth)).toThrow(/contains forbidden control or format characters/);

      // Right-to-Left Override \u202E (Cf)
      const badBidi = createValidProfileSnapshot({
        soul: 'Bidi attack \u202E reverse',
      });
      expect(() => validateAgentProfileSnapshot(badBidi)).toThrow(AgentProfileValidationError);
      expect(() => validateAgentProfileSnapshot(badBidi)).toThrow(/contains forbidden control or format characters/);

      // Unicode line separator \u2028
      const badLineSep = createValidProfileSnapshot({
        agents: 'Line\u2028Separator',
      });
      expect(() => validateAgentProfileSnapshot(badLineSep)).toThrow(AgentProfileValidationError);
      expect(() => validateAgentProfileSnapshot(badLineSep)).toThrow(/contains forbidden control or format characters/);

      // Unicode paragraph separator \u2029
      const badParagraphSep = createValidProfileSnapshot({
        tools: 'Paragraph\u2029Separator',
      });
      expect(() => validateAgentProfileSnapshot(badParagraphSep)).toThrow(AgentProfileValidationError);
      expect(() => validateAgentProfileSnapshot(badParagraphSep)).toThrow(/contains forbidden control or format characters/);
    });

    it('rejects hash mismatch loudly with AgentProfileValidationError', () => {
      const snapshot = createValidProfileSnapshot({
        promptHash: '0000000000000000000000000000000000000000000000000000000000000000',
      });
      expect(() => validateAgentProfileSnapshot(snapshot)).toThrow(AgentProfileValidationError);
      expect(() => validateAgentProfileSnapshot(snapshot)).toThrow(/does not match computed hash/);
    });

    it('rejects invalid or missing profileId', () => {
      expect(() => validateAgentProfileSnapshot({ ...createValidProfileSnapshot(), profileId: '' })).toThrow(
        AgentProfileValidationError
      );
      expect(() => validateAgentProfileSnapshot({ ...createValidProfileSnapshot(), profileId: 'invalid/id with spaces' })).toThrow(
        AgentProfileValidationError
      );
      expect(() => validateAgentProfileSnapshot({ ...createValidProfileSnapshot(), profileId: null as unknown as string })).toThrow(
        AgentProfileValidationError
      );
    });

    it('rejects template variable syntax and tokens {{ or }} in any section', () => {
      const badTemplateInIdentity = createValidProfileSnapshot({
        identity: 'You are an agent acting as {{user_role}} with name {{username}}.',
      });
      expect(() => validateAgentProfileSnapshot(badTemplateInIdentity)).toThrow(AgentProfileValidationError);
      expect(() => validateAgentProfileSnapshot(badTemplateInIdentity)).toThrow(/forbidden template variable/);

      const badTemplateInSoul = createValidProfileSnapshot({
        soul: 'Act with mood: {{mood}}.',
      });
      expect(() => validateAgentProfileSnapshot(badTemplateInSoul)).toThrow(AgentProfileValidationError);

      const badTemplateInAgents = createValidProfileSnapshot({
        agents: 'Delegate to {{agent_name}}.',
      });
      expect(() => validateAgentProfileSnapshot(badTemplateInAgents)).toThrow(AgentProfileValidationError);

      const badTemplateInTools = createValidProfileSnapshot({
        tools: 'Use tool {{preferred_tool}}.',
      });
      expect(() => validateAgentProfileSnapshot(badTemplateInTools)).toThrow(AgentProfileValidationError);

      // Test unpaired tokens {{ and }}
      const unpairedOpening = createValidProfileSnapshot({
        identity: 'Unpaired opening {{ token',
      });
      expect(() => validateAgentProfileSnapshot(unpairedOpening)).toThrow(AgentProfileValidationError);

      const unpairedClosing = createValidProfileSnapshot({
        soul: 'Unpaired closing }} token',
      });
      expect(() => validateAgentProfileSnapshot(unpairedClosing)).toThrow(AgentProfileValidationError);
    });

    it('rejects forbidden control characters in any section while permitting \\n, \\r, \\t', () => {
      // Null byte \x00
      const badNullByte = createValidProfileSnapshot({
        identity: 'Null byte attack \x00 in identity',
      });
      expect(() => validateAgentProfileSnapshot(badNullByte)).toThrow(AgentProfileValidationError);
      expect(() => validateAgentProfileSnapshot(badNullByte)).toThrow(/contains forbidden control or format characters/);

      // Bell character \x07
      const badBell = createValidProfileSnapshot({
        soul: 'Bell \x07 character',
      });
      expect(() => validateAgentProfileSnapshot(badBell)).toThrow(AgentProfileValidationError);

      // Escape character \x1b
      const badEsc = createValidProfileSnapshot({
        tools: 'Escape \x1b[31m colored \x1b[0m',
      });
      expect(() => validateAgentProfileSnapshot(badEsc)).toThrow(AgentProfileValidationError);

      // Valid whitespace: \n, \r, \t are permitted
      const validWhitespace = createValidProfileSnapshot({
        identity: 'Line 1\r\nLine 2\tIndented',
        soul: 'Soul with\nmultiple\nlines\tand tabs.',
      });
      expect(() => validateAgentProfileSnapshot(validWhitespace)).not.toThrow();
    });

    it('rejects oversize total prompt sections (>64KiB / 65536 bytes)', () => {
      const largeText = 'A'.repeat(20 * 1024); // 20 KiB each * 4 = 80 KiB > 64 KiB
      const oversizedSnapshot = createValidProfileSnapshot({
        identity: largeText,
        soul: largeText,
        agents: largeText,
        tools: largeText,
      });
      expect(() => validateAgentProfileSnapshot(oversizedSnapshot)).toThrow(AgentProfileValidationError);
      expect(() => validateAgentProfileSnapshot(oversizedSnapshot)).toThrow(/exceeds maximum allowable limit/);
    });

    it('accepts valid sections close to 64KiB limit', () => {
      const exactText = 'A'.repeat(15 * 1024); // 15 KiB each * 4 = 60 KiB < 64 KiB
      const validLargeSnapshot = createValidProfileSnapshot({
        identity: exactText,
        soul: exactText,
        agents: exactText,
        tools: exactText,
      });
      expect(() => validateAgentProfileSnapshot(validLargeSnapshot)).not.toThrow();
    });
  });

  describe('2. Official System Prompt Scoped Injection & Assembly', () => {
    it('injects 4 ordered scoped sections after persona and preserves Harness identity', async () => {
      const runtime = await createTestRuntime();
      const sessionId = 'ses_10000000000000000000000000000001';
      const profile = createValidProfileSnapshot({
        identity: 'CUSTOM IDENTITY: Expert TypeScript Architect.',
        soul: 'CUSTOM SOUL: Rigorous, methodical, test-driven.',
        agents: 'CUSTOM AGENTS: Delegated subagents for linting and security.',
        tools: 'CUSTOM TOOLS: Preferred tools: read, edit, grep, glob.',
      });

      const agent = await runtime.getOrCreateAgent(sessionId, profile);

      // Assemble system prompt for this agent's scope
      const assembly = await runtime.context.systemPrompt.assemble({ scope: agent });

      // Verify sections presence
      const sectionNames = assembly.sections.map((s) => s.name);
      expect(sectionNames).toContain('harness:identity');
      expect(sectionNames).toContain('deployment:persona');
      expect(sectionNames).toContain(PROFILE_SECTION_NAMES.identity);
      expect(sectionNames).toContain(PROFILE_SECTION_NAMES.soul);
      expect(sectionNames).toContain(PROFILE_SECTION_NAMES.agents);
      expect(sectionNames).toContain(PROFILE_SECTION_NAMES.tools);

      // Verify ordering: harness:identity (-100) -> deployment:persona (0) -> profile:identity (10) -> profile:soul (20) -> profile:agents (30) -> profile:tools (40)
      const harnessIdx = sectionNames.indexOf('harness:identity');
      const personaIdx = sectionNames.indexOf('deployment:persona');
      const identityIdx = sectionNames.indexOf(PROFILE_SECTION_NAMES.identity);
      const soulIdx = sectionNames.indexOf(PROFILE_SECTION_NAMES.soul);
      const agentsIdx = sectionNames.indexOf(PROFILE_SECTION_NAMES.agents);
      const toolsIdx = sectionNames.indexOf(PROFILE_SECTION_NAMES.tools);

      expect(harnessIdx).toBeLessThan(personaIdx);
      expect(personaIdx).toBeLessThan(identityIdx);
      expect(identityIdx).toBeLessThan(soulIdx);
      expect(soulIdx).toBeLessThan(agentsIdx);
      expect(agentsIdx).toBeLessThan(toolsIdx);

      // Verify section text contents
      const identitySection = assembly.sections.find((s) => s.name === PROFILE_SECTION_NAMES.identity);
      const soulSection = assembly.sections.find((s) => s.name === PROFILE_SECTION_NAMES.soul);
      const agentsSection = assembly.sections.find((s) => s.name === PROFILE_SECTION_NAMES.agents);
      const toolsSection = assembly.sections.find((s) => s.name === PROFILE_SECTION_NAMES.tools);

      expect(identitySection?.text).toBe(profile.identity);
      expect(soulSection?.text).toBe(profile.soul);
      expect(agentsSection?.text).toBe(profile.agents);
      expect(toolsSection?.text).toBe(profile.tools);

      // Verify rendered prompt string contains official harness identity + persona + all 4 profile sections
      const rendered = renderPrompt(assembly);
      expect(rendered).toContain('You are an AI agent powered by DeepSeek Harness.');
      expect(rendered).toContain('CUSTOM IDENTITY: Expert TypeScript Architect.');
      expect(rendered).toContain('CUSTOM SOUL: Rigorous, methodical, test-driven.');
      expect(rendered).toContain('CUSTOM AGENTS: Delegated subagents for linting and security.');
      expect(rendered).toContain('CUSTOM TOOLS: Preferred tools: read, edit, grep, glob.');
    });

    it('does not register empty profile sections', async () => {
      const runtime = await createTestRuntime();
      const sessionId = 'ses_10000000000000000000000000000002';
      const partialProfile = createValidProfileSnapshot({
        identity: 'Non-empty Identity',
        soul: '', // Empty soul
        agents: '   ', // Whitespace-only agents
        tools: 'Non-empty Tools guidance',
      });

      const agent = await runtime.getOrCreateAgent(sessionId, partialProfile);
      const assembly = await runtime.context.systemPrompt.assemble({ scope: agent });

      const sectionNames = assembly.sections.map((s) => s.name);
      expect(sectionNames).toContain(PROFILE_SECTION_NAMES.identity);
      expect(sectionNames).not.toContain(PROFILE_SECTION_NAMES.soul);
      expect(sectionNames).not.toContain(PROFILE_SECTION_NAMES.agents);
      expect(sectionNames).toContain(PROFILE_SECTION_NAMES.tools);
    });
  });

  describe('3. Strict Scoped Session Isolation', () => {
    it('guarantees complete prompt isolation between distinct sessions', async () => {
      const runtime = await createTestRuntime();

      const profileA = createValidProfileSnapshot({
        profileId: 'profile-agent-alpha',
        identity: 'ROLE: Alpha Security Engineer.',
        soul: 'FOCUS: Vulnerability scanning and CVE analysis.',
        agents: 'SUBAGENTS: Alpha-1, Alpha-2.',
        tools: 'TOOLS: Alpha tool suite.',
      });

      const profileB = createValidProfileSnapshot({
        profileId: 'profile-agent-beta',
        identity: 'ROLE: Beta Frontend Developer.',
        soul: 'FOCUS: UI/UX accessibility and Tailwind CSS.',
        agents: 'SUBAGENTS: Beta-1, Beta-2.',
        tools: 'TOOLS: Beta tool suite.',
      });

      const sessionA = 'ses_1000000000000000000000000000000a';
      const sessionB = 'ses_1000000000000000000000000000000b';
      const sessionC = 'ses_1000000000000000000000000000000c';

      const agentA = await runtime.getOrCreateAgent(sessionA, profileA);
      const agentB = await runtime.getOrCreateAgent(sessionB, profileB);
      const agentC = await runtime.getOrCreateAgent(sessionC, null); // No profile

      const assemblyA = await runtime.context.systemPrompt.assemble({ scope: agentA });
      const assemblyB = await runtime.context.systemPrompt.assemble({ scope: agentB });
      const assemblyC = await runtime.context.systemPrompt.assemble({ scope: agentC });
      const globalAssembly = await runtime.context.systemPrompt.assemble({});

      // Prompt A contains only Profile A
      const textA = renderPrompt(assemblyA);
      expect(textA).toContain('ROLE: Alpha Security Engineer.');
      expect(textA).not.toContain('ROLE: Beta Frontend Developer.');

      // Prompt B contains only Profile B
      const textB = renderPrompt(assemblyB);
      expect(textB).toContain('ROLE: Beta Frontend Developer.');
      expect(textB).not.toContain('ROLE: Alpha Security Engineer.');

      // Prompt C (unprofiled) contains no profile sections
      const textC = renderPrompt(assemblyC);
      expect(textC).toContain('You are an AI agent powered by DeepSeek Harness.');
      expect(textC).not.toContain('ROLE: Alpha Security Engineer.');
      expect(textC).not.toContain('ROLE: Beta Frontend Developer.');
      expect(assemblyC.sections.some((s) => s.name.startsWith('profile:'))).toBe(false);

      // Global assembly without scope contains no profile sections
      expect(globalAssembly.sections.some((s) => s.name.startsWith('profile:'))).toBe(false);
    });
  });

  describe('4. Turn Execution with sendFollowup', () => {
    it('executes followup turn with profile snapshot and persists session log', async () => {
      const runtime = await createTestRuntime();
      const sessionId = 'ses_10000000000000000000000000000003';
      const profile = createValidProfileSnapshot({
        identity: 'Senior Database Architect.',
        soul: 'Ensures ACID compliance and zero data loss.',
        agents: 'DB query planners and indexing subagents.',
        tools: 'PostgreSQL migration tools.',
      });

      const response = await runtime.sendFollowup(
        'Please review the database schema migration plan.',
        sessionId,
        'turn_10000000000000000000000000000003',
        profile
      );

      expect(response.sessionId).toBe(sessionId);
      expect(response.status).toBe('completed');
      expect(response.persisted).toBe(true);
      expect(response.eventsCount).toBeGreaterThan(0);
      expect(response.replyText).toBeDefined();

      // Verify agent's prompt assembly retained the profile
      const agent = await runtime.getOrCreateAgent(sessionId, null);
      const assembly = await runtime.context.systemPrompt.assemble({ scope: agent });
      expect(renderPrompt(assembly)).toContain('Senior Database Architect.');
    });
  });

  describe('5. Persisted Session Resume with Profile', () => {
    it('correctly injects profile snapshot upon session resumption from JSONL', async () => {
      const sessionId = 'ses_10000000000000000000000000000004';
      const profile = createValidProfileSnapshot({
        profileId: 'profile-dsh-expert-v1',
        identity: 'DSH Core System Expert.',
        soul: 'Pragmatic, concise, adheres to harness invariants.',
        agents: 'Core loop coordinator.',
        tools: 'Tools: read, write, edit, bash, subagent.',
      });

      // Runtime 1: create session with profile and execute turn 1
      const runtime1 = await createTestRuntime('alice');
      const turn1Resp = await runtime1.sendFollowup(
        'Turn 1: Initialize project with profile.',
        sessionId,
        'turn_10000000000000000000000000000004',
        profile
      );
      expect(turn1Resp.status).toBe('completed');
      await runtime1.dispose();

      // Runtime 2: fresh runtime instance resumes persisted session with profile snapshot
      const runtime2 = await createTestRuntime('alice');
      const agentResumed = await runtime2.getOrCreateAgent(sessionId, profile);

      const assembly = await runtime2.context.systemPrompt.assemble({ scope: agentResumed });
      const promptText = renderPrompt(assembly);

      expect(promptText).toContain('You are an AI agent powered by DeepSeek Harness.');
      expect(promptText).toContain('DSH Core System Expert.');
      expect(promptText).toContain('Pragmatic, concise, adheres to harness invariants.');
      expect(promptText).toContain('Core loop coordinator.');
      expect(promptText).toContain('Tools: read, write, edit, bash, subagent.');

      // Execute turn 2 on resumed session
      const turn2Resp = await runtime2.sendFollowup(
        'Turn 2: Continue work on resumed session.',
        sessionId,
        'turn_10000000000000000000000000000005',
        profile
      );
      expect(turn2Resp.status).toBe('completed');
      expect(turn2Resp.eventsCount).toBeGreaterThan(turn1Resp.eventsCount);
    });
  });

  describe('6. Same-Session Profile Drift Rejection (Fail-Closed, Generic Error)', () => {
    it('rejects differing profile prompt hash on same session with generic mismatch error (no leaked hashes)', async () => {
      const runtime = await createTestRuntime();
      const sessionId = 'ses_10000000000000000000000000000005';

      const initialProfile = createValidProfileSnapshot({
        profileId: 'profile-v1',
        identity: 'Initial Profile V1 Identity',
      });

      const driftedProfile = createValidProfileSnapshot({
        profileId: 'profile-v2',
        identity: 'Drifted Profile V2 Identity (Conflicting Prompt)',
      });

      // Turn 1 with initial profile
      const turn1 = await runtime.sendFollowup(
        'Turn 1 prompt',
        sessionId,
        'turn_10000000000000000000000000000006',
        initialProfile
      );
      expect(turn1.status).toBe('completed');

      // Subsequent call on same session with identical profile succeeds
      await expect(
        runtime.sendFollowup(
          'Turn 2 with same profile',
          sessionId,
          'turn_10000000000000000000000000000007',
          initialProfile
        )
      ).resolves.toBeDefined();

      // Subsequent call on same session with conflicting profile hash FAILS CLOSED with generic error
      let caughtError: unknown;
      try {
        await runtime.sendFollowup(
          'Turn 3 with drifted profile',
          sessionId,
          'turn_10000000000000000000000000000008',
          driftedProfile
        );
      } catch (err) {
        caughtError = err;
      }

      expect(caughtError).toBeInstanceOf(AgentProfileSessionMismatchError);
      const errMsg = (caughtError as Error).message;
      expect(errMsg).toContain('Agent profile session mismatch: existing profile snapshot does not match incoming profile configuration');
      // Assert that neither full hash is exposed in the error message
      expect(errMsg).not.toContain(initialProfile.promptHash);
      expect(errMsg).not.toContain(driftedProfile.promptHash);

      await expect(
        runtime.getOrCreateAgent(sessionId, driftedProfile)
      ).rejects.toThrow(AgentProfileSessionMismatchError);
    });

    it('rejects profile injection onto an existing unprofiled session without recreation', async () => {
      const runtime = await createTestRuntime();
      const sessionId = 'ses_10000000000000000000000000000006';

      // Turn 1 without profile
      await runtime.sendFollowup(
        'Initial unprofiled turn',
        sessionId,
        'turn_10000000000000000000000000000009',
        null
      );

      const profile = createValidProfileSnapshot();

      // Passing a profile to an existing unprofiled agent handle fails closed
      await expect(
        runtime.sendFollowup(
          'Turn 2 with new profile',
          sessionId,
          'turn_10000000000000000000000000000010',
          profile
        )
      ).rejects.toThrow(AgentProfileSessionMismatchError);
    });
  });

  describe('7. Scoped Disposal & HMR Lifecycle Cleanliness', () => {
    it('removes scoped prompt sections when runtime or agent handle is disposed', async () => {
      const runtime = await createTestRuntime();
      const sessionId = 'ses_10000000000000000000000000000007';
      const profile = createValidProfileSnapshot({
        identity: 'Ephemeral Identity to be Disposed',
      });

      const agent = await runtime.getOrCreateAgent(sessionId, profile);
      const beforeDisposal = await runtime.context.systemPrompt.assemble({ scope: agent });
      expect(renderPrompt(beforeDisposal)).toContain('Ephemeral Identity to be Disposed');

      // Dispose runtime
      await runtime.dispose();

      // In a fresh runtime instance without profile, no residue exists
      const freshRuntime = await createTestRuntime();
      const freshAgent = await freshRuntime.getOrCreateAgent('ses_10000000000000000000000000000008', null);
      const freshAssembly = await freshRuntime.context.systemPrompt.assemble({ scope: freshAgent });

      expect(renderPrompt(freshAssembly)).not.toContain('Ephemeral Identity to be Disposed');
    });

    it('collects all disposer errors into AggregateError without swallowing', () => {
      const mockSection = vi.fn().mockImplementation(() => {
        return () => {
          throw new Error('Section unregister failure');
        };
      });

      const mockCtx = {
        systemPrompt: {
          section: mockSection,
        },
      } as unknown as Context;

      const profile = createValidProfileSnapshot();
      const disposer = installAgentProfile(mockCtx, profile);

      expect(() => disposer()).toThrow(AggregateError);
      try {
        disposer();
      } catch (err: unknown) {
        expect(err).toBeInstanceOf(AggregateError);
        expect((err as AggregateError).message).toBe('Agent profile disposal failed');
        expect((err as AggregateError).errors.length).toBe(4);
      }
    });
  });

  describe('8. ExecTransport TurnId & Profile Forwarding', () => {
    it('DockerExecTransport.sendFollowup forwards turnId and profile snapshot to execOwned payload', async () => {
      let capturedPayload: unknown;
      const validSessionId = 'ses_0123456789abcdef0123456789abcdef';
      const validTurnId = 'turn_0123456789abcdef0123456789abcdef';
      const fakeDockerClient = {
        execOwned: async (_expectation: unknown, request: unknown) => {
          capturedPayload = request;
          return {
            status: 'completed' as const,
            sessionId: validSessionId,
            replyText: 'Echo reply',
            eventsCount: 2,
            persisted: true,
            turnId: validTurnId,
          };
        },
      } as unknown as DockerClient;

      const expectation: ContainerExpectation = {
        containerName: 'enkeep-demo-alice-001',
        runId: 'alice-001',
        userId: 'alice',
        volumeId: 'vol-alice-001',
      };

      const transport = new DockerExecTransport(fakeDockerClient as any, expectation as any, '/opt/enkeep/dist/runtime/cli.js');

      const profile = createValidProfileSnapshot();
      const res = await transport.sendFollowup({
        prompt: 'Test turnId forwarding',
        sessionId: validSessionId,
        turnId: validTurnId,
        profile,
      });

      expect(res.status).toBe('completed');
      expect(res.turnId).toBe(validTurnId);
      expect(capturedPayload).toEqual({
        action: 'followup',
        prompt: 'Test turnId forwarding',
        sessionId: validSessionId,
        turnId: validTurnId,
        profile,
      });
    });
  });
});
