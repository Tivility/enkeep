import { describe, expect, it } from 'vitest';
import { Context, Service } from '@deepseek-ai/cordis';
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import {
  getCompiledTrustedPluginRegistry,
  getTrustedPlugin,
  listTrustedPlugins,
  validateTrustedPluginDescriptor,
  applyTrustedEchoPlugin,
  applyTestFailingPlugin,
  TRUSTED_ECHO_PLUGIN,
  TRUSTED_TEST_FAILING_PLUGIN,
} from '../src/trusted-registry.js';

class MockToolsRuntime extends Service {
  public registeredTools: ToolDefinition[] = [];

  constructor(ctx: Context) {
    super(ctx, 'tools');
  }

  register(tool: ToolDefinition) {
    this.registeredTools.push(tool);
    return () => {
      const idx = this.registeredTools.indexOf(tool);
      if (idx !== -1) {
        this.registeredTools.splice(idx, 1);
      }
    };
  }
}

describe('dsh-enkeep-bundle: trusted plugin registry and runtime echo tool', () => {
  it('retrieves compiled trusted plugins and individual plugins by id and slug', () => {
    const all = listTrustedPlugins();
    expect(all.length).toBeGreaterThanOrEqual(1);

    const echoPlugin = getTrustedPlugin('enkeep.echo');
    expect(echoPlugin).toBeDefined();
    expect(echoPlugin?.slug).toBe('trusted-echo');
    expect(echoPlugin?.version).toBe(1);
    expect(echoPlugin?.manifest.tool).toBe('plugin__trusted-echo__echo');

    const bySlug = getTrustedPlugin('trusted-echo');
    expect(bySlug).toBe(echoPlugin);

    expect(getTrustedPlugin('nonexistent.plugin')).toBeUndefined();
    expect(getTrustedPlugin('')).toBeUndefined();
  });

  it('strictly validates trusted plugin descriptor and fails closed on invalid descriptors', () => {
    const valid = validateTrustedPluginDescriptor({
      trustedPluginId: 'enkeep.echo',
      version: 1,
      integrity: TRUSTED_ECHO_PLUGIN.integritySha256,
    });
    expect(valid).toBe(TRUSTED_ECHO_PLUGIN);

    // Unknown plugin
    expect(() =>
      validateTrustedPluginDescriptor({
        trustedPluginId: 'untrusted.plugin',
        version: 1,
        integrity: 'abc',
      })
    ).toThrow(/FAIL-CLOSED: Unknown or unverified trusted plugin ID/);

    // Version mismatch
    expect(() =>
      validateTrustedPluginDescriptor({
        trustedPluginId: 'enkeep.echo',
        version: 2,
        integrity: TRUSTED_ECHO_PLUGIN.integritySha256,
      })
    ).toThrow(/FAIL-CLOSED: Plugin version mismatch/);

    // Integrity mismatch
    expect(() =>
      validateTrustedPluginDescriptor({
        trustedPluginId: 'enkeep.echo',
        version: 1,
        integrity: 'invalid_sha256_hash',
      })
    ).toThrow(/FAIL-CLOSED: Plugin integrity checksum mismatch/);

    // Invalid descriptor input
    expect(() => validateTrustedPluginDescriptor(null as any)).toThrow(
      /FAIL-CLOSED: Invalid plugin descriptor/
    );
  });

  it('applies trusted echo plugin, registers tool, executes canonical rc1 output, and unregisters on dispose', async () => {
    const ctx = new Context();
    const toolsService = new MockToolsRuntime(ctx);

    const fiber = await ctx.plugin(applyTrustedEchoPlugin);
    expect(toolsService.registeredTools).toHaveLength(1);

    const echoTool = toolsService.registeredTools[0];
    expect(echoTool.name).toBe('plugin__trusted-echo__echo');
    expect(echoTool.description).toBe('Echoes input text prefixed with PLUGIN:');
    expect(echoTool.parameters).toBeDefined();
    expect(echoTool.output).toBeDefined();
    expect(echoTool.output.schema).toBeDefined();

    // 1. Execute tool with valid args
    const execResult = await echoTool.execute({ text: 'hello world' }, {} as any);
    expect(execResult).toEqual({ result: 'PLUGIN:hello world' });

    // 2. Render tool output
    const rendered = echoTool.output.render({ text: 'hello world' }, execResult as any);
    expect(rendered).toEqual([{ type: 'text', text: 'PLUGIN:hello world' }]);

    // 3. Invalid args execution failure (validated by defineTool parameter schema)
    await expect(echoTool.execute({} as any, {} as any)).rejects.toThrow(
      /missing required property "text"/
    );
    await expect(echoTool.execute({ text: 123 } as any, {} as any)).rejects.toThrow(
      /"text" must be a string/
    );

    // 4. Dispose fiber and verify tool unregistration
    await fiber.dispose();
    expect(toolsService.registeredTools).toHaveLength(0);
  });

  it('fails closed when tools registry service is unavailable on Context', async () => {
    const ctx = new Context();
    expect(() => applyTrustedEchoPlugin(ctx)).toThrow(
      /Trusted echo plugin activation failed: "tools" registry service is unavailable/
    );
  });

  it('throws simulated failure on applyTestFailingPlugin activation', () => {
    const ctx = new Context();
    expect(() => applyTestFailingPlugin(ctx)).toThrow(
      'Simulated plugin activation failure in enkeep.test-failing'
    );
  });
});
