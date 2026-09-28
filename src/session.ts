import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from './config/load.js';
import type { IsolateConfig } from './config/schema.js';
import { startSingleApp } from './app/apps.js';
import { cloneDatabase, databaseUrlVars, type WorkerDatabase } from './db/databases.js';
import { scanUnmanaged, unmanagedWarning, type UnmanagedService } from './init/unmanaged.js';
import { log } from './log.js';
import { isolatePaths } from './paths.js';
import { commandWithConfig, parsePlaywrightCommand, type PlaywrightCommand } from './playwright/command.js';
import { InterruptGuard } from './playwright/interrupts.js';
import { readResults, type PwResults } from './playwright/results.js';
import { startPlaywright } from './playwright/runner.js';
import { scanForHazards, usesGlobalSetup } from './playwright/scan.js';
import { workerEnv } from './playwright/worker-env.js';
import { writeWrapper, type Wrapper } from './playwright/wrapper.js';
import { readTail } from './proc/tail.js';
import { parseSharedOrigin, type SharedOrigin } from './proxy/origin.js';
import { WORKER_HEADER } from './proxy/protocol.js';
import { buildReport } from './report/build.js';
import { cpuUsage, readCpuTimes, type CpuUsage } from './report/cpu.js';
import { describeMachine } from './report/machine.js';
import { classifyFailures, notRerun } from './report/rerun.js';
import { misrouted, proxyReport, requestsTo, type ProxyReport } from './report/requests.js';
import { measureDbActivity, readXactCommits, type DbActivity } from './report/routing.js';
import type { Failure } from './report/schema.js';
import { Stopwatch } from './report/stopwatch.js';
import { failedTests } from './report/summary.js';
import { renderTable } from './report/table.js';
import { routingVerdict, type RoutingVerdict, type WorkerEvidence } from './report/verdict.js';
import { startStack, type Stack } from './stack.js';
import { startTracer, type Tracer } from './trace/tracer.js';

/**
 * `run`: one app and database per worker. `trace`: the same, and it also writes the impact map (.isolate/map.json).
 * `baseline`: the repo's own config against one fresh copy of seed.
 */
export type SessionMode = 'run' | 'trace' | 'baseline';

/** What `isolate run` was asked to do. */
export interface SessionOptions {
  repoDir: string;
  command: string[];
  mode: SessionMode;
  /** Number of apps and databases in `run` and `trace` mode; unused in `baseline` mode. */
  workers: number;
  /** Send the x-isolate-worker header with every request (always on with a shared origin). */
  tagRequests: boolean;
  /** `--shared-origin`: overrides `playwright.sharedOrigin`; ignored in baseline mode (DECISIONS D-014). */
  sharedOrigin: string | undefined;
  /** Skip the flaky/deterministic reruns of failed tests (failures are reported as not rerun). */
  noRerun: boolean;
  /** Baseline mode: start one app on b0 for a config without webServer, and point the base-URL variables at it. */
  baselineApp?: boolean;
}

/** Name of the one database the baseline runs against. */
const BASELINE_DATABASE = 'b0';

/** What the tests run against: the databases whose activity is checked, and the variables Playwright gets. */
interface Targets {
  databases: WorkerDatabase[];
  env: Record<string, string>;
  /** The baseline's own app (`--baseline --app`), stopped after the tests. */
  baselineApp?: { stop(): Promise<void>; bootMs: number };
}

/** Everything the tests phase produced. */
interface TestsOutcome {
  exitCode: number;
  results: PwResults | null;
  cpu: CpuUsage | null;
  dbActivity: DbActivity[];
  proxy: ProxyReport | null;
  routing: RoutingVerdict;
}

/** A worker that ran a test: its database's name and its app's index (none for b0 in baseline mode). */
interface UsedWorker {
  name: string;
  app: number | null;
}

/** What `prepare` found out before anything starts. */
interface Prepared {
  config: IsolateConfig;
  command: PlaywrightCommand;
  sharedOrigin: SharedOrigin | undefined;
  warnings: string[];
  unmanaged: UnmanagedService[];
  /** Run the repo's globalSetup once against w0 and copy w0 to every worker before the tests (DECISIONS D-015). */
  fanOut: boolean;
}

