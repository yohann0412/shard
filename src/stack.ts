import { mkdirSync, writeFileSync } from 'node:fs';
import { startApps, type AppExit, type AppGroup, type RunningApp } from './app/apps.js';
import type { IsolateConfig } from './config/schema.js';
import { runnableBinaries } from './db/access.js';
import { findPostgresBinaries, type PostgresBinaries } from './db/binaries.js';
import { cloneDatabases, fanOutDatabases, prepareSeed, SETUP_DATABASE, seedDatabaseUrl, type WorkerDatabase } from './db/databases.js';
import { initCluster, makeCluster, startPostgres, type Cluster, type PostgresServer } from './db/server.js';
import { log } from './log.js';
import { isolatePaths } from './paths.js';
import { runGroup } from './proc/group.js';
import { startReaper, type Reaper } from './proc/reaper.js';
import { startRssSampler } from './proc/rss.js';
import { elapsedMs } from './proc/timing.js';
import type { SharedOrigin } from './proxy/origin.js';
import { startProxy, type OriginProxy } from './proxy/proxy.js';
import type { BuildConfig } from './snapshot/key.js';
import { cacheOutcome, formatSize, planCache, shortKey, type CacheOutcome, type EntryPlan } from './snapshot/plan.js';
import { restoreBuild, restoreDatabase, saveBuild, saveDatabase } from './snapshot/store.js';

/** What to bring up. */
export interface StackOptions {
  /** Repository root: commands run here and logs go to `<repoDir>/.isolate/logs`. */
  repoDir: string;
  config: IsolateConfig;
  /** Number of worker databases, and of apps when `apps` is true. */
  workers: number;
  /** Also start one app per worker at the end. */
  apps: boolean;
  /** Run `build.command` (if configured) first. Defaults to `apps`, since only the apps need the build. */
  build?: boolean;
  /** `use` (the default) restores from the snapshot cache on a hit and saves to it on a miss; `refresh` never restores and always saves. */
  cache?: 'use' | 'refresh';
  /** Start the shared-origin proxy on this origin first, and route each app's worker index to it (DECISIONS D-014). */
  sharedOrigin?: SharedOrigin;
  /**
   * With apps: start only w0's app, for the repo's globalSetup to run against; `fanOut()` then copies w0 to the other
   * workers and starts every app (DECISIONS D-015).
   */
  deferApps?: boolean;
}

/**
 * Milliseconds spent in each startup phase; 0 for a phase that did not run. Saving to the snapshot cache counts toward
 * the phase whose result is saved (build or migrateSeed); restoring from it is `restore`.
 */
export interface StackTimings {
  restore: number;
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
  /** Empty when the stack was started without apps; only w0's app before `fanOut()` when apps were deferred. */
  readonly apps: RunningApp[];
  /** The database reruns copy: `seed`, or after `fanOut()` the copy of w0 taken after globalSetup. */
  readonly rerunTemplate: string;
  /** The shared-origin proxy, or null without a shared origin. */
  proxy: OriginProxy | null;
  timings: StackTimings;
  /** Output of `postgres --version` for the server in use. */
  postgresVersion: string;
  /** What the snapshot cache restored. */
  cache: CacheOutcome;
  /** Pass to spawnGroup to start further processes (such as the Playwright command) under the same cleanup and run ID. */
  reaper: Reaper;
  /** Resolves if an app dies on its own after it was healthy; never resolves for a stack without apps. */
  appExited: Promise<AppExit>;
  /**
   * Only for a stack started with `deferApps`: stops w0's app, copies w0 into every other worker's database (and into
   * `setup`, for reruns), then starts every app. Returns the milliseconds spent copying and booting.
   */
  fanOut(): Promise<{ clone: number; appBoot: number }>;
  /**
   * Stops the proxy, the apps, then Postgres, deletes the data directory and ends the reaper; returns peak RSS per
   * process tree in MB.
   */
  stop(): Promise<{ peakRssMb: Record<string, number> }>;
}

/** Runs `run` and adds its duration to one phase. */
type Timed = <T>(phase: keyof StackTimings, run: () => T | Promise<T>) => Promise<T>;

/** What the cache-aware startup steps share. */
interface StepContext {
  repoDir: string;
  config: IsolateConfig;
  reaper: Reaper;
  timed: Timed;
}

