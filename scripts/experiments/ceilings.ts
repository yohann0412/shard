import { finalAttempts, type TestRecord } from '../../src/playwright/results.js';
import type { ArmRun } from './arms.js';
import { median, round } from './stats.js';

/** The serial work of one test file in one project, at isolated@1. */
export interface FileWork {
  project: string;
  file: string;
  /** True if two of its tests ran at the same time in some isolated run with N > 1 (observed, not configured). */
  parallel: boolean;
  tests: number;
  /** Longest test when parallel, else the sum of its tests' median durations. */
  durationMs: number;
}

/** What the scheduling ceiling is computed from. */
export interface SchedulingInputs {
  /** T1: the sum of every test's median duration at isolated@1. */
  t1Ms: number;
  longestFile: FileWork | null;
  files: FileWork[];
}

/** Tests that reached a verdict in a run (skipped and interrupted tests took no test time). */
function ran(run: ArmRun): TestRecord[] {
  return run.results === null ? [] : finalAttempts(run.results).filter((test) => test.status !== 'skipped' && test.status !== 'interrupted');
}

/** Groups items by a string key, keeping first-seen order. */
function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) groups.set(key(item), [...(groups.get(key(item)) ?? []), item]);
  return groups;
}

/** A file's key: the same file in two projects is two units of work. */
function fileKey(test: TestRecord): string {
  return `${test.project} › ${test.file}`;
}

/** Files where two tests' [start, start + duration] intervals overlapped in some run. */
function observedParallelFiles(runs: ArmRun[]): Set<string> {
  const parallel = new Set<string>();
  for (const run of runs) {
    const byFile = groupBy(ran(run), fileKey);
    for (const [key, tests] of byFile) {
      const overlaps = tests.some((a, i) => tests.slice(i + 1).some((b) => a.startMs < b.startMs + b.durationMs && b.startMs < a.startMs + a.durationMs));
      if (overlaps) parallel.add(key);
    }
  }
  return parallel;
}

/**
 * T1 and each file's work from the isolated@1 runs (per-test median durations), with parallelism per file observed in
 * `parallelRuns` (the isolated runs with N > 1).
 */
export function schedulingInputs(isolated1: ArmRun[], parallelRuns: ArmRun[]): SchedulingInputs {
  const durations = new Map<string, { test: TestRecord; samples: number[] }>();
  for (const test of isolated1.flatMap(ran)) {
    const entry = durations.get(test.id) ?? { test, samples: [] };
    entry.samples.push(test.durationMs);
    durations.set(test.id, entry);
  }
  const parallel = observedParallelFiles(parallelRuns);
  const byFile = groupBy([...durations.values()], (entry) => fileKey(entry.test));
  const files = [...byFile].map(([key, entries]): FileWork => {
    const ms = entries.map((entry) => median(entry.samples));
    const isParallel = parallel.has(key);
    const { project, file } = entries[0]!.test;
    return { project, file, parallel: isParallel, tests: entries.length, durationMs: round(isParallel ? Math.max(...ms) : ms.reduce((a, b) => a + b, 0), 1) };
  });
  files.sort((a, b) => b.durationMs - a.durationMs);
  const t1Ms = round([...durations.values()].reduce((sum, entry) => sum + median(entry.samples), 0), 1);
  return { t1Ms, longestFile: files[0] ?? null, files };
}

/** Scheduling ceiling at N workers: T1 / max(T1 / N, longest file). */
export function schedulingCeiling(inputs: SchedulingInputs, workers: number): number | null {
  if (inputs.longestFile === null || inputs.t1Ms === 0) return null;
  return round(inputs.t1Ms / Math.max(inputs.t1Ms / workers, inputs.longestFile.durationMs));
}

/** Resource ceiling at N workers: min(N, cores / d), where d is the CPU demand of one worker slot at isolated@1. */
export function resourceCeiling(workers: number, cores: number, cpuDemand: number | null): number | null {
  if (cpuDemand === null || cpuDemand <= 0) return null;
  return round(Math.min(workers, cores / cpuDemand));
}
