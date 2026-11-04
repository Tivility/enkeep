/**
 * Removal of leftover test runtimes.
 *
 * Test and demo runs create runtime containers and home volumes in the test namespace
 * (`enkeep-demo-*`, `app=enkeep-demo`, `enkeep.env=test`). A run that is killed before its teardown
 * leaves them behind in the Docker VM. `reapTestResources` removes such leftovers and nothing else:
 * a resource is a candidate only when its name is in the test namespace AND it carries both test
 * labels. Production resources (`enkeep-runtime-*` / `enkeep-home-*`, `app=enkeep`), resources from
 * before `enkeep.env` existed, and every other project's containers never match.
 *
 * @module @enkeep/demo-runner/reap
 */

import { execFile } from 'node:child_process';
import {
  DEMO_LABEL_KEY,
  ENV_LABEL_KEY,
  TEST_RESOURCE_NAMESPACE,
  namespaceOfContainerName,
  namespaceOfVolumeName,
} from '../config.js';

/** Runs `docker <args>` and resolves stdout. */
export type DockerExec = (args: readonly string[]) => Promise<string>;

export interface ReapOptions {
  /** Running test containers and unused test volumes older than this are removed (default 24). */
  maxAgeHours?: number;
  /** Stopped test containers younger than this are kept, so a run still starting is not hit (default 10). */
  minStoppedAgeMinutes?: number;
  dryRun?: boolean;
  docker?: DockerExec;
  now?: () => number;
}

export interface ReapedResource {
  kind: 'container' | 'volume';
  name: string;
  reason: string;
  removed: boolean;
  error?: string;
}

export interface ReapResult {
  ok: boolean;
  dryRun: boolean;
  resources: ReapedResource[];
}

const defaultDocker: DockerExec = (args) =>
  new Promise((resolve, reject) => {
    execFile('docker', [...args], { timeout: 60_000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
      if (error) reject(error);
      else resolve(String(stdout));
    });
  });

interface ContainerRow {
  name: string;
  state: string;
  createdAt: number;
  labels: Record<string, string>;
}

interface VolumeRow {
  name: string;
  createdAt: number;
  labels: Record<string, string>;
}

function isTestLabelled(labels: Record<string, string>): boolean {
  return labels[DEMO_LABEL_KEY] === TEST_RESOURCE_NAMESPACE.appLabel && labels[ENV_LABEL_KEY] === TEST_RESOURCE_NAMESPACE.env;
}

async function inspectContainers(docker: DockerExec): Promise<ContainerRow[]> {
  const ids = (await docker(['ps', '-a', '-q', '--filter', `label=${ENV_LABEL_KEY}=${TEST_RESOURCE_NAMESPACE.env}`]))
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if (ids.length === 0) return [];
  const raw = JSON.parse(await docker(['inspect', ...ids])) as Array<{
    Name?: string;
    Created?: string;
    State?: { Status?: string };
    Config?: { Labels?: Record<string, string> | null };
  }>;
  return raw.map((entry) => ({
    name: String(entry.Name ?? '').replace(/^\//, ''),
    state: String(entry.State?.Status ?? ''),
    createdAt: Date.parse(String(entry.Created ?? '')),
    labels: entry.Config?.Labels ?? {},
  }));
}

async function inspectUnusedVolumes(docker: DockerExec): Promise<VolumeRow[]> {
  const names = (
    await docker(['volume', 'ls', '-q', '--filter', 'dangling=true', '--filter', `label=${ENV_LABEL_KEY}=${TEST_RESOURCE_NAMESPACE.env}`])
  )
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if (names.length === 0) return [];
  const raw = JSON.parse(await docker(['volume', 'inspect', ...names])) as Array<{
    Name?: string;
    CreatedAt?: string;
    Labels?: Record<string, string> | null;
  }>;
  return raw.map((entry) => ({
    name: String(entry.Name ?? ''),
    createdAt: Date.parse(String(entry.CreatedAt ?? '')),
    labels: entry.Labels ?? {},
  }));
}

/**
 * Removes leftover test containers (stopped, or running longer than `maxAgeHours`) and unused test
 * volumes older than `maxAgeHours`. Never removes a resource outside the test namespace.
 */
export async function reapTestResources(options: ReapOptions = {}): Promise<ReapResult> {
  const docker = options.docker ?? defaultDocker;
  const now = (options.now ?? Date.now)();
  const maxAgeMs = Math.max(0, options.maxAgeHours ?? 24) * 3_600_000;
  const minStoppedMs = Math.max(0, options.minStoppedAgeMinutes ?? 10) * 60_000;
  const dryRun = options.dryRun === true;
  const resources: ReapedResource[] = [];
  let ok = true;

  for (const c of await inspectContainers(docker)) {
    if (namespaceOfContainerName(c.name) !== TEST_RESOURCE_NAMESPACE || !isTestLabelled(c.labels)) continue;
    const age = Number.isFinite(c.createdAt) ? now - c.createdAt : 0;
    let reason: string | undefined;
    if (c.state !== 'running' && age >= minStoppedMs) reason = `not running (${c.state})`;
    else if (c.state === 'running' && age >= maxAgeMs) reason = `running for ${Math.round(age / 3_600_000)}h`;
    if (!reason) continue;
    const entry: ReapedResource = { kind: 'container', name: c.name, reason, removed: false };
    if (!dryRun) {
      try {
        await docker(['rm', '-f', c.name]);
        entry.removed = true;
      } catch (err: unknown) {
        entry.error = err instanceof Error ? err.message : String(err);
        ok = false;
      }
    }
    resources.push(entry);
  }

  for (const v of await inspectUnusedVolumes(docker)) {
    if (namespaceOfVolumeName(v.name) !== TEST_RESOURCE_NAMESPACE || !isTestLabelled(v.labels)) continue;
    const age = Number.isFinite(v.createdAt) ? now - v.createdAt : 0;
    if (age < maxAgeMs) continue;
    const entry: ReapedResource = { kind: 'volume', name: v.name, reason: `unused for ${Math.round(age / 3_600_000)}h`, removed: false };
    if (!dryRun) {
      try {
        await docker(['volume', 'rm', v.name]);
        entry.removed = true;
      } catch (err: unknown) {
        entry.error = err instanceof Error ? err.message : String(err);
        ok = false;
      }
    }
    resources.push(entry);
  }

  return { ok, dryRun, resources };
}
