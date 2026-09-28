import { finalAttempts, type PwResults, type TestRecord } from '../../src/playwright/results.js';
import { failedTests } from '../../src/report/summary.js';

/** A test's verdict in one run, from its last attempt. `skipped` includes interrupted and did-not-run tests. */
export type Outcome = 'passed' | 'failed' | 'skipped';

/** The verdict of one last attempt, as isolate's own report counts it. */
function outcomeOf(record: TestRecord): Outcome {
  if (record.status === 'skipped' || record.status === 'interrupted') return 'skipped';
  return record.ok ? 'passed' : 'failed';
}

/** Every test's outcome in one run, keyed by test id. */
export function testOutcomes(results: PwResults): Record<string, Outcome> {
  return Object.fromEntries(finalAttempts(results).map((record) => [record.id, outcomeOf(record)]));
}

/** Ids of the tests whose last attempt failed. */
export function failingIds(results: PwResults): string[] {
  return failedTests(results).map((record) => record.id);
}

/** Ids of the tests that were skipped, interrupted or did not run. */
export function notRunIds(results: PwResults): string[] {
  return finalAttempts(results)
    .filter((record) => outcomeOf(record) === 'skipped')
    .map((record) => record.id);
}

/** Each test's duration in ms (last attempt), keyed by test id. */
export function testDurations(results: PwResults): Record<string, number> {
  return Object.fromEntries(finalAttempts(results).map((record) => [record.id, record.durationMs]));
}