/** Loads the config, parses the command and scans the tests before anything starts, so a refused command costs nothing. */
async function prepare(options: SessionOptions): Promise<Prepared> {
  const config = await loadConfig(options.repoDir);
  const origin = options.mode === 'baseline' ? undefined : (options.sharedOrigin ?? config.playwright.sharedOrigin);
  const sharedOrigin = origin === undefined ? undefined : parseSharedOrigin(origin);
  const command = parsePlaywrightCommand(options.command, {
    repoDir: options.repoDir,
    defaultConfig: config.playwright.config,
    workers: options.mode === 'baseline' ? null : options.workers,
  });
  const warnings = options.mode === 'baseline' ? [] : scanForHazards(command.repoConfig, options.repoDir, config.playwright.globalSetup);
  const fanOut = options.mode !== 'baseline' && config.playwright.globalSetup === 'fan-out' && usesGlobalSetup(command.repoConfig);
  const unmanaged = scanUnmanaged(options.repoDir);
  const unmanagedNote = unmanagedWarning(unmanaged);
  if (unmanagedNote !== null) warnings.push(unmanagedNote);
  for (const warning of warnings) log.warn(warning);
  return { config, command, sharedOrigin, warnings, unmanaged, fanOut };
}

/**
 * In run and trace mode, every worker's variables for its app and database (plus the tracer's, when tracing); in
 * baseline mode, a fresh b0 in the database variables.
 */
async function prepareTargets(
  options: SessionOptions,
  config: IsolateConfig,
  stack: Stack,
  tracer: Tracer | undefined,
  tagRequests: boolean,
): Promise<Targets> {
  if (options.mode === 'baseline') {
    const database = await cloneDatabase(stack.postgres, BASELINE_DATABASE);
    if (!options.baselineApp) return { databases: [database], env: databaseUrlVars(config, database.url) };
    const logFile = isolatePaths(options.repoDir).appLog(0);
    const app = await startSingleApp({ repoDir: options.repoDir, config, reaper: stack.reaper, index: 0, database, logFile });
    const { ISOLATE_BASE_URL: _url, ISOLATE_APP_INDEX: _index, ...env } = workerEnv(config, app);
    return { databases: [database], env: { ...databaseUrlVars(config, database.url), ...env }, baselineApp: app };
  }
  const envs = stack.apps.map((app) => workerEnv(config, app));
  return {
    databases: stack.databases,
    env: {
      ISOLATE_WORKER_ENVS: JSON.stringify(envs),
      ISOLATE_WORKERS: String(envs.length),
      ISOLATE_TAG_REQUESTS: tagRequests ? '1' : '0',
      ...tracer?.playwrightEnv,
    },
  };
}

/** The workers that ran a test (b0 in baseline mode), or null when Playwright wrote no per-test results. */
function usedWorkers(mode: SessionMode, results: PwResults | null, databases: WorkerDatabase[]): UsedWorker[] | null {
  if (results === null) return null;
  const ran = results.tests.filter((test) => test.status !== 'skipped');
  if (mode === 'baseline') return ran.length > 0 ? [{ name: BASELINE_DATABASE, app: null }] : [];
  const indexes = new Set(ran.map((test) => test.parallelIndex));
  return databases.flatMap((database, index) => (indexes.has(index) ? [{ name: database.name, app: index }] : []));
}

/** Size in bytes of each app's log, by app index. */
function appLogSizes(repoDir: string, stack: Stack): Map<number, number> {
  const paths = isolatePaths(repoDir);
  return new Map(stack.apps.map((app) => [app.index, statSync(paths.appLog(app.index), { throwIfNoEntry: false })?.size ?? 0]));
}

/** Runs the Playwright command, reads the reporter's results and checks routing from outside the test process. */
async function runTests(
  options: SessionOptions,
  config: IsolateConfig,
  stack: Stack,
  targets: Targets,
  argv: string[],
  guard: InterruptGuard,
): Promise<TestsOutcome> {
  const paths = isolatePaths(options.repoDir);
  const adminUrl = stack.postgres.url('postgres');
  const before = await readXactCommits(adminUrl, targets.databases.map((database) => database.name));
  const logsBefore = appLogSizes(options.repoDir, stack);
  await stack.proxy?.take();
  const cpuBefore = readCpuTimes();
  rmSync(paths.pwResults, { force: true });

  log.info(`running: ${argv.join(' ')}`);
  const env = { ...targets.env, ISOLATE_RESULTS_FILE: paths.pwResults, PLAYWRIGHT_HTML_OPEN: 'never' };
  const exitCode = await guard.run(startPlaywright(argv, { cwd: options.repoDir, env, reaper: stack.reaper }));
  const cpu = cpuUsage(cpuBefore, readCpuTimes());
  const proxy = stack.proxy === null ? null : proxyReport(stack.proxy.origin.href, await stack.proxy.take(), stack.apps);
  const logsAfter = appLogSizes(options.repoDir, stack);

  const results = readResults(paths.pwResults);
  const used = usedWorkers(options.mode, results, targets.databases);
  const dbActivity = await measureDbActivity(adminUrl, before, (used ?? []).map((worker) => worker.name));
  const evidence = used?.map(
    ({ name, app }): WorkerEvidence => ({
      name,
      xactCommitDelta: dbActivity.find((db) => db.name === name)?.xactCommitDelta ?? 0,
      proxied: proxy === null || app === null ? null : requestsTo(proxy, app),
      logBytes: app === null ? null : (logsAfter.get(app) ?? 0) - (logsBefore.get(app) ?? 0),
    }),
  );
  const routing = routingVerdict({ used: evidence ?? null, misrouted: proxy === null ? [] : misrouted(proxy), urlEnv: config.db.urlEnv });
  return { exitCode, results, cpu, dbActivity, proxy, routing };
}

