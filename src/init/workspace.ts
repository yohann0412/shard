import { existsSync } from 'node:fs';
import path from 'node:path';
import { isFile, readPackageJson, readText, relPath, searchableSubdirs } from './files.js';

/** The workspace a repo directory belongs to: its root and every member package directory (absolute). */
export interface Workspace {
  root: string;
  packageDirs: string[];
}

/** How deep below a workspace root member packages are looked for. */
const MAX_PACKAGE_DEPTH = 5;

/** The `packages:` list of a pnpm-workspace.yaml (line-based: it is a flat list of strings). */
function pnpmWorkspacePatterns(text: string): string[] {
  const patterns: string[] = [];
  let inPackages = false;
  for (const line of text.split('\n')) {
    if (/^[^\s#-]/.test(line)) inPackages = /^packages\s*:/.test(line);
    const item = inPackages ? /^\s*-\s*['"]?([^'"#]+?)['"]?\s*(#.*)?$/.exec(line) : null;
    if (item) patterns.push(item[1]!);
  }
  return patterns;
}

/** Workspace package globs declared in a directory (pnpm-workspace.yaml or package.json `workspaces`), or null. */
function workspacePatterns(dir: string): string[] | null {
  const pnpm = readText(path.join(dir, 'pnpm-workspace.yaml'));
  if (pnpm !== null) return pnpmWorkspacePatterns(pnpm);
  const workspaces = readPackageJson(dir)?.workspaces;
  if (workspaces === undefined) return null;
  return Array.isArray(workspaces) ? workspaces : (workspaces.packages ?? []);
}

/** Converts a workspace glob (`apps/*`, `packages/**`, `.`) to a regex over paths relative to the root. */
function globToRegex(glob: string): RegExp {
  const clean = glob.replace(/^\.\//, '').replace(/\/+$/, '') || '.';
  const source = clean
    .split('/')
    .map((segment) => (segment === '**' ? '.*' : segment.replace(/[.+^${}()|[\]\\]/g, '\\$&').replaceAll('*', '[^/]*')))
    .join('/');
  return new RegExp(`^${source}$`);
}

/** Directories below `dir` (relative to `root`) that contain a package.json. */
function packageDirsUnder(root: string, dir: string, depth: number): string[] {
  const here = isFile(path.join(dir, 'package.json')) ? [relPath(root, dir)] : [];
  if (depth === 0) return here;
  return [...here, ...searchableSubdirs(dir).flatMap((sub) => packageDirsUnder(root, sub, depth - 1))];
}

/** Member package directories of a workspace root, from its globs (`!` globs exclude). */
function expandPatterns(root: string, patterns: string[]): string[] {
  const include = patterns.filter((glob) => !glob.startsWith('!')).map(globToRegex);
  const exclude = patterns.filter((glob) => glob.startsWith('!')).map((glob) => globToRegex(glob.slice(1)));
  return packageDirsUnder(root, root, MAX_PACKAGE_DEPTH)
    .filter((rel) => include.some((re) => re.test(rel)) && !exclude.some((re) => re.test(rel)))
    .map((rel) => path.resolve(root, rel));
}

/**
 * Finds the workspace repoDir belongs to by walking up to the git root: the first directory whose workspace globs
 * include repoDir. A repo outside any workspace is its own one-package workspace.
 */
export function findWorkspace(repoDir: string): Workspace {
  for (let dir = repoDir; ; dir = path.dirname(dir)) {
    const patterns = workspacePatterns(dir);
    if (patterns !== null) {
      const members = expandPatterns(dir, patterns);
      if (dir === repoDir || members.includes(repoDir)) {
        return { root: dir, packageDirs: [...new Set([dir, repoDir, ...members])].filter((d) => isFile(path.join(d, 'package.json'))) };
      }
    }
    if (existsSync(path.join(dir, '.git')) || path.dirname(dir) === dir) break;
  }
  return { root: repoDir, packageDirs: [repoDir] };
}
