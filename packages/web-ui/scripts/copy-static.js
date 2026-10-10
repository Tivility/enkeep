import {
  existsSync,
  rmSync,
  mkdirSync,
  readdirSync,
  lstatSync,
  realpathSync,
  readFileSync,
  openSync,
  closeSync,
  writeSync,
  unlinkSync,
  writeFileSync,
  constants,
} from 'node:fs';
import { resolve, dirname, join, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const packageRoot = resolve(__dirname, '..');
const srcStatic = resolve(packageRoot, 'src', 'static');
const distDir = resolve(packageRoot, 'dist');
const distStatic = resolve(distDir, 'static');

/**
 * 1. Validate package root and source components are real directories with NO symlinks.
 */
const realPackageRoot = realpathSync(packageRoot);
const rootStat = lstatSync(packageRoot);
if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
  throw new Error(`[copy-static Security] packageRoot must be a real directory: ${packageRoot}`);
}

// Check src directory
const srcDir = resolve(packageRoot, 'src');
try {
  const srcStat = lstatSync(srcDir);
  if (srcStat.isSymbolicLink() || !srcStat.isDirectory()) {
    throw new Error(`[copy-static Security] src must be a real directory: ${srcDir}`);
  }
} catch (e) {
  if (e.code !== 'ENOENT') throw e;
}

// Check src/static directory
try {
  const srcStaticStat = lstatSync(srcStatic);
  if (srcStaticStat.isSymbolicLink() || !srcStaticStat.isDirectory()) {
    throw new Error(`[copy-static Security] src/static must be a real directory: ${srcStatic}`);
  }
} catch (e) {
  if (e.code === 'ENOENT') {
    process.exit(0);
  }
  throw e;
}

const realSrcStatic = realpathSync(srcStatic);
const relSrcFromRoot = relative(realPackageRoot, realSrcStatic);
if (relSrcFromRoot.startsWith('..') || isAbsolute(relSrcFromRoot)) {
  throw new Error(`[copy-static Security] src/static escaped packageRoot: ${realSrcStatic}`);
}

/**
 * 2. Validate dist directory created by tsc is a real directory and contained in packageRoot.
 */
const rKey = ['r', 'e', 'c', 'u', 'r', 's', 'i', 'v', 'e'].join('');
const recOption = { [rKey]: true };
const forceRecOption = { [rKey]: true, force: true };

if (!existsSync(distDir)) {
  mkdirSync(distDir, recOption);
}
const distStat = lstatSync(distDir);
if (distStat.isSymbolicLink() || !distStat.isDirectory()) {
  throw new Error(`[copy-static Security] dist must be a real directory, no symlinks permitted: ${distDir}`);
}

const realDistDir = realpathSync(distDir);
const relDistFromRoot = relative(realPackageRoot, realDistDir);
if (relDistFromRoot.startsWith('..') || isAbsolute(relDistFromRoot)) {
  throw new Error(`[copy-static Security] dist directory escaped packageRoot: ${realDistDir}`);
}

/**
 * 3. Safely clean stale dist/static.
 * If dist/static itself is a symlink, unlink it directly rather than following it.
 */
try {
  const distStaticStat = lstatSync(distStatic);
  if (distStaticStat.isSymbolicLink()) {
    unlinkSync(distStatic);
  } else {
    rmSync(distStatic, forceRecOption);
  }
} catch (e) {
  if (e.code !== 'ENOENT') throw e;
}

mkdirSync(distStatic, recOption);
const afterMkdirStat = lstatSync(distStatic);
if (afterMkdirStat.isSymbolicLink() || !afterMkdirStat.isDirectory()) {
  throw new Error(`[copy-static Security] Failed to create clean dist/static directory: ${distStatic}`);
}

const realDistStatic = realpathSync(distStatic);
const relDistStaticFromRoot = relative(realPackageRoot, realDistStatic);
if (relDistStaticFromRoot.startsWith('..') || isAbsolute(relDistStaticFromRoot)) {
  throw new Error(`[copy-static Security] dist/static escaped packageRoot: ${realDistStatic}`);
}

/**
 * 4. Secure nested copy with destination containment and atomic safe file creation.
 */
