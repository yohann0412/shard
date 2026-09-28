import { mkdirSync, writeFileSync } from 'node:fs';
import { startApps, type AppExit, type AppGroup, type RunningApp } from './app/apps.js';
import type { IsolateConfig } from './config/schema.js';
import { findPostgresBinaries } from './db/binaries.js';
import { cloneDatabases, prepareSeed, type WorkerDatabase } from './db/databases.js';
import { startPostgres, type PostgresServer } from './db/server.js';
import { log } from './log.js';
import { isolatePaths } from './paths.js';
import { runGroup } from './proc/group.js';
import { startReaper, type Reaper } from './proc/reaper.js';
import { startRssSampler } from './proc/rss.js';
import { elapsedMs } from './proc/timing.js';

/** What to bring up. */
export interface StackOptions {
  /** Repository root: commands run here and logs go to `<repoDir>/.isolate/logs`. */
  repoDir: string;
  config: IsolateConfig;
  /** Number of worker databases, and of apps when `apps` is true. */
  workers: number;
  /** Also run `build.command` (if configured) first and start one app per worker at the end. */
  apps: boolean;
}

/** Milliseconds spent in each startup phase; 0 for a phase that did not run. */
export interface StackTimings {
  build: number;
  postgresStart: number;
  migrateSeed: number;
  clone: number;
  appBoot: number;
}

/** A running stack: one Postgres server, the seeded `seed` database, N copies of it and, optionally, N apps. */
export interface Stack {
  postgres: PostgresServer;
  seedUrl: string;
  databases: WorkerDatabase[];
  /** Empty when the stack was started without apps. */
  apps: RunningApp[];
  timings: StackTimings;
  /** Output of `postgres --version` for the server in use. */
  postgresVersion: string;
  /** Pass to spawnGroup to start further processes (such as the Playwright command) under the same cleanup and run ID. */
  reaper: Reaper;
  /** Resolves if an app dies on its own after it was healthy; never resolves for a stack without apps. */
  appExited: Promise<AppExit>;
  /** Stops the apps, then Postgres, deletes the data directory and ends the reaper; returns peak RSS per process tree in MB. */
  stop(): Promise<{ peakRssMb: Record<string, number> }>;
}

/** Parses a `--workers` value into a positive integer. */
export function parseWorkers(value: string | undefined): number {
  const workers = Number(value);
  if (value === undefined || !Number.isInteger(workers) || workers < 1) {
    throw new Error(`--workers N is required and must be a positive integer (got ${value ?? 'nothing'})`);
  }
  return workers;
}

/**
 * Brings up everything `db up`, `app up` and `run` need, in this order: the build (only with apps, and only if
 * configured), Postgres, the `seed` database via migrate and seed, one template copy per worker, and one app per
 * worker (only with apps). A detached reaper watches this process from the first step, so even a SIGKILL leaves
 * nothing behind. If a phase fails, whatever already started is stopped before the error is rethrown.
 */
export async function startStack(options: StackOptions): Promise<Stack> {
  const { repoDir, config, workers } = options;
  const paths = isolatePaths(repoDir);
  mkdirSync(paths.logs, { recursive: true });
  const reaper = startReaper(paths.reaperState(process.pid), paths.reaperLog);
  const rss = startRssSampler();
  const timings: StackTimings = { build: 0, postgresStart: 0, migrateSeed: 0, clone: 0, appBoot: 0 };
  const timed = async <T>(phase: keyof StackTimings, run: () => Promise<T>): Promise<T> => {
    const start = performance.now();
    const result = await run();
    timings[phase] = elapsedMs(start);
    return result;
  };

  let postgres: PostgresServer | undefined;
  let postgresVersion = '';
  let appGroup: AppGroup | undefined;
  const stopAll = async () => {
    const peakRssMb = await rss.stop();
    await appGroup?.stop();
    await postgres?.stop();
    const escaped = await reaper.close();
    if (escaped.length > 0) log.warn(`killed ${escaped.length} process(es) that had escaped their process group: ${escaped.join(', ')}`);
    return { peakRssMb };
  };

  try {
    const build = config.build;
    if (options.apps && build !== undefined) {
      log.info(`build: ${build.command}`);
      writeFileSync(paths.buildLog, '');
      const buildOptions = { cwd: repoDir, env: process.env, logFile: paths.buildLog, reaper };
      await timed('build', () => runGroup('/bin/sh', ['-c', build.command], buildOptions, 'build'));
    }

    const server = await timed('postgresStart', async () => {
      const binaries = await findPostgresBinaries(config);
      log.info(`postgres binaries: ${binaries.source} (${binaries.version})`);
      postgresVersion = binaries.version;
      return startPostgres({ repoDir, config, binaries, workers, reaper });
    });
    postgres = server;
    rss.track('postgres', server.pid);

    const seedUrl = await timed('migrateSeed', () => prepareSeed({ postgres: server, repoDir, config, reaper }));
    const databases = await timed('clone', () => cloneDatabases(server, workers));

    if (options.apps) {
      appGroup = await timed('appBoot', () => startApps({ repoDir, config, databases, reaper }));
      for (const app of appGroup.apps) rss.track(`w${app.index}`, app.pid);
    }
    log.info(timings, 'ready; phase times in ms:');

    let stopping: Promise<{ peakRssMb: Record<string, number> }> | undefined;
    return {
      postgres: server,
      seedUrl,
      databases,
      apps: appGroup?.apps ?? [],
      timings,
      postgresVersion,
      reaper,
      appExited: appGroup?.unexpectedExit ?? new Promise<never>(() => {}),
      stop: () => (stopping ??= stopAll()),
    };
  } catch (error) {
    await stopAll().catch((cleanupError: unknown) => log.error(`cleanup after the failed start also failed: ${String(cleanupError)}`));
    throw error;
  }
}