/**
 * Prints and returns what makes the tests phase suspect: no reporter results, the routing verdict's errors and
 * warnings, requests the shared-origin proxy refused, refused Postgres connections (PLAN §8, rule 5).
 */
function testWarnings(repoDir: string, tests: TestsOutcome): string[] {
  const errors: string[] = [];
  if (tests.results === null) errors.push('Playwright exited without writing the isolate reporter results');
  errors.push(...tests.routing.errors);
  const warnings = [...tests.routing.warnings];
  const paths = isolatePaths(repoDir);
  if (tests.proxy !== null && tests.proxy.refused > 0) {
    warnings.push(`the shared-origin proxy refused ${tests.proxy.refused} request(s) without a usable ${WORKER_HEADER} header (421); see ${paths.proxyLog}`);
  }
  if (existsSync(paths.postgresLog) && readFileSync(paths.postgresLog, 'utf8').includes('too many clients')) {
    errors.push(`Postgres refused connections ("too many clients", see ${paths.postgresLog}): exclude this run from timing`);
  }
  for (const error of errors) log.error(error);
  for (const warning of warnings) log.warn(warning);
  return [...errors, ...warnings];
}

/**
 * Runs only the repo's globalSetup, in a Playwright run of its own against w0's app and database (one placeholder test,
 * no globalTeardown), so that nothing it opens stays connected to w0 when w0 is copied (DECISIONS D-015). Throws with
 * the log's tail if the run fails.
 */
async function runGlobalSetup(options: SessionOptions, config: IsolateConfig, stack: Stack, command: PlaywrightCommand, tagRequests: boolean, guard: InterruptGuard): Promise<void> {
  const paths = isolatePaths(options.repoDir);
  const first = stack.apps[0];
  if (first === undefined) throw new Error('globalSetup needs w0 running, but no app was started');
  const wrapper = writeWrapper({ mode: 'setup', repoConfig: command.repoConfig, outputFile: paths.pwResults, rootDir: options.repoDir, cliReporters: null });
  for (const file of wrapper.files) stack.reaper.trackDir(file);
  writeFileSync(paths.globalSetupLog, '');
  const env = {
    ISOLATE_WORKER_ENVS: JSON.stringify([workerEnv(config, first)]),
    ISOLATE_WORKERS: '1',
    ISOLATE_TAG_REQUESTS: tagRequests ? '1' : '0',
    PLAYWRIGHT_HTML_OPEN: 'never',
  };
  log.info(`globalSetup: running the repo's globalSetup once against w0 (log: ${paths.globalSetupLog})`);
  try {
    const exitCode = await guard.run(startPlaywright(commandWithConfig(command, wrapper.configFile, []), { cwd: options.repoDir, env, reaper: stack.reaper, logFile: paths.globalSetupLog }));
    if (exitCode !== 0 && guard.signal === null) {
      throw new Error(`the repo's globalSetup failed (exit code ${exitCode}). Last lines of ${paths.globalSetupLog}:\n${readTail(paths.globalSetupLog)}`);
    }
  } finally {
    wrapper.remove();
  }
}

/**
 * Runs a Playwright suite under isolate: starts the stack, writes the wrapper, runs the command, checks routing, writes
 * the impact map (trace mode), reruns failures (run and trace mode), tears down, writes .isolate/report.json and prints
 * the summary table. Returns the exit code:
 * Playwright's, 1 if routing was invalid (not if it is unknown), or 128 + n after a signal.
 */
