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

/** At most this many CREATE DATABASE statements run at once, each on its own connection. */
const COPY_CONCURRENCY = 8;

/**
 * How this server copies a template. `fileCopy`: `STRATEGY = FILE_COPY` (Postgres 15+), which copies the template's
 * files instead of writing every page through shared buffers and WAL (the default, WAL_LOG): no dirty buffers for the
 * shutdown to write, and several times faster for a seeded database of any size. `clone`: `file_copy_method = clone`
 * (Postgres 18+), copy-on-write clones where the file system has them (APFS, Btrfs, XFS); turned off for the rest of
 * the run if a clone fails.
 */
interface CopyMethod {
  fileCopy: boolean;
  clone: boolean;
}

const copyMethods = new WeakMap<PostgresServer, Promise<CopyMethod>>();

/** Asks the server once which copy method it supports. */
function copyMethod(postgres: PostgresServer): Promise<CopyMethod> {
  let method = copyMethods.get(postgres);
  if (method === undefined) {
    method = (async () => {
      const client = new pg.Client({ connectionString: postgres.url('postgres') });
      await client.connect();
      try {
        const version = Number((await client.query<{ server_version_num: string }>('SHOW server_version_num')).rows[0]?.server_version_num);
        let clone = false;
        if (version >= 180000) {
          clone = await client.query('SET file_copy_method = clone').then(
            () => true,
            () => false,
          );
        }
        return { fileCopy: version >= 150000, clone };
      } finally {
        await client.end();
      }
    })();
    copyMethods.set(postgres, method);
  }
  return method;
}

/** Terminates every connection to `template`: a template must have none. */
async function releaseTemplate(postgres: PostgresServer, template: string): Promise<void> {
  const client = new pg.Client({ connectionString: postgres.url('postgres') });
  await client.connect();
  try {
    await client.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()', [template]);
  } finally {
    await client.end();
  }
}

/**
 * Copies `template` into a new database `name` on its own connection, dropping an existing `name` first if `replace`,
 * timing the copy. With `clone`, a failed copy-on-write clone is retried as a plain file copy.
 */
async function copyDatabase(postgres: PostgresServer, template: string, name: string, replace: boolean): Promise<WorkerDatabase> {
  const method = await copyMethod(postgres);
  const client = new pg.Client({ connectionString: postgres.url('postgres') });
  await client.connect();
  try {
    if (replace) await client.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    const start = performance.now();
    const create = `CREATE DATABASE "${name}" TEMPLATE "${template}"${method.fileCopy ? ' STRATEGY = FILE_COPY' : ''}`;
    if (method.clone) {
      try {
        await client.query('SET file_copy_method = clone');
        await client.query(create);
      } catch (error) {
        method.clone = false;
        log.warn(`copy-on-write clone of ${template} failed (${error instanceof Error ? error.message : String(error)}); copying files instead`);
        await client.query('RESET file_copy_method');
        await client.query(create);
      }
    } else {
      await client.query(create);
    }
    const copyMs = elapsedMs(start);
    log.info(`copied ${name} from ${template} in ${copyMs}ms`);
    return { name, url: postgres.url(name), copyMs };
  } finally {
    await client.end();
  }
}

/** Copies `template` into every database in `names`, COPY_CONCURRENCY at a time; returns them in the order of `names`. */
async function copyAll(postgres: PostgresServer, template: string, names: string[], replace: boolean): Promise<WorkerDatabase[]> {
  const copies: WorkerDatabase[] = [];
  for (let first = 0; first < names.length; first += COPY_CONCURRENCY) {
    const batch = names.slice(first, first + COPY_CONCURRENCY);
    copies.push(...(await Promise.all(batch.map((name) => copyDatabase(postgres, template, name, replace)))));
  }
  return copies;
}

/**
 * Terminates every connection to `seed`, then copies it into w0..w<count-1> with `CREATE DATABASE "w<i>" TEMPLATE seed`,
 * several at a time, timing each copy.
 */
export async function cloneDatabases(postgres: PostgresServer, count: number): Promise<WorkerDatabase[]> {
  await releaseTemplate(postgres, SEED_DATABASE);
  return copyAll(
    postgres,
    SEED_DATABASE,
    Array.from({ length: count }, (_, index) => `w${index}`),
    false,
  );
}

/**
 * Copies `template` (by default `seed`) into one more database named `name` (the baseline's `b0`, or a fresh copy for a
 * rerun), timing the copy.
 */
export async function cloneDatabase(postgres: PostgresServer, name: string, template = SEED_DATABASE): Promise<WorkerDatabase> {
  await releaseTemplate(postgres, template);
  return copyDatabase(postgres, template, name, false);
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
  await releaseTemplate(postgres, first.name);
  await copyDatabase(postgres, first.name, SETUP_DATABASE, true);
  await releaseTemplate(postgres, SETUP_DATABASE);
  const copies = await copyAll(
    postgres,
    SETUP_DATABASE,
    databases.slice(1).map((database) => database.name),
    true,
  );
  return [first, ...copies];
}
