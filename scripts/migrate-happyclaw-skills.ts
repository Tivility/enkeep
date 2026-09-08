#!/usr/bin/env node
/**
 * HappyClaw Skills & MCP Migration Script for Enkeep
 *
 * Migrates 25 HappyClaw user skills into Enkeep as global upload skills.
 *
 * Invariants:
 * - Read-only access to HappyClaw snapshot; never touches the live HappyClaw installation.
 * - Idempotent: Skips identical (name + contentHash); updates if hash changed; inserts if new.
 * - Zero secrets printed in output or written to plaintext DB columns.
 * - Programmatic service code path: Uses ExtensionCatalogService + SqliteTenantScopedSkillPackageRepository.
 * - Places files into <dshHome>/skills/<slug> and <dataRoot>/skills/<slug>.
 * - Dual-writes to both unified M30 extension tables (extension_packages, extension_contributions, extension_versions)
 *   and M21 skill governance tables (skill_packages, skill_package_versions).
 * - For MCP: user-defined loose MCP servers without canonical extension packages and containing
 *   plaintext secrets in argv are NOT imported under Enkeep supply chain governance; prints guidance.
 *
 * @module @enkeep/scripts/migrate-happyclaw-skills
 */

import { DatabaseSync } from 'node:sqlite';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import * as zlib from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = __dirname.endsWith('dist/scripts') || __dirname.endsWith('dist/scripts/')
  ? path.resolve(__dirname, '../../')
  : path.resolve(__dirname, '../');

interface MigrationCliOptions {
  snapshotDir?: string;
  dbPath?: string;
  targetUsername: string;
  dryRun: boolean;
  dataRoot?: string;
  bindAllSpaces: boolean;
}

function parseCliArgs(): MigrationCliOptions {
  const args = process.argv.slice(2);
  let snapshotDir = process.env.HAPPYCLAW_SNAPSHOT_DIR || undefined;
  let dbPath = process.env.ENKEEP_PLATFORM_DB || undefined;
  let targetUsername = process.env.TARGET_USERNAME || 'tivility';
  let dryRun = false;
  let dataRoot = process.env.ENKEEP_DATA_ROOT || undefined;
  let bindAllSpaces = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--snapshot' && args[i + 1]) {
      snapshotDir = path.resolve(args[++i]);
    } else if (arg.startsWith('--snapshot=')) {
      snapshotDir = path.resolve(arg.slice('--snapshot='.length));
    } else if (arg === '--db' && args[i + 1]) {
      dbPath = path.resolve(args[++i]);
    } else if (arg.startsWith('--db=')) {
      dbPath = path.resolve(arg.slice('--db='.length));
    } else if (arg === '--target-username' && args[i + 1]) {
      targetUsername = args[++i];
    } else if (arg.startsWith('--target-username=')) {
      targetUsername = arg.slice('--target-username='.length);
    } else if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--bind-all-spaces') {
      bindAllSpaces = true;
    } else if (arg === '--data-root' && args[i + 1]) {
      dataRoot = path.resolve(args[++i]);
    } else if (arg.startsWith('--data-root=')) {
      dataRoot = path.resolve(arg.slice('--data-root='.length));
    } else if (arg === '--help' || arg === '-h') {
      printUsage();
      process.exit(0);
    }
  }

  return {
    snapshotDir,
    dbPath,
    targetUsername,
    dryRun,
    dataRoot,
    bindAllSpaces,
  };
}

function printUsage(): void {
  console.log(`
Usage: migrate-happyclaw-skills [options]

Options:
  --snapshot <dir>          Path to HappyClaw snapshot directory (or set HAPPYCLAW_SNAPSHOT_DIR)
  --db <path>               Path to Enkeep SQLite database (or set ENKEEP_PLATFORM_DB)
  --target-username <user>  Target Enkeep username (default: tivility)
  --bind-all-spaces         Bind and enable all migrated skills into all active spaces of target user
  --dry-run                 Simulate migration without modifying files or database
  --data-root <dir>         Root data directory for Enkeep (default: parent of db)
  --help, -h                Show this help message
`);
}

