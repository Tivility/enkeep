/**
 * Hardened Git Skill Installer with Credential Isolation & Bounded Execution
 *
 * Implements:
 * - Scheme allowlists & DNS SSRF validation via GitSourcePolicy
 * - Ephemeral GIT_ASKPASS credential helper (zero argv/process table token leakage)
 * - Strict SSH host key verification (StrictHostKeyChecking=yes + known_hosts)
 * - Output bounding (1 MiB max stdout/stderr), process tree kill on timeout/overflow
 * - Safe exit code & error masking (zero raw path/credential leakage in API/DB)
 * - Security-critical secret destruction with cleanup error verification
 * - Stale temp staging TTL startup cleanup
 *
 * @module @enkeep/platform-server/skills/git-installer
 */

import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ValidationError, PlatformError } from '@enkeep/platform-core';
import {
  validateSkillDirectory,
} from './security-validator.js';
import {
  type GitSourcePolicy,
  DEFAULT_GIT_SOURCE_POLICY,
  validateGitUrlAgainstPolicy,
} from './git-source-policy.js';
import type {
  GitInstallSourceInput,
  ValidatedSkillPayload,
  SkillDiffPreview,
} from './skill-types.js';

export const MAX_GIT_OUTPUT_BYTES = 1024 * 1024; // 1 MiB stdout/stderr buffer limit
export const DEFAULT_GIT_TIMEOUT_MS = 30000; // 30 seconds

export interface StagedGitSkillResult {
  stageDir: string;
  targetDir: string;
  commitSha: string;
  sanitizedUrl: string;
  payload: ValidatedSkillPayload;
  cleanup: () => void;
}

export class GitExecutionError extends PlatformError {
  constructor(message: string, code = 'GIT_EXECUTION_ERROR', statusCode = 400) {
    super(message, code, statusCode);
  }
}

export type StaleCleanupErrorCode =
  | 'TEMP_READ_FAILED'
  | 'TEMP_REMOVE_FAILED'
  | 'TEMP_PERMISSION_FAILED';

export interface StaleCleanupError {
  readonly code: StaleCleanupErrorCode;
}

export interface StaleCleanupResult {
  readonly cleaned: number;
  readonly errors: readonly StaleCleanupError[];
}

/**
 * Periodically or on startup cleans up stale ephemeral temp directories older than TTL.
 */
export function cleanupStaleGitTempDirs(maxAgeMs = 3600000): StaleCleanupResult {
  const errors: StaleCleanupError[] = [];
  let cleaned = 0;
  try {
    const tmpRoot = os.tmpdir();
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(tmpRoot, { withFileTypes: true });
    } catch (readErr) {
      if (readErr && (readErr as NodeJS.ErrnoException).code !== 'ENOENT') {
        const code: StaleCleanupErrorCode =
          (readErr as NodeJS.ErrnoException).code === 'EACCES' ||
          (readErr as NodeJS.ErrnoException).code === 'EPERM'
            ? 'TEMP_PERMISSION_FAILED'
            : 'TEMP_READ_FAILED';
        errors.push({ code });
      }
      return { cleaned, errors };
    }

    const now = Date.now();

    for (const entry of entries) {
      if (
        entry.isDirectory() &&
        (entry.name.startsWith('enkeep-git-') || entry.name.startsWith('enkeep-archive-'))
      ) {
        const fullPath = path.join(tmpRoot, entry.name);
        try {
          const stat = fs.statSync(fullPath);
          if (now - stat.mtimeMs > maxAgeMs) {
            fs.rmSync(fullPath, { recursive: true, force: true });
            cleaned++;
          }
        } catch (statOrRmErr) {
          if (statOrRmErr && (statOrRmErr as NodeJS.ErrnoException).code !== 'ENOENT') {
            const code: StaleCleanupErrorCode =
              (statOrRmErr as NodeJS.ErrnoException).code === 'EACCES' ||
              (statOrRmErr as NodeJS.ErrnoException).code === 'EPERM'
                ? 'TEMP_PERMISSION_FAILED'
                : 'TEMP_REMOVE_FAILED';
            errors.push({ code });
          }
        }
      }
    }
  } catch (outerErr) {
    const code: StaleCleanupErrorCode =
      (outerErr as NodeJS.ErrnoException)?.code === 'EACCES' ||
      (outerErr as NodeJS.ErrnoException)?.code === 'EPERM'
        ? 'TEMP_PERMISSION_FAILED'
        : 'TEMP_READ_FAILED';
    errors.push({ code });
  }
  return { cleaned, errors };
}

