/**
 * Runtime resource namespaces: production containers and volumes never share names or ownership
 * labels with test/demo runs, and a spec cannot mix the two.
 *
 * @module @enkeep/runtime-runner/tests/resource-namespace.test
 */

import { describe, it, expect } from 'vitest';
import {
  validateContainerSpec,
  namespaceOfContainerName,
  namespaceOfVolumeName,
  labelsMatchNamespace,
  PRODUCTION_RESOURCE_NAMESPACE,
  TEST_RESOURCE_NAMESPACE,
  ENV_LABEL_KEY,
  DockerRuntimeAdapter,
  type RuntimeContainerSpec,
} from '../src/index.js';

const VOL_ID = 'vol_0123456789abcdef0123456789abcdef';

function productionSpec(overrides: Partial<RuntimeContainerSpec> = {}): RuntimeContainerSpec {
  return {
    userId: 'alice',
    runId: 'run_test_123',
    containerName: 'enkeep-runtime-alice',
    image: 'enkeep-runtime:test',
    user: '1000:1000',
    workingDir: '/home/dsh',
    volume: { volumeName: 'enkeep-home-alice', volumeId: VOL_ID, containerPath: '/home/dsh' },
    networkMode: 'none',
    labels: {
      app: 'enkeep',
      [ENV_LABEL_KEY]: 'production',
      'enkeep.user': 'alice',
      'enkeep.run-id': 'run_test_123',
      'enkeep.volume-id': VOL_ID,
    },
    environment: { DSH_USER: 'alice', DSH_HOME: '/home/dsh/.dsh', DSH_SPACES: '/home/dsh/spaces' },
    ...overrides,
  };
}

describe('runtime resource namespaces', () => {
  it('derives the namespace from the name', () => {
    expect(namespaceOfContainerName('enkeep-runtime-alice')).toBe(PRODUCTION_RESOURCE_NAMESPACE);
    expect(namespaceOfContainerName('enkeep-demo-alice-e2e')).toBe(TEST_RESOURCE_NAMESPACE);
    expect(namespaceOfContainerName('enkeep-alice')).toBeUndefined();
    expect(namespaceOfContainerName('enkeep-runtime-')).toBeUndefined();
    expect(namespaceOfVolumeName('enkeep-home-alice')).toBe(PRODUCTION_RESOURCE_NAMESPACE);
    expect(namespaceOfVolumeName('enkeep-demo-dsh-alice')).toBe(TEST_RESOURCE_NAMESPACE);
    expect(namespaceOfVolumeName('enkeep-runtime-alice')).toBeUndefined();
  });

  it('matches labels to a namespace, with enkeep.env optional but never contradicting', () => {
    expect(labelsMatchNamespace({ app: 'enkeep', [ENV_LABEL_KEY]: 'production' }, PRODUCTION_RESOURCE_NAMESPACE)).toBe(true);
    expect(labelsMatchNamespace({ app: 'enkeep-demo' }, TEST_RESOURCE_NAMESPACE)).toBe(true);
    expect(labelsMatchNamespace({ app: 'enkeep-demo' }, PRODUCTION_RESOURCE_NAMESPACE)).toBe(false);
    expect(labelsMatchNamespace({ app: 'enkeep', [ENV_LABEL_KEY]: 'test' }, PRODUCTION_RESOURCE_NAMESPACE)).toBe(false);
  });

  it('accepts a production container on a production volume', () => {
    const result = validateContainerSpec(productionSpec());
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it('rejects a production container on a test volume', () => {
    const result = validateContainerSpec(
      productionSpec({ volume: { volumeName: 'enkeep-demo-dsh-alice', volumeId: VOL_ID, containerPath: '/home/dsh' } })
    );
    expect(result.valid).toBe(false);
    expect(result.errors.join('\n')).toMatch(/production volume/);
  });

  it('rejects a production container carrying the demo app label or a test env label', () => {
    const demoLabel = productionSpec();
    (demoLabel.labels as Record<string, string>).app = 'enkeep-demo';
    expect(validateContainerSpec(demoLabel).valid).toBe(false);

    const testEnv = productionSpec();
    (testEnv.labels as Record<string, string>)[ENV_LABEL_KEY] = 'test';
    expect(validateContainerSpec(testEnv).valid).toBe(false);
  });

  it('rejects a production container not scoped to its user', () => {
    expect(validateContainerSpec(productionSpec({ containerName: 'enkeep-runtime-bob' })).valid).toBe(false);
  });

  it('builds production specs with production names and labels', () => {
    const adapter = new DockerRuntimeAdapter();
    const spec = adapter.createDefaultUserSpec({ userId: 'alice', namespace: PRODUCTION_RESOURCE_NAMESPACE });
    expect(spec.containerName).toBe('enkeep-runtime-alice');
    expect(spec.volume.volumeName).toBe('enkeep-home-alice');
    expect(spec.labels.app).toBe('enkeep');
    expect(spec.labels[ENV_LABEL_KEY]).toBe('production');
    expect(validateContainerSpec(spec).valid).toBe(true);
  });

  it('keeps test specs on the demo names and marks them as test', () => {
    const adapter = new DockerRuntimeAdapter();
    const spec = adapter.createDefaultUserSpec({ userId: 'alice', nameSuffix: 'e2e' });
    expect(spec.containerName).toBe('enkeep-demo-alice-e2e');
    expect(spec.volume.volumeName).toBe('enkeep-demo-dsh-alice-e2e');
    expect(spec.labels.app).toBe('enkeep-demo');
    expect(spec.labels[ENV_LABEL_KEY]).toBe('test');
  });
});
