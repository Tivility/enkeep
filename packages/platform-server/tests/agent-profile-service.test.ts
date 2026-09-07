import { describe, it, expect, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import {
  PlatformProfileService,
  createProfileService,
  computeAgentProfilePromptHash,
  canonicalProfileJsonStringify,
  validateSectionText,
  validatePromptSections,
  MAX_PROFILE_PROMPT_BYTES,
  PROMPT_HASH_PATTERN,
  ALLOWED_RUNTIME_PROFILE_KEYS,
  type AgentProfileApi,
} from '../src/profiles/profile-service.js';
import {
  SqlitePlatformStorage,
  SqliteTenantScopedAgentProfileRepository,
} from '@enkeep/platform-storage-sqlite';
import {
  PlatformError,
  NotFoundError,
  ValidationError,
  TenantAccessDeniedError,
} from '@enkeep/platform-core';
import { SqlitePlatformWebApiAdapter } from '../src/storage/sqlite-platform-api.js';
import { SqliteWebMessageStore } from '../src/storage/web-messages.js';
import { DefaultAuthService } from '@enkeep/platform-auth';
import { PlatformServerMigrationRunner, ALL_PLATFORM_MIGRATIONS } from '../src/storage/migrations.js';
// Import runtime runner's canonical prompt hash for cross-package fixture test
import {
  computeAgentProfilePromptHash as runtimeComputePromptHash,
  validateAgentProfileSnapshot as runtimeValidateSnapshot,
  AgentProfileValidationError as RuntimeValidationError,
} from '../../runtime-runner/src/runtime/agent-profile.js';

describe('Agent Profile Service & Canonical Governance Unit Tests', () => {
  let db: DatabaseSync;
  let storage: SqlitePlatformStorage;
  let profileService: AgentProfileApi;
  const aliceUserId = 'user_alice_test';
  const bobUserId = 'user_bob_test';

  beforeEach(async () => {
    db = new DatabaseSync(':memory:');
    const runner = new PlatformServerMigrationRunner(db);
    await runner.migrate(ALL_PLATFORM_MIGRATIONS);

    // Insert test users
    db.prepare(`
      INSERT INTO users (id, username, password_hash, role, status, created_at, updated_at)
      VALUES (?, 'alice', 'hash', 'user', 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `).run(aliceUserId);
    db.prepare(`
      INSERT INTO users (id, username, password_hash, role, status, created_at, updated_at)
      VALUES (?, 'bob', 'hash', 'user', 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `).run(bobUserId);

    storage = new SqlitePlatformStorage(db);
    profileService = createProfileService(storage, db);
  });

  describe('1. Canonical JSON Hashing & Cross-Package Fixture Compatibility', () => {
    it('generates 64-character lowercase hex SHA-256 hash matching PROMPT_HASH_PATTERN', () => {
      const sections = {
        identity: 'You are a helpful coding assistant.',
        soul: 'Be direct and concise.',
        agents: 'Delegate subtasks cleanly.',
        tools: 'Use file tools carefully.',
      };
      const hash = computeAgentProfilePromptHash(sections);
      expect(hash).toMatch(PROMPT_HASH_PATTERN);
      expect(hash.length).toBe(64);
      expect(hash).toBe(hash.toLowerCase());
    });

    it('matches runtime-runner computeAgentProfilePromptHash 100% byte-for-byte across diverse fixtures', () => {
      const testCases = [
        {
          identity: '',
          soul: '',
          agents: '',
          tools: '',
        },
        {
          identity: 'Single line identity',
          soul: 'Short soul',
          agents: 'Agent list',
          tools: 'Tool guidelines',
        },
        {
          identity: 'Multi-line\nIdentity\r\nWith\tTabs',
          soul: 'Special chars: !@#$%^&*()_+~`|}{[]:;?><,./-=\\',
          agents: 'Delegation rules with quotes: "hello" and \'world\'',
          tools: 'Tool definitions:\n1. read\n2. write\n3. bash',
        },
        {
          identity: 'CJK characters: 你好，世界！这是一个测试。',
          soul: 'Japanese: こんにちは世界、よろしくお願いします。',
          agents: 'Korean: 안녕하세요 세계',
          tools: 'Emoji test: 🚀 🤖 🛡️ 📦 ⚡',
        },
        {
          identity: 'A'.repeat(5000),
          soul: 'B'.repeat(5000),
          agents: 'C'.repeat(5000),
          tools: 'D'.repeat(5000),
        },
      ];

      for (const tc of testCases) {
        const serverHash = computeAgentProfilePromptHash(tc);
        const runtimeHash = runtimeComputePromptHash(tc);
        expect(serverHash).toBe(runtimeHash);
      }
    });

    it('is key-order invariant and deterministic', () => {
      const s1 = { identity: 'ID', soul: 'SOUL', agents: 'AGENTS', tools: 'TOOLS' };
      const s2 = { tools: 'TOOLS', identity: 'ID', soul: 'SOUL', agents: 'AGENTS' };
      expect(computeAgentProfilePromptHash(s1)).toBe(computeAgentProfilePromptHash(s2));
    });
  });

  describe('2. Prompt Section Validation (64 KiB, NFC, Control/Format/Bidi, Template Syntax)', () => {
    it('accepts valid 4 sections within 64 KiB', () => {
      const valid = {
        identity: 'Valid identity',
        soul: 'Valid soul',
        agents: 'Valid agents',
        tools: 'Valid tools',
      };
      const result = validatePromptSections(valid);
      expect(result.identity).toBe('Valid identity');
      expect(result.promptHash).toMatch(PROMPT_HASH_PATTERN);
    });

    it('allows valid whitespace: \\t, \\n, \\r', () => {
      const validWhitespace = {
        identity: 'Line 1\nLine 2\r\nLine 3\tTabbed',
        soul: '',
        agents: '',
        tools: '',
      };
      expect(() => validatePromptSections(validWhitespace)).not.toThrow();
    });

    it('rejects unnormalized Unicode (non-NFC) form', () => {
      // 'e' + combining acute accent (NFD)
      const nfdText = 'cafe\u0301';
      expect(nfdText.normalize('NFC') === nfdText).toBe(false);

      expect(() => validateSectionText('identity', nfdText)).toThrow(ValidationError);
      expect(() => validateSectionText('identity', nfdText)).toThrow(/Unicode NFC normalized form/);
    });

    it('rejects forbidden ASCII control characters (null, bell, ESC, etc.)', () => {
      expect(() => validateSectionText('soul', 'bad\x00null')).toThrow(ValidationError);
      expect(() => validateSectionText('soul', 'bad\x07bell')).toThrow(ValidationError);
      expect(() => validateSectionText('soul', 'bad\x1bescape')).toThrow(ValidationError);
      expect(() => validateSectionText('soul', 'bad\x08backspace')).toThrow(ValidationError);
    });

    it('rejects forbidden Unicode format and bidi characters (Cf, LTR/RTL overrides, zero-width spaces)', () => {
      expect(() => validateSectionText('agents', 'bad\u200Bzero-width')).toThrow(ValidationError); // zero-width space
      expect(() => validateSectionText('agents', 'bad\u200Eleft-to-right')).toThrow(ValidationError); // LRM
      expect(() => validateSectionText('agents', 'bad\u202Eoverride')).toThrow(ValidationError); // RLO
      expect(() => validateSectionText('agents', 'bad\u2028line-separator')).toThrow(ValidationError);
      expect(() => validateSectionText('agents', 'bad\u2029paragraph-separator')).toThrow(ValidationError);
    });

    it('rejects forbidden template variable tokens {{ and }} in any section', () => {
      expect(() => validateSectionText('identity', 'Hello {{user}}')).toThrow(ValidationError);
      expect(() => validateSectionText('identity', 'Hello {{user}}')).toThrow(/forbidden template variable/);
      expect(() => validateSectionText('soul', 'Be like {{ role }}')).toThrow(ValidationError);
      expect(() => validateSectionText('agents', 'Delegate to {{\nagent\n}}')).toThrow(ValidationError);
      expect(() => validateSectionText('tools', 'Use {{ tools.search }}')).toThrow(ValidationError);
      // Unpaired tokens
      expect(() => validateSectionText('identity', 'Hello {{ unclosed')).toThrow(ValidationError);
      expect(() => validateSectionText('identity', 'Hello unopened }}')).toThrow(ValidationError);
      expect(() => validateSectionText('soul', 'Isolated {{ token')).toThrow(ValidationError);
      expect(() => validateSectionText('tools', 'Isolated }} token')).toThrow(ValidationError);
    });

    it('strictly enforces total 64 KiB (65,536 bytes) limit across all 4 sections', () => {
      // 16,384 bytes each = exactly 65,536 bytes total -> allowed
      const exactFit = {
        identity: 'a'.repeat(16384),
        soul: 'b'.repeat(16384),
        agents: 'c'.repeat(16384),
        tools: 'd'.repeat(16384),
      };
      expect(() => validatePromptSections(exactFit)).not.toThrow();

      // 65,537 bytes -> rejected
      const oversized = {
        identity: 'a'.repeat(16385),
        soul: 'b'.repeat(16384),
        agents: 'c'.repeat(16384),
        tools: 'd'.repeat(16384),
      };
      expect(() => validatePromptSections(oversized)).toThrow(ValidationError);
      expect(() => validatePromptSections(oversized)).toThrow(/exceeds maximum allowable limit/);
    });
  });

  describe('3. Profile Creation, Listing, and Idempotency', () => {
    it('creates a profile with version 1 and active snapshot', async () => {
      const created = await profileService.createProfile(aliceUserId, {
        name: 'Coding Assistant',
        description: 'A helper for TypeScript development',
        identity: 'You are a Senior TypeScript Architect.',
        soul: 'Write robust, clean code.',
        agents: 'Delegate focused subtasks.',
        tools: 'Use git, read, write tools.',
        changeSummary: 'Initial profile creation',
      });

      expect(created.id).toBeDefined();
      expect((created as unknown as Record<string, unknown>).userId).toBeUndefined();
      expect(created.name).toBe('Coding Assistant');
      expect(created.activeVersion).toBe(1);
      expect(created.status).toBe('active');
      expect((created as unknown as Record<string, unknown>).promptHash).toBeUndefined();
      expect(created.snapshot).toBeDefined();
      expect(created.snapshot?.version).toBe(1);
      expect((created.snapshot as unknown as Record<string, unknown>).id).toBeUndefined();
      expect((created.snapshot as unknown as Record<string, unknown>).userId).toBeUndefined();
      expect((created.snapshot as unknown as Record<string, unknown>).profileId).toBeUndefined();
      expect((created.snapshot as unknown as Record<string, unknown>).promptHash).toBeUndefined();
      expect(created.snapshot?.identity).toBe('You are a Senior TypeScript Architect.');

      // Stringification check: ensures JSON.stringify contains no promptHash, snapshotId, or userId
      const json = JSON.stringify(created);
      expect(json).not.toContain('promptHash');
      expect(json).not.toContain('snapshotId');
      expect(json).not.toContain('userId');
    });

    it('supports Idempotency-Key: replays exact cached result on identical request', async () => {
      const key = 'a1111111-1111-4111-8111-111111111111';
      const input = {
        name: 'Idempotent Profile',
        identity: 'Identical Identity',
        soul: 'Identical Soul',
      };

      const res1 = await profileService.createProfile(aliceUserId, input, key);
      const res2 = await profileService.createProfile(aliceUserId, input, key);

      expect(res1.id).toBe(res2.id);
      expect(res1.name).toBe(res2.name);
      expect(res1.activeVersion).toBe(res2.activeVersion);
    });

    it('rejects reused Idempotency-Key with different payload with 409 Conflict', async () => {
      const key = 'a2222222-2222-4222-8222-222222222222';
      await profileService.createProfile(aliceUserId, {
        name: 'Profile Original',
        identity: 'Identity A',
      }, key);

      await expect(
        profileService.createProfile(aliceUserId, {
          name: 'Profile Modified',
          identity: 'Identity B',
        }, key)
      ).rejects.toThrow(PlatformError);

      try {
        await profileService.createProfile(aliceUserId, {
          name: 'Profile Modified',
          identity: 'Identity B',
        }, key);
      } catch (err) {
        expect((err as PlatformError).status).toBe(409);
        expect((err as PlatformError).code).toBe('CONFLICT');
      }
    });

    it('lists profiles for tenant without leaking raw prompt or promptHash in summary view', async () => {
      await profileService.createProfile(aliceUserId, {
        name: 'Alice Profile 1',
        identity: 'Secret Prompt Alice 1',
      });
      await profileService.createProfile(aliceUserId, {
        name: 'Alice Profile 2',
        identity: 'Secret Prompt Alice 2',
      });

      const list = await profileService.listProfiles(aliceUserId);
      expect(list.total).toBe(2);
      expect(list.items.length).toBe(2);
      expect((list.items[0] as unknown as Record<string, unknown>).promptHash).toBeUndefined();
      // Ensure safe summary does not have raw snapshot fields attached to top level
      expect((list.items[0] as unknown as Record<string, unknown>).identity).toBeUndefined();
    });

    it('enforces tenant isolation: Alice cannot see Bob profiles', async () => {
      await profileService.createProfile(bobUserId, {
        name: 'Bob Secret Profile',
        identity: 'Top Secret Bob Prompt',
      });

      const aliceList = await profileService.listProfiles(aliceUserId);
      expect(aliceList.total).toBe(0);
      expect(aliceList.items.length).toBe(0);
    });
  });

  describe('4. Version Creation & Immutability', () => {
    it('creates sequential immutable versions via DB transactions', async () => {
      const profile = await profileService.createProfile(aliceUserId, {
        name: 'Versioning Profile',
        identity: 'Version 1 Identity',
      });

      const v2 = await profileService.createVersion(aliceUserId, profile.id, {
        identity: 'Version 2 Identity',
        soul: 'Version 2 Soul',
        changeSummary: 'Upgraded to v2',
      });

      expect(v2.version).toBe(2);
      expect(v2.identity).toBe('Version 2 Identity');
      expect(v2.soul).toBe('Version 2 Soul');

      const v3 = await profileService.createVersion(aliceUserId, profile.id, {
        identity: 'Version 3 Identity',
        changeSummary: 'Upgraded to v3',
      });

      expect(v3.version).toBe(3);
      expect(v3.identity).toBe('Version 3 Identity');

      // Verify all versions are preserved and immutable
      const allVersions = await profileService.listVersions(aliceUserId, profile.id);
      expect(allVersions.length).toBe(3);
      expect(allVersions[0].version).toBe(1);
      expect(allVersions[0].identity).toBe('Version 1 Identity');
      expect(allVersions[1].version).toBe(2);
      expect(allVersions[1].identity).toBe('Version 2 Identity');
      expect(allVersions[2].version).toBe(3);
      expect(allVersions[2].identity).toBe('Version 3 Identity');
    });

    it('fetches specific version snapshot for owner', async () => {
      const profile = await profileService.createProfile(aliceUserId, {
        name: 'Multi Version Profile',
        identity: 'V1 Text',
      });
      await profileService.createVersion(aliceUserId, profile.id, {
        identity: 'V2 Text',
      });

      const v1 = await profileService.getVersion(aliceUserId, profile.id, 1);
      expect(v1?.version).toBe(1);
      expect(v1?.identity).toBe('V1 Text');

      const v2 = await profileService.getVersion(aliceUserId, profile.id, 2);
      expect(v2?.version).toBe(2);
      expect(v2?.identity).toBe('V2 Text');

      const v99 = await profileService.getVersion(aliceUserId, profile.id, 99);
      expect(v99).toBeNull();
    });

    it('handles concurrent version creations without version collisions', async () => {
      const profile = await profileService.createProfile(aliceUserId, {
        name: 'Concurrent Profile',
        identity: 'V1',
      });

      // Fire 5 concurrent version additions
      const promises = Array.from({ length: 5 }, (_, i) =>
        profileService.createVersion(aliceUserId, profile.id, {
          identity: `Concurrent Identity ${i + 2}`,
          changeSummary: `Concurrent update ${i + 2}`,
        })
      );

      const results = await Promise.all(promises);
      const versionNumbers = results.map((r) => r.version).sort((a, b) => a - b);
      expect(versionNumbers).toEqual([2, 3, 4, 5, 6]);

      const snapshots = await profileService.listVersions(aliceUserId, profile.id);
      expect(snapshots.length).toBe(6);
    });
  });

  describe('5. Space Profile Binding & Session Snapshot Resolution', () => {
    let spaceId: string;
    let routeId: string;

    beforeEach(async () => {
      const space = await storage.forTenant(aliceUserId).spaces.create({
        name: 'Alice Dev Space',
        folder: `space-${crypto.randomBytes(16).toString('hex')}`,
        executionMode: 'container',
      });
      spaceId = space.id;

      const route = await storage.forTenant(aliceUserId).sessionRoutes.create({
        spaceId: space.id,
        channel: 'web',
        nativeContextId: 'ctx_alice_1',
        dshSessionId: `ses_${crypto.randomBytes(16).toString('hex')}`,
        executionMode: 'container',
      });
      routeId = route.id;
    });

    it('returns null when no profile is bound to route or space', async () => {
      const snapshot = await profileService.getProfileSnapshotForSession(aliceUserId, routeId, 1);
      expect(snapshot).toBeNull();
    });

    it('binds space to profile version and resolves runtime snapshot for session route', async () => {
      const profile = await profileService.createProfile(aliceUserId, {
        name: 'Coding Bot',
        identity: 'You are CodingBot.',
        soul: 'Helpful and sharp.',
        agents: 'Delegate subagents.',
        tools: 'Use standard tools.',
      });

      // Bind space
      const bindResult = await profileService.bindSpaceProfile(aliceUserId, spaceId, {
        profileId: profile.id,
        version: 1,
      });
      expect(bindResult.spaceId).toBe(spaceId);
      expect(bindResult.profile).toEqual({
        id: profile.id,
        name: profile.name,
        version: 1,
      });

      const sessionRoute = await storage.forTenant(aliceUserId).sessionRoutes.create({
        spaceId,
        channel: 'web',
        nativeContextId: 'ctx_alice_bound',
        dshSessionId: `ses_${crypto.randomBytes(16).toString('hex')}`,
        executionMode: 'container',
      });

      // Resolve for session
      const snapshot = await profileService.getProfileSnapshotForSession(aliceUserId, sessionRoute.id, 1);
      expect(snapshot).toBeDefined();
      expect(snapshot?.profileId).toBe(profile.id);
      expect(snapshot?.version).toBe(1);
      expect(snapshot?.identity).toBe('You are CodingBot.');
      expect(snapshot?.promptHash).toMatch(PROMPT_HASH_PATTERN);

      // Verify that runtime-runner's validateAgentProfileSnapshot accepts it cleanly with NO extra keys!
      expect(() => runtimeValidateSnapshot(snapshot!)).not.toThrow();
      const validated = runtimeValidateSnapshot(snapshot!);
      expect(validated.promptHash).toBe(snapshot?.promptHash);
      expect(new Set(Object.keys(snapshot!))).toEqual(ALLOWED_RUNTIME_PROFILE_KEYS);
    });

    it('supports route-level explicit snapshot override taking precedence over space binding', async () => {
      const spaceProfile = await profileService.createProfile(aliceUserId, {
        name: 'Space Profile',
        identity: 'Space Identity',
      });
      const routeProfile = await profileService.createProfile(aliceUserId, {
        name: 'Route Profile',
        identity: 'Route Specific Identity',
      });

      await profileService.bindSpaceProfile(aliceUserId, spaceId, {
        profileId: spaceProfile.id,
      });

      const sessionRoute = await storage.forTenant(aliceUserId).sessionRoutes.create({
        spaceId,
        channel: 'web',
        nativeContextId: 'ctx_alice_route_override',
        dshSessionId: `ses_${crypto.randomBytes(16).toString('hex')}`,
        executionMode: 'container',
      });

      // Override on route generation
      const routeSnaps = await storage.forTenant(aliceUserId).agentProfiles.listSnapshots(routeProfile.id);
      const routeSnap = routeSnaps[0];
      db.prepare('UPDATE session_generations SET agent_profile_snapshot_id = ? WHERE route_id = ?').run(
        routeSnap.id,
        sessionRoute.id
      );

      const resolved = await profileService.getProfileSnapshotForSession(aliceUserId, sessionRoute.id, 1);
      expect(resolved?.profileId).toBe(routeProfile.id);
      expect(resolved?.identity).toBe('Route Specific Identity');
    });

    it('unbinding space profile removes profile binding', async () => {
      const profile = await profileService.createProfile(aliceUserId, {
        name: 'Temporary Profile',
        identity: 'Temp',
      });
      await profileService.bindSpaceProfile(aliceUserId, spaceId, { profileId: profile.id });

      const unbindResult = await profileService.unbindSpaceProfile(aliceUserId, spaceId);
      expect(unbindResult.spaceId).toBe(spaceId);
      expect(unbindResult.profile).toBeNull();

      const newSession = await storage.forTenant(aliceUserId).sessionRoutes.create({
        spaceId,
        channel: 'web',
        nativeContextId: 'ctx_unbound',
        dshSessionId: `ses_${crypto.randomBytes(16).toString('hex')}`,
        executionMode: 'container',
      });

      const resolved = await profileService.getProfileSnapshotForSession(aliceUserId, newSession.id, 1);
      expect(resolved).toBeNull();
    });

    it('rejects binding an archived profile, but preserves snapshot resolution for existing space bindings', async () => {
      const profile = await profileService.createProfile(aliceUserId, {
        name: 'Archived Bound Profile',
        identity: 'Bound before archive',
      });

      // Bind space before archiving
      await profileService.bindSpaceProfile(aliceUserId, spaceId, { profileId: profile.id });

      const pinnedSession = await storage.forTenant(aliceUserId).sessionRoutes.create({
        spaceId,
        channel: 'web',
        nativeContextId: 'ctx_pinned',
        dshSessionId: `ses_${crypto.randomBytes(16).toString('hex')}`,
        executionMode: 'container',
      });

      // Archive profile
      await profileService.archiveProfile(aliceUserId, profile.id);

      // Existing space binding continues to resolve immutable snapshot seamlessly!
      const resolved = await profileService.getProfileSnapshotForSession(aliceUserId, pinnedSession.id, 1);
      expect(resolved).toBeDefined();
      expect(resolved?.profileId).toBe(profile.id);
      expect(resolved?.identity).toBe('Bound before archive');

      // But creating a new binding to this archived profile is rejected with ValidationError!
      const space2 = await storage.forTenant(aliceUserId).spaces.create({
        name: 'Alice Dev Space 2',
        folder: `space-${crypto.randomBytes(16).toString('hex')}`,
        executionMode: 'container',
      });

      await expect(
        profileService.bindSpaceProfile(aliceUserId, space2.id, { profileId: profile.id })
      ).rejects.toThrow(ValidationError);
      await expect(
        profileService.bindSpaceProfile(aliceUserId, space2.id, { profileId: profile.id })
      ).rejects.toThrow(/Cannot modify or bind archived or deleted agent profile/);
    });

    it('fails closed with 500 when bound snapshot is deleted or corrupted', async () => {
      const profile = await profileService.createProfile(aliceUserId, {
        name: 'Corrupted Profile',
        identity: 'Valid initially',
      });
      await profileService.bindSpaceProfile(aliceUserId, spaceId, { profileId: profile.id });

      const corRoute = await storage.forTenant(aliceUserId).sessionRoutes.create({
        spaceId,
        channel: 'web',
        nativeContextId: 'ctx_corrupt',
        dshSessionId: `ses_${crypto.randomBytes(16).toString('hex')}`,
        executionMode: 'container',
      });

      // Corrupt snapshot binding by turning off foreign keys temporarily to simulate DB corruption
      db.exec('PRAGMA foreign_keys = OFF');
      db.prepare('UPDATE session_generations SET agent_profile_snapshot_id = ? WHERE route_id = ?').run(
        'snap_non_existent_123',
        corRoute.id
      );
      db.exec('PRAGMA foreign_keys = ON');

      try {
        await profileService.getProfileSnapshotForSession(aliceUserId, corRoute.id, 1);
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(PlatformError);
        expect((err as PlatformError).code).toBe('FAIL_CLOSED');
        expect((err as Error).message).toBe('Bound agent profile snapshot not found.');
      }
    });

    it('fails closed with 500 when snapshot text contains corrupted forbidden control characters', async () => {
      const profile = await profileService.createProfile(aliceUserId, {
        name: 'Control Profile',
        identity: 'Valid',
      });
      await profileService.bindSpaceProfile(aliceUserId, spaceId, { profileId: profile.id });

      const ctrlRoute = await storage.forTenant(aliceUserId).sessionRoutes.create({
        spaceId,
        channel: 'web',
        nativeContextId: 'ctx_ctrl',
        dshSessionId: `ses_${crypto.randomBytes(16).toString('hex')}`,
        executionMode: 'container',
      });

      // Corrupt snapshot text in DB directly with forbidden ESC control character
      db.prepare('UPDATE agent_profile_snapshots SET identity = ? WHERE profile_id = ?').run(
        'Corrupted\x1bEscapeCode',
        profile.id
      );

      try {
        await profileService.getProfileSnapshotForSession(aliceUserId, ctrlRoute.id, 1);
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(PlatformError);
        expect((err as PlatformError).code).toBe('FAIL_CLOSED');
        expect((err as Error).message).toBe('Agent profile snapshot failed validation.');
      }
    });
  });

  describe('6. Safe Audit Logging (Never Records Raw Prompts, Raw Hashes, snapshotId, or userId in Details)', () => {
    it('records audit log entries with metadata only and excludes raw sections and prompt hashes', async () => {
      const created = await profileService.createProfile(aliceUserId, {
        name: 'Audited Profile',
        identity: 'CLASSIFIED_PROMPT_CONTENT_NEVER_LOGGED',
        soul: 'CONFIDENTIAL_SOUL_CONTENT',
      });

      const auditLogs = await storage.auditLogs.listByUserId(aliceUserId);
      expect(auditLogs.length).toBeGreaterThan(0);

      const createLog = auditLogs.find((l) => (l.details as Record<string, unknown>)?.subAction === 'create_agent_profile');
      expect(createLog).toBeDefined();
      expect(createLog?.details?.profileId).toBe(created.id);
      expect(createLog?.details?.sectionBytes).toBeDefined();

      const details = createLog?.details as Record<string, unknown>;
      expect(details.promptHash).toBeUndefined();
      expect(details.snapshotId).toBeUndefined();
      expect(details.userId).toBeUndefined();

      // Verify raw prompt string is nowhere in the audit log JSON
      const serializedLog = JSON.stringify(createLog);
      expect(serializedLog).not.toContain('CLASSIFIED_PROMPT_CONTENT_NEVER_LOGGED');
      expect(serializedLog).not.toContain('CONFIDENTIAL_SOUL_CONTENT');

      // Verify serialized details contains no promptHash, snapshotId, or userId
      const serializedDetails = JSON.stringify(details);
      expect(serializedDetails).not.toContain('promptHash');
      expect(serializedDetails).not.toContain('snapshotId');
      expect(serializedDetails).not.toContain('userId');
    });
  });

  describe('7. Governance, Missing Idempotency Schema Loud Failure & DB Replay Verification', () => {
    it('fails loud with 500 when operation_idempotency table is missing and service does not auto-create it', async () => {
      // Drop operation_idempotency table to simulate missing migration
      db.exec('DROP TABLE IF EXISTS operation_idempotency');

      // Attempting createProfile with idempotencyKey should fail loudly (not silently create table)
      await expect(
        profileService.createProfile(aliceUserId, {
          name: 'Should Fail Loud Profile',
          identity: 'Identity',
        }, 'f0000000-0000-4000-8000-000000000001')
      ).rejects.toThrow(/Failed to check operation idempotency|no such table: operation_idempotency/);

      // Verify table was NOT auto-created by service
      const tableCheck = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='operation_idempotency'"
      ).get();
      expect(tableCheck).toBeUndefined();
    });

    it('persists receipt safe {profileId, version} in DB and reconstructs response from DB on replay', async () => {
      // Re-create migration 006 / operation_idempotency
      db.exec(`
        CREATE TABLE IF NOT EXISTS operation_idempotency (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          scope TEXT NOT NULL,
          idempotency_key TEXT NOT NULL,
          target_id TEXT,
          request_hash TEXT NOT NULL,
          response_payload TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
          UNIQUE(user_id, scope, idempotency_key)
        );
      `);

      const key = 'e1111111-1111-4111-8111-111111111111';
      const created = await profileService.createProfile(aliceUserId, {
        name: 'Persisted Receipt Profile',
        identity: 'Initial Identity',
        soul: 'Initial Soul',
      }, key);

      // Inspect DB row directly to verify stored receipt payload contains ONLY safe receipt {profileId, version}
      const row = db.prepare(
        'SELECT response_payload FROM operation_idempotency WHERE idempotency_key = ?'
      ).get(key) as { response_payload: string };
      expect(row).toBeDefined();

      const parsedReceipt = JSON.parse(row.response_payload);
      expect(parsedReceipt.profileId).toBe(created.id);
      expect(parsedReceipt.version).toBe(1);
      // Ensure receipt does not store raw prompts, promptHash, or snapshotId
      expect(parsedReceipt.identity).toBeUndefined();
      expect(parsedReceipt.promptHash).toBeUndefined();
      expect(parsedReceipt.snapshotId).toBeUndefined();

      // Replay returns reconstructed SafeAgentProfileDetail from DB
      const replayed = await profileService.createProfile(aliceUserId, {
        name: 'Persisted Receipt Profile',
        identity: 'Initial Identity',
        soul: 'Initial Soul',
      }, key);

      expect(replayed.id).toBe(created.id);
      expect(replayed.name).toBe('Persisted Receipt Profile');
      expect(replayed.snapshot?.identity).toBe('Initial Identity');
    });

    it('runtime resolver verifies persisted snapshot prompt_hash against recomputed hash', async () => {
      // Add prompt_hash column if not already present
      const cols = db.prepare("PRAGMA table_info('agent_profile_snapshots')").all() as { name: string }[];
      if (!cols.some((c) => c.name === 'prompt_hash')) {
        db.exec('ALTER TABLE agent_profile_snapshots ADD COLUMN prompt_hash TEXT;');
      }

      const profile = await profileService.createProfile(aliceUserId, {
        name: 'Hash Verified Profile',
        identity: 'Secure Identity',
        soul: 'Secure Soul',
        agents: 'Secure Agents',
        tools: 'Secure Tools',
      });

      const space = await storage.forTenant(aliceUserId).spaces.create({
        name: 'Secure Space',
        folder: `space-${crypto.randomBytes(16).toString('hex')}`,
      });

      await profileService.bindSpaceProfile(aliceUserId, space.id, { profileId: profile.id });

      const route = await storage.forTenant(aliceUserId).sessionRoutes.create({
        spaceId: space.id,
        channel: 'web',
        nativeContextId: 'ctx_secure',
        dshSessionId: `ses_${crypto.randomBytes(16).toString('hex')}`,
      });

      // Valid resolution succeeds
      const resolved = await profileService.getProfileSnapshotForSession(aliceUserId, route.id, 1);
      expect(resolved).toBeDefined();
      expect(resolved?.promptHash).toMatch(PROMPT_HASH_PATTERN);

      // Tamper with stored prompt_hash in DB directly
      db.prepare('UPDATE agent_profile_snapshots SET prompt_hash = ? WHERE profile_id = ?').run(
        '0000000000000000000000000000000000000000000000000000000000000000',
        profile.id
      );

      // Resolver detects mismatch and fails closed with FAIL_CLOSED
      try {
        await profileService.getProfileSnapshotForSession(aliceUserId, route.id, 1);
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(PlatformError);
        expect((err as PlatformError).code).toBe('FAIL_CLOSED');
        expect((err as Error).message).toBe('Stored prompt hash does not match recomputed hash.');
      }
    });

    it('confirms profile service exposes no hard delete method', () => {
      expect((profileService as any).delete).toBeUndefined();
      expect((profileService as any).deleteProfile).toBeUndefined();
    });
  });

  describe('8. End-to-End Generative Reset & Space Binding Lifecycle (createSession, resetSession)', () => {
    let platformApi: SqlitePlatformWebApiAdapter;

    beforeEach(() => {
      const authService = new DefaultAuthService(storage, {
        cookieSecret: 'test_cookie_secret_at_least_32_chars_long_12345',
      });
      platformApi = new SqlitePlatformWebApiAdapter({
        storage,
        authService,
        messageStore: new SqliteWebMessageStore(db),
        db,
      });
    });

    it('binds space then creates session with v1; publish v2 preserves v1 until reset then gets v2', async () => {
      // 1. Create Space
      const space = await storage.forTenant(aliceUserId).spaces.create({
        name: 'Lifecycle Space',
        folder: `space-${crypto.randomBytes(16).toString('hex')}`,
        executionMode: 'container',
      });

      // 2. Create Profile v1
      const profile = await profileService.createProfile(aliceUserId, {
        name: 'Lifecycle Profile',
        identity: 'Version 1 Identity',
      });

      // 3. Bind Space to Profile v1
      await profileService.bindSpaceProfile(aliceUserId, space.id, {
        profileId: profile.id,
        version: 1,
      });

      // 4. Create Session in Space -> gets pinned to v1 snapshot
      const session = await platformApi.createSession(aliceUserId, {
        spaceId: space.id,
        title: 'Lifecycle Session',
      });

      expect(session.id).toBeDefined();
      expect(session.currentGeneration).toBe(1);

      const snapshotGen1 = await profileService.getProfileSnapshotForSession(aliceUserId, session.id, 1);
      expect(snapshotGen1).toBeDefined();
      expect(snapshotGen1?.version).toBe(1);
      expect(snapshotGen1?.identity).toBe('Version 1 Identity');

      // 5. Publish Profile Version 2 and update space binding to v2
      const v2 = await profileService.createVersion(aliceUserId, profile.id, {
        identity: 'Version 2 Identity',
      });
      expect(v2.version).toBe(2);

      await profileService.bindSpaceProfile(aliceUserId, space.id, {
        profileId: profile.id,
        version: 2,
      });

      // 6. Existing session remains pinned to v1 BEFORE reset!
      const snapshotBeforeReset = await profileService.getProfileSnapshotForSession(aliceUserId, session.id, 1);
      expect(snapshotBeforeReset).toBeDefined();
      expect(snapshotBeforeReset?.version).toBe(1);
      expect(snapshotBeforeReset?.identity).toBe('Version 1 Identity');

      // 7. Reset Session -> Generates generation 2 with refreshed space binding v2!
      const resetResult = await platformApi.resetSession(aliceUserId, session.id, {
        idempotencyKey: '00000000-0000-4000-8000-000000000001',
        reason: 'Upgrade to v2',
      });
      expect(resetResult.generation.generation).toBe(2);
      expect(resetResult.session.currentGeneration).toBe(2);

      const snapshotGen2 = await profileService.getProfileSnapshotForSession(aliceUserId, session.id, 2);
      expect(snapshotGen2).toBeDefined();
      expect(snapshotGen2?.version).toBe(2);
      expect(snapshotGen2?.identity).toBe('Version 2 Identity');

      // Verify generation 1 in DB still preserves v1 snapshot
      const gen1Row = db.prepare(`
        SELECT agent_profile_snapshot_id
        FROM session_generations
        WHERE route_id = ? AND generation_number = 1
      `).get(session.id) as { agent_profile_snapshot_id: string };
      const gen2Row = db.prepare(`
        SELECT agent_profile_snapshot_id
        FROM session_generations
        WHERE route_id = ? AND generation_number = 2
      `).get(session.id) as { agent_profile_snapshot_id: string };

      expect(gen1Row.agent_profile_snapshot_id).not.toBe(gen2Row.agent_profile_snapshot_id);

      // 8. Unbind Profile from Space -> existing session remains pinned to v2 until reset
      await profileService.unbindSpaceProfile(aliceUserId, space.id);

      const snapshotBeforeReset2 = await profileService.getProfileSnapshotForSession(aliceUserId, session.id, 2);
      expect(snapshotBeforeReset2).toBeDefined();
      expect(snapshotBeforeReset2?.version).toBe(2);

      // 9. Reset Session again -> Generation 3 has no snapshot
      const resetResult2 = await platformApi.resetSession(aliceUserId, session.id, {
        idempotencyKey: '00000000-0000-4000-8000-000000000002',
        reason: 'Unbind to raw space',
      });
      expect(resetResult2.generation.generation).toBe(3);

      const snapshotGen3 = await profileService.getProfileSnapshotForSession(aliceUserId, session.id, 3);
      expect(snapshotGen3).toBeNull();
    });

    it('fails closed with 500 when space binding references corrupt snapshot during createSession and resetSession', async () => {
      const space = await storage.forTenant(aliceUserId).spaces.create({
        name: 'Corrupt Bound Space',
        folder: `space-${crypto.randomBytes(16).toString('hex')}`,
        executionMode: 'container',
      });

      // Manually set invalid snapshot ID in space
      db.exec('PRAGMA foreign_keys = OFF');
      db.prepare('UPDATE spaces SET agent_profile_snapshot_id = ? WHERE id = ?').run(
        'snap_corrupt_nonexistent',
        space.id
      );
      db.exec('PRAGMA foreign_keys = ON');

      // createSession fails closed
      await expect(
        platformApi.createSession(aliceUserId, { spaceId: space.id })
      ).rejects.toThrow(/FAIL_CLOSED/);
    });

    it('fails closed with 500 when space binding references archived profile during createSession and resetSession', async () => {
      const space = await storage.forTenant(aliceUserId).spaces.create({
        name: 'Archived Bound Space',
        folder: `space-${crypto.randomBytes(16).toString('hex')}`,
        executionMode: 'container',
      });

      const profile = await profileService.createProfile(aliceUserId, {
        name: 'Profile To Be Archived',
        identity: 'Active at creation',
      });

      // Set space agent_profile_id directly
      db.prepare('UPDATE spaces SET agent_profile_id = ? WHERE id = ?').run(
        profile.id,
        space.id
      );

      // Archive profile
      await profileService.archiveProfile(aliceUserId, profile.id);

      // createSession fails closed with 500 FAIL_CLOSED because space references archived profile
      await expect(
        platformApi.createSession(aliceUserId, { spaceId: space.id })
      ).rejects.toThrow(/FAIL_CLOSED.*archived/);
    });
  });

  describe('9. Strict Session Generation Snapshot Resolution & Fail-Closed Invariants', () => {
    it('validates that generation must be a positive safe integer', async () => {
      const space = await storage.forTenant(aliceUserId).spaces.create({
        name: 'Gen Test Space',
        folder: `space-${crypto.randomBytes(16).toString('hex')}`,
      });
      const route = await storage.forTenant(aliceUserId).sessionRoutes.create({
        spaceId: space.id,
        channel: 'web',
        nativeContextId: 'ctx_gen_test',
        dshSessionId: `ses_${crypto.randomBytes(16).toString('hex')}`,
      });

      // 0, negative, float, NaN, infinity
      await expect(profileService.getProfileSnapshotForSession(aliceUserId, route.id, 0)).rejects.toThrow(ValidationError);
      await expect(profileService.getProfileSnapshotForSession(aliceUserId, route.id, -1)).rejects.toThrow(ValidationError);
      await expect(profileService.getProfileSnapshotForSession(aliceUserId, route.id, 1.5)).rejects.toThrow(ValidationError);
      await expect(profileService.getProfileSnapshotForSession(aliceUserId, route.id, NaN)).rejects.toThrow(ValidationError);
      await expect(profileService.getProfileSnapshotForSession(aliceUserId, route.id, Infinity)).rejects.toThrow(ValidationError);

      await expect(profileService.resolve(aliceUserId, route.id, 0)).rejects.toThrow(ValidationError);
      await expect(profileService.resolve(aliceUserId, route.id, -1)).rejects.toThrow(ValidationError);
    });

    it('fails closed when session_generations row does not exist for the queried generation', async () => {
      const space = await storage.forTenant(aliceUserId).spaces.create({
        name: 'Missing Gen Space',
        folder: `space-${crypto.randomBytes(16).toString('hex')}`,
      });
      const route = await storage.forTenant(aliceUserId).sessionRoutes.create({
        spaceId: space.id,
        channel: 'web',
        nativeContextId: 'ctx_missing_gen',
        dshSessionId: `ses_${crypto.randomBytes(16).toString('hex')}`,
      });

      // Generation 999 does not exist in session_generations table
      try {
        await profileService.getProfileSnapshotForSession(aliceUserId, route.id, 999);
        expect.unreachable('Should have failed closed');
      } catch (err) {
        expect(err).toBeInstanceOf(PlatformError);
        expect((err as PlatformError).code).toBe('FAIL_CLOSED');
        expect((err as Error).message).toBe('Session generation record not found.');
      }

      // resolve also fails closed
      try {
        await profileService.resolve(aliceUserId, route.id, 999);
        expect.unreachable('Should have failed closed');
      } catch (err) {
        expect(err).toBeInstanceOf(PlatformError);
        expect((err as PlatformError).code).toBe('FAIL_CLOSED');
        expect((err as Error).message).toBe('Session generation record not found.');
      }
    });

    it('resolve delegates directly to getProfileSnapshotForSession and returns RuntimeAgentProfileSnapshot or null', async () => {
      const space = await storage.forTenant(aliceUserId).spaces.create({
        name: 'Resolve Test Space',
        folder: `space-${crypto.randomBytes(16).toString('hex')}`,
      });
      const route = await storage.forTenant(aliceUserId).sessionRoutes.create({
        spaceId: space.id,
        channel: 'web',
        nativeContextId: 'ctx_resolve_test',
        dshSessionId: `ses_${crypto.randomBytes(16).toString('hex')}`,
      });

      // No profile bound -> returns null
      const nullResult = await profileService.resolve(aliceUserId, route.id, 1);
      expect(nullResult).toBeNull();

      // Profile bound -> returns snapshot
      const profile = await profileService.createProfile(aliceUserId, {
        name: 'Resolve Bot',
        identity: 'Resolve Identity',
      });
      await profileService.bindSpaceProfile(aliceUserId, space.id, { profileId: profile.id });

      const snapList = await storage.forTenant(aliceUserId).agentProfiles.listSnapshots(profile.id);
      db.prepare('UPDATE session_generations SET agent_profile_snapshot_id = ? WHERE route_id = ?').run(
        snapList[0].id,
        route.id
      );

      const resolved = await profileService.resolve(aliceUserId, route.id, 1);
      expect(resolved).not.toBeNull();
      expect(resolved?.profileId).toBe(profile.id);
      expect(resolved?.identity).toBe('Resolve Identity');
    });

    it('createVersion idempotency replay fails with INTERNAL_ERROR if replay record has invalid/missing version', async () => {
      const profile = await profileService.createProfile(aliceUserId, {
        name: 'Idemp Test Profile',
        identity: 'Initial Identity',
      });

      const key = 'a0000000-0000-4000-8000-000000000099';
      // First version create
      await profileService.createVersion(aliceUserId, profile.id, {
        identity: 'Version 2 Identity',
      }, key);

      // Corrupt the stored response_payload to omit version
      db.prepare('UPDATE operation_idempotency SET response_payload = ? WHERE idempotency_key = ?').run(
        JSON.stringify({ profileId: profile.id }), // missing version!
        key
      );

      await expect(
        profileService.createVersion(aliceUserId, profile.id, {
          identity: 'Version 2 Identity',
        }, key)
      ).rejects.toThrow(/Idempotent replay record missing valid version/);
    });

    it('rollbackProfileVersion: rolls back to targetVersion creating N+1 active version snapshot with correct audit logging', async () => {
      const profile = await profileService.createProfile(aliceUserId, {
        name: 'Service Rollback Test Profile',
        identity: 'V1 Identity',
        soul: 'V1 Soul',
      });

      await profileService.createVersion(aliceUserId, profile.id, {
        identity: 'V2 Identity',
        soul: 'V2 Soul',
      });

      await profileService.createVersion(aliceUserId, profile.id, {
        identity: 'V3 Identity',
        soul: 'V3 Soul',
      });

      const key = 'b0000000-0000-4000-8000-000000000001';
      const rolledBack = await profileService.rollbackProfileVersion(
        aliceUserId,
        profile.id,
        { targetVersion: 1 },
        key,
        { id: aliceUserId }
      );

      expect(rolledBack.version).toBe(4);
      expect(rolledBack.newVersion).toBe(4);
      expect(rolledBack.identity).toBe('V1 Identity');
      expect(rolledBack.soul).toBe('V1 Soul');
      expect(rolledBack.changeSummary).toBe('Rollback to v1');

      // Idempotent replay with same key
      const replay = await profileService.rollbackProfileVersion(
        aliceUserId,
        profile.id,
        { targetVersion: 1 },
        key,
        { id: aliceUserId }
      );
      expect(replay.version).toBe(4);
      expect(replay.newVersion).toBe(4);

      // Replay conflict with same key different targetVersion -> 409
      await expect(
        profileService.rollbackProfileVersion(
          aliceUserId,
          profile.id,
          { targetVersion: 2 },
          key,
          { id: aliceUserId }
        )
      ).rejects.toThrow(/Idempotency key was already used with different request parameters/);

      // Verify atomic audit log with action profile_version_rolled_back
      const auditLog = db.prepare("SELECT username, action, details FROM auth_audit_log WHERE action = 'profile_version_rolled_back'").get() as any;
      expect(auditLog).toBeDefined();
      expect(auditLog.username).toBe('alice');
      const details = JSON.parse(auditLog.details);
      expect(details.profileId).toBe(profile.id);
      expect(details.version).toBe(4);
      expect(details.newVersion).toBe(4);
      expect(details.targetVersion).toBe(1);
      expect(details.changeSummary).toBeUndefined();
      expect(details.identity).toBeUndefined();
    });
  });
});