/**
 * Creates an ephemeral secure directory (mode 0o700) for staging or credentials.
 */
export function createSecureTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  try {
    fs.chmodSync(dir, 0o700);
  } catch (_chmodErr) {
    if (process.platform !== 'win32') {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch (_rmErr) {
        // preserve original error intent
      }
      throw new PlatformError(
        'Failed to set secure permissions (0700) on temp directory',
        'INSECURE_TEMP_DIR_ERROR'
      );
    }
  }
  return dir;
}

/**
 * Safely kills a child process and its process group.
 */
export function killProcessGroup(child: ChildProcess): void {
  if (!child.pid || child.killed) return;
  try {
    if (process.platform !== 'win32') {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException)?.code !== 'ESRCH') {
          try {
            child.kill('SIGKILL');
          } catch (kErr: unknown) {
            if ((kErr as NodeJS.ErrnoException)?.code !== 'ESRCH') {
              // ignore if already exited
            }
          }
        }
      }
    } else {
      try {
        child.kill('SIGKILL');
      } catch (kErr: unknown) {
        if ((kErr as NodeJS.ErrnoException)?.code !== 'ESRCH') {
          // ignore if already exited
        }
      }
    }
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ESRCH') {
      // ignore if already exited
    }
  }
}

export interface RunGitCommandOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  authToken?: string;
  sshPrivateKey?: string;
  knownHosts?: string;
  knownHostsFile?: string;
  policy?: GitSourcePolicy;
}

/**
 * Executes a Git command via spawn with bounded output, credential isolation, and process group safety.
 */
