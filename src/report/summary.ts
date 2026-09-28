import { finalAttempts, isFlaky, type PwResults, type TestRecord } from '../playwright/results.js';
import type { Report } from './schema.js';

/** True if the test did not reach a verdict: skipped, or interrupted (Ctrl+C, max failures). */
function unfinished(record: TestRecord): boolean {
  return record.status === 'skipped' || record.status === 'interrupted';
}

/** True if the test's last attempt reached a verdict other than the expected one. */
function failed(record: TestRecord): boolean {
  return !record.ok && !unfinished(record);
}

/** The tests whose last attempt failed, in the order they ran. */
export function failedTests(results: PwResults | null): TestRecord[] {
  return results === null ? [] : finalAttempts(results).filter(failed);
}

/** Totals over every test, counting each test once by its last attempt; `skipped` includes interrupted tests. */
export function testTotals(results: PwResults | null): Report['tests'] {
  if (results === null) return { total: 0, passed: 0, failed: 0, flaky: 0, skipped: 0 };
  const finals = finalAttempts(results);
  const skipped = finals.filter(unfinished).length;
  const flaky = finals.filter((record) => isFlaky(results, record)).length;
  const failures = finals.filter(failed).length;
  return { total: finals.length, passed: finals.length - skipped - flaky - failures, failed: failures, flaky, skipped };
}

/** Test counts per Playwright parallel index, each test counted once, on the worker of its last attempt. */
export function workerCounts(results: PwResults | null): Report['workers'] {
  const byIndex = new Map<number, Report['workers'][number]>();
  for (const record of results === null ? [] : finalAttempts(results)) {
    const entry = byIndex.get(record.parallelIndex) ?? { parallelIndex: record.parallelIndex, tests: 0, passed: 0, failed: 0 };
    entry.tests++;
    if (record.ok) entry.passed++;
    if (failed(record)) entry.failed++;
    byIndex.set(record.parallelIndex, entry);
  }
  return [...byIndex.values()].sort((a, b) => a.parallelIndex - b.parallelIndex);
}

/** Playwright's own timing: test phase, time before and after it, concurrency, and setup vs body time per attempt. */
export function playwrightTiming(results: PwResults | null): Report['playwright'] {
  if (results === null) return null;
  const setupMs = results.tests.reduce((sum, record) => sum + record.setupMs, 0);
  const bodyMs = results.tests.reduce((sum, record) => sum + record.bodyMs, 0);
  return {
    testPhaseMs: results.testPhaseMs,
    preTestMs: results.preTestMs,
    postTestMs: results.postTestMs,
    resolvedWorkers: results.resolvedWorkers,
    maxConcurrent: results.maxConcurrent,
    parallelIndexes: results.parallelIndexes,
    setupMs,
    bodyMs,
  };
}
