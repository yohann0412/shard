import { chownSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import type { IsolateConfig } from '../config/schema.js';
import { log } from '../log.js';
import { isolatePaths } from '../paths.js';
import { killGroup, runGroup, sendSignal, spawnGroup, type GroupOptions, type GroupProcess } from '../proc/group.js';
import { freePorts } from '../proc/ports.js';
import { waitForReady } from '../proc/ready.js';
import type { Reaper } from '../proc/reaper.js';
import { elapsedMs } from '../proc/timing.js';
import { settlesWithin } from '../proc/wait.js';
import type { PostgresBinaries } from './binaries.js';
import { asUser, postgresUser, type PostgresUser } from './user.js';

const HOST = '127.0.0.1';
const START_TIMEOUT_MS = 60_000;
const SHUTDOWN_TIMEOUT_MS = 10_000;

/** A throwaway cluster directory: `pgdata/` (empty until initdb or a restore fills it) and the Unix socket directory. */
export interface Cluster {
  /** Deleted when the server stops, or by the reaper if isolate dies first. */
  dir: string;
  pgdata: string;
  socketDir: string;
  inRam: boolean;
  /** The account Postgres runs as; undefined when isolate is not root. */
  user: PostgresUser | undefined;
  /** Receives the output of initdb and postgres. */
  logFile: string;
}

/** A running Postgres server owned by this isolate invocation. */
export interface PostgresServer {
  /** PID of the postmaster, which leads its own process group; a new one after whileStopped. */
  readonly pid: number;
  port: number;
  /** Directory holding the cluster (`pgdata/`) and its Unix socket (`socket/`); deleted on stop. */
  dir: string;
  /** Connection URL for one database on this server. */
  url(database: string): string;
  /**
   * Shuts the server down cleanly (fast shutdown), runs `task` on its data directory, then starts it again on the same
   * port. Throws, leaving the server stopped, if the shutdown was not clean or `task` fails.
   */
  whileStopped<T>(task: (pgdata: string) => T | Promise<T>): Promise<T>;
  /** Immediate shutdown (SIGQUIT to the postmaster, no checkpoint), SIGKILL of the group after a timeout, then deletion of `dir`. */
  stop(): Promise<void>;
}

/** What startPostgres needs. */
export interface PostgresOptions {
  config: IsolateConfig;
  binaries: PostgresBinaries;
  cluster: Cluster;
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
 * on 4 cores) plus tests opening their own, unless the config sets `postgres.maxConnections`. In RAM, dynamic shared memory lives as files in pgdata instead of
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
    `max_connections=${config.postgres.maxConnections ?? 50 + 40 * workers}`,
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
 * Sends SIGINT (fast shutdown: a final checkpoint writes every dirty buffer) or SIGQUIT (immediate shutdown: no
 * checkpoint, the next start would replay WAL, which is fine for a data directory about to be deleted) and waits; kills
 * the group if it hangs. Returns whether the postmaster exited in time.
 */
async function shutDown(server: GroupProcess, mode: 'fast' | 'immediate' = 'fast'): Promise<boolean> {
  sendSignal(server.pid, mode === 'fast' ? 'SIGINT' : 'SIGQUIT');
  const clean = await settlesWithin(server.exited, SHUTDOWN_TIMEOUT_MS);
  if (!clean) log.warn(`postgres did not shut down within ${SHUTDOWN_TIMEOUT_MS} ms; killing its process group`);
  await killGroup(server.pid, 1_000);
  return clean;
}

/**
 * Makes an empty cluster directory, owned by the Postgres user, and registers it with the reaper. Truncates the
 * Postgres log.
 */
export async function makeCluster(repoDir: string, reaper: Reaper): Promise<Cluster> {
  const logFile = isolatePaths(repoDir).postgresLog;
  writeFileSync(logFile, '');
  const user = await postgresUser();
  const { dir, inRam } = makeDataDir();
  reaper.trackDir(dir);
  const socketDir = path.join(dir, 'socket');
  mkdirSync(socketDir);
  if (user !== undefined) {
    chownSync(dir, user.uid, user.gid);
    chownSync(socketDir, user.uid, user.gid);
  }
  return { dir, pgdata: path.join(dir, 'pgdata'), socketDir, inRam, user, logFile };
}

/** Fills an empty cluster with a fresh initdb (superuser `postgres`, trust authentication, UTF8). */
export async function initCluster(cluster: Cluster, binaries: PostgresBinaries, reaper: Reaper): Promise<void> {
  const initdb = asUser(cluster.user, binaries.initdb, ['-D', cluster.pgdata, '-U', 'postgres', '--auth=trust', '-E', 'UTF8', '--no-sync']);
  await runGroup(initdb.file, initdb.args, { cwd: cluster.dir, env: process.env, logFile: cluster.logFile, reaper }, 'initdb');
}

/**
 * Starts `postgres` on a filled cluster directly (never pg_ctl, which calls setsid and would escape the process group)
 * on a free port on 127.0.0.1, with durability turned off. Resolves once it accepts connections.
 */
export async function startPostgres(options: PostgresOptions): Promise<PostgresServer> {
  const { config, binaries, cluster, workers, reaper } = options;
  const [port] = await freePorts(1);
  if (port === undefined) throw new Error('could not find a free port for Postgres');
  const settings = serverSettings(config, workers, cluster.inRam);
  const args = ['-D', cluster.pgdata, '-p', String(port), '-k', cluster.socketDir, ...settings.flatMap((s) => ['-c', s])];
  const command = asUser(cluster.user, binaries.postgres, args);
  const groupOptions: GroupOptions = { cwd: cluster.dir, env: process.env, logFile: cluster.logFile, reaper };
  const url = (database: string) => `postgres://postgres@${HOST}:${port}/${database}`;

  const launch = async (): Promise<GroupProcess> => {
    const server = await spawnGroup(command.file, command.args, groupOptions);
    log.info(`postgres starting on port ${port} (pid ${server.pid}, data in ${cluster.dir}): ${settings.join(' ')}`);
    try {
      await waitForReady(() => acceptsConnections(url('postgres')), server, 'postgres', START_TIMEOUT_MS);
    } catch (error) {
      await shutDown(server);
      throw error;
    }
    return server;
  };

  let current = await launch();
  const whileStopped = async <T>(task: (pgdata: string) => T | Promise<T>): Promise<T> => {
    if (!(await shutDown(current))) throw new Error('postgres did not shut down cleanly, so its data directory cannot be copied');
    const result = await task(cluster.pgdata);
    current = await launch();
    return result;
  };
  let stopping: Promise<void> | undefined;
  const stop = async () => {
    const start = performance.now();
    await shutDown(current, 'immediate');
    const shutdownMs = elapsedMs(start);
    rmSync(cluster.dir, { recursive: true, force: true });
    reaper.untrackDir(cluster.dir);
    log.debug({ shutdownMs, removeMs: elapsedMs(start) - shutdownMs }, 'postgres stop in ms:');
  };
  return {
    get pid() {
      return current.pid;
    },
    port,
    dir: cluster.dir,
    url,
    whileStopped,
    stop: () => (stopping ??= stop()),
  };
}
