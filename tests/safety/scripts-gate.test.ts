import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { findRepoRoot } from '../../scripts/safety/preflight.js';

describe('Root Scripts & Build-Gate Safety Assertions', () => {
  const repoRoot = findRepoRoot();
  const pkgJsonPath = join(repoRoot, 'package.json');

  it('root package.json exists and contains valid JSON', () => {
    expect(existsSync(pkgJsonPath)).toBe(true);
    const content = readFileSync(pkgJsonPath, 'utf-8');
    const pkg = JSON.parse(content);
    expect(pkg.name).toBe('enkeep-root');
    expect(pkg.scripts).toBeDefined();
  });

  it('declares safe clean script that cleans root and package dist directories', () => {
    const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'));
    expect(pkg.scripts.clean).toBeDefined();
    expect(typeof pkg.scripts.clean).toBe('string');
    expect(pkg.scripts.clean).toContain('dist');
  });

  it('asserts test:docker executes build before docker build and package tests (self-contained from clean tree, auto-detects real LLM)', () => {
    const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'));
    const script: string = pkg.scripts['test:docker'];
    expect(script).toBeDefined();

    // Verify test:docker does NOT hardcode ENKEEP_LLM_ENABLED=0 so it auto-detects real DSH LLM config
    expect(script).not.toContain('ENKEEP_LLM_ENABLED=0');

    // Verify commands ordering
    const parts = script.split('&&').map((p) => p.trim());
    const buildIndex = parts.findIndex((p) => p.includes('pnpm run build') || p.includes('build:packages'));
    const dockerBuildIndex = parts.findIndex((p) => p.includes('docker:build-runtime') || p.includes('docker build'));
    const testRunnerIndex = parts.findIndex((p) => p.includes('@enkeep/runtime-runner'));
    const demoRunnerIndex = parts.findIndex((p) => p.includes('@enkeep/demo-runner'));
    const webE2eIndex = parts.findIndex((p) => p.includes('@enkeep/web-e2e'));

    expect(buildIndex).toBeGreaterThanOrEqual(0);
    expect(dockerBuildIndex).toBeGreaterThanOrEqual(0);
    expect(testRunnerIndex).toBeGreaterThanOrEqual(0);
    expect(demoRunnerIndex).toBeGreaterThanOrEqual(0);
    expect(webE2eIndex).toBeGreaterThanOrEqual(0);

    // Build must strictly precede docker:build-runtime and all test suites
    expect(buildIndex).toBeLessThan(dockerBuildIndex);
    expect(buildIndex).toBeLessThan(testRunnerIndex);
    expect(buildIndex).toBeLessThan(demoRunnerIndex);
    expect(buildIndex).toBeLessThan(webE2eIndex);

    // docker:build-runtime must precede all test suites
    expect(dockerBuildIndex).toBeLessThan(testRunnerIndex);
    expect(dockerBuildIndex).toBeLessThan(demoRunnerIndex);
    expect(dockerBuildIndex).toBeLessThan(webE2eIndex);
  });

  it('asserts test:docker:demo provides explicit ENKEEP_LLM_ENABLED=0 demo mode with full build gate', () => {
    const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'));
    const script: string = pkg.scripts['test:docker:demo'];
    expect(script).toBeDefined();
    expect(script).toContain('ENKEEP_LLM_ENABLED=0');

    const parts = script.split('&&').map((p) => p.trim());
    const buildIndex = parts.findIndex((p) => p.includes('pnpm run build') || p.includes('build:packages'));
    const dockerBuildIndex = parts.findIndex((p) => p.includes('docker:build-runtime') || p.includes('docker build'));
    expect(buildIndex).toBeGreaterThanOrEqual(0);
    expect(dockerBuildIndex).toBeGreaterThanOrEqual(0);
    expect(buildIndex).toBeLessThan(dockerBuildIndex);
  });

  it('asserts demo:test executes build before docker build and demo:test CLI execution', () => {
    const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'));
    const script: string = pkg.scripts['demo:test'];
    expect(script).toBeDefined();

    const parts = script.split('&&').map((p) => p.trim());
    const buildIndex = parts.findIndex((p) => p.includes('pnpm run build') || p.includes('build:packages'));
    const dockerBuildIndex = parts.findIndex((p) => p.includes('docker:build-runtime') || p.includes('docker build'));
    const demoTestIndex = parts.findIndex((p) => p.includes('@enkeep/demo-runner') && p.includes('demo:test'));

    expect(buildIndex).toBeGreaterThanOrEqual(0);
    expect(dockerBuildIndex).toBeGreaterThanOrEqual(0);
    expect(demoTestIndex).toBeGreaterThanOrEqual(0);

    // Build must strictly precede docker build and demo:test
    expect(buildIndex).toBeLessThan(dockerBuildIndex);
    expect(buildIndex).toBeLessThan(demoTestIndex);
    expect(dockerBuildIndex).toBeLessThan(demoTestIndex);
  });

  it('asserts verify pipeline executes preflight, typecheck, build, and test in sequence', () => {
    const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'));
    const script: string = pkg.scripts['verify'];
    expect(script).toBeDefined();

    const parts = script.split('&&').map((p) => p.trim());
    const preflightIdx = parts.findIndex((p) => p.includes('preflight'));
    const typecheckIdx = parts.findIndex((p) => p.includes('typecheck'));
    const buildIdx = parts.findIndex((p) => p.includes('pnpm run build') || p.includes('build'));
    const testIdx = parts.findIndex((p) => p.includes('pnpm run test') || p.includes('test'));

    expect(preflightIdx).toBeGreaterThanOrEqual(0);
    expect(typecheckIdx).toBeGreaterThanOrEqual(0);
    expect(buildIdx).toBeGreaterThanOrEqual(0);
    expect(testIdx).toBeGreaterThanOrEqual(0);

    expect(preflightIdx).toBeLessThan(typecheckIdx);
    expect(typecheckIdx).toBeLessThan(buildIdx);
    expect(buildIdx).toBeLessThan(testIdx);
  });
});
