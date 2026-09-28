import { appendFileSync, writeFileSync } from 'node:fs';
import pg from 'pg';
import type { IsolateConfig } from '../config/schema.js';
import { log } from '../log.js';
import { isolatePaths } from '../paths.js';
import { runGroup } from '../proc/group.js';
import type { Reaper } from '../proc/reaper.js';
import { elapsedMs } from '../proc/timing.js';
import type { PostgresServer } from './server.js';

/** Name of the database that migrate and seed fill, and that every worker database is copied from. */
const SEED_DATABASE = 'seed';

/** One worker's copy of the seeded database. */
export interface WorkerDatabase {
  name: string;
  url: string;
  /** How long `CREATE DATABASE ... TEMPLATE seed` took. */
  copyMs: number;
}

/** What prepareSeed needs. */
export interface SeedOptions {
  postgres: PostgresServer;
  repoDir: string;
  config: IsolateConfig;
  reaper: Reaper;
}

/** `db.urlEnv` and every `db.extraUrlEnvs` variable, each set to `url`. */
export function databaseUrlVars(config: IsolateConfig, url: string): Record<string, string> {
  return Object.fromEntries([config.db.urlEnv, ...config.db.extraUrlEnvs].map((name) => [name, url]));
}

async function execute(url: string, statement: string): Promise<void> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query(statement);
  } finally {
    await client.end();
  }
}

/**
 * Creates the `seed` database and runs `db.migrate`, then `db.seed`, against it (in the repo directory, output in
 * .isolate/logs/migrate-seed.log). Throws with the log tail if either exits non-zero. Returns the seed database URL.
 */
export async function prepareSeed(options: SeedOptions): Promise<string> {
  const { postgres, repoDir, config, reaper } = options;
  const logFile = isolatePaths(repoDir).migrateSeedLog;
  writeFileSync(logFile, '');
  await execute(postgres.url('postgres'), `CREATE DATABASE "${SEED_DATABASE}"`);
  const seedUrl = postgres.url(SEED_DATABASE);
  const steps: [string, string | undefined][] = [
    ['migrate', config.db.migrate],
    ['seed', config.db.seed],
  ];
  for (const [step, command] of steps) {
    if (command === undefined) continue;
    log.info(`${step}: ${command}`);
    appendFileSync(logFile, `$ ${command}\n`);
    const env = { ...process.env, ...databaseUrlVars(config, seedUrl) };
    await runGroup('/bin/sh', ['-c', command], { cwd: repoDir, env, logFile, reaper }, step);
  }
  return seedUrl;
}

/** Opens a connection to the `postgres` database, terminates every connection to `seed` (a template must have none), then runs `copy`. */
async function withSeedReleased<T>(postgres: PostgresServer, copy: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: postgres.url('postgres') });
  await client.connect();
  try {
    await client.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()', [SEED_DATABASE]);
    return await copy(client);
  } finally {
    await client.end();
  }
}

/** Copies `seed` into a new database `name` with `CREATE DATABASE ... TEMPLATE seed`, timing the copy. */
async function copySeed(client: pg.Client, postgres: PostgresServer, name: string): Promise<WorkerDatabase> {
  const start = performance.now();
  await client.query(`CREATE DATABASE "${name}" TEMPLATE "${SEED_DATABASE}"`);
  const copyMs = elapsedMs(start);
  log.info(`copied ${name} in ${copyMs}ms`);
  return { name, url: postgres.url(name), copyMs };
}

/**
 * Terminates every connection to `seed`, then copies it into w0..w<count-1> with `CREATE DATABASE "w<i>" TEMPLATE seed`,
 * one at a time, timing each copy.
 */
export async function cloneDatabases(postgres: PostgresServer, count: number): Promise<WorkerDatabase[]> {
  return withSeedReleased(postgres, async (client) => {
    const databases: WorkerDatabase[] = [];
    for (let index = 0; index < count; index++) databases.push(await copySeed(client, postgres, `w${index}`));
    return databases;
  });
}

/** Copies `seed` into one more database named `name` (the baseline's `b0`, or a fresh copy for a rerun), timing the copy. */
export async function cloneDatabase(postgres: PostgresServer, name: string): Promise<WorkerDatabase> {
  return withSeedReleased(postgres, (client) => copySeed(client, postgres, name));
}