/** Parses a `--workers` value into a positive integer. */
export function parseWorkers(value: string | undefined): number {
  const workers = Number(value);
  if (value === undefined || !Number.isInteger(workers) || workers < 1) {
    throw new Error(`--workers N is required and must be a positive integer (got ${value ?? 'nothing'})`);
  }
  return workers;
}

/** Restores the build outputs on a cache hit; otherwise runs the build and, if the build has a key, saves its outputs. */
async function buildOrRestore(context: StepContext, build: BuildConfig, plan: EntryPlan<string | undefined>): Promise<void> {
  const { repoDir, reaper, timed } = context;
  const { key, entry } = plan;
  if (key !== undefined && entry !== undefined) {
    const start = performance.now();
    await timed('restore', () => restoreBuild(entry, repoDir, build.outputs));
    log.info(`cache hit: restored build ${shortKey(key)} in ${elapsedMs(start)}ms`);
    return;
  }
  const buildLog = isolatePaths(repoDir).buildLog;
  log.info(`build: ${build.command}`);
  writeFileSync(buildLog, '');
  await timed('build', () => runGroup('/bin/sh', ['-c', build.command], { cwd: repoDir, env: process.env, logFile: buildLog, reaper }, 'build'));
  if (key === undefined) return;
  const start = performance.now();
  const bytes = await timed('build', () => saveBuild(repoDir, key, build.outputs, reaper));
  log.info(`cache: saved build ${shortKey(key)} (${formatSize(bytes)}) in ${elapsedMs(start)}ms`);
}

/** Fills the empty cluster with a copy of the cached data directory on a hit, else with initdb. */
async function fillCluster(context: StepContext, cluster: Cluster, binaries: PostgresBinaries, plan: EntryPlan<string>): Promise<void> {
  const { reaper, timed } = context;
  const { key, entry } = plan;
  if (entry === undefined) {
    await timed('postgresStart', () => initCluster(cluster, binaries, reaper));
    return;
  }
  const start = performance.now();
  await timed('restore', () => restoreDatabase(entry, cluster.pgdata, cluster.user));
  log.info(`cache hit: restored database ${shortKey(key)} in ${elapsedMs(start)}ms`);
}

/**
 * Creates `seed` with migrate and seed, then saves the cluster as the database entry for `key` (Postgres is stopped for
 * the copy and started again).
 */
async function seedAndSave(context: StepContext, server: PostgresServer, key: string): Promise<void> {
  const { repoDir, config, reaper, timed } = context;
  await timed('migrateSeed', () => prepareSeed({ postgres: server, repoDir, config, reaper }));
  const start = performance.now();
  const bytes = await timed('migrateSeed', () => server.whileStopped((pgdata) => saveDatabase(repoDir, key, pgdata, reaper)));
  log.info(`cache: saved database ${shortKey(key)} (${formatSize(bytes)}) in ${elapsedMs(start)}ms, including the Postgres restart`);
}

/**
 * Brings up everything `db up`, `app up`, `run` and `snapshot` need, in this order: the shared-origin proxy (only with
 * `sharedOrigin`, first so that a taken port costs nothing), the build (with apps or `build`, and only if configured),
 * Postgres, the `seed` database via migrate and seed, one template copy per worker, and one app per worker (only with
 * apps), each routed through the proxy. The build and the seeded cluster come from the snapshot cache when their keys
 * match (see src/snapshot/), and are saved to it otherwise. A detached reaper watches this process from the first step,
 * so even a SIGKILL leaves nothing behind. If a phase fails, whatever already started is stopped before the error is
 * rethrown.
 */
