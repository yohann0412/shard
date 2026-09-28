import { rmSync } from 'node:fs';
import path from 'node:path';
import { startSingleApp } from '../app/apps.js';
import type { IsolateConfig } from '../config/schema.js';
import { cloneDatabase } from '../db/databases.js';
import { log } from '../log.js';
import { isolatePaths } from '../paths.js';
import { commandWithConfig, type PlaywrightCommand } from '../playwright/command.js';
import type { InterruptGuard } from '../playwright/interrupts.js';
import { readResults, type TestRecord } from '../playwright/results.js';
import { startPlaywright } from '../playwright/runner.js';
import { workerEnv } from '../playwright/worker-env.js';
import type { Stack } from '../stack.js';
import type { Failure } from './schema.js';

/** At most this many failed tests are rerun; the rest are reported as `not-rerun`. */
const MAX_RERUN_TESTS = 10;
const RUNS_PER_TEST = 2;

/** What reruns need from the session. */
export interface RerunOptions {
  repoDir: string;
  config: IsolateConfig;
  stack: Stack;
  command: PlaywrightCommand;
  wrapperConfig: string;
  tagRequests: boolean;
  guard: InterruptGuard;
}

type Outcome = Failure['reruns'][number];

/** Escapes a string for use inside a regular expression. */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Playwright arguments that select exactly this test's file and line in its project, on one worker, without retries. */
function selectTest(repoDir: string, test: TestRecord): string[] {
  const file = `^${escapeRegExp(path.resolve(repoDir, test.file))}$:${test.line}`;
  const project = test.project === '' ? [] : ['--project', test.project];
  return [file, ...project, '--workers', '1', '--retries', '0'];
}

/**
 * Runs one test alone against a fresh copy of `seed` and a fresh app started on it, so that leftovers from the main
 * run cannot decide the outcome. `run` numbers the rerun; it names the database, the app log and the app's worker index.
 */
async function rerunOnce(options: RerunOptions, test: TestRecord, run: number): Promise<Outcome> {
  const { repoDir, config, stack } = options;
  const paths = isolatePaths(repoDir);
  const index = stack.databases.length + run;
  const database = await cloneDatabase(stack.postgres, `rerun${run}`);
  const app = await startSingleApp({ repoDir, config, reaper: stack.reaper, index, database, logFile: paths.rerunAppLog(run) });
  try {
    rmSync(paths.rerunResults, { force: true });
    const env = {
      ISOLATE_WORKER_ENVS: JSON.stringify([workerEnv(config, { index, port: app.port, url: app.url, dbUrl: database.url })]),
      ISOLATE_WORKERS: '1',
      ISOLATE_TAG_REQUESTS: options.tagRequests ? '1' : '0',
      ISOLATE_RESULTS_FILE: paths.rerunResults,
      PLAYWRIGHT_HTML_OPEN: 'never',
    };
    const argv = commandWithConfig(options.command, options.wrapperConfig, selectTest(repoDir, test));
    const exitCode = await options.guard.run(startPlaywright(argv, { cwd: repoDir, env, reaper: stack.reaper, logFile: paths.rerunsLog }));
    const record = readResults(paths.rerunResults)?.tests.find((result) => result.id === test.id);
    if (record === undefined) throw new Error(`rerun ${run} did not run the test (exit code ${exitCode}); see ${paths.rerunsLog}`);
    return record.ok ? 'passed' : 'failed';
  } finally {
    await app.stop();
  }
}

/** A failed test as the report lists it before (or without) reruns. */
export function notRerun(test: TestRecord): Failure {
  return { id: test.id, title: test.title, file: test.file, line: test.line, project: test.project, classification: 'not-rerun', reruns: [] };
}

/**
 * Reruns each failed test (at most MAX_RERUN_TESTS) twice, alone, and classifies it: passed in any rerun → flaky,
 * failed in both → deterministic. Tests beyond the limit, or whose reruns could not run, are `not-rerun`.
 */
export async function classifyFailures(options: RerunOptions, failed: TestRecord[]): Promise<{ failures: Failure[]; warnings: string[] }> {
  const warnings: string[] = [];
  if (failed.length > MAX_RERUN_TESTS) {
    warnings.push(`${failed.length - MAX_RERUN_TESTS} failed test(s) were not rerun (at most ${MAX_RERUN_TESTS} are)`);
    log.warn(warnings.at(-1)!);
  }
  const failures: Failure[] = [];
  let run = 0;
  for (const [position, test] of failed.entries()) {
    const failure = notRerun(test);
    failures.push(failure);
    if (position >= MAX_RERUN_TESTS || options.guard.signal !== null) continue;
    try {
      for (let attempt = 0; attempt < RUNS_PER_TEST && options.guard.signal === null; attempt++) {
        failure.reruns.push(await rerunOnce(options, test, run++));
      }
    } catch (error) {
      warnings.push(`could not rerun ${test.id}: ${error instanceof Error ? error.message : String(error)}`);
      log.warn(warnings.at(-1)!);
    }
    if (failure.reruns.includes('passed')) failure.classification = 'flaky';
    else if (failure.reruns.length === RUNS_PER_TEST) failure.classification = 'deterministic';
    log.info(`rerun ${test.id}: ${failure.reruns.join(', ') || 'not run'} → ${failure.classification}`);
  }
  return { failures, warnings };
}
