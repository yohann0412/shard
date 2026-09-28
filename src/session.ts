import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from './config/load.js';
import type { IsolateConfig } from './config/schema.js';
import { cloneDatabase, databaseUrlVars, type WorkerDatabase } from './db/databases.js';
import { log } from './log.js';
import { isolatePaths } from './paths.js';
import { commandWithConfig, parsePlaywrightCommand, type PlaywrightCommand } from './playwright/command.js';
import { InterruptGuard } from './playwright/interrupts.js';
import { readResults, type PwResults } from './playwright/results.js';
import { startPlaywright } from './playwright/runner.js';
import { scanForHazards } from './playwright/scan.js';
import { workerEnv } from './playwright/worker-env.js';
import { writeWrapper, type Wrapper } from './playwright/wrapper.js';
import { buildReport } from './report/build.js';
import { cpuUsage, readCpuTimes, type CpuUsage } from './report/cpu.js';
import { describeMachine } from './report/machine.js';
import { classifyFailures, notRerun } from './report/rerun.js';
import { checkRouting, readXactCommits, routingError, type RoutingCheck } from './report/routing.js';
import type { Failure } from './report/schema.js';
import { Stopwatch } from './report/stopwatch.js';
import { failedTests } from './report/summary.js';
import { renderTable } from './report/table.js';
import { startStack, type Stack } from './stack.js';

/** `run`: one app and database per worker. `baseline`: the repo's own config against one fresh copy of seed. */
export type SessionMode = 'run' | 'baseline';

/** What `isolate run` was asked to do. */
export interface SessionOptions {
  repoDir: string;
  command: string[];
  mode: SessionMode;
  /** Number of apps and databases in `run` mode; unused in `baseline` mode. */
  workers: number;
  tagRequests: boolean;
}

/** Name of the one database the baseline runs against. */
const BASELINE_DATABASE = 'b0';

/** What the tests run against: the databases whose activity is checked, and the variables Playwright gets. */
interface Targets {
  databases: WorkerDatabase[];
  env: Record<string, string>;
}

/** Everything the tests phase produced. */
interface TestsOutcome {
  exitCode: number;
  results: PwResults | null;
  cpu: CpuUsage | null;
  routing: RoutingCheck;
}

/** Loads the config, parses the command and scans the tests before anything starts, so a refused command costs nothing. */
async function prepare(options: SessionOptions): Promise<{ config: IsolateConfig; command: PlaywrightCommand; warnings: string[] }> {
  const config = await loadConfig(options.repoDir);
  const command = parsePlaywrightCommand(options.command, {
    repoDir: options.repoDir,
    defaultConfig: config.playwright.config,
    workers: options.mode === 'run' ? options.workers : null,
  });
  const warnings = options.mode === 'run' ? scanForHazards(command.repoConfig, options.repoDir) : [];
  for (const warning of warnings) log.warn(warning);
  return { config, command, warnings };
}

/** In run mode, every worker's variables for its app and database; in baseline mode, a fresh b0 in the database variables. */
async function prepareTargets(options: SessionOptions, config: IsolateConfig, stack: Stack): Promise<Targets> {
  if (options.mode === 'baseline') {
    const database = await cloneDatabase(stack.postgres, BASELINE_DATABASE);
    return { databases: [database], env: databaseUrlVars(config, database.url) };
  }
  const envs = stack.apps.map((app) => workerEnv(config, { index: app.index, port: app.port, url: app.url, dbUrl: app.dbUrl }));
  return {
    databases: stack.databases,
    env: {
      ISOLATE_WORKER_ENVS: JSON.stringify(envs),
      ISOLATE_WORKERS: String(envs.length),
      ISOLATE_TAG_REQUESTS: options.tagRequests ? '1' : '0',
    },
  };
}

/** Databases that must show activity: those of the parallel indexes that ran a test (b0 in baseline mode). */
function usedDatabases(mode: SessionMode, results: PwResults | null, databases: WorkerDatabase[]): string[] {
  const ran = (results?.tests ?? []).filter((test) => test.status !== 'skipped');
  if (mode === 'baseline') return ran.length > 0 ? [BASELINE_DATABASE] : [];
  const indexes = new Set(ran.map((test) => test.parallelIndex));
  return databases.filter((_, index) => indexes.has(index)).map((database) => database.name);
}