export async function runGitCommand(
  args: string[],
  options: RunGitCommandOptions = {}
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS;
  const policy: GitSourcePolicy = options.policy ?? DEFAULT_GIT_SOURCE_POLICY;

  // Ephemeral credential directory
  let credDir: string | undefined;
  let tokenFile: string | undefined;
  let askpassScript: string | undefined;
  let sshKeyFile: string | undefined;
  let customKnownHostsFile: string | undefined;

  const cleanupCredentials = () => {
    const errors: Error[] = [];
    if (tokenFile && fs.existsSync(tokenFile)) {
      try {
        fs.rmSync(tokenFile, { force: true });
      } catch (_err) {
        errors.push(new PlatformError('Failed to securely delete ephemeral auth token file', 'CREDENTIAL_CLEANUP_FAILED'));
      }
    }
    if (sshKeyFile && fs.existsSync(sshKeyFile)) {
      try {
        fs.rmSync(sshKeyFile, { force: true });
      } catch (_err) {
        errors.push(new PlatformError('Failed to securely delete ephemeral SSH private key file', 'CREDENTIAL_CLEANUP_FAILED'));
      }
    }
    if (customKnownHostsFile && fs.existsSync(customKnownHostsFile)) {
      try {
        fs.rmSync(customKnownHostsFile, { force: true });
      } catch (_err) {
        errors.push(new PlatformError('Failed to securely delete ephemeral known_hosts file', 'CREDENTIAL_CLEANUP_FAILED'));
      }
    }
    if (credDir && fs.existsSync(credDir)) {
      try {
        fs.rmSync(credDir, { recursive: true, force: true });
      } catch (_err) {
        errors.push(new PlatformError('Failed to remove ephemeral credentials directory', 'CREDENTIAL_CLEANUP_FAILED'));
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, 'Security Critical: Failed to clean up ephemeral git credentials');
    }
  };

  try {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...options.env,
      GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_NOSYSTEM: '1',
    };

    // 1. Token authentication via GIT_ASKPASS (zero argv leakage)
    if (options.authToken) {
      credDir = createSecureTempDir('enkeep-git-auth-');
      tokenFile = path.join(credDir, 'token.txt');
      fs.writeFileSync(tokenFile, options.authToken, { mode: 0o600 });

      // Create askpass executable script
      askpassScript = path.join(credDir, 'askpass.sh');
      const scriptContent = `#!/bin/sh\nexec cat "${tokenFile}"\n`;
      fs.writeFileSync(askpassScript, scriptContent, { mode: 0o700 });

      env.GIT_ASKPASS = askpassScript;
      env.GIT_USERNAME = 'oauth2';
    }

    // 2. SSH key authentication with strict host key checking
    if (options.sshPrivateKey) {
      let resolvedKnownHostsFile = options.knownHostsFile ?? policy.knownHostsFile;

      if (!resolvedKnownHostsFile && options.knownHosts) {
        if (!credDir) {
          credDir = createSecureTempDir('enkeep-git-auth-');
        }
        customKnownHostsFile = path.join(credDir, 'known_hosts');
        fs.writeFileSync(customKnownHostsFile, options.knownHosts, { mode: 0o600 });
        resolvedKnownHostsFile = customKnownHostsFile;
      }

      if (!resolvedKnownHostsFile && !fs.existsSync('/etc/ssh/ssh_known_hosts') && !fs.existsSync(path.join(os.homedir(), '.ssh', 'known_hosts'))) {
        throw new ValidationError(
          'SSH host key verification requires a configured known_hosts file (StrictHostKeyChecking=yes). Configure knownHostsFile in deployment policy.'
        );
      }

      if (!credDir) {
        credDir = createSecureTempDir('enkeep-git-auth-');
      }
      sshKeyFile = path.join(credDir, 'id_rsa');
      fs.writeFileSync(sshKeyFile, options.sshPrivateKey, { mode: 0o600 });

      const knownHostsArg = resolvedKnownHostsFile ? `-o UserKnownHostsFile="${resolvedKnownHostsFile}"` : '';
      env.GIT_SSH_COMMAND = `ssh -i "${sshKeyFile}" -o StrictHostKeyChecking=yes -o IdentitiesOnly=yes ${knownHostsArg}`.trim();
    }

    // 3. Construct git arguments with strict protocol isolation
    const protocolFilePolicy = policy.allowFileScheme ? 'user' : 'never';
    const finalArgs: string[] = [
      '-c', `protocol.file.allow=${protocolFilePolicy}`,
      '-c', 'core.symlinks=false',
      '-c', 'http.followRedirects=initial',
    ];

    finalArgs.push(...args);

    return await new Promise((resolve, reject) => {
      let settled = false;
      let timer: NodeJS.Timeout | undefined;

      const safeSettle = (fn: () => void) => {
        if (!settled) {
          settled = true;
          if (timer) {
            clearTimeout(timer);
          }
          fn();
        }
      };

      let child: ChildProcess;
      try {
        child = spawn('git', finalArgs, {
          cwd: options.cwd,
          env,
          shell: false,
          detached: process.platform !== 'win32',
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (_spawnErr) {
        safeSettle(() => reject(new GitExecutionError('Failed to spawn git process', 'GIT_SPAWN_ERROR')));
        return;
      }

      let stdout = '';
      let stderr = '';
      let stdoutBytes = 0;
      let stderrBytes = 0;

      child.stdout?.on('data', (chunk: Buffer) => {
        stdoutBytes += chunk.length;
        if (stdoutBytes > MAX_GIT_OUTPUT_BYTES) {
          killProcessGroup(child);
          safeSettle(() => reject(new GitExecutionError('Git stdout limit exceeded', 'GIT_OUTPUT_LIMIT_EXCEEDED')));
          return;
        }
        stdout += chunk.toString('utf8');
      });

      child.stderr?.on('data', (chunk: Buffer) => {
        stderrBytes += chunk.length;
        if (stderrBytes > MAX_GIT_OUTPUT_BYTES) {
          killProcessGroup(child);
          safeSettle(() => reject(new GitExecutionError('Git stderr limit exceeded', 'GIT_OUTPUT_LIMIT_EXCEEDED')));
          return;
        }
        stderr += chunk.toString('utf8');
      });

      child.stdout?.on('error', (_err: Error) => {
        killProcessGroup(child);
        safeSettle(() => reject(new GitExecutionError('Git stdout stream error', 'GIT_STREAM_ERROR')));
      });
      child.stderr?.on('error', (_err: Error) => {
        killProcessGroup(child);
        safeSettle(() => reject(new GitExecutionError('Git stderr stream error', 'GIT_STREAM_ERROR')));
      });

      timer = setTimeout(() => {
        killProcessGroup(child);
        safeSettle(() => reject(new GitExecutionError('Git operation timed out', 'GIT_TIMEOUT', 408)));
      }, timeoutMs);

      child.on('error', (_err) => {
        killProcessGroup(child);
        safeSettle(() => reject(new GitExecutionError('Failed to execute git subprocess', 'GIT_SPAWN_ERROR')));
      });

      child.on('close', (code, signal) => {
        safeSettle(() => {
          if (code !== 0) {
            reject(
              new GitExecutionError(
                `Git command failed with exit code ${code ?? signal ?? 'unknown'}`,
                'GIT_COMMAND_FAILED'
              )
            );
            return;
          }
          resolve({ stdout, stderr, exitCode: 0 });
        });
      });
    });
  } finally {
    cleanupCredentials();
  }
}

/**
 * Stages and validates a Git Skill repository under GitSourcePolicy.
 */
export async function stageGitSkill(
  source: GitInstallSourceInput,
  policy: GitSourcePolicy = DEFAULT_GIT_SOURCE_POLICY
): Promise<StagedGitSkillResult> {
  const { sanitizedUrl } = await validateGitUrlAgainstPolicy(source.repositoryUrl, policy);

  const stageDir = createSecureTempDir('enkeep-git-stage-');

  const cleanup = () => {
    const errors: Error[] = [];
    if (fs.existsSync(stageDir)) {
      try {
        fs.rmSync(stageDir, { recursive: true, force: true });
      } catch (rmErr) {
        if (rmErr && (rmErr as NodeJS.ErrnoException).code !== 'ENOENT') {
          errors.push(new PlatformError('Failed to remove git staging directory', 'STAGE_CLEANUP_FAILED'));
        }
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, 'Failed to clean up staged git directory');
    }
  };

  try {
    const isCommitSha = source.ref && /^[0-9a-f]{40}$/i.test(source.ref);

    if (isCommitSha) {
      // Clone repository then checkout specific commit
      await runGitCommand(['clone', '--no-recurse-submodules', source.repositoryUrl, stageDir], {
        authToken: source.authToken,
        sshPrivateKey: source.sshPrivateKey,
        knownHostsFile: source.knownHostsFile,
        policy,
      });
      await runGitCommand(['checkout', source.ref!], {
        cwd: stageDir,
        policy,
      });
    } else {
      const cloneArgs = [
        'clone',
        '--no-recurse-submodules',
        '--depth', '1',
      ];

      if (source.ref) {
        cloneArgs.push('--branch', source.ref);
      }

      cloneArgs.push(source.repositoryUrl, stageDir);

      await runGitCommand(cloneArgs, {
        authToken: source.authToken,
        sshPrivateKey: source.sshPrivateKey,
        knownHostsFile: source.knownHostsFile,
        policy,
      });
    }

    // Inspect remote.origin.url to ensure it wasn't redirected to an unauthorized target
    const remoteUrlResult = await runGitCommand(['config', '--get', 'remote.origin.url'], {
      cwd: stageDir,
      policy,
    });
    const finalRemoteUrl = remoteUrlResult.stdout.trim();
    if (finalRemoteUrl) {
      await validateGitUrlAgainstPolicy(finalRemoteUrl, policy);
    }

    // Get current commit SHA
    const revParseResult = await runGitCommand(['rev-parse', 'HEAD'], {
      cwd: stageDir,
      policy,
    });
    const commitSha = revParseResult.stdout.trim();

    // If expectedCommit is specified, verify exact match
    if (source.expectedCommit && source.expectedCommit !== commitSha) {
      throw new ValidationError(
        `Commit SHA mismatch: expected ${source.expectedCommit}, but cloned repository is at ${commitSha}`
      );
    }

    const targetDir = source.subdirectory ? path.join(stageDir, source.subdirectory) : stageDir;
    const payload = validateSkillDirectory(stageDir, source.subdirectory);

    return {
      stageDir,
      targetDir,
      commitSha,
      sanitizedUrl,
      payload,
      cleanup,
    };
  } catch (err) {
    cleanup();
    throw err;
  }
}

/**
 * Previews diff between current commit and target ref for moving branch/tag updates.
 */
export async function previewGitDiff(
  source: GitInstallSourceInput,
  currentCommit: string,
  policy: GitSourcePolicy = DEFAULT_GIT_SOURCE_POLICY
): Promise<SkillDiffPreview> {
  await validateGitUrlAgainstPolicy(source.repositoryUrl, policy);
  const stageDir = createSecureTempDir('enkeep-git-diff-');

  const cleanup = () => {
    const errors: Error[] = [];
    if (fs.existsSync(stageDir)) {
      try {
        fs.rmSync(stageDir, { recursive: true, force: true });
      } catch (rmErr) {
        if (rmErr && (rmErr as NodeJS.ErrnoException).code !== 'ENOENT') {
          errors.push(new PlatformError('Failed to remove diff staging directory', 'STAGE_CLEANUP_FAILED'));
        }
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, 'Failed to clean up diff staging directory');
    }
  };

  try {
    // Clone full history
    await runGitCommand(['clone', '--no-recurse-submodules', source.repositoryUrl, stageDir], {
      authToken: source.authToken,
      sshPrivateKey: source.sshPrivateKey,
      knownHostsFile: source.knownHostsFile,
      policy,
    });

    const targetRef = source.ref || 'HEAD';
    const targetRevResult = await runGitCommand(['rev-parse', targetRef], {
      cwd: stageDir,
      policy,
    });
    const targetCommit = targetRevResult.stdout.trim();

    // Check if targetCommit is same as currentCommit
    if (targetCommit === currentCommit) {
      const payload = validateSkillDirectory(stageDir, source.subdirectory);
      return {
        skillName: payload.name,
        currentCommit,
        targetCommit,
        currentVersion: 1,
        targetVersion: 1,
        changedFiles: [],
        diffSummary: 'No changes detected between commits',
        requiresConfirmation: false,
      };
    }

    // Diff files
    const subpath = source.subdirectory || '.';
    const diffStat = await runGitCommand(
      ['diff', '--name-status', currentCommit, targetCommit, '--', subpath],
      { cwd: stageDir, policy }
    );

    const changedFiles: Array<{ path: string; status: 'added' | 'modified' | 'deleted' }> = [];
    const lines = diffStat.stdout.trim().split('\n').filter(Boolean);
    for (const line of lines) {
      const parts = line.split('\t');
      if (parts.length >= 2) {
        const code = parts[0].trim();
        const filePath = parts[1].trim();
        let status: 'added' | 'modified' | 'deleted' = 'modified';
        if (code.startsWith('A')) status = 'added';
        else if (code.startsWith('D')) status = 'deleted';
        changedFiles.push({ path: filePath, status });
      }
    }

    const payload = validateSkillDirectory(stageDir, source.subdirectory);

    return {
      skillName: payload.name,
      currentCommit,
      targetCommit,
      currentVersion: 1,
      targetVersion: 2,
      changedFiles,
      diffSummary: `Commit diff: ${currentCommit.slice(0, 8)}..${targetCommit.slice(0, 8)} (${changedFiles.length} files changed)`,
      requiresConfirmation: true,
    };
  } finally {
    cleanup();
  }
}
