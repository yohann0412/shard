import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { execa, type ResultPromise } from 'execa';
import pg from 'pg';

/** Absolute path of the repository root (this file compiles to dist/e2e/). */
export const repoRoot = path.resolve(import.meta.dirname, '..', '..');

/** Absolute path of the compiled CLI entry point. */
export const cliPath = path.join(repoRoot, 'dist', 'src', 'cli.js');

/** Absolute path of the fixture app. */
export const fixtureDir = path.join(repoRoot, 'examples', 'fixture-app');

/** Runs the isolate CLI to completion; never throws on a non-zero exit. */
export function isolate(args: string[], options: { cwd?: string; env?: Record<string, string>; timeoutMs?: number } = {}) {
  return execa('node', [cliPath, ...args], {
    cwd: options.cwd ?? fixtureDir,
    env: options.env,
    reject: false,
    all: true,
    timeout: options.timeoutMs ?? 15 * 60_000,
  });
}

/** Runs a shell command to completion; never throws on a non-zero exit. */
export function sh(command: string, options: { cwd?: string; env?: Record<string, string>; timeoutMs?: number } = {}) {
  return execa(command, {
    shell: true,
    cwd: options.cwd ?? fixtureDir,
    env: options.env,
    reject: false,
    all: true,
    timeout: options.timeoutMs ?? 15 * 60_000,
  });
}

/** A long-running isolate command and the `ready` event it printed on stdout. */
export interface Foreground {
  proc: ResultPromise;
  ready: Record<string, unknown>;
  output: () => string;
}

/** Starts a long-running isolate command and resolves once it prints a JSON line with `"event":"ready"`. */
export async function startForeground(args: string[], options: { cwd?: string; timeoutMs?: number } = {}): Promise<Foreground> {
  const proc = execa('node', [cliPath, ...args], { cwd: options.cwd ?? fixtureDir, reject: false, buffer: false });
  let output = '';
  proc.stderr?.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });
  const lines = createInterface({ input: proc.stdout! });
  const ready = await new Promise<Record<string, unknown>>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no ready event within timeout; output:\n${output}`)), options.timeoutMs ?? 5 * 60_000);
    lines.on('line', (line) => {
      output += `${line}\n`;
      if (!line.startsWith('{')) return;
      const event = JSON.parse(line) as Record<string, unknown>;
      if (event.event === 'ready') {
        clearTimeout(timer);
        resolve(event);
      }
    });
    void proc.then(() => {
      clearTimeout(timer);
      reject(new Error(`exited before ready; output:\n${output}`));
    });
  });
  return { proc, ready, output: () => output };
}

/** Returns `{ table: rowCount }` for every table in the public schema of a database. */
export async function rowCounts(url: string): Promise<Record<string, number>> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const tables = await client.query<{ tablename: string }>("select tablename from pg_tables where schemaname = 'public' order by tablename");
    const counts: Record<string, number> = {};
    for (const { tablename } of tables.rows) {
      const result = await client.query<{ n: string }>(`select count(*)::text as n from "${tablename}"`);
      counts[tablename] = Number(result.rows[0]!.n);
    }
    return counts;
  } finally {
    await client.end();
  }
}

/** True if a process with this PID exists. */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Waits until the predicate holds or the timeout passes; returns whether it held. */
export async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return predicate();
}

/**
 * Copies the fixture app into a fresh temp directory (without node_modules, build output or .isolate)
 * and links its node_modules back to the installed fixture. Returns the copy's path.
 */
export function copyFixture(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'isolate-fixture-'));
  cpSync(fixtureDir, dir, {
    recursive: true,
    filter: (source) => !/[/\\](node_modules|dist|\.isolate|test-results|playwright-report)([/\\]|$)/.test(source.slice(fixtureDir.length)),
  });
  symlinkSync(path.join(fixtureDir, 'node_modules'), path.join(dir, 'node_modules'));
  return dir;
}

/** Deletes a directory created by copyFixture. */
export function removeDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

/** Reads and parses a JSON file. */
export function readJson<T>(file: string): T {
  if (!existsSync(file)) throw new Error(`missing ${file}`);
  return JSON.parse(readFileSync(file, 'utf8')) as T;
}