export async function startStack(options: StackOptions): Promise<Stack> {
  const { repoDir, config, workers } = options;
  const paths = isolatePaths(repoDir);
  mkdirSync(paths.logs, { recursive: true });
  const reaper = startReaper(paths.reaperState(process.pid), paths.reaperLog);
  const rss = startRssSampler();
  const timings: StackTimings = { restore: 0, build: 0, postgresStart: 0, migrateSeed: 0, clone: 0, appBoot: 0 };
  const timed: Timed = async (phase, run) => {
    const start = performance.now();
    const result = await run();
    timings[phase] = Math.round((timings[phase] + elapsedMs(start)) * 10) / 10;
    return result;
  };
  const context: StepContext = { repoDir, config, reaper, timed };

  let proxy: OriginProxy | undefined;
  let postgres: PostgresServer | undefined;
  let appGroup: AppGroup | undefined;
  const stopAll = async () => {
    const steps: Record<string, number> = {};
    const step = async <T>(name: string, run: () => Promise<T>): Promise<T> => {
      const start = performance.now();
      const result = await run();
      steps[name] = elapsedMs(start);
      return result;
    };
    const peakRssMb = await step('rss', () => rss.stop());
    await step('proxy', async () => proxy?.stop());
    await step('apps', async () => appGroup?.stop());
    await step('postgres', async () => postgres?.stop());
    const escaped = await step('reaper', () => reaper.close());
    log.debug(steps, 'teardown steps in ms:');
    if (escaped.length > 0) log.warn(`killed ${escaped.length} process(es) that had escaped their process group: ${escaped.join(', ')}`);
    return { peakRssMb };
  };

  try {
    if (options.sharedOrigin !== undefined) {
      proxy = await startProxy(options.sharedOrigin, reaper, paths.proxyLog);
      log.info(`shared-origin proxy listening for ${proxy.origin.href} (log: ${paths.proxyLog})`);
    }
    const binaries = await timed('postgresStart', async () => runnableBinaries(await findPostgresBinaries(config)));
    log.info(`postgres binaries: ${binaries.source} (${binaries.version})`);
    const build = (options.build ?? options.apps) ? config.build : undefined;
    const plan = await planCache({ repoDir, config, postgresVersion: binaries.version, build, refresh: options.cache === 'refresh' });
    if (build !== undefined && plan.build !== null) await buildOrRestore(context, build, plan.build);

    const cluster = await timed('postgresStart', () => makeCluster(repoDir, reaper));
    await fillCluster(context, cluster, binaries, plan.db);
    const server = await timed('postgresStart', () => startPostgres({ config, binaries, cluster, workers, reaper }));
    postgres = server;
    rss.track('postgres', server.pid);

    if (plan.db.entry === undefined) {
      await seedAndSave(context, server, plan.db.key);
      rss.track('postgres', server.pid); // the save restarted Postgres under a new PID
    }
    const seedUrl = seedDatabaseUrl(server);
    const databases = await timed('clone', () => cloneDatabases(server, workers));

    let exitSeen: (exit: AppExit) => void = () => {};
    const appExited = new Promise<AppExit>((resolve) => {
      exitSeen = resolve;
    });
    const bootApps = async (count: number) => {
      const group = await startApps({ repoDir, config, databases: databases.slice(0, count), reaper, origin: options.sharedOrigin?.href });
      appGroup = group;
      void group.unexpectedExit.then(exitSeen);
      for (const app of group.apps) {
        rss.track(`w${app.index}`, app.pid);
        await proxy?.route(app.index, app.port);
      }
    };
    if (options.apps) await timed('appBoot', () => bootApps(options.deferApps ? Math.min(1, databases.length) : databases.length));
    log.info(timings, 'ready; phase times in ms:');

    let rerunTemplate = 'seed';
    let fannedOut = !options.deferApps;
    let stopping: Promise<{ peakRssMb: Record<string, number> }> | undefined;
    return {
      postgres: server,
      seedUrl,
      databases,
      get apps() {
        return appGroup?.apps ?? [];
      },
      get rerunTemplate() {
        return rerunTemplate;
      },
      proxy: proxy ?? null,
      timings,
      postgresVersion: binaries.version,
      cache: cacheOutcome(plan),
      reaper,
      appExited,
      async fanOut() {
        if (fannedOut || !options.apps) throw new Error('fanOut() needs a stack started with apps and deferApps, and runs once');
        fannedOut = true;
        await appGroup?.stop();
        appGroup = undefined;
        const cloneStart = performance.now();
        await fanOutDatabases(server, databases);
        rerunTemplate = SETUP_DATABASE;
        const clone = elapsedMs(cloneStart);
        const bootStart = performance.now();
        await bootApps(databases.length);
        return { clone, appBoot: elapsedMs(bootStart) };
      },
      stop: () => (stopping ??= stopAll()),
    };
  } catch (error) {
    await stopAll().catch((cleanupError: unknown) => log.error(`cleanup after the failed start also failed: ${String(cleanupError)}`));
    throw error;
  }
}
