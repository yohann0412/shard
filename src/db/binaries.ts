import { existsSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execa } from 'execa';
import type { IsolateConfig } from '../config/schema.js';

/** The Postgres programs isolate runs, where they came from, and their version. */
export interface PostgresBinaries {
  initdb: string;
  postgres: string;
  /** Human-readable origin, e.g. "@embedded-postgres/linux-x64" or "pg_config --bindir". */
  source: string;
  /** Output of `postgres --version`. */
  version: string;
}

type Candidate = Omit<PostgresBinaries, 'version'>;

function fromBinDir(binDir: string, source: string): Candidate {
  return { initdb: path.join(binDir, 'initdb'), postgres: path.join(binDir, 'postgres'), source };
}

/** The binaries of the embedded-postgres platform package, resolved from embedded-postgres's own location (pnpm does not hoist it). */
async function embeddedCandidate(): Promise<Candidate | undefined> {
  const name = `@embedded-postgres/${process.platform}-${process.arch}`;
  try {
    const embeddedEntry = createRequire(import.meta.url).resolve('embedded-postgres');
    const platformEntry = createRequire(embeddedEntry).resolve(name);
    const binaries = (await import(pathToFileURL(platformEntry).href)) as { initdb: string; postgres: string };
    return { initdb: binaries.initdb, postgres: binaries.postgres, source: name };
  } catch {
    return undefined;
  }
}

async function pgConfigCandidate(): Promise<Candidate | undefined> {
  const result = await execa('pg_config', ['--bindir'], { reject: false });
  return result.exitCode === 0 ? fromBinDir(result.stdout.trim(), 'pg_config --bindir') : undefined;
}

function debianCandidate(): Candidate | undefined {
  const root = '/usr/lib/postgresql';
  if (!existsSync(root)) return undefined;
  const newest = readdirSync(root)
    .filter((entry) => /^\d+(\.\d+)?$/.test(entry))
    .sort((a, b) => Number(b) - Number(a))[0];
  return newest === undefined ? undefined : fromBinDir(path.join(root, newest, 'bin'), `${root}/${newest}/bin`);
}

function hasBinaries(candidate: Candidate): boolean {
  return existsSync(candidate.initdb) && existsSync(candidate.postgres);
}

async function withVersion(candidate: Candidate): Promise<PostgresBinaries> {
  const { stdout } = await execa(candidate.postgres, ['--version']);
  return { ...candidate, version: stdout.trim() };
}

/**
 * Finds initdb and postgres. `postgres.binDir` from the config always wins (and must contain both); otherwise it tries,
 * in order, the embedded-postgres platform package, `pg_config --bindir`, and the newest `/usr/lib/postgresql/<version>/bin`.
 */
export async function findPostgresBinaries(config: IsolateConfig): Promise<PostgresBinaries> {
  if (config.postgres.binDir !== undefined) {
    const configured = fromBinDir(config.postgres.binDir, 'postgres.binDir in isolate.config.ts');
    if (!hasBinaries(configured)) throw new Error(`postgres.binDir ${config.postgres.binDir} does not contain initdb and postgres`);
    return withVersion(configured);
  }
  const lookups: (() => Promise<Candidate | undefined> | Candidate | undefined)[] = [embeddedCandidate, pgConfigCandidate, debianCandidate];
  for (const lookup of lookups) {
    const candidate = await lookup();
    if (candidate !== undefined && hasBinaries(candidate)) return withVersion(candidate);
  }
  throw new Error(
    'no Postgres binaries found: install dependencies (embedded-postgres), set postgres.binDir in isolate.config.ts, or install Postgres so that pg_config is on PATH',
  );
}
