import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

/** The fields of a package.json that init reads. */
export interface PackageJson {
  type?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  packageManager?: string;
  workspaces?: string[] | { packages?: string[] };
  prisma?: { seed?: string; schema?: string };
}

/** Directories no detector looks into. */
const SKIPPED_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage', 'test-results', 'playwright-report']);

/** Reads a text file, or returns null if it does not exist or is not a file. */
export function readText(file: string): string | null {
  return isFile(file) ? readFileSync(file, 'utf8') : null;
}

/** Reads `<dir>/package.json`, or returns null if it is missing or not valid JSON. */
export function readPackageJson(dir: string): PackageJson | null {
  const text = readText(path.join(dir, 'package.json'));
  if (text === null) return null;
  try {
    return JSON.parse(text) as PackageJson;
  } catch {
    return null;
  }
}

/** True if the path exists and is a regular file (following symlinks). */
export function isFile(file: string): boolean {
  return existsSync(file) && statSync(file).isFile();
}

/** True if the path exists and is a directory (following symlinks). */
export function isDir(dir: string): boolean {
  return existsSync(dir) && statSync(dir).isDirectory();
}

/** Path of `target` relative to `from` with forward slashes, or `.` when they are the same. */
export function relPath(from: string, target: string): string {
  return path.relative(from, target).split(path.sep).join('/') || '.';
}

/** Names of a package's dependencies and devDependencies. */
export function dependencyNames(pkg: PackageJson | null): string[] {
  return [...Object.keys(pkg?.dependencies ?? {}), ...Object.keys(pkg?.devDependencies ?? {})];
}

/** Subdirectories of `dir` to search, skipping dot directories, dependencies and build output. */
export function searchableSubdirs(dir: string): string[] {
  if (!isDir(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && !SKIPPED_DIRS.has(entry.name))
    .map((entry) => path.join(dir, entry.name))
    .sort();
}

/** Every file under `dir` (to `maxDepth` levels) whose name passes the filter, skipping what searchableSubdirs skips. */
export function listFiles(dir: string, accept: (name: string) => boolean, maxDepth: number): string[] {
  if (!isDir(dir)) return [];
  const files = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && accept(entry.name))
    .map((entry) => path.join(dir, entry.name))
    .sort();
  if (maxDepth <= 0) return files;
  return [...files, ...searchableSubdirs(dir).flatMap((sub) => listFiles(sub, accept, maxDepth - 1))];
}