/** Runs the Playwright command, reads the reporter's results and checks routing from outside the test process. */
async function runTests(
  options: SessionOptions,
  stack: Stack,
  targets: Targets,
  argv: string[],
  guard: InterruptGuard,
): Promise<TestsOutcome> {
  const paths = isolatePaths(options.repoDir);
  const adminUrl = stack.postgres.url('postgres');
  const before = await readXactCommits(adminUrl, targets.databases.map((database) => database.name));
  const cpuBefore = readCpuTimes();
  rmSync(paths.pwResults, { force: true });

  log.info(`running: ${argv.join(' ')}`);
  const env = { ...targets.env, ISOLATE_RESULTS_FILE: paths.pwResults, PLAYWRIGHT_HTML_OPEN: 'never' };
  const exitCode = await guard.run(startPlaywright(argv, { cwd: options.repoDir, env, reaper: stack.reaper }));
  const cpu = cpuUsage(cpuBefore, readCpuTimes());

  const results = readResults(paths.pwResults);
  const routing = await checkRouting(adminUrl, before, usedDatabases(options.mode, results, targets.databases));
  return { exitCode, results, cpu, routing };
}

/** Prints and returns what makes the tests phase suspect: no reporter results, invalid routing, refused connections (PLAN §8, rule 5). */
function testWarnings(repoDir: string, config: IsolateConfig, tests: TestsOutcome): string[] {
  const warnings: string[] = [];
  if (tests.results === null) warnings.push('Playwright exited without writing the isolate reporter results');
  if (tests.routing.idle.length > 0) warnings.push(routingError(tests.routing.idle, config.db.urlEnv));
  const postgresLog = isolatePaths(repoDir).postgresLog;
  if (existsSync(postgresLog) && readFileSync(postgresLog, 'utf8').includes('too many clients')) {
    warnings.push(`Postgres refused connections ("too many clients", see ${postgresLog}): exclude this run from timing`);
  }
  for (const warning of warnings) log.error(warning);
  return warnings;
}

/**
 * Runs a Playwright suite under isolate: starts the stack, writes the wrapper, runs the command, checks routing, reruns
 * failures (run mode), tears down, writes .isolate/report.json and prints the summary table. Returns the exit code:
 * Playwright's, 1 if routing was invalid, or 128 + n after a signal.
 */
export async function runSession(options: SessionOptions): Promise<number> {
  const stopwatch = new Stopwatch();
  const loadAvg1 = os.loadavg()[0] ?? 0;
  const paths = isolatePaths(options.repoDir);
  const { config, command, warnings } = await prepare(options);
  stopwatch.lap('setup');

  const stack = await startStack({ repoDir: options.repoDir, config, workers: options.mode === 'run' ? options.workers : 0, apps: options.mode === 'run' });
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
  let targets: Targets;
  let tests: TestsOutcome;
  let failures: Failure[];
  let peakRssMb: Record<string, number>;
  try {
    targets = await prepareTargets(options, config, stack);
    if (options.mode === 'baseline') stopwatch.lap('clone');
    wrapper = writeWrapper({
      mode: options.mode === 'run' ? 'isolate' : 'passthrough',
      repoConfig: command.repoConfig,
      outputFile: paths.pwResults,
      rootDir: options.repoDir,
      cliReporters: command.cliReporters,
    });
    for (const file of wrapper.files) stack.reaper.trackDir(file);
    stopwatch.lap('setup');

    tests = await runTests(options, stack, targets, commandWithConfig(command, wrapper.configFile), guard);
    warnings.push(...testWarnings(options.repoDir, config, tests));
    stopwatch.lap('tests');

    const failed = failedTests(tests.results);
    failures = failed.map(notRerun);
    if (options.mode === 'run' && failed.length > 0 && guard.signal === null) {
      const rerun = await classifyFailures({ repoDir: options.repoDir, config, stack, command, wrapperConfig: wrapper.configFile, tagRequests: options.tagRequests, guard }, failed);
      failures = rerun.failures;
      warnings.push(...rerun.warnings);
      stopwatch.lap('reruns');
    }
  } finally {
    wrapper?.remove();
    peakRssMb = (await stack.stop()).peakRssMb;
    guard.dispose();
    stopwatch.lap('teardown');
  }

  const report = buildReport({
    repoDir: options.repoDir,
    command: options.command,
    mode: options.mode,
    workerCount: options.mode === 'run' ? options.workers : (tests.results?.resolvedWorkers ?? 0),
    cache: stack.cache,
    stopwatch,
    machine: describeMachine(stack.postgresVersion, path.dirname(command.repoConfig), loadAvg1),
    cpu: tests.cpu,
    results: tests.results,
    apps: stack.apps,
    peakRssMb,
    clones: targets.databases,
    failures,
    routing: tests.routing,
    warnings,
  });
  writeFileSync(paths.report, `${JSON.stringify(report, null, 2)}\n`);
  process.stderr.write(renderTable(report, paths.report));
  if (guard.signal !== null) return 128 + os.constants.signals[guard.signal];
  return report.routingValid || tests.exitCode !== 0 ? tests.exitCode : 1;
}
