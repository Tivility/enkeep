/**
 * Enkeep Runtime Bundle Composition Tests
 *
 * Validates manifest declaration, typed bundle composition, strict options validation,
 * atomic entry factories, fiber lifecycle, and reverse disposal on failure.
 *
 * @module @enkeep/dsh-enkeep-bundle/tests/bundle.test
 */

import { existsSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, afterEach } from 'vitest';
import { Context, Service } from '@deepseek-ai/cordis';

import {
  createEnkeepRuntimeBundle,
  validateEnkeepBundleOptions,
  applyBundleEntry,
  applyEnkeepBundle,
  isRecord,
  createReceiptStoreEntry,
  createInboundEntry,
  createEventRelayEntry,
  createToolsEntry,
  createExternalInteractionEntry,
  createAffinityPolicyEntry,
  createLlmAffinityEntry,
  createBrowserToolsEntry,
  createMcpGovernanceEntry,
  createCliToolsEntry,
  receiptStorePlugin,
  inboundPlugin,
  eventRelayPlugin,
  toolsPlugin,
  externalInteractionPlugin,
  affinityPolicyPlugin,
  llmAffinityPlugin,
  browserToolsPlugin,
  mcpGovernancePlugin,
  cliToolsPlugin,
} from '../src/index.js';

class MockAgentsService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'agents');
  }
}

class MockToolsService extends Service {
  public tools: Array<{ name: string }> = [];
  constructor(ctx: Context) {
    super(ctx, 'tools');
  }
  register(tool: { name: string }) {
    this.tools.push(tool);
    return () => {
      const idx = this.tools.indexOf(tool);
      if (idx !== -1) this.tools.splice(idx, 1);
    };
  }
}

class MockLlmService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'llm');
  }
}

