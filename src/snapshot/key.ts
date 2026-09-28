import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, readlinkSync, statSync } from 'node:fs';
import path from 'node:path';
import { execa } from 'execa';
import { CONFIG_FILE } from '../config/load.js';
import type { IsolateConfig } from '../config/schema.js';
import { log } from '../log.js';

/** Changes whenever what goes into a key, or how an entry is laid out, changes, so old entries stop matching. */
const FORMAT_VERSION = 'isolate-snapshot-1';

/** The `build` section of the config. */
export type BuildConfig = NonNullable<IsolateConfig['build']>;

function sha256(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/** True if the absolute path `file` is `dir` or lies inside it. */
function isWithin(dir: string, file: string): boolean {
  const relative = path.relative(dir, file);
  return !(relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative));
}

/** A file's content hash, a symlink's target, or a marker for anything else; the entry itself is never followed. */
function entryDigest(file: string): string {
  const stats = lstatSync(file, { throwIfNoEntry: false });
  if (stats === undefined) return 'missing';
  if (stats.isSymbolicLink()) return `link:${readlinkSync(file)}`;
  return stats.isFile() ? sha256(readFileSync(file)) : 'not-a-file';
}

/** Every non-directory under `dir`, relative to it, walked depth-first in sorted order. */
function filesUnder(dir: string): string[] {
  return readdirSync(dir)
    .sort()
    .flatMap((name) => {
      const full = path.join(dir, name);
      return lstatSync(full).isDirectory() ? filesUnder(full).map((file) => path.join(name, file)) : [name];
    });
}

/**
 * Hash of a list of paths relative to `repoDir`: a file by its content, a directory by the relative path and content
 * of every file under it, and a missing path by a `missing:<path>` marker.
 */
function hashPaths(repoDir: string, inputs: string[]): string {
  const hash = createHash('sha256');
  for (const input of inputs) {
    const full = path.resolve(repoDir, input);
    const stats = statSync(full, { throwIfNoEntry: false });
    if (stats === undefined) {
      hash.update(`missing:${input}\n`);
    } else if (stats.isDirectory()) {
      for (const file of filesUnder(full)) hash.update(`${path.join(input, file)}\0${entryDigest(path.join(full, file))}\n`);
    } else {
      hash.update(`${input}\0${sha256(readFileSync(full))}\n`);
    }
  }
  return hash.digest('hex');
}

/** The root of the git work tree `dir` is in, or undefined when it is in none (or git is not installed). */
async function gitTopLevel(dir: string): Promise<string | undefined> {
  const result = await execa('git', ['rev-parse', '--show-toplevel'], { cwd: dir, reject: false });
  return result.exitCode === 0 ? result.stdout.trim() : undefined;
}

/**
 * Hash of the git state under `repoDir`: `git ls-files -s` (index blob IDs) plus the content of every modified or
 * untracked-not-ignored file from `git status`, leaving out `.isolate/` and the build outputs. Undefined outside git.
 */
async function hashWorkTree(repoDir: string, outputs: string[]): Promise<string | undefined> {
  const topLevel = await gitTopLevel(repoDir);
  if (topLevel === undefined) return undefined;
  const excluded = ['.isolate', ...outputs].map((dir) => path.resolve(repoDir, dir));
  const kept = (file: string) => !excluded.some((dir) => isWithin(dir, path.resolve(repoDir, file)));
  const git = async (args: string[]) => (await execa('git', args, { cwd: repoDir })).stdout.split('\0').filter(Boolean);

  const hash = createHash('sha256');
  for (const entry of await git(['ls-files', '-s', '-z'])) {
    if (kept(entry.slice(entry.indexOf('\t') + 1))) hash.update(`${entry}\n`);
  }
  const status = await git(['--no-optional-locks', 'status', '--porcelain', '-z', '--untracked-files=all', '--no-renames', '--', '.']);
  const changed = status.map((entry) => path.relative(repoDir, path.join(topLevel, entry.slice(3))));
  for (const file of changed.filter(kept).sort()) hash.update(`${file}\0${entryDigest(path.join(repoDir, file))}\n`);
  return hash.digest('hex');
}

/**
 * Key of the seeded database: a format version, the Postgres version, the CPU architecture, the isolate config file,
 * and every path in `cache.inputs`.
 */
export function databaseKey(repoDir: string, config: IsolateConfig, postgresVersion: string): string {
  const configFile = readFileSync(path.join(repoDir, CONFIG_FILE));
  return sha256([FORMAT_VERSION, postgresVersion, process.arch, sha256(configFile), hashPaths(repoDir, config.cache.inputs)].join('\0'));
}

/**
 * Key of the build outputs: the database key, the build command, and the build inputs (`build.inputs` if set, else the
 * git state of the repo). Undefined, with the reason logged, when there is neither or an output lies outside the repo:
 * the build then always runs.
 */
export async function buildKey(repoDir: string, build: BuildConfig, dbKey: string): Promise<string | undefined> {
  const misplaced = build.outputs.filter((output) => {
    const target = path.resolve(repoDir, output);
    return target === repoDir || !isWithin(repoDir, target);
  });
  if (misplaced.length > 0) {
    log.info(`build cache off: build outputs must lie inside ${repoDir} (${misplaced.join(', ')}), so the build always runs`);
    return undefined;
  }
  const inputs = build.inputs === undefined ? await hashWorkTree(repoDir, build.outputs) : hashPaths(repoDir, build.inputs);
  if (inputs === undefined) {
    log.info(`build cache off: ${repoDir} is not in a git work tree and build.inputs is not set, so the build always runs`);
    return undefined;
  }
  return sha256([dbKey, build.command, inputs].join('\0'));
}
