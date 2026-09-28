import { existsSync, readFileSync } from 'node:fs';

/** Final status of one test attempt, as Playwright reports it. */
export type TestStatus = 'passed' | 'failed' | 'timedOut' | 'skipped' | 'interrupted';

/** One attempt of one test, as recorded by the isolate reporter. */
export interface TestRecord {
  id: string;
  title: string;
  file: string;
  line: number;
  project: string;
  status: TestStatus;
  expectedStatus: TestStatus;
  ok: boolean;
  durationMs: number;
  retry: number;
  parallelIndex: number;
  workerIndex: number;
  startMs: number;
  setupMs: number;
  bodyMs: number;
  error: string | null;
}

/** Everything the isolate reporter writes. Times are ms on a monotonic clock, relative to the reporter's construction. */
export interface PwResults {
  startedAt: string;
  status: string;
  resolvedWorkers: number;
  beginMs: number;
  firstTestBeginMs: number | null;
  lastTestEndMs: number | null;
  endMs: number;
  testPhaseMs: number;
  preTestMs: number;
  postTestMs: number;
  maxConcurrent: number;
  parallelIndexes: number[];
  tests: TestRecord[];
}

/** Reads the isolate reporter's output file, or returns null if Playwright never wrote it. */
export function readResults(file: string): PwResults | null {
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, 'utf8')) as PwResults;
}

/** The last attempt of every test, in first-seen order. */
export function finalAttempts(results: PwResults): TestRecord[] {
  const last = new Map<string, TestRecord>();
  for (const record of results.tests) {
    const seen = last.get(record.id);
    if (seen === undefined || record.retry >= seen.retry) last.set(record.id, record);
  }
  return [...last.values()];
}

/** True if any attempt of this test failed while its last attempt passed. */
export function isFlaky(results: PwResults, final: TestRecord): boolean {
  return final.ok && results.tests.some((record) => record.id === final.id && !record.ok);
}
