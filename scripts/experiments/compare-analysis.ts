import type { PwResults, TestRecord } from '../../src/playwright/results.js';
import { finalAttempts } from '../../src/playwright/results.js';

/** Why a test failed, from its status and the first line of its error. */
export type FailureKind = 'rate limit (429)' | 'timeout' | 'other';

export const FAILURE_KINDS: FailureKind[] = ['rate limit (429)', 'timeout', 'other'];

/** The failures of one run: how many of each kind, and the time the failed tests took. */
export interface FailureBreakdown {
  failed: number;
  /** Tests a serial group skipped after a failure in it ("did not run"). */
  didNotRun: number;
  byKind: Record<FailureKind, number>;
  /** Sum of the failed tests' durations: time the run spent on tests that did not pass. */
  failedMs: number;
  /** Sum of every test's duration that ran in a worker. */
  ranMs: number;
}

/** A test that ran and did not pass (a failure, a timeout or an interruption). */
export function isFailure(test: TestRecord): boolean {
  return test.status === 'failed' || test.status === 'timedOut' || test.status === 'interrupted';
}

/** A test that was skipped although it was expected to run: a serial group's follower after a failure. */
function didNotRun(test: TestRecord): boolean {
  return test.status === 'skipped' && test.expectedStatus !== 'skipped';
}

/** Classifies a failed test by its status and error message. */
export function failureKind(test: TestRecord): FailureKind {
  const error = test.error ?? '';
  if (/\b429\b|too many requests/i.test(error)) return 'rate limit (429)';
  if (test.status === 'timedOut' || /timeout|timed out|exceeded/i.test(error)) return 'timeout';
  return 'other';
}

/** Counts one run's failures by kind and adds up the time they took. */
export function breakdown(results: PwResults): FailureBreakdown {
  const tests = finalAttempts(results);
  const failed = tests.filter(isFailure);
  const byKind: Record<FailureKind, number> = { 'rate limit (429)': 0, timeout: 0, other: 0 };
  for (const test of failed) byKind[failureKind(test)]++;
  return {
    failed: failed.length,
    didNotRun: tests.filter(didNotRun).length,
    byKind,
    failedMs: failed.reduce((sum, test) => sum + test.durationMs, 0),
    ranMs: tests.filter((test) => test.workerIndex >= 0).reduce((sum, test) => sum + test.durationMs, 0),
  };
}

/** The ids of the tests that passed in every one of `runs` (their setup's runs): the tests known to work there. */
export function passedEverywhere(runs: PwResults[]): Set<string> {
  if (runs.length === 0) return new Set();
  const passed = runs.map((run) => new Set(finalAttempts(run).filter((test) => test.status === 'passed').map((test) => test.id)));
  return new Set([...passed[0]!].filter((id) => passed.every((set) => set.has(id))));
}

/** The tests of `run` that failed although they passed in every run of their setup. */
export function newFailures(run: PwResults, passedInTheirs: Set<string>): TestRecord[] {
  return finalAttempts(run).filter((test) => isFailure(test) && passedInTheirs.has(test.id));
}
