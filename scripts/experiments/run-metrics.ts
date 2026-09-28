import { finalAttempts } from '../../src/playwright/results.js';
import type { ArmRun } from './arms.js';
import { testOutcomes, type Outcome } from './outcomes.js';

/** The numbers Experiment A takes from one run. All times in ms. */
export interface RunMetrics {
  /** First test begin to last test end (the verdict's span). */
  testPhaseMs: number;
  /** The isolate command's whole wall time, from its report. */
  wallMs: number;
  /** Playwright start to first test begin: webServer, globalSetup, worker and browser start. */
  preTestMs: number;
  /** Last test end to Playwright's end. */
  postTestMs: number;
  /** Playwright's own wall time: pre-test + test phase + post-test. */
  playwrightWallMs: number;
  /** The isolate command's wall time without the build (done once, untimed) and the failure reruns. */
  endToEndMs: number;
  /** Sum of the durations of the tests that ran. */
  sumDurationMs: number;
  /** Sum of the time those tests spent in hooks and fixtures. */
  sumSetupMs: number;
  resolvedWorkers: number;
  maxConcurrent: number;
  distinctParallelIndexes: number;
  /** CPU demand d: machine-wide busy CPU seconds per second of test phase (null without /proc/stat). */
  cpuDemand: number | null;
  /** Peak RSS of every app tree plus the Postgres tree, in MB (each tree's own peak, summed). */
  memoryMb: number;
}

/** A mismatch between a run's per-test outcome and the reference's. */
export interface Mismatch {
  id: string;
  expected: Outcome | 'missing';
  actual: Outcome | 'missing';
}

/** Whether one run counts, and why not. */
export interface RunValidity {
  arm: string;
  round: ArmRun['round'];
  valid: boolean;
  reasons: string[];
  routingValid: boolean | null;
  tooManyClients: boolean;
  mismatches: Mismatch[];
}

/** The metrics of one run, or null when isolate wrote no report or Playwright no results. */
export function runMetrics(run: ArmRun, cores: number): RunMetrics | null {
  const { report, results } = run;
  const pw = report?.playwright;
  if (report === null || results === null || pw === null || pw === undefined) return null;
  const ran = finalAttempts(results).filter((test) => test.status !== 'skipped' && test.status !== 'interrupted');
  const playwrightWallMs = pw.preTestMs + pw.testPhaseMs + pw.postTestMs;
  return {
    testPhaseMs: pw.testPhaseMs,
    wallMs: report.wallMs,
    preTestMs: pw.preTestMs,
    postTestMs: pw.postTestMs,
    playwrightWallMs,
    endToEndMs: report.wallMs - (report.phases.build ?? 0) - (report.phases.reruns ?? 0),
    sumDurationMs: ran.reduce((sum, test) => sum + test.durationMs, 0),
    sumSetupMs: ran.reduce((sum, test) => sum + test.setupMs, 0),
    resolvedWorkers: pw.resolvedWorkers,
    maxConcurrent: pw.maxConcurrent,
    distinctParallelIndexes: pw.parallelIndexes.length,
    cpuDemand: report.cpu === null || pw.testPhaseMs === 0 ? null : ((report.cpu.busyPct / 100) * cores * playwrightWallMs) / pw.testPhaseMs,
    memoryMb: report.apps.reduce((sum, app) => sum + app.peakRssMb, 0) + report.postgresPeakRssMb,
  };
}

/**
 * The reference outcome of every test: its most frequent outcome over baseline@1's timed rounds (a tie goes to the
 * earliest round's outcome). Null when no baseline@1 round produced results.
 */
export function referenceOutcomes(runs: ArmRun[]): Record<string, Outcome> | null {
  const rounds = runs.filter((run) => run.arm === 'baseline@1' && typeof run.round === 'number' && run.results !== null);
  if (rounds.length === 0) return null;
  const perRound = rounds.map((run) => testOutcomes(run.results!));
  const ids = new Set(perRound.flatMap((outcomes) => Object.keys(outcomes)));
  const reference: Record<string, Outcome> = {};
  for (const id of ids) {
    const seen = perRound.map((outcomes) => outcomes[id]).filter((outcome): outcome is Outcome => outcome !== undefined);
    const counts = new Map<Outcome, number>();
    for (const outcome of seen) counts.set(outcome, (counts.get(outcome) ?? 0) + 1);
    reference[id] = seen.reduce((best, outcome) => (counts.get(outcome)! > counts.get(best)! ? outcome : best), seen[0]!);
  }
  return reference;
}

/** The tests whose outcome in `actual` differs from the reference (a test missing on either side counts). */
function mismatches(actual: Record<string, Outcome>, reference: Record<string, Outcome>): Mismatch[] {
  const ids = [...new Set([...Object.keys(actual), ...Object.keys(reference)])].sort();
  return ids
    .map((id) => ({ id, expected: reference[id] ?? ('missing' as const), actual: actual[id] ?? ('missing' as const) }))
    .filter((pair) => pair.expected !== pair.actual);
}

/**
 * Whether a run counts (PLAN §5.5, §8): it wrote a report and results, stayed under the cap, routed every used worker to
 * its own database, saw no "too many clients", and its per-test outcomes match baseline@1's reference outcomes.
 */
export function runValidity(run: ArmRun, reference: Record<string, Outcome> | null): RunValidity {
  const reasons: string[] = [];
  const tooManyClients = run.run.tooManyClients || (run.report?.warnings.some((warning) => warning.includes('too many clients')) ?? false);
  if (run.run.exceededCap) reasons.push('exceeded cap');
  if (run.report === null) reasons.push('no report');
  if (run.results === null || run.report?.playwright === null) reasons.push('no Playwright results');
  if (run.report?.routingValid === false) reasons.push('routing invalid');
  if (run.report?.routingValid === null) reasons.push('routing unknown');
  if (tooManyClients) reasons.push('too many clients');
  const differ = reference !== null && run.results !== null ? mismatches(testOutcomes(run.results), reference) : [];
  if (reference === null) reasons.push('no baseline@1 reference outcomes');
  if (differ.length > 0) reasons.push(`outcomes differ from baseline@1 for ${differ.length} test(s)`);
  return {
    arm: run.arm,
    round: run.round,
    valid: reasons.length === 0,
    reasons,
    routingValid: run.report?.routingValid ?? null,
    tooManyClients,
    mismatches: differ,
  };
}