export async function runSession(options: SessionOptions): Promise<number> {
  const stopwatch = new Stopwatch();
  const loadAvg1 = os.loadavg()[0] ?? 0;
  const paths = isolatePaths(options.repoDir);
  const { config, command, sharedOrigin, warnings, unmanaged, fanOut } = await prepare(options);
  const tagRequests = options.tagRequests || sharedOrigin !== undefined;
  stopwatch.lap('setup');

  const isolated = options.mode !== 'baseline';
  const mapHeaders: Record<string, string> = sharedOrigin === undefined ? {} : { [WORKER_HEADER]: '0' };
  const tracer = options.mode === 'trace' ? await startTracer(options.repoDir, config, options.workers, mapHeaders) : undefined;
  const stackOptions = { repoDir: options.repoDir, config: tracer?.appConfig ?? config, workers: isolated ? options.workers : 0, apps: isolated, sharedOrigin, deferApps: fanOut };
  const stack = await startStack(stackOptions).catch(async (error: unknown) => {
    await tracer?.close();
    throw error;
  });
  if (tracer !== undefined) stack.reaper.trackDir(tracer.dir);
  stopwatch.lapParts({ ...stack.timings }, 'setup');
  void stack.appExited.then((exit) => {
    warnings.push(`app w${exit.index} exited during the run`);
    log.error(`app w${exit.index} exited during the run; last lines of its log:\n${exit.logTail}`);
  });

  let wrapper: Wrapper | undefined;
  const guard = new InterruptGuard((signal) => {
    wrapper?.remove();
    process.exit(128 + os.constants.signals[signal]);
  });
  let targets: Targets | undefined;
  let tests: TestsOutcome;
  let failures: Failure[];
  let peakRssMb: Record<string, number>;
  try {
    if (fanOut) {
      await runGlobalSetup(options, config, stack, command, tagRequests, guard);
      stopwatch.lap('globalSetup');
      const fanned = await stack.fanOut();
      stopwatch.lapParts(fanned, 'setup');
      log.info(`globalSetup: copied w0 to ${options.workers - 1} other worker(s) and started every app (copy ${fanned.clone}ms, boot ${fanned.appBoot}ms)`);
    }
    targets = await prepareTargets(options, config, stack, tracer, tagRequests);
    if (options.mode === 'baseline') stopwatch.lapParts({ appBoot: targets.baselineApp?.bootMs ?? 0 }, 'clone');
    wrapper = writeWrapper({
      mode: isolated ? 'isolate' : 'passthrough',
      repoConfig: command.repoConfig,
      outputFile: paths.pwResults,
      rootDir: options.repoDir,
      cliReporters: command.cliReporters,
      skipGlobalSetup: fanOut,
    });
    for (const file of wrapper.files) stack.reaper.trackDir(file);
    stopwatch.lap('setup');

    tests = await runTests(options, config, stack, targets, commandWithConfig(command, wrapper.configFile), guard);
    warnings.push(...testWarnings(options.repoDir, tests));
    if (tracer !== undefined) {
      const ran = (tests.results?.tests ?? []).filter((test) => test.status !== 'skipped').map((test) => test.id);
      warnings.push(...(await tracer.finish(ran)));
    }
    stopwatch.lap('tests');

    const failed = failedTests(tests.results);
    failures = failed.map(notRerun);
    if (isolated && !options.noRerun && failed.length > 0 && guard.signal === null) {
      const rerun = await classifyFailures({ repoDir: options.repoDir, config, stack, command, wrapperConfig: wrapper.configFile, tagRequests, guard }, failed);
      failures = rerun.failures;
      warnings.push(...rerun.warnings);
      stopwatch.lap('reruns');
    }
  } finally {
    wrapper?.remove();
    await targets?.baselineApp?.stop();
    peakRssMb = (await stack.stop()).peakRssMb;
    await tracer?.close();
    guard.dispose();
    stopwatch.lap('teardown');
  }

  const report = buildReport({
    repoDir: options.repoDir,
    command: options.command,
    mode: options.mode,
    workerCount: isolated ? options.workers : (tests.results?.resolvedWorkers ?? 0),
    cache: stack.cache,
    stopwatch,
    machine: describeMachine(stack.postgresVersion, path.dirname(command.repoConfig), loadAvg1),
    cpu: tests.cpu,
    results: tests.results,
    apps: stack.apps,
    peakRssMb,
    clones: targets.databases,
    failures,
    dbActivity: tests.dbActivity,
    proxy: tests.proxy,
    routingValid: tests.routing.valid,
    unmanaged,
    warnings,
  });
  writeFileSync(paths.report, `${JSON.stringify(report, null, 2)}\n`);
  process.stderr.write(renderTable(report, paths.report));
  if (guard.signal !== null) return 128 + os.constants.signals[guard.signal];
  return report.routingValid === false && tests.exitCode === 0 ? 1 : tests.exitCode;
}
