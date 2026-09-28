import { chownSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import type { IsolateConfig } from '../config/schema.js';
import { log } from '../log.js';
import { isolatePaths } from '../paths.js';
import { killGroup, runGroup, sendSignal, spawnGroup, type GroupOptions } from '../proc/group.js';
import { freePorts } from '../proc/ports.js';
import { waitForReady } from '../proc/ready.js';
import type { Reaper } from '../proc/reaper.js';
import { settlesWithin } from '../proc/wait.js';
import type { PostgresBinaries } from './binaries.js';
import { asUser, postgresUser } from './user.js';

const HOST = '127.0.0.1';
const START_TIMEOUT_MS = 60_000;
const SHUTDOWN_TIMEOUT_MS = 10_000;

/** A running Postgres server owned by this isolate invocation. */
export interface PostgresServer {
  /** PID of the postmaster, which leads its own process group. */
  pid: number;
  port: number;
  /** Directory holding the cluster (`pgdata/`) and its Unix socket (`socket/`); deleted on stop. */
  dir: string;
  /** Connection URL for one database on this server. */
  url(database: string): string;
  /** Fast shutdown (SIGINT to the postmaster), SIGKILL of the group after a timeout, then deletion of `dir`. */
  stop(): Promise<void>;
}

/** What startPostgres needs. */
export interface PostgresOptions {
  repoDir: string;
  config: IsolateConfig;
  binaries: PostgresBinaries;
  workers: number;
  reaper: Reaper;
}

/** Makes the directory for the cluster in RAM (/dev/shm) where possible, else in the OS temp directory. */
function makeDataDir(): { dir: string; inRam: boolean } {
  if (process.platform === 'linux' && existsSync('/dev/shm')) return { dir: mkdtempSync('/dev/shm/isolate-'), inRam: true };
  log.warn(`database is on disk, not RAM (no /dev/shm on ${process.platform})`);
  return { dir: mkdtempSync(path.join(os.tmpdir(), 'isolate-')), inRam: false };
}

/**
 * Server settings (`-c` options), tuned for speed over durability. shared_buffers is 25% of RAM capped at 2 GB unless
 * the config sets `postgres.sharedBuffers`. max_connections leaves room for N apps with pools (Prisma opens 9 per client
 * on 4 cores) plus tests opening their own. In RAM, dynamic shared memory lives as files in pgdata instead of
 * /dev/shm/PostgreSQL.*, which a killed server would leak.
 */
function serverSettings(config: IsolateConfig, workers: number, inRam: boolean): string[] {
  const sharedBuffers = config.postgres.sharedBuffers ?? `${Math.min(Math.floor(os.totalmem() / 4 / 1024 / 1024), 2048)}MB`;
  return [
    `listen_addresses=${HOST}`,
    'fsync=off',
    'synchronous_commit=off',
    'full_page_writes=off',
    `shared_buffers=${sharedBuffers}`,
    `max_connections=${50 + 40 * workers}`,
    ...(inRam ? ['dynamic_shared_memory_type=mmap'] : []),
  ];
}

async function acceptsConnections(url: string): Promise<boolean> {
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 1_000 });
  try {
    await client.connect();
    await client.end();
    return true;
  } catch {
    return false;
  }
}

/**
 * Creates a throwaway cluster with initdb and starts `postgres` directly (never pg_ctl, which calls setsid and would
 * escape the process group) on a free port on 127.0.0.1, with durability turned off. Resolves once it accepts connections.
 */
export async function startPostgres(options: PostgresOptions): Promise<PostgresServer> {
  const { repoDir, config, binaries, workers, reaper } = options;
  const logFile = isolatePaths(repoDir).postgresLog;
  writeFileSync(logFile, '');
  const user = await postgresUser();

  const { dir, inRam } = makeDataDir();
  reaper.trackDir(dir);
  const pgdata = path.join(dir, 'pgdata');
  const socketDir = path.join(dir, 'socket');
  mkdirSync(socketDir);
  if (user !== undefined) {
    chownSync(dir, user.uid, user.gid);
    chownSync(socketDir, user.uid, user.gid);
  }
  const groupOptions: GroupOptions = { cwd: dir, env: process.env, logFile, reaper };

  const initdb = asUser(user, binaries.initdb, ['-D', pgdata, '-U', 'postgres', '--auth=trust', '-E', 'UTF8', '--no-sync']);
  await runGroup(initdb.file, initdb.args, groupOptions, 'initdb');

  const [port] = await freePorts(1);
  if (port === undefined) throw new Error('could not find a free port for Postgres');
  const settings = serverSettings(config, workers, inRam);
  const postgres = asUser(user, binaries.postgres, ['-D', pgdata, '-p', String(port), '-k', socketDir, ...settings.flatMap((s) => ['-c', s])]);
  const server = await spawnGroup(postgres.file, postgres.args, groupOptions);
  const url = (database: string) => `postgres://postgres@${HOST}:${port}/${database}`;
  log.info(`postgres starting on port ${port} (pid ${server.pid}, data in ${dir}): ${settings.join(' ')}`);

  let stopping: Promise<void> | undefined;
  const stop = async () => {
    sendSignal(server.pid, 'SIGINT');
    if (!(await settlesWithin(server.exited, SHUTDOWN_TIMEOUT_MS))) {
      log.warn(`postgres did not shut down within ${SHUTDOWN_TIMEOUT_MS} ms; killing its process group`);
    }
    await killGroup(server.pid, 1_000);
    rmSync(dir, { recursive: true, force: true });
    reaper.untrackDir(dir);
  };
  const handle: PostgresServer = { pid: server.pid, port, dir, url, stop: () => (stopping ??= stop()) };

  try {
    await waitForReady(() => acceptsConnections(url('postgres')), server, 'postgres', START_TIMEOUT_MS);
  } catch (error) {
    await handle.stop();
    throw error;
  }
  return handle;
}
