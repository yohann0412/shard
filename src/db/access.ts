import { chmodSync, cpSync, existsSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { execa } from 'execa';
import { log } from '../log.js';
import type { PostgresBinaries } from './binaries.js';
import { asUser, postgresUser } from './user.js';

/** Gives every file under `dir` read access for all users, and directories and executables traverse/execute access. */
function openUp(dir: string): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      chmodSync(full, 0o755);
      openUp(full);
    } else {
      chmodSync(full, statSync(full).mode & 0o111 ? 0o755 : 0o644);
    }
  }
}

/** True when the Postgres user can run `postgres --version` from these binaries. */
async function runnable(binaries: PostgresBinaries, user: NonNullable<Awaited<ReturnType<typeof postgresUser>>>): Promise<boolean> {
  const command = asUser(user, binaries.postgres, ['--version']);
  return (await execa(command.file, command.args, { reject: false })).exitCode === 0;
}

/**
 * Returns binaries the Postgres user can run. As root, Postgres runs as an unprivileged user, which cannot reach
 * binaries inside a root-only directory (a repo under /root, say): the loader then fails with "cannot open shared
 * object file". In that case the binaries' installation directory (the parent of `bin/`) is copied once into a
 * world-readable directory under the OS temp directory, keyed by path and version, and used from there.
 */
export async function runnableBinaries(binaries: PostgresBinaries): Promise<PostgresBinaries> {
  const user = await postgresUser();
  if (user === undefined || (await runnable(binaries, user))) return binaries;

  const installDir = path.dirname(path.dirname(binaries.postgres));
  const key = createHash('sha256').update(`${installDir}\n${binaries.version}`).digest('hex').slice(0, 12);
  const copyDir = path.join(os.tmpdir(), `isolate-postgres-${key}`);
  const moved = (file: string) => path.join(copyDir, path.relative(installDir, file));
  const copied: PostgresBinaries = { ...binaries, initdb: moved(binaries.initdb), postgres: moved(binaries.postgres), source: `${binaries.source} (copied to ${copyDir})` };
  if (!existsSync(copyDir)) {
    log.warn(`user ${user.name} cannot run the Postgres binaries in ${installDir}; copying them to ${copyDir}`);
    const staging = `${copyDir}.tmp-${process.pid}`;
    rmSync(staging, { recursive: true, force: true });
    cpSync(installDir, staging, { recursive: true, verbatimSymlinks: true });
    chmodSync(staging, 0o755);
    openUp(staging);
    renameSync(staging, copyDir);
  }
  if (!(await runnable(copied, user))) {
    throw new Error(`user ${user.name} cannot run Postgres from ${installDir} or from the copy in ${copyDir}; set postgres.binDir to a readable installation`);
  }
  return copied;
}