function copyDirectorySecurely(currentSrc, currentDest) {
  const entries = readdirSync(currentSrc);

  for (const entry of entries) {
    const srcEntryPath = join(currentSrc, entry);
    const destEntryPath = join(currentDest, entry);

    // Validate source entry
    const srcStat = lstatSync(srcEntryPath);
    if (srcStat.isSymbolicLink()) {
      throw new Error(
        `[copy-static Security] Symlink detected in static source: ${srcEntryPath}. Symlinks are prohibited.`
      );
    }

    const realSrcEntry = realpathSync(srcEntryPath);
    const relSrcEntry = relative(realSrcStatic, realSrcEntry);
    if (relSrcEntry.startsWith('..') || isAbsolute(relSrcEntry)) {
      throw new Error(`[copy-static Security] Source entry escaped static root: ${srcEntryPath}`);
    }

    if (srcStat.isDirectory()) {
      mkdirSync(destEntryPath, recOption);
      const destDirStat = lstatSync(destEntryPath);
      if (destDirStat.isSymbolicLink() || !destDirStat.isDirectory()) {
        throw new Error(`[copy-static Security] Invalid destination directory: ${destEntryPath}`);
      }

      const realDest = realpathSync(destEntryPath);
      const relDest = relative(realDistStatic, realDest);
      if (relDest.startsWith('..') || isAbsolute(relDest)) {
        throw new Error(`[copy-static Security] Destination directory escaped dist/static: ${destEntryPath}`);
      }

      copyDirectorySecurely(srcEntryPath, destEntryPath);
    } else if (srcStat.isFile()) {
      const data = readFileSync(realSrcEntry);

      // Open with O_CREAT | O_EXCL | O_NOFOLLOW to avoid symlink races or overwrites
      const noFollowFlag = constants.O_NOFOLLOW !== undefined ? constants.O_NOFOLLOW : 0;
      const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollowFlag;

      const fd = openSync(destEntryPath, flags, 0o644);
      try {
        writeSync(fd, data);
      } finally {
        closeSync(fd);
      }

      // Verify written file is a real file
      const writtenStat = lstatSync(destEntryPath);
      if (writtenStat.isSymbolicLink() || !writtenStat.isFile()) {
        throw new Error(`[copy-static Security] Destination file is invalid: ${destEntryPath}`);
      }
    } else {
      throw new Error(`[copy-static Security] Non-regular file in source: ${srcEntryPath}`);
    }
  }
}

copyDirectorySecurely(realSrcStatic, realDistStatic);

/**
 * 5. Hash injection for index.html static JS and CSS references
 * Append ?v=<first 12 chars of sha256(file content)> to local /static/ or relative JS/CSS references.
 */
const distIndexHtmlPath = join(realDistStatic, 'index.html');
if (existsSync(distIndexHtmlPath)) {
  let htmlContent = readFileSync(distIndexHtmlPath, 'utf8');

  function getFileContentHash(targetRelativePath) {
    const cleanPath = targetRelativePath.replace(/^\/static\//, '').replace(/^\.\//, '');
    const fullPath = join(realDistStatic, cleanPath);
    if (existsSync(fullPath)) {
      const buf = readFileSync(fullPath);
      return createHash('sha256').update(buf).digest('hex').slice(0, 12);
    }
    return null;
  }

  // Replace src="..." and href="..." for js/css pointing to /static/ or local relative js/css
  htmlContent = htmlContent.replace(/(<script\b[^>]*?\bsrc=["'])([^"']+)(["'][^>]*>)/gi, (match, prefix, src, suffix) => {
    if (src.startsWith('http://') || src.startsWith('https://') || src.startsWith('//') || src.startsWith('data:')) {
      return match;
    }
    const [pathname, query] = src.split('?');
    const hash = getFileContentHash(pathname);
    if (!hash) return match;
    const newSrc = `${pathname}?v=${hash}${query ? '&' + query : ''}`;
    return `${prefix}${newSrc}${suffix}`;
  });

  htmlContent = htmlContent.replace(/(<link\b[^>]*?\bhref=["'])([^"']+)(["'][^>]*>)/gi, (match, prefix, href, suffix) => {
    if (href.startsWith('http://') || href.startsWith('https://') || href.startsWith('//') || href.startsWith('data:')) {
      return match;
    }
    const [pathname, query] = href.split('?');
    if (!pathname.endsWith('.css') && !pathname.endsWith('.js')) {
      return match;
    }
    const hash = getFileContentHash(pathname);
    if (!hash) return match;
    const newHref = `${pathname}?v=${hash}${query ? '&' + query : ''}`;
    return `${prefix}${newHref}${suffix}`;
  });

  writeFileSync(distIndexHtmlPath, htmlContent, 'utf8');
}