/**
 * Sanitizes frontmatter in SKILL.md if argument-hint has consecutive unquoted flow sequences.
 * e.g. "argument-hint: [product-name] [competitor-url]" -> 'argument-hint: "[product-name] [competitor-url]"'
 */
function sanitizeSkillMarkdown(content: string): string {
  return content.replace(/^(argument-hint:\s*)(\[.+\](?:\s+\[.+\])+)\s*$/m, '$1"$2"');
}

/**
 * Recursively packs a skill directory into a gzipped tar archive Buffer.
 */
function createSkillArchive(skillDirPath: string, TarWriterClass: any): Buffer {
  const writer = new TarWriterClass();

  function walk(currentDir: string, currentRel = '') {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.name === '.git' || entry.name === '.DS_Store') continue;
      const rel = currentRel ? `${currentRel}/${entry.name}` : entry.name;
      const full = path.join(skillDirPath, rel);

      if (entry.isDirectory()) {
        walk(full, rel);
      } else if (entry.isFile()) {
        let data = fs.readFileSync(full);
        if (entry.name === 'SKILL.md' || entry.name === 'skill.md') {
          const text = data.toString('utf8');
          const sanitized = sanitizeSkillMarkdown(text);
          data = Buffer.from(sanitized, 'utf8');
        }
        writer.addFile({ path: rel, data });
      }
    }
  }

  walk(skillDirPath, '');
  const tarBuf = writer.finalize();
  return zlib.gzipSync(tarBuf);
}

interface SkillImportResult {
  name: string;
  status: 'IMPORTED' | 'SKIPPED' | 'UPDATED' | 'FAILED';
  hash: string;
  fileCount: number;
  totalBytes: number;
  reason?: string;
}

