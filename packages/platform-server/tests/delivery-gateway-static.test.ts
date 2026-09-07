import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('DeliveryRuntimeGateway Static & Architectural Invariants', () => {
  const gatewaySourcePath = path.resolve(__dirname, '../src/runtime/delivery-gateway.ts');
  const source = fs.readFileSync(gatewaySourcePath, 'utf8');

  it('verifies DeliveryGateway source code does NOT contain executeWithFallback calls', () => {
    // DeliveryGateway must not wrap turn execution with executeWithFallback because it causes duplicate tool side-effects
    expect(source).not.toContain('executeWithFallback');
  });

  it('verifies this.executor.execute occurs exactly once in the entire DeliveryGateway implementation', () => {
    const matches = source.match(/this\.executor\.execute/g);
    expect(matches).not.toBeNull();
    expect(matches!.length).toBe(1);
  });

  it('verifies executor.execute call receives executionRequest with modelSelection intact', () => {
    expect(source).toMatch(/executionResult\s*=\s*await\s+this\.executor\.execute\s*\(\s*executionRequest\s*\)/);
  });

  it('verifies DeliveryGateway does NOT contain in-memory sessionQueues Map', () => {
    expect(source).not.toContain('sessionQueues = new Map');
    expect(source).not.toContain('this.sessionQueues');
  });

  it('verifies session execution lease insert does NOT use empty catch block', () => {
    expect(source).not.toMatch(/INSERT INTO session_execution_leases[\s\S]*?\)\s*catch\s*\{\s*\}/);
  });
});
