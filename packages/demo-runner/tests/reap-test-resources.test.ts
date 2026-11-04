/**
 * reapTestResources removes only leftover test runtimes, never production or foreign resources.
 */
import { describe, it, expect } from 'vitest';
import { reapTestResources, type DockerExec } from '../src/reap/index.js';

const NOW = Date.parse('2026-01-02T00:00:00.000Z');
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();

interface FakeContainer {
  id: string;
  name: string;
  state: string;
  created: string;
  labels: Record<string, string>;
}
interface FakeVolume {
  name: string;
  created: string;
  labels: Record<string, string>;
  dangling: boolean;
}

function fakeDocker(containers: FakeContainer[], volumes: FakeVolume[]) {
  const calls: string[][] = [];
  const docker: DockerExec = async (args) => {
    calls.push([...args]);
    if (args[0] === 'ps') {
      // The real filter selects by enkeep.env=test only; the reaper must re-check names and app labels.
      return containers.filter((c) => c.labels['enkeep.env'] === 'test').map((c) => c.id).join('\n');
    }
    if (args[0] === 'inspect') {
      return JSON.stringify(
        args.slice(1).map((id) => {
          const c = containers.find((x) => x.id === id)!;
          return { Name: `/${c.name}`, Created: c.created, State: { Status: c.state }, Config: { Labels: c.labels } };
        })
      );
    }
    if (args[0] === 'volume' && args[1] === 'ls') {
      return volumes.filter((v) => v.dangling && v.labels['enkeep.env'] === 'test').map((v) => v.name).join('\n');
    }
    if (args[0] === 'volume' && args[1] === 'inspect') {
      return JSON.stringify(
        args.slice(2).map((name) => {
          const v = volumes.find((x) => x.name === name)!;
          return { Name: v.name, CreatedAt: v.created, Labels: v.labels };
        })
      );
    }
    return '';
  };
  return { docker, calls };
}

const testLabels = { app: 'enkeep-demo', 'enkeep.env': 'test' };

describe('reapTestResources', () => {
  it('removes stopped and stale test containers and old unused test volumes only', async () => {
    const { docker, calls } = fakeDocker(
      [
        { id: 'c1', name: 'enkeep-demo-alice-e2e', state: 'exited', created: hoursAgo(1), labels: testLabels },
        { id: 'c2', name: 'enkeep-demo-bob-e2e', state: 'running', created: hoursAgo(30), labels: testLabels },
        { id: 'c3', name: 'enkeep-demo-carol-e2e', state: 'running', created: hoursAgo(2), labels: testLabels },
        { id: 'c4', name: 'enkeep-demo-dave-e2e', state: 'created', created: new Date(NOW - 60_000).toISOString(), labels: testLabels },
        // Mislabelled: production name with a test env label must never be removed.
        { id: 'c5', name: 'enkeep-runtime-alice', state: 'exited', created: hoursAgo(48), labels: { app: 'enkeep', 'enkeep.env': 'test' } },
        // Test name but missing the app label.
        { id: 'c6', name: 'enkeep-demo-erin', state: 'exited', created: hoursAgo(48), labels: { 'enkeep.env': 'test' } },
      ],
      [
        { name: 'enkeep-demo-dsh-alice-e2e', created: hoursAgo(30), labels: testLabels, dangling: true },
        { name: 'enkeep-demo-dsh-bob-e2e', created: hoursAgo(2), labels: testLabels, dangling: true },
        { name: 'enkeep-home-alice', created: hoursAgo(90), labels: { app: 'enkeep', 'enkeep.env': 'test' }, dangling: true },
      ]
    );

    const result = await reapTestResources({ docker, now: () => NOW });

    expect(result.ok).toBe(true);
    expect(result.resources.map((r) => r.name).sort()).toEqual(['enkeep-demo-alice-e2e', 'enkeep-demo-bob-e2e', 'enkeep-demo-dsh-alice-e2e']);
    const removals = calls.filter((c) => c[0] === 'rm' || (c[0] === 'volume' && c[1] === 'rm')).map((c) => c[c.length - 1]);
    expect(removals.sort()).toEqual(['enkeep-demo-alice-e2e', 'enkeep-demo-bob-e2e', 'enkeep-demo-dsh-alice-e2e']);
  });

  it('never selects resources without enkeep.env=test (legacy and production runtimes)', async () => {
    const { docker, calls } = fakeDocker(
      [{ id: 'c1', name: 'enkeep-demo-alice', state: 'exited', created: hoursAgo(100), labels: { app: 'enkeep-demo' } }],
      [{ name: 'enkeep-demo-dsh-alice', created: hoursAgo(100), labels: { app: 'enkeep-demo' }, dangling: true }]
    );
    const result = await reapTestResources({ docker, now: () => NOW });
    expect(result.resources).toEqual([]);
    expect(calls.some((c) => c[0] === 'rm' || c[1] === 'rm')).toBe(false);
  });

  it('only reports in dry-run mode', async () => {
    const { docker, calls } = fakeDocker(
      [{ id: 'c1', name: 'enkeep-demo-alice-e2e', state: 'exited', created: hoursAgo(1), labels: testLabels }],
      []
    );
    const result = await reapTestResources({ docker, now: () => NOW, dryRun: true });
    expect(result.resources).toHaveLength(1);
    expect(result.resources[0]!.removed).toBe(false);
    expect(calls.some((c) => c[0] === 'rm')).toBe(false);
  });
});
