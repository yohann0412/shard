import { existsSync, lstatSync, readdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { isDir, isFile, readPackageJson, relPath } from '../files.js';
import { found, guess, type Finding } from '../finding.js';
import type { PackageManager } from '../scripts.js';

/** The package manager, and the lockfile it was read from (absolute), if any. */
export interface PackageManagerFinding extends Finding<PackageManager> {
  lockfile: string | null;
}

const LOCKFILES: Array<[string, PackageManager]> = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['package-lock.json', 'npm'],
  ['npm-shrinkwrap.json', 'npm'],
  ['yarn.lock', 'yarn'],
  ['bun.lock', 'bun'],
  ['bun.lockb', 'bun'],
];

/** The `packageManager` field (`pnpm@10.1.0`) of a package.json, if it names a known package manager. */
function packageManagerField(dir: string): PackageManager | null {
  const name = readPackageJson(dir)?.packageManager?.split('@')[0];
  return LOCKFILES.some(([, manager]) => manager === name) ? (name as PackageManager) : null;
}

/** True if node_modules was laid out by pnpm: a `.pnpm` store, or dependencies that are links into one. */
function installedByPnpm(dir: string): boolean {
  const modules = path.join(dir, 'node_modules');
  if (!isDir(modules)) return false;
  if (isDir(path.join(modules, '.pnpm'))) return true;
  return readdirSync(modules)
    .map((name) => path.join(modules, name))
    .some((entry) => lstatSync(entry).isSymbolicLink() && existsSync(entry) && realpathSync(entry).includes(`${path.sep}.pnpm${path.sep}`));
}

/**
 * Detects the package manager from the lockfile in the repo or at the workspace root, else from the `packageManager`
 * field, else from how node_modules is laid out. Falls back to npm.
 */
export function detectPackageManager(repoDir: string, workspaceRoot: string): PackageManagerFinding {
  const dirs = [...new Set([repoDir, workspaceRoot])];
  for (const dir of dirs) {
    for (const [name, manager] of LOCKFILES) {
      const lockfile = path.join(dir, name);
      if (isFile(lockfile)) return { ...found(manager, relPath(repoDir, lockfile)), lockfile };
    }
  }
  for (const dir of dirs) {
    const manager = packageManagerField(dir);
    if (manager !== null) return { ...found(manager, `packageManager in ${relPath(repoDir, path.join(dir, 'package.json'))}`), lockfile: null };
  }
  if (installedByPnpm(repoDir)) return { ...found<PackageManager>('pnpm', 'node_modules links into a .pnpm store (no lockfile)'), lockfile: null };
  if (isFile(path.join(repoDir, 'node_modules', '.package-lock.json'))) {
    return { ...found<PackageManager>('npm', 'node_modules/.package-lock.json (no lockfile)'), lockfile: null };
  }
  return { ...guess<PackageManager>('npm', 'no lockfile, packageManager field or recognizable node_modules'), lockfile: null };
}