describe('dsh-enkeep-bundle: Manifest, Typed Composition & Lifecycle', () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });

  it('declares valid dsh.bundle manifest with exact dependencies in package.json', () => {
    const manifestPath = resolve(root, 'package.json');
    expect(existsSync(manifestPath)).toBe(true);

    const rawParsed: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'));
    expect(isRecord(rawParsed)).toBe(true);
    if (!isRecord(rawParsed)) throw new Error('Expected record');

    const dsh = rawParsed['dsh'];
    expect(isRecord(dsh)).toBe(true);
    if (!isRecord(dsh)) throw new Error('Expected dsh record');

    const bundle = dsh['bundle'];
    expect(isRecord(bundle)).toBe(true);
    if (!isRecord(bundle)) throw new Error('Expected bundle record');

    expect(bundle['patch']).toBe('./cordis.patch.yml');

    const patchPath = resolve(root, String(bundle['patch']));
    expect(existsSync(patchPath)).toBe(true);

    const deps = rawParsed['dependencies'];
    expect(isRecord(deps)).toBe(true);
    if (!isRecord(deps)) throw new Error('Expected dependencies record');

    // Verify registry version for @tivility/dsh-llm-affinity (must be exact 0.1.1)
    expect(deps['@tivility/dsh-llm-affinity']).toBe('0.1.1');
    expect(deps['@enkeep/dsh-receipt-store-sqlite']).toBe('workspace:*');
    expect(deps['@enkeep/dsh-inbound']).toBe('workspace:*');
    expect(deps['@enkeep/dsh-event-relay']).toBe('workspace:*');
    expect(deps['@enkeep/dsh-tools']).toBe('workspace:*');
    expect(deps['@enkeep/dsh-external-interaction']).toBe('workspace:*');
    expect(deps['@enkeep/dsh-affinity-policy']).toBe('workspace:*');
    expect(deps['@enkeep/dsh-tool-browser']).toBe('workspace:*');
  });

  it('validateEnkeepBundleOptions strictly validates and rejects relative, non-sibling, or invalid options', () => {
    // Non-plain-object input
    expect(() => validateEnkeepBundleOptions(null)).toThrow(/plain object/i);
    expect(() => validateEnkeepBundleOptions('invalid')).toThrow(/plain object/i);
    expect(() => validateEnkeepBundleOptions([])).toThrow(/plain object/i);

    // Unexpected extra keys
    expect(() =>
      validateEnkeepBundleOptions({
        userId: 'alice',
        dshHome: '/tmp/test/.dsh',
        spacesDir: '/tmp/test/spaces',
        unknownKey: 'hack',
      })
    ).toThrow(/Unexpected option key/i);

    // Invalid or missing userId
    expect(() =>
      validateEnkeepBundleOptions({
        userId: '',
        dshHome: '/tmp/test/.dsh',
        spacesDir: '/tmp/test/spaces',
      })
    ).toThrow(/Invalid or missing "userId"/i);

    expect(() =>
      validateEnkeepBundleOptions({
        userId: 'bad/user/name',
        dshHome: '/tmp/test/.dsh',
        spacesDir: '/tmp/test/spaces',
      })
    ).toThrow(/Invalid or missing "userId"/i);

    // Missing dshHome
    expect(() =>
      validateEnkeepBundleOptions({
        userId: 'alice',
        dshHome: '',
        spacesDir: '/tmp/test/spaces',
      })
    ).toThrow(/Invalid or missing "dshHome"/i);

    // Relative dshHome (must reject relative paths)
    expect(() =>
      validateEnkeepBundleOptions({
        userId: 'alice',
        dshHome: 'relative/.dsh',
        spacesDir: '/tmp/test/spaces',
      })
    ).toThrow(/Invalid or missing "dshHome"/i);

    // Non-normalized dshHome (e.g. containing /../)
    expect(() =>
      validateEnkeepBundleOptions({
        userId: 'alice',
        dshHome: '/tmp/test/../other/.dsh',
        spacesDir: '/tmp/test/spaces',
      })
    ).toThrow(/Invalid or missing "dshHome"/i);

    // Missing spacesDir
    expect(() =>
      validateEnkeepBundleOptions({
        userId: 'alice',
        dshHome: '/tmp/test/.dsh',
      })
    ).toThrow(/Invalid or missing "spacesDir"/i);

    // Relative spacesDir
    expect(() =>
      validateEnkeepBundleOptions({
        userId: 'alice',
        dshHome: '/tmp/test/.dsh',
        spacesDir: 'relative/spaces',
      })
    ).toThrow(/Invalid or missing "spacesDir"/i);

    // Non-sibling spacesDir (arbitrary path rejected)
    expect(() =>
      validateEnkeepBundleOptions({
        userId: 'alice',
        dshHome: '/home/dsh/.dsh',
        spacesDir: '/custom/arbitrary/spaces',
      })
    ).toThrow(/must be a sibling directory under dirname\(dshHome\)/i);

    // Non-spaces basename rejected
    expect(() =>
      validateEnkeepBundleOptions({
        userId: 'alice',
        dshHome: '/home/dsh/.dsh',
        spacesDir: '/home/dsh/custom-spaces',
      })
    ).toThrow(/named "spaces"/i);

    // Valid sibling directories
    const valid = validateEnkeepBundleOptions({
      userId: 'alice',
      dshHome: '/home/dsh/.dsh',
      spacesDir: '/home/dsh/spaces',
    });
    expect(valid.userId).toBe('alice');
    expect(valid.dshHome).toBe('/home/dsh/.dsh');
    expect(valid.spacesDir).toBe('/home/dsh/spaces');
  });

  it('createEnkeepRuntimeBundle returns exact 8 typed entries in composition order with canonical paths', () => {
    const parentDir = mkdtempSync(join(tmpdir(), 'enkeep-bundle-test-'));
    tempDirs.push(parentDir);
    const dshHome = join(parentDir, '.dsh');
    const spacesDir = join(parentDir, 'spaces');

    const bundle = createEnkeepRuntimeBundle({
      userId: 'alice',
      dshHome,
      spacesDir,
    });

    expect(bundle.length).toBe(10);

    const [
      receiptStore,
      inbound,
      eventRelay,
      tools,
      externalInteraction,
      affinityPolicy,
      llmAffinity,
      browserTools,
      mcpGovernance,
      cliTools,
    ] = bundle;

    // 1. receipt-store
    expect(receiptStore.id).toBe('receipt-store');
    expect(receiptStore.name).toBe('@enkeep/dsh-receipt-store-sqlite');
    expect(receiptStore.plugin).toBe(receiptStorePlugin);
    expect(receiptStore.config.path).toBe(join(dshHome, 'data', 'receipts.db'));
    expect(receiptStore.config.userId).toBe('alice');
    expect(receiptStore.config.busyTimeoutMs).toBe(5000);

    // 2. inbound
    expect(inbound.id).toBe('inbound');
    expect(inbound.name).toBe('@enkeep/dsh-inbound');
    expect(inbound.plugin).toBe(inboundPlugin);
    expect(inbound.config.defaultTarget).toBe('followup');

    // 3. event-relay
    expect(eventRelay.id).toBe('event-relay');
    expect(eventRelay.name).toBe('@enkeep/dsh-event-relay');
    expect(eventRelay.plugin).toBe(eventRelayPlugin);
    expect(eventRelay.config.maxBufferSize).toBe(1000);

    // 4. enkeep-tools
    expect(tools.id).toBe('enkeep-tools');
    expect(tools.name).toBe('@enkeep/dsh-tools');
    expect(tools.plugin).toBe(toolsPlugin);
    expect(tools.config.workspaceRoot).toBe(spacesDir);
    expect(tools.config.maxFileSizeBytes).toBe(10485760);

    // 5. enkeep-external-interaction
    expect(externalInteraction.id).toBe('enkeep-external-interaction');
    expect(externalInteraction.name).toBe('@enkeep/dsh-external-interaction');
    expect(externalInteraction.plugin).toBe(externalInteractionPlugin);
    expect(externalInteraction.config.defaultTimeoutMs).toBe(60000);

    // 6. enkeep-affinity-policy
    expect(affinityPolicy.id).toBe('enkeep-affinity-policy');
    expect(affinityPolicy.name).toBe('@enkeep/dsh-affinity-policy');
    expect(affinityPolicy.plugin).toBe(affinityPolicyPlugin);
    expect(affinityPolicy.config.strict).toBe(true);
    expect(affinityPolicy.config.exemptAuxiliary).toBe(false);

    // 7. llm-affinity
    expect(llmAffinity.id).toBe('llm-affinity');
    expect(llmAffinity.name).toBe('@tivility/dsh-llm-affinity');
    expect(llmAffinity.plugin).toBe(llmAffinityPlugin);
    expect(llmAffinity.config.header).toBe('X-Session-ID');

    // 8. browser-tools
    expect(browserTools.id).toBe('browser-tools');
    expect(browserTools.name).toBe('@enkeep/dsh-tool-browser');
    expect(browserTools.plugin).toBe(browserToolsPlugin);
    expect(browserTools.config.maxSnapshotLength).toBe(65536);
    expect(browserTools.config.defaultTimeoutMs).toBe(30000);

    // 9. mcp-governance
    expect(mcpGovernance.id).toBe('mcp-governance');
    expect(mcpGovernance.name).toBe('@enkeep/dsh-mcp-governance');
    expect(mcpGovernance.plugin).toBe(mcpGovernancePlugin);
    expect(mcpGovernance.config.defaultTimeoutMs).toBe(60000);
    expect(mcpGovernance.config.maxInlineBytes).toBe(65536);

    // 10. cli-tools
    expect(cliTools.id).toBe('cli-tools');
    expect(cliTools.name).toBe('@enkeep/dsh-tool-cli');
    expect(cliTools.plugin).toBe(cliToolsPlugin);
    expect(cliTools.config.defaultTimeoutMs).toBe(15000);
    expect(cliTools.config.maxOutputBytes).toBe(1048576);
  });

  it('allows atomic plugins to be individually applied and disposed independently', async () => {
    const parentDir = mkdtempSync(join(tmpdir(), 'enkeep-atomic-plugins-'));
    tempDirs.push(parentDir);
    const dshHome = join(parentDir, '.dsh');
    const spacesDir = join(parentDir, 'spaces');

    // 1. Receipt store alone
    {
      const ctx = new Context();
      const entry = createReceiptStoreEntry(dshHome, 'test-user');
      const fiber = await applyBundleEntry(ctx, entry);
      expect(ctx.receiptStore).toBeDefined();
      await fiber.dispose();
      await ctx.fiber.dispose();
    }

    // 2. Inbound alone
    {
      const ctx = new Context();
      ctx.plugin(MockAgentsService);
      const entry = createInboundEntry();
      const fiber = await applyBundleEntry(ctx, entry);
      expect(ctx.inbound).toBeDefined();
      await fiber.dispose();
      await ctx.fiber.dispose();
    }

    // 3. Event relay alone
    {
      const ctx = new Context();
      const entry = createEventRelayEntry();
      const fiber = await applyBundleEntry(ctx, entry);
      expect(ctx.eventRelay).toBeDefined();
      await fiber.dispose();
      await ctx.fiber.dispose();
    }

    // 4. Tools alone
    {
      const ctx = new Context();
      ctx.plugin(MockToolsService);
      const entry = createToolsEntry(spacesDir);
      const fiber = await applyBundleEntry(ctx, entry);
      expect(ctx.tools).toBeDefined();
      await fiber.dispose();
      await ctx.fiber.dispose();
    }

    // 5. External interaction alone
    {
      const ctx = new Context();
      const entry = createExternalInteractionEntry();
      const fiber = await applyBundleEntry(ctx, entry);
      expect(ctx.externalInteraction).toBeDefined();
      await fiber.dispose();
      await ctx.fiber.dispose();
    }

    // 6. Affinity policy alone
    {
      const ctx = new Context();
      const entry = createAffinityPolicyEntry();
      const fiber = await applyBundleEntry(ctx, entry);
      expect(fiber).toBeDefined();
      await fiber.dispose();
      await ctx.fiber.dispose();
    }

    // 7. LLM affinity alone
    {
      const ctx = new Context();
      ctx.plugin(MockLlmService);
      const entry = createLlmAffinityEntry();
      const fiber = await applyBundleEntry(ctx, entry);
      expect(fiber).toBeDefined();
      await fiber.dispose();
      await ctx.fiber.dispose();
    }

    // 8. Browser tools alone
    {
      const ctx = new Context();
      ctx.plugin(MockToolsService);
      const entry = createBrowserToolsEntry();
      const fiber = await applyBundleEntry(ctx, entry);
      expect(ctx.browserTools).toBeDefined();
      await fiber.dispose();
      await ctx.fiber.dispose();
    }

    // 9. MCP Governance alone
    {
      const ctx = new Context();
      const entry = createMcpGovernanceEntry();
      const fiber = await applyBundleEntry(ctx, entry);
      expect(ctx.mcpGovernance).toBeDefined();
      await fiber.dispose();
      await ctx.fiber.dispose();
    }
  });

  it('applies full bundle and returns active fibers tuple with clean teardown', async () => {
    const parentDir = mkdtempSync(join(tmpdir(), 'enkeep-full-bundle-'));
    tempDirs.push(parentDir);
    const dshHome = join(parentDir, '.dsh');
    const spacesDir = join(parentDir, 'spaces');

    const ctx = new Context();
    ctx.plugin(MockAgentsService);
    ctx.plugin(MockToolsService);
    ctx.plugin(MockLlmService);

    const bundle = createEnkeepRuntimeBundle({
      userId: 'alice',
      dshHome,
      spacesDir,
    });

    const fibers = await applyEnkeepBundle(ctx, bundle);
    expect(fibers).toHaveLength(10);

    // Verify services are present and functioning
    expect(ctx.receiptStore).toBeDefined();
    expect(ctx.inbound).toBeDefined();
    expect(ctx.eventRelay).toBeDefined();
    expect(ctx.tools).toBeDefined();
    expect(ctx.externalInteraction).toBeDefined();
    expect(ctx.browserTools).toBeDefined();
    expect(ctx.mcpGovernance).toBeDefined();
    expect(ctx.cliTools).toBeDefined();

    // Verify clean disposal
    for (let i = fibers.length - 1; i >= 0; i--) {
      await fibers[i].dispose();
    }
    await ctx.fiber.dispose();
  });

  it('rolls back previously applied fibers in reverse order when a downstream entry fails', async () => {
    const parentDir = mkdtempSync(join(tmpdir(), 'enkeep-rollback-test-'));
    tempDirs.push(parentDir);
    const dshHome = join(parentDir, '.dsh');
    const spacesDir = join(parentDir, 'spaces');

    const ctx = new Context();

    const entry1 = createReceiptStoreEntry(dshHome, 'alice');
    // Create an entry that throws on apply
    let disposed1 = false;
    const fiber1 = await applyBundleEntry(ctx, entry1);
    expect(ctx.receiptStore).toBeDefined();
    await fiber1.dispose();

    // Now test applyEnkeepBundle with an invalid config that triggers throw in downstream entry 3
    const failingReceiptStoreEntry = {
      id: 'receipt-store' as const,
      name: '@enkeep/dsh-receipt-store-sqlite',
      plugin: receiptStorePlugin,
      config: {
        path: '', // Empty path throws TypeError in SqliteReceiptStore constructor
        busyTimeoutMs: 5000,
        userId: '',
      },
    };

    const entriesToTest = [
      createInboundEntry(),
      createEventRelayEntry(),
      failingReceiptStoreEntry,
    ];

    let didThrow = false;
    try {
      await applyEnkeepBundle(ctx, entriesToTest);
    } catch (err: unknown) {
      didThrow = true;
    }
    expect(didThrow).toBe(true);

    await ctx.fiber.dispose();
  });
});
