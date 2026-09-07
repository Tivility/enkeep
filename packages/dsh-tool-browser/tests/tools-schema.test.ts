/**
 * Tool Schema & Definition Verification Tests for @enkeep/dsh-tool-browser
 *
 * Validates:
 * 1. Minimal, unambiguous names: browser_open, browser_snapshot, browser_interact, browser_screenshot, browser_close.
 * 2. Strict schemas: additionalProperties: false on all parameters and output schemas.
 * 3. Required parameters and allowed enums.
 *
 * @module @enkeep/dsh-tool-browser/tests/tools-schema.test
 */

import { describe, it, expect } from 'vitest';
import {
  createBrowserOpenTool,
  createBrowserSnapshotTool,
  createBrowserInteractTool,
  createBrowserScreenshotTool,
  createBrowserCloseTool,
} from '../src/index.js';

describe('dsh-tool-browser: Strict Tool Schemas & Definitions', () => {
  const dummyClient = { request: async () => ({ status: 200, data: {} }) };
  const getClient = () => dummyClient;

  const openTool = createBrowserOpenTool(getClient);
  const snapshotTool = createBrowserSnapshotTool(getClient);
  const interactTool = createBrowserInteractTool(getClient);
  const screenshotTool = createBrowserScreenshotTool(getClient);
  const closeTool = createBrowserCloseTool(getClient);

  const allTools = [openTool, snapshotTool, interactTool, screenshotTool, closeTool];

  it('declares exact 5 minimal unambiguous tool names', () => {
    const names = allTools.map((t) => t.name);
    expect(names).toEqual([
      'browser_open',
      'browser_snapshot',
      'browser_interact',
      'browser_screenshot',
      'browser_close',
    ]);
  });

  it('enforces additionalProperties: false on all parameters schemas', () => {
    for (const tool of allTools) {
      expect(tool.parameters).toBeDefined();
      expect((tool.parameters as any).type).toBe('object');
      expect((tool.parameters as any).additionalProperties).toBe(false);
    }
  });

  it('enforces additionalProperties: false on all output schemas', () => {
    for (const tool of allTools) {
      expect(tool.output).toBeDefined();
      expect(tool.output?.schema).toBeDefined();
      expect((tool.output?.schema as any).type).toBe('object');
      expect((tool.output?.schema as any).additionalProperties).toBe(false);
    }
  });

  it('validates browser_open schema', () => {
    const params = openTool.parameters as any;
    expect(params.required).toEqual(['url']);
    expect(params.properties.url.type).toBe('string');
    expect(params.properties.userId).toBeUndefined();
    expect(params.properties.sessionId).toBeUndefined();
    expect(params.properties.spaceId).toBeUndefined();
  });

  it('validates browser_snapshot schema', () => {
    const params = snapshotTool.parameters as any;
    expect(params.required).toEqual(['pageId']);
    expect(params.properties.pageId.type).toBe('string');
    expect(params.properties.userId).toBeUndefined();
  });

  it('validates browser_interact schema', () => {
    const params = interactTool.parameters as any;
    expect(params.required).toEqual(['pageId', 'action', 'ref']);
    expect(params.properties.action.enum).toEqual(['click', 'fill', 'press', 'select']);
    expect(params.properties.ref.type).toBe('string');
    expect(params.properties.value.type).toBe('string');
    expect(params.properties.userId).toBeUndefined();
  });

  it('validates browser_screenshot schema', () => {
    const params = screenshotTool.parameters as any;
    expect(params.required).toEqual(['pageId']);
    expect(params.properties.pageId.type).toBe('string');
    expect(params.properties.fullPage.type).toBe('boolean');
    expect(params.properties.userId).toBeUndefined();
  });

  it('validates browser_close schema', () => {
    const params = closeTool.parameters as any;
    expect(params.required).toEqual(['pageId']);
    expect(params.properties.pageId.type).toBe('string');
    expect(params.properties.userId).toBeUndefined();
  });
});
