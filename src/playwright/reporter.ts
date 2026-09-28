import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { FullConfig, FullResult, Reporter, TestCase, TestResult } from '@playwright/test/reporter';
import type { PwResults, TestRecord } from './results.js';
import { relativeFile, testId } from './test-id.js';

/** Options the wrapper config passes to this reporter. */
interface Options {
  outputFile: string;
  rootDir: string;
}

const ANSI_ESCAPES = /\u001b\[[0-9;]*m/g;

/** First line of an error message, without terminal colors. */
function firstLine(message: string | undefined): string | null {
  return message === undefined ? null : message.replace(ANSI_ESCAPES, '').split('\n')[0]!;
}

/** Time spent in top-level hook and fixture steps: setup and teardown around the test body. */
function setupMs(result: TestResult): number {
  return result.steps.filter((step) => step.category === 'hook' || step.category === 'fixture').reduce((sum, step) => sum + step.duration, 0);
}

/**
 * Time in the test outside hooks and fixtures. `result.duration` stops before the after-hooks finish,
 * so the attempt's span runs to whichever ends last: the duration or the last top-level step.
 */
function bodyMs(result: TestResult): number {
  const start = result.startTime.getTime();
  const span = Math.max(result.duration, ...result.steps.map((step) => step.startTime.getTime() + step.duration - start));
  return Math.max(0, span - setupMs(result));
}

/**
 * Playwright reporter that records per-test timing, worker placement and outcome on a monotonic clock
 * and writes them as JSON. It imports nothing from Playwright at runtime, so it works with any version.
 */
export default class IsolateReporter implements Reporter {
  private readonly options: Options;
  private readonly startedAt = new Date();
  private readonly origin = performance.now();
  private resolvedWorkers = 0;
  private beginMs = 0;
  private firstTestBeginMs: number | null = null;
  private lastTestEndMs: number | null = null;
  private running = 0;
  private maxConcurrent = 0;
  private readonly startTimes = new Map<TestResult, number>();
  private readonly records: TestRecord[] = [];

  constructor(options: Partial<Options>) {
    if (!options.outputFile || !options.rootDir) throw new Error('isolate reporter needs the outputFile and rootDir options');
    this.options = { outputFile: options.outputFile, rootDir: options.rootDir };
  }

  printsToStdio(): boolean {
    return false;
  }

  onBegin(config: FullConfig): void {
    this.beginMs = this.now();
    this.resolvedWorkers = config.workers;
  }

  onTestBegin(_test: TestCase, result: TestResult): void {
    const now = this.now();
    this.firstTestBeginMs ??= now;
    this.startTimes.set(result, now);
    this.running++;
    this.maxConcurrent = Math.max(this.maxConcurrent, this.running);
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    const now = this.now();
    this.lastTestEndMs = now;
    this.running = Math.max(0, this.running - 1);
    const outcome = test.outcome();
    const project = test.parent.project()?.name ?? '';
    this.records.push({
      id: testId(project, this.options.rootDir, test.location.file, test.titlePath().slice(3)),
      title: test.title,
      file: relativeFile(this.options.rootDir, test.location.file),
      line: test.location.line,
      project,
      status: result.status,
      expectedStatus: test.expectedStatus,
      ok: outcome === 'expected' || outcome === 'flaky',
      durationMs: result.duration,
      retry: result.retry,
      parallelIndex: result.parallelIndex,
      workerIndex: result.workerIndex,
      startMs: this.startTimes.get(result) ?? now - result.duration,
      setupMs: setupMs(result),
      bodyMs: bodyMs(result),
      error: firstLine(result.error?.message),
    });
    this.startTimes.delete(result);
  }

  onEnd(result: FullResult): void {
    const endMs = this.now();
    const first = this.firstTestBeginMs;
    const last = this.lastTestEndMs;
    const output: PwResults = {
      startedAt: this.startedAt.toISOString(),
      status: result.status,
      resolvedWorkers: this.resolvedWorkers,
      beginMs: this.beginMs,
      firstTestBeginMs: first,
      lastTestEndMs: last,
      endMs,
      testPhaseMs: first !== null && last !== null ? last - first : 0,
      preTestMs: first ?? endMs,
      postTestMs: last !== null ? endMs - last : 0,
      maxConcurrent: this.maxConcurrent,
      parallelIndexes: [...new Set(this.records.map((record) => record.parallelIndex))].filter((index) => index >= 0).sort((a, b) => a - b),
      tests: this.records,
    };
    mkdirSync(path.dirname(this.options.outputFile), { recursive: true });
    writeFileSync(this.options.outputFile, `${JSON.stringify(output, null, 2)}\n`);
  }

  private now(): number {
    return performance.now() - this.origin;
  }
}
