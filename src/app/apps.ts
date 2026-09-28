import { writeFileSync } from 'node:fs';
import type { IsolateConfig } from '../config/schema.js';
import type { WorkerDatabase } from '../db/databases.js';
import { log } from '../log.js';
import { isolatePaths } from '../paths.js';
import { killGroup, spawnGroup, type ExitInfo, type GroupProcess } from '../proc/group.js';
import { freePorts } from '../proc/ports.js';
import type { Reaper } from '../proc/reaper.js';
import { readTail } from '../proc/tail.js';
import { elapsedMs } from '../proc/timing.js';
import { appEnv, fillPlaceholders } from './env.js';
import { waitForHealthy } from './health.js';

/** One healthy app process, as printed in the `ready` line. */
export interface RunningApp {
  index: number;
  port: number;
  url: string;
  /** PID of the app's process group leader. */
  pid: number;
  dbUrl: string;
  /** From spawn to the first healthy answer. */
  bootMs: number;
}

/** An app that exited on its own after it had become healthy. */
export interface AppExit extends ExitInfo {
  index: number;
  logTail: string;
}

/** The app processes of one isolate invocation, one per worker. */
export interface AppGroup {
  apps: RunningApp[];
  /** Resolves when any app exits on its own after it was healthy; stays pending once stop() has been called. */
  unexpectedExit: Promise<AppExit>;
  /** Kills every app's process group. */
  stop(): Promise<void>;
}

/** What startApps needs. */
export interface AppOptions {
  repoDir: string;
  config: IsolateConfig;
  databases: WorkerDatabase[];
  reaper: Reaper;
}

interface StartedApp {
  app: RunningApp;
  proc: GroupProcess;
}

async function startApp(
  options: Pick<AppOptions, 'repoDir' | 'config' | 'reaper'>,
  index: number,
  port: number,
  database: WorkerDatabase,
  logFile = isolatePaths(options.repoDir).appLog(index),
): Promise<StartedApp> {
  const { repoDir, config, reaper } = options;
  writeFileSync(logFile, '');
  const url = `http://127.0.0.1:${port}`;
  const env = appEnv(config, { index, port, url, dbUrl: database.url });
  const start = performance.now();
  const command = fillPlaceholders(config.app.start, { index, port, url, dbUrl: database.url });
  const proc = await spawnGroup('/bin/sh', ['-c', command], { cwd: repoDir, env, logFile, reaper });
  try {
    await waitForHealthy(port, config.app.healthPath, proc, `w${index}`, config.app.bootTimeoutMs);
  } catch (error) {
    await killGroup(proc.pid);
    throw error;
  }
  const bootMs = elapsedMs(start);
  log.info(`app w${index} healthy at ${url} in ${bootMs}ms (pid ${proc.pid}, database ${database.name})`);
  return { app: { index, port, url, pid: proc.pid, dbUrl: database.url, bootMs }, proc };
}

/** What startSingleApp needs: the database, the worker index for `{i}` and ISOLATE_WORKER_INDEX, and the log file. */
export interface SingleAppOptions extends Pick<AppOptions, 'repoDir' | 'config' | 'reaper'> {
  index: number;
  database: WorkerDatabase;
  logFile: string;
}

/** Starts one more app on its own free port against `database` (for example for a rerun); returns it and a function that stops it. */
export async function startSingleApp(options: SingleAppOptions): Promise<RunningApp & { stop(): Promise<void> }> {
  const [port] = await freePorts(1);
  const { app, proc } = await startApp(options, options.index, port!, options.database, options.logFile);
  return { ...app, stop: () => killGroup(proc.pid) };
}

/**
 * Starts one app per worker database, in parallel, each in its own process group on its own free port, with
 * `app.env` filled in for that worker, the port and database URL variables set, ISOLATE_WORKER_INDEX=i, and output in
 * .isolate/logs/w<i>.log. Resolves once every app is healthy; if any fails, stops the others and throws its error.
 */
export async function startApps(options: AppOptions): Promise<AppGroup> {
  const ports = await freePorts(options.databases.length);
  const results = await Promise.allSettled(options.databases.map((database, index) => startApp(options, index, ports[index]!, database)));
  const started = results.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []));
  const failure = results.find((result) => result.status === 'rejected');
  if (failure !== undefined) {
    await Promise.all(started.map(({ proc }) => killGroup(proc.pid)));
    throw failure.reason;
  }

  let stopping = false;
  const exits = started.map(({ app, proc }) =>
    proc.exited.then((exit) => {
      if (stopping) return new Promise<never>(() => {});
      return { ...exit, index: app.index, logTail: readTail(proc.logFile) };
    }),
  );
  return {
    apps: started.map(({ app }) => app),
    unexpectedExit: Promise.race(exits),
    async stop() {
      stopping = true;
      await Promise.all(started.map(({ proc }) => killGroup(proc.pid)));
    },
  };
}
