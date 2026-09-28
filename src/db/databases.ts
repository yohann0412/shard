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

/** URL of the `seed` database on a server. */
export function seedDatabaseUrl(postgres: PostgresServer): string {
  return postgres.url(SEED_DATABASE);
}

/** Replaces {dbHost}, {dbPort}, {dbName}, {dbUser} and {dbPassword} in a template with the parts of a database URL. */
export function fillDatabaseParts(template: string, url: string): string {
  const parsed = new URL(url);
  return template
    .replaceAll('{dbHost}', parsed.hostname)
    .replaceAll('{dbPort}', parsed.port)
    .replaceAll('{dbName}', decodeURIComponent(parsed.pathname.slice(1)))
    .replaceAll('{dbUser}', decodeURIComponent(parsed.username))
    .replaceAll('{dbPassword}', decodeURIComponent(parsed.password));
}

/**
 * The variables that point a process at one database: `db.urlEnv` and every `db.extraUrlEnvs` variable set to `url`,
 * then `db.env` with {db} and the URL's parts filled in (for apps configured by host, port and name instead of a URL).
 */
export function databaseUrlVars(config: IsolateConfig, url: string): Record<string, string> {
  const urls = [config.db.urlEnv, ...config.db.extraUrlEnvs].map((name) => [name, url]);
  const parts = Object.entries(config.db.env).map(([name, template]) => [name, fillDatabaseParts(template.replaceAll('{db}', url), url)]);
  return Object.fromEntries([...urls, ...parts]);
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
  const seedUrl = seedDatabaseUrl(postgres);
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

/** Opens a connection to the `postgres` database, terminates every connection to `template` (a template must have none), then runs `copy`. */
async function withTemplateReleased<T>(postgres: PostgresServer, template: string, copy: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: postgres.url('postgres') });
  await client.connect();
  try {
    await client.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()', [template]);
    return await copy(client);
  } finally {
    await client.end();
  }
}

/** Copies `template` into a new database `name` with `CREATE DATABASE ... TEMPLATE`, dropping an existing `name` first if `replace`, timing the copy. */
async function copyDatabase(client: pg.Client, postgres: PostgresServer, template: string, name: string, replace = false): Promise<WorkerDatabase> {
  const start = performance.now();
  if (replace) await client.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  await client.query(`CREATE DATABASE "${name}" TEMPLATE "${template}"`);
  const copyMs = elapsedMs(start);
  log.info(`copied ${name} from ${template} in ${copyMs}ms`);
  return { name, url: postgres.url(name), copyMs };
}

/**
 * Terminates every connection to `seed`, then copies it into w0..w<count-1> with `CREATE DATABASE "w<i>" TEMPLATE seed`,
 * one at a time, timing each copy.
 */
export async function cloneDatabases(postgres: PostgresServer, count: number): Promise<WorkerDatabase[]> {
  return withTemplateReleased(postgres, SEED_DATABASE, async (client) => {
    const databases: WorkerDatabase[] = [];
    for (let index = 0; index < count; index++) databases.push(await copyDatabase(client, postgres, SEED_DATABASE, `w${index}`));
    return databases;
  });
}

/**
 * Copies `template` (by default `seed`) into one more database named `name` (the baseline's `b0`, or a fresh copy for a
 * rerun), timing the copy.
 */
export async function cloneDatabase(postgres: PostgresServer, name: string, template = SEED_DATABASE): Promise<WorkerDatabase> {
  return withTemplateReleased(postgres, template, (client) => copyDatabase(client, postgres, template, name));
}

/** Name of the database that keeps what the repo's globalSetup wrote into w0, for the other workers and for reruns. */
export const SETUP_DATABASE = 'setup';

/**
 * After the repo's globalSetup ran against w0 (with nothing connected to w0 any more): copies w0 into `setup`, then
 * replaces w1..w<count-1> with copies of `setup`. Returns every worker database, w0 unchanged.
 */
export async function fanOutDatabases(postgres: PostgresServer, databases: WorkerDatabase[]): Promise<WorkerDatabase[]> {
  const first = databases[0];
  if (first === undefined) return databases;
  await withTemplateReleased(postgres, first.name, (client) => copyDatabase(client, postgres, first.name, SETUP_DATABASE, true));
  return withTemplateReleased(postgres, SETUP_DATABASE, async (client) => {
    const copies = [first];
    for (const database of databases.slice(1)) copies.push(await copyDatabase(client, postgres, SETUP_DATABASE, database.name, true));
    return copies;
  });
}