async function main(): Promise<void> {
  const opts = parseCliArgs();

  // Dynamic module imports
  const { TarWriter } = await import(
    pathToFileURL(path.join(REPO_ROOT, 'packages/backup-restore/dist/index.js')).href
  );
  const { SqlitePlatformStorage } = await import(
    pathToFileURL(path.join(REPO_ROOT, 'packages/platform-storage-sqlite/dist/index.js')).href
  );
  const {
    ExtensionCatalogService,
    stageArchiveSkill,
    DEFAULT_GIT_SOURCE_POLICY,
  } = await import(
    pathToFileURL(path.join(REPO_ROOT, 'packages/platform-server/dist/index.js')).href
  );

  if (!opts.snapshotDir) {
    console.error('FAIL-CLOSED: --snapshot <dir> or HAPPYCLAW_SNAPSHOT_DIR is required');
    printUsage();
    process.exit(1);
  }

  if (!opts.dbPath) {
    console.error('FAIL-CLOSED: --db <path> or ENKEEP_PLATFORM_DB is required');
    printUsage();
    process.exit(1);
  }

  const snapshotDir = path.resolve(opts.snapshotDir);
  const dbPath = path.resolve(opts.dbPath);

  if (!fs.existsSync(snapshotDir)) {
    console.error(`FAIL-CLOSED: Snapshot directory does not exist: ${snapshotDir}`);
    process.exit(1);
  }

  if (!fs.existsSync(dbPath)) {
    console.error(`FAIL-CLOSED: Target database does not exist: ${dbPath}`);
    process.exit(1);
  }

  // Resolve skills directory inside snapshot
  let skillsDir = path.join(snapshotDir, 'skills');
  if (!fs.existsSync(skillsDir)) {
    // If snapshotDir itself directly contains the skills
    if (fs.existsSync(path.join(snapshotDir, 'asr-transcribe', 'SKILL.md'))) {
      skillsDir = snapshotDir;
    } else {
      console.error(`FAIL-CLOSED: No skills directory found in snapshot at ${skillsDir}`);
      process.exit(1);
    }
  }

  // Determine data roots
  const effectiveDataRoot = opts.dataRoot
    ? path.resolve(opts.dataRoot)
    : path.dirname(dbPath);

  const spacesDir = path.join(effectiveDataRoot, 'spaces');
  const userHostRuntimesDir = path.join(effectiveDataRoot, 'host-runtimes', opts.targetUsername);
  const userDshHome = path.join(userHostRuntimesDir, '.dsh');
  const globalDshHome = fs.existsSync(userDshHome) ? userDshHome : effectiveDataRoot;

  console.log('===============================================================');
  console.log('       Enkeep HappyClaw Skills & MCP Migration Service         ');
  console.log('===============================================================');
  console.log(`Snapshot Dir:      ${snapshotDir}`);
  console.log(`Skills Source:     ${skillsDir}`);
  console.log(`Target Database:   ${dbPath}`);
  console.log(`Target User:       ${opts.targetUsername}`);
  console.log(`Data Root:         ${effectiveDataRoot}`);
  console.log(`DSH Home:          ${globalDshHome}`);
  console.log(`Spaces Dir:        ${spacesDir}`);
  console.log(`Execution Mode:    ${opts.dryRun ? 'DRY-RUN (Simulated)' : 'REAL (Mutating)'}\n`);

  // Connect to DB and lookup user
  const db = new DatabaseSync(dbPath, { readOnly: opts.dryRun });
  const userRow = db.prepare('SELECT id, username, role, status FROM users WHERE username = ?').get(opts.targetUsername) as
    | { id: string; username: string; role: string; status: string }
    | undefined;

  if (!userRow) {
    console.error(`FAIL-CLOSED: Target user "${opts.targetUsername}" not found in database`);
    process.exit(1);
  }

  const targetUserId = userRow.id;
  console.log(`Resolved Target User ID: ${targetUserId} (role: ${userRow.role})\n`);

  const storage = new SqlitePlatformStorage(db);
  const extensionCatalogService = new ExtensionCatalogService(storage, {
    dshHome: globalDshHome,
    spacesDir,
    gitSourcePolicy: DEFAULT_GIT_SOURCE_POLICY,
  });

  const skillEntries = fs.readdirSync(skillsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => e.name)
    .sort();

  console.log(`Discovered ${skillEntries.length} skill directories in snapshot.\n`);

  const results: SkillImportResult[] = [];

  for (let i = 0; i < skillEntries.length; i++) {
    const slug = skillEntries[i];
    const skillPath = path.join(skillsDir, slug);
    const skillMdPath = path.join(skillPath, 'SKILL.md');

    if (!fs.existsSync(skillMdPath)) {
      results.push({
        name: slug,
        status: 'FAILED',
        hash: '',
        fileCount: 0,
        totalBytes: 0,
        reason: 'SKILL.md not found',
      });
      continue;
    }

    try {
      // 1. Pack archive buffer
      const archiveBuffer = createSkillArchive(skillPath, TarWriter);

      // 2. Pre-flight staging and validation
      const staged = await stageArchiveSkill(archiveBuffer, `${slug}.tar.gz`);

      try {
        const payload: ValidatedSkillPayload = staged.payload;
        const contentHash = payload.contentHash;

        // 3. Check existing records in M21 (skill_packages) and M30 (extension_packages)
        const existingSkillPkg = db.prepare(
          'SELECT id, version, content_hash, status FROM skill_packages WHERE user_id = ? AND name = ? AND scope = \'global\''
        ).get(targetUserId, slug) as { id: string; version: number; content_hash: string; status: string } | undefined;

        const existingExtPkg = db.prepare(
          'SELECT id, installed_version, integrity_sha256, status FROM extension_packages WHERE user_id = ? AND slug = ?'
        ).get(targetUserId, slug) as { id: string; installed_version: number; integrity_sha256: string; status: string } | undefined;

        const isSameContent =
          (existingSkillPkg !== undefined && existingSkillPkg.content_hash === contentHash) &&
          (existingExtPkg !== undefined && existingExtPkg.integrity_sha256 === contentHash);

        if (isSameContent) {
          results.push({
            name: slug,
            status: 'SKIPPED',
            hash: contentHash,
            fileCount: payload.fileCount,
            totalBytes: payload.totalBytes,
            reason: 'Identical name and content hash already active',
          });
          continue;
        }

        if (opts.dryRun) {
          results.push({
            name: slug,
            status: existingSkillPkg ? 'UPDATED' : 'IMPORTED',
            hash: contentHash,
            fileCount: payload.fileCount,
            totalBytes: payload.totalBytes,
            reason: 'Simulated dry-run (would install globally)',
          });
          continue;
        }

        // 4. Real Execution:
        // 4.1 Install via ExtensionCatalogService (creates extension_packages, extension_versions, extension_contributions)
        await extensionCatalogService.installArchive({
          userId: targetUserId,
          archiveBuffer,
          archiveFilename: `${slug}.tar.gz`,
          targetSpaceId: null, // Global installation
        });

        // 4.2 Sync to M21 skill_packages & skill_package_versions
        const pkgRepo = storage.forTenant(targetUserId).skillPackages;
        const manifestObj = {
          name: payload.name,
          description: payload.description,
          whenToUse: payload.whenToUse,
          entrypoint: 'SKILL.md',
          invocation: payload.invocation,
        };
        const manifestJson = JSON.stringify(manifestObj);

        let skillPkgId: string;
        let nextVersion = 1;

        if (existingSkillPkg) {
          nextVersion = existingSkillPkg.content_hash === contentHash
            ? existingSkillPkg.version
            : existingSkillPkg.version + 1;
          skillPkgId = existingSkillPkg.id;

          await pkgRepo.update(skillPkgId, {
            name: payload.name,
            version: nextVersion,
            contentHash,
            manifestJson,
            status: 'active',
          });
        } else {
          skillPkgId = `spkg_${crypto.randomUUID().replace(/-/g, '')}`;
          await pkgRepo.create({
            id: skillPkgId,
            name: payload.name,
            scope: 'global',
            spaceId: null,
            version: 1,
            sourceType: 'upload',
            sourceUrl: null,
            sourceRef: `${slug}.tar.gz`,
            commitSha: null,
            subdirectory: null,
            contentHash,
            manifestJson,
            status: 'active',
          });
        }

        // Add version record
        const versionId = `spver_${crypto.randomUUID().replace(/-/g, '')}`;
        await pkgRepo.createVersion({
          id: versionId,
          packageId: skillPkgId,
          version: nextVersion,
          commitSha: null,
          contentHash,
          manifestJson,
          changeSummary: `HappyClaw snapshot migration (${slug}.tar.gz)`,
        });

        // 4.3 Ensure skill files reside in dataRoot/skills as well
        const altSkillsRoot = path.join(effectiveDataRoot, 'skills', slug);
        if (altSkillsRoot !== path.join(globalDshHome, 'skills', slug)) {
          fs.mkdirSync(altSkillsRoot, { recursive: true });
          fs.cpSync(staged.targetDir, altSkillsRoot, { recursive: true });
        }

        results.push({
          name: slug,
          status: existingSkillPkg ? 'UPDATED' : 'IMPORTED',
          hash: contentHash,
          fileCount: payload.fileCount,
          totalBytes: payload.totalBytes,
        });
      } finally {
        staged.cleanup();
      }
    } catch (err) {
      results.push({
        name: slug,
        status: 'FAILED',
        hash: '',
        fileCount: 0,
        totalBytes: 0,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Print results table
  console.log('---------------------------------------------------------------------------------------------');
  console.log(
    'Skill Name'.padEnd(28) +
    'Status'.padEnd(12) +
    'Files'.padEnd(8) +
    'Bytes'.padEnd(10) +
    'SHA-256 (head)'.padEnd(18) +
    'Details'
  );
  console.log('---------------------------------------------------------------------------------------------');

  for (const r of results) {
    const hashHead = r.hash ? `${r.hash.slice(0, 16)}...` : '-';
    const statusCol = r.status.padEnd(12);
    const filesCol = String(r.fileCount).padEnd(8);
    const bytesCol = String(r.totalBytes).padEnd(10);
    const details = r.reason ? `(${r.reason})` : '';

    console.log(
      `${r.name.padEnd(28)}${statusCol}${filesCol}${bytesCol}${hashHead.padEnd(18)}${details}`
    );
  }
  console.log('---------------------------------------------------------------------------------------------\n');

  const importedCount = results.filter((r) => r.status === 'IMPORTED').length;
  const updatedCount = results.filter((r) => r.status === 'UPDATED').length;
  const skippedCount = results.filter((r) => r.status === 'SKIPPED').length;
  const failedCount = results.filter((r) => r.status === 'FAILED').length;

  console.log(`Summary: ${importedCount} imported, ${updatedCount} updated, ${skippedCount} skipped, ${failedCount} failed (${results.length} total)`);

  // Handle Per-Space Enablement Bindings (--bind-all-spaces)
  if (opts.bindAllSpaces) {
    console.log('\n===============================================================');
    console.log('            Per-Space Skill Enablement Bindings                ');
    console.log('===============================================================');

    // Query all active spaces for the target user
    const spaces = (db.prepare(
      'SELECT id, name, folder, execution_mode FROM spaces WHERE user_id = ? AND status = \'active\' ORDER BY name ASC'
    ).all(targetUserId) as unknown[]) as Array<{ id: string; name: string; folder: string; execution_mode: string }>;

    console.log(`Found ${spaces.length} active spaces for user "${opts.targetUsername}".`);

    const bindRepo = storage.forTenant(targetUserId).extensionBindings;
    const skillBindRepo = storage.forTenant(targetUserId).skillBindings;
    const pkgRepo = storage.forTenant(targetUserId).skillPackages;

    let totalBindingsCreated = 0;
    let totalBindingsSkipped = 0;

    const successfulSkills = results.filter((r) => r.status === 'IMPORTED' || r.status === 'SKIPPED' || r.status === 'UPDATED');

    for (const space of spaces) {
      const spacePath = path.join(spacesDir, space.folder);
      const spaceSkillsRoot = path.join(spacePath, '.skills');

      for (const skill of successfulSkills) {
        const slug = skill.name;

        // Check if binding already exists
        const existingPkg = await storage.forTenant(targetUserId).extensionPackages.findBySlug(slug);

        if (opts.dryRun) {
          if (existingPkg) {
            const contribs = await storage.forTenant(targetUserId).extensionPackages.listContributions(existingPkg.id);
            const mainContrib = contribs.find((c: any) => c.contributionKey === slug) || contribs[0];
            const existingBinding = mainContrib ? await bindRepo.findBySpaceAndContribution(space.id, mainContrib.id) : null;
            if (existingBinding && existingBinding.enabled) {
              totalBindingsSkipped++;
            } else {
              totalBindingsCreated++;
            }
          } else {
            totalBindingsCreated++;
          }
          continue;
        }

        if (!existingPkg) continue;

        const contribs = await storage.forTenant(targetUserId).extensionPackages.listContributions(existingPkg.id);
        const mainContrib = contribs.find((c: any) => c.contributionKey === slug) || contribs[0];
        if (!mainContrib) continue;

        const existingBinding = await bindRepo.findBySpaceAndContribution(space.id, mainContrib.id);

        // Ensure physical skill files exist in spacePath/.skills/<slug> so resolveForSpace finds them
        const spaceSkillDir = path.join(spaceSkillsRoot, slug);
        if (!fs.existsSync(spaceSkillDir)) {
          const srcGlobalSkillDir = path.join(globalDshHome, 'skills', slug);
          const altSrcSkillDir = path.join(effectiveDataRoot, 'skills', slug);
          const srcDir = fs.existsSync(srcGlobalSkillDir) ? srcGlobalSkillDir : altSrcSkillDir;
          if (fs.existsSync(srcDir)) {
            fs.mkdirSync(spaceSkillDir, { recursive: true });
            fs.cpSync(srcDir, spaceSkillDir, { recursive: true });
          }
        }

        // Also sync to host runtime spaces if executionMode is host
        if (userHostRuntimesDir && fs.existsSync(userHostRuntimesDir)) {
          const hostSpaceSkillDir = path.join(userHostRuntimesDir, 'spaces', space.folder, '.skills', slug);
          if (!fs.existsSync(hostSpaceSkillDir)) {
            const srcGlobalSkillDir = path.join(globalDshHome, 'skills', slug);
            if (fs.existsSync(srcGlobalSkillDir)) {
              fs.mkdirSync(hostSpaceSkillDir, { recursive: true });
              fs.cpSync(srcGlobalSkillDir, hostSpaceSkillDir, { recursive: true });
            }
          }
        }

        if (existingBinding && existingBinding.enabled) {
          totalBindingsSkipped++;
        } else {
          // Enable via authoritative service method: ExtensionCatalogService.enable()
          await extensionCatalogService.enable(targetUserId, space.id, slug);

          // Also record in legacy M21 skill_bindings table
          const m21Pkg = await pkgRepo.findByName(slug, 'global', null);
          await skillBindRepo.setBinding(space.id, slug, true, m21Pkg?.id ?? null);

          totalBindingsCreated++;
        }
      }
    }

    console.log(
      `Bindings summary: ${totalBindingsCreated} created, ${totalBindingsSkipped} skipped (${totalBindingsCreated + totalBindingsSkipped} total across ${spaces.length} spaces)`
    );

    // Verify with resolveForSpace on a sample space
    if (!opts.dryRun && spaces.length > 0) {
      const sampleSpace = spaces[0];
      const plan = await extensionCatalogService.resolveForSpace(targetUserId, sampleSpace.id);
      console.log(`\nVerification on sample space "${sampleSpace.name}" (${sampleSpace.id}):`);
      console.log(`- Resolved active skills count: ${plan.skills.length} (expected: ${successfulSkills.length})`);
      if (plan.skills.length === successfulSkills.length) {
        console.log(`✅ All ${successfulSkills.length} skills successfully resolved for space "${sampleSpace.name}".`);
      } else {
        console.warn(`⚠️ Warning: Expected ${successfulSkills.length} skills, but resolved ${plan.skills.length}`);
      }
    }
  }

  // Handle MCP Servers check
  console.log('\n===============================================================');
  console.log('               MCP Server Registration Assessment              ');
  console.log('===============================================================');

  const mcpServersJsonPath = path.join(snapshotDir, 'mcp-servers', 'servers.json');
  if (fs.existsSync(mcpServersJsonPath)) {
    console.log(`Discovered HappyClaw MCP config at: ${mcpServersJsonPath}`);
    try {
      const mcpRaw = JSON.parse(fs.readFileSync(mcpServersJsonPath, 'utf8'));
      const servers = mcpRaw.servers || {};
      const serverKeys = Object.keys(servers);

      for (const key of serverKeys) {
        console.log(`\n• MCP Server: "${key}"`);
        console.log('  Status: NOT IMPORTED');
        console.log(
          '  Reason: Enkeep supply chain governance strictly prohibits loose user-defined stdio MCP servers'
        );
        console.log(
          '          without a canonical extension package (extension.json). Furthermore, HappyClaw servers.json'
        );
        console.log(
          '          contains raw plaintext secrets in command arguments (-s / --feishu-app-secret),'
        );
        console.log(
          '          which violates Enkeep strict non-plaintext secret security policy (assertNoSecretFieldsInManifest).'
        );
      }

      console.log('\n📋 Governance Guidance for MCP in Enkeep:');
      console.log(
        '  1. Feishu / Lark channel messaging is already natively handled via the platform Lark channel adapter'
      );
      console.log(
        '     and LarkEncryptedCredentialStore (channel_encrypted_credentials table).'
      );
      console.log(
        '  2. To register MCP tools in Enkeep, package them into an extension archive with extension.json,'
      );
      console.log(
        '     pass credentials through secure credentialRef IDs (never in argv/env), and install via admin role:'
      );
      console.log(
        '     POST /api/manage/extensions/install with kind="mcp" and valid credentialRefs.'
      );
    } catch (mcpErr) {
      console.log(`  Unable to parse MCP config: ${mcpErr instanceof Error ? mcpErr.message : String(mcpErr)}`);
    }
  } else {
    console.log('No mcp-servers/servers.json found in snapshot.');
  }

  console.log('\nMigration complete.');
}

main().catch((err) => {
  console.error('Unhandled fatal error in migration script:', err);
  process.exit(1);
});
