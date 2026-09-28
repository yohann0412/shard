import { chmodSync, constants, cpSync, existsSync, lchownSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, statSync, utimesSync } from 'node:fs';
import path from 'node:path';
import type { PostgresUser } from '../db/user.js';
import { log } from '../log.js';
import { isolatePaths } from '../paths.js';
import type { Reaper } from '../proc/reaper.js';

/** How many entries of each kind the cache keeps; older ones are deleted after every save. */
const KEEP_ENTRIES = 3;

/** A cached Postgres data directory (`db-<key>/pgdata`) or a set of build outputs (`build-<key>/<output paths>`). */
export type EntryKind = 'db' | 'build';

function entryDir(repoDir: string, kind: EntryKind, key: string): string {
  return path.join(isolatePaths(repoDir).cache, `${kind}-${key}`);
}

/**
 * Copies a file or directory tree, keeping modes, timestamps and symlink targets as they are. Synchronous on purpose:
 * on Node 22 `fs.cpSync` copies a 47 MB, 1300-file Postgres data directory about 12 times faster than `fs.promises.cp`,
 * but creates directories with the default mode, so each copied directory then gets its source's mode back (Postgres
 * refuses a data directory that is not 0700 or 0750). Files are copy-on-write clones where the file system supports
 * them (APFS, Btrfs, XFS), and plain copies elsewhere.
 */
function copyTree(from: string, to: string): void {
  cpSync(from, to, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE });
  if (!lstatSync(from).isDirectory()) return;
  for (const entry of ['.', ...readdirSync(from, { recursive: true, encoding: 'utf8' })]) {
    const stats = lstatSync(path.join(from, entry));
    if (stats.isDirectory()) chmodSync(path.join(to, entry), stats.mode & 0o7777);
  }
}

/** Total size in bytes of the files under `dir`. */
function treeBytes(dir: string): number {
  return readdirSync(dir, { recursive: true, encoding: 'utf8' }).reduce((sum, entry) => {
    const stats = lstatSync(path.join(dir, entry));
    return sum + (stats.isFile() ? stats.size : 0);
  }, 0);
}

/** Deletes all but the KEEP_ENTRIES most recently written or used entries of one kind. */
function prune(cacheDir: string, kind: EntryKind): void {
  const entries = readdirSync(cacheDir)
    .filter((name) => name.startsWith(`${kind}-`))
    .map((name) => ({ name, usedMs: statSync(path.join(cacheDir, name)).mtimeMs }))
    .sort((a, b) => b.usedMs - a.usedMs);
  for (const { name } of entries.slice(KEEP_ENTRIES)) {
    rmSync(path.join(cacheDir, name), { recursive: true, force: true });
    log.info(`cache: deleted old entry ${name}`);
  }
}

/**
 * Writes an entry: `fill` copies into a temporary directory in the cache, which is then renamed into place, replacing
 * an entry with the same key, so a crash never leaves a half-written entry behind (the reaper deletes the temporary
 * directory if isolate is killed). Then prunes old entries of that kind. Returns the entry's size in bytes.
 */
function writeEntry(repoDir: string, kind: EntryKind, key: string, reaper: Reaper, fill: (dir: string) => void): number {
  const cacheDir = isolatePaths(repoDir).cache;
  mkdirSync(cacheDir, { recursive: true });
  const temp = mkdtempSync(path.join(cacheDir, `.tmp-${kind}-`));
  reaper.trackDir(temp);
  const dir = entryDir(repoDir, kind, key);
  try {
    fill(temp);
    rmSync(dir, { recursive: true, force: true });
    renameSync(temp, dir);
  } finally {
    rmSync(temp, { recursive: true, force: true });
    reaper.untrackDir(temp);
  }
  prune(cacheDir, kind);
  return treeBytes(dir);
}

/** The directory of the complete entry for `key`, marked as just used, or undefined if there is none. */
export function findEntry(repoDir: string, kind: EntryKind, key: string): string | undefined {
  const dir = entryDir(repoDir, kind, key);
  if (!existsSync(dir)) return undefined;
  const now = new Date();
  utimesSync(dir, now, now);
  return dir;
}

/** Copies a stopped cluster's data directory into the cache as the database entry for `key`; returns its size in bytes. */
export function saveDatabase(repoDir: string, key: string, pgdata: string, reaper: Reaper): number {
  return writeEntry(repoDir, 'db', key, reaper, (dir) => copyTree(pgdata, path.join(dir, 'pgdata')));
}

/**
 * Copies a database entry's data directory to `pgdata`, which must not exist yet. When Postgres runs as another user
 * (isolate is root), every copied file is then handed to that user, since Postgres refuses a data directory it does not own.
 */
export function restoreDatabase(entry: string, pgdata: string, owner: PostgresUser | undefined): void {
  copyTree(path.join(entry, 'pgdata'), pgdata);
  if (owner === undefined) return;
  lchownSync(pgdata, owner.uid, owner.gid);
  for (const file of readdirSync(pgdata, { recursive: true, encoding: 'utf8' })) lchownSync(path.join(pgdata, file), owner.uid, owner.gid);
}

/** Copies the build outputs (paths relative to `repoDir`) into the cache as the build entry for `key`; returns its size in bytes. */
export function saveBuild(repoDir: string, key: string, outputs: string[], reaper: Reaper): number {
  return writeEntry(repoDir, 'build', key, reaper, (dir) => {
    for (const output of outputs) {
      const source = path.join(repoDir, output);
      if (existsSync(source)) copyTree(source, path.join(dir, output));
      else log.warn(`build output ${output} does not exist after the build, so the cache holds nothing for it`);
    }
  });
}

/** Replaces each build output in `repoDir` with the build entry's copy: the existing output is deleted first. */
export function restoreBuild(entry: string, repoDir: string, outputs: string[]): void {
  for (const output of outputs) {
    const target = path.join(repoDir, output);
    rmSync(target, { recursive: true, force: true });
    const cached = path.join(entry, output);
    if (existsSync(cached)) copyTree(cached, target);
  }
}

/** Size in bytes of the entry for `key`, or undefined if there is none. */
export function entryBytes(repoDir: string, kind: EntryKind, key: string): number | undefined {
  const dir = entryDir(repoDir, kind, key);
  return existsSync(dir) ? treeBytes(dir) : undefined;
}
